package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
)

type allowAll struct{}

func (allowAll) Check(*http.Request) error { return nil }

type fakePinger struct {
	failures int32 // number of initial failures
	calls    atomic.Int32
}

func (p *fakePinger) Ping(context.Context) error {
	n := p.calls.Add(1)
	if n <= p.failures {
		return errors.New("connection refused (cold start)")
	}
	return nil
}

func testDeps(buf *bytes.Buffer) Deps {
	return Deps{
		Log:         zerolog.New(buf),
		Auth:        allowAll{},
		PingBackoff: time.Millisecond,
		PingTimeout: time.Second,
	}
}

func do(h http.Handler, method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if method != http.MethodGet {
		req.Header.Set(CSRFHeader, CSRFValue) // tests that exercise the CSRF guard override it via hdr
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

type errResp struct {
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func decodeErr(t *testing.T, rec *httptest.ResponseRecorder) errResp {
	t.Helper()
	var e errResp
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Error.Code == "" {
		t.Fatalf("not an error envelope (status %d): %s", rec.Code, rec.Body.String())
	}
	return e
}

func TestHealthzDoesNotTouchDatabase(t *testing.T) {
	p := &fakePinger{failures: 100}
	d := testDeps(&bytes.Buffer{})
	d.Pinger = p
	d.Auth = DenyAll{} // healthz is public
	h := NewRouter(d)
	for _, path := range []string{"/healthz", BasePath + "/healthz"} {
		rec := do(h, http.MethodGet, path, "", nil)
		if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
	if p.calls.Load() != 0 {
		t.Fatal("healthz pinged the database")
	}
}

// API-01 (envelope part): unknown routes and wrong methods answer with the error envelope.
func TestUnknownRouteAndMethodReturnEnvelope(t *testing.T) {
	h := NewRouter(testDeps(&bytes.Buffer{}))
	rec := do(h, http.MethodGet, "/api/v1/nope", "", nil)
	if rec.Code != http.StatusNotFound || decodeErr(t, rec).Error.Code != CodeNotFound {
		t.Fatalf("unknown route: %d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, http.MethodGet, "/totally/unknown", "", nil)
	if rec.Code != http.StatusNotFound || decodeErr(t, rec).Error.Code != CodeNotFound {
		t.Fatalf("unknown root route: %d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, http.MethodPost, "/healthz", "", nil)
	if rec.Code != http.StatusMethodNotAllowed || decodeErr(t, rec).Error.Code != CodeBadRequest {
		t.Fatalf("wrong method: %d %s", rec.Code, rec.Body.String())
	}
}

// API-01: an unknown symbol maps to 404 NOT_FOUND with details.symbol (the lookup itself arrives in B03).
func TestNotFoundErrorShape(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, httptest.NewRequest(http.MethodGet, "/", nil), ErrNotFound("Instrument not found", map[string]any{"symbol": "XYZ"}))
	e := decodeErr(t, rec)
	if rec.Code != 404 || e.Error.Code != "NOT_FOUND" || e.Error.Message != "Instrument not found" || e.Error.Details["symbol"] != "XYZ" {
		t.Fatalf("%d %+v", rec.Code, e)
	}
}

// API-09
func TestErrorMapping(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"bad request", ErrBadRequest("x"), 400, "BAD_REQUEST"},
		{"unauthenticated", ErrUnauthenticated("x"), 401, "UNAUTHENTICATED"},
		{"forbidden", ErrForbidden("x"), 403, "FORBIDDEN"},
		{"conflict", ErrConflict("x"), 409, "CONFLICT"},
		{"validation", ErrValidation(FieldError{Field: "qty", Message: "must be > 0"}), 422, "UNPROCESSABLE"},
		{"rate limited", ErrRateLimited(7), 429, "RATE_LIMITED"},
		{"data unavailable", ErrDataUnavailable("no_prices_imported"), 404, "DATA_UNAVAILABLE"},
		{"source down", ErrSourceDown("x"), 503, "SOURCE_DOWN"},
		{"internal", ErrInternal(), 500, "INTERNAL"},
		{"wrapped app error", errors.Join(errors.New("ctx"), ErrConflict("dup")), 409, "CONFLICT"},
		{"plain error hides cause", errors.New("pq: password authentication failed for user x"), 500, "INTERNAL"},
		{"deadline", context.DeadlineExceeded, 500, "INTERNAL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			WriteError(rec, httptest.NewRequest(http.MethodGet, "/", nil), tc.err)
			e := decodeErr(t, rec)
			if rec.Code != tc.status || e.Error.Code != tc.code {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "password authentication") {
				t.Fatal("internal cause leaked to client")
			}
		})
	}
	rec := httptest.NewRecorder()
	WriteError(rec, httptest.NewRequest(http.MethodGet, "/", nil), ErrValidation(FieldError{Field: "qty", Message: "must be > 0"}))
	if !strings.Contains(rec.Body.String(), `"fields":[{"field":"qty","message":"must be > 0"}]`) {
		t.Fatalf("422 details.fields missing: %s", rec.Body.String())
	}
}

func TestSuccessEnvelopeMetaAndWarnings(t *testing.T) {
	rec := httptest.NewRecorder()
	asOf := time.Date(2026, 10, 9, 13, 5, 0, 0, time.UTC)
	WriteData(rec, http.StatusOK, map[string]any{"a": 1},
		WithMeta(NewMeta(asOf, "import", false, 0)),
		WithWarnings(Warning{Code: "UNCONFIRMED_ACTION", Message: "Possible split"}))
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	meta := got["meta"].(map[string]any)
	if meta["as_of"] != "2026-10-09T13:05:00Z" || meta["source"] != "import" || meta["stale"] != false {
		t.Fatalf("meta = %v", meta)
	}
	if len(got["warnings"].([]any)) != 1 || got["data"].(map[string]any)["a"] != float64(1) {
		t.Fatalf("body = %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	WriteData(rec, http.StatusCreated, []int{})
	if rec.Code != 201 || strings.TrimSpace(rec.Body.String()) != `{"data":[]}` {
		t.Fatalf("minimal envelope: %d %s", rec.Code, rec.Body.String())
	}
}

func TestDecodeJSON(t *testing.T) {
	type body struct {
		A int `json:"a"`
	}
	cases := []struct {
		name, in string
		wantErr  bool
	}{
		{"ok", `{"a":1}`, false},
		{"unknown field", `{"a":1,"b":2}`, true},
		{"trailing value", `{"a":1}{"a":2}`, true},
		{"not json", `nope`, true},
		{"wrong type", `{"a":"x"}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var b body
			err := DecodeJSON(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.in)), &b)
			var app *AppError
			if tc.wantErr && (!errors.As(err, &app) || app.Status != 400) {
				t.Fatalf("err = %v", err)
			}
			if !tc.wantErr && err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMaxBody(t *testing.T) {
	var gotErr error
	h := MaxBody(16)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var v map[string]any
		gotErr = DecodeJSON(r, &v)
		if gotErr != nil {
			WriteError(w, r, gotErr)
		}
	}))
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":"`+strings.Repeat("x", 100)+`"}`))
	req.ContentLength = -1 // unknown length: enforced while reading
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge || decodeErr(t, rec).Error.Code != CodeBadRequest {
		t.Fatalf("streamed: %d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, http.MethodPost, "/", `{"a":"`+strings.Repeat("x", 100)+`"}`, nil) // declared length
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared: %d", rec.Code)
	}
}

func TestStubsReturn501Envelope(t *testing.T) {
	h := NewRouter(testDeps(&bytes.Buffer{}))
	rec := do(h, http.MethodGet, "/api/v1/stocks/TCS", "", nil)
	if rec.Code != http.StatusNotImplemented || decodeErr(t, rec).Error.Code != CodeNotImplemented {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, http.MethodGet, "/api/v1/broker/login", "", nil)
	if rec.Code != http.StatusUnprocessableEntity || decodeErr(t, rec).Error.Code != "BROKER_DISABLED" {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// SEC-14
func TestProtectedRoutesFailClosedWithDenyAll(t *testing.T) {
	d := testDeps(&bytes.Buffer{})
	d.Auth = nil // default must be deny-all
	h := NewRouter(d)
	for _, p := range []string{"/api/v1/readyz", "/api/v1/stocks/TCS", "/api/v1/portfolio/summary"} {
		rec := do(h, http.MethodGet, p, "", nil)
		if rec.Code != 401 || decodeErr(t, rec).Error.Code != CodeUnauthenticated {
			t.Fatalf("%s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	// Public routes stay reachable.
	if rec := do(h, http.MethodPost, "/api/v1/auth/login", `{}`, nil); rec.Code != http.StatusNotImplemented {
		t.Fatalf("login stub: %d", rec.Code)
	}
}

// SYS-01: a cold database gets exactly one retry with a backoff before readyz fails.
func TestReadyzRetriesOnce(t *testing.T) {
	cases := []struct {
		name     string
		failures int32
		status   int
		calls    int32
	}{
		{"healthy", 0, 200, 1},
		{"cold start recovers on retry", 1, 200, 2},
		{"still down after one retry", 5, 503, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePinger{failures: tc.failures}
			d := testDeps(&bytes.Buffer{})
			d.Pinger = p
			rec := do(NewRouter(d), http.MethodGet, "/api/v1/readyz", "", nil)
			if rec.Code != tc.status || p.calls.Load() != tc.calls {
				t.Fatalf("status %d (want %d), calls %d (want %d): %s", rec.Code, tc.status, p.calls.Load(), tc.calls, rec.Body.String())
			}
			if tc.status == 503 && decodeErr(t, rec).Error.Code != CodeSourceDown {
				t.Fatalf("body: %s", rec.Body.String())
			}
		})
	}
}

// SEC-10: per-IP login limit answers 429 with Retry-After and the envelope.
func TestLoginRateLimit(t *testing.T) {
	d := testDeps(&bytes.Buffer{})
	d.TrustedProxyHops = 1 // the "other IP" check below needs X-Forwarded-For to be honoured
	h := NewRouter(d)
	for i := 1; i <= 10; i++ {
		if rec := do(h, http.MethodPost, "/api/v1/auth/login", `{}`, nil); rec.Code != http.StatusNotImplemented {
			t.Fatalf("request %d: %d", i, rec.Code)
		}
	}
	rec := do(h, http.MethodPost, "/api/v1/auth/login", `{}`, nil)
	e := decodeErr(t, rec)
	if rec.Code != 429 || e.Error.Code != CodeRateLimited {
		t.Fatalf("11th request: %d %s", rec.Code, rec.Body.String())
	}
	ra := rec.Header().Get("Retry-After")
	if ra == "" || ra == "0" {
		t.Fatalf("Retry-After = %q", ra)
	}
	if e.Error.Details["retry_after_seconds"] == nil {
		t.Fatalf("details = %v", e.Error.Details)
	}
	// A different client address has its own bucket.
	rec = do(h, http.MethodPost, "/api/v1/auth/login", `{}`, map[string]string{"X-Forwarded-For": "203.0.113.9"})
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("other IP: %d", rec.Code)
	}
}

func TestGeneralRateLimitAndLimiterRefill(t *testing.T) {
	d := testDeps(&bytes.Buffer{})
	d.GeneralLimiter = NewLimiter(3)
	h := NewRouter(d)
	for i := 0; i < 3; i++ {
		if rec := do(h, http.MethodGet, "/api/v1/stocks/TCS", "", nil); rec.Code != 501 {
			t.Fatalf("request %d: %d", i, rec.Code)
		}
	}
	if rec := do(h, http.MethodGet, "/api/v1/stocks/TCS", "", nil); rec.Code != 429 {
		t.Fatalf("expected 429, got %d", rec.Code)
	}
	// healthz is never limited.
	if rec := do(h, http.MethodGet, "/healthz", "", nil); rec.Code != 200 {
		t.Fatalf("healthz: %d", rec.Code)
	}

	now := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	l := newLimiter(60, func() time.Time { return now })
	for i := 0; i < 60; i++ {
		if ok, _ := l.Allow("k"); !ok {
			t.Fatalf("token %d denied", i)
		}
	}
	ok, wait := l.Allow("k")
	if ok || wait != 1 {
		t.Fatalf("ok=%v wait=%d", ok, wait)
	}
	now = now.Add(1500 * time.Millisecond)
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("no refill after 1.5 s at 1 token/s")
	}
	if ok, _ := l.Allow("k"); ok {
		t.Fatal("only one token should have refilled")
	}
}

// SEC-13
func TestSecurityHeaders(t *testing.T) {
	h := NewRouter(testDeps(&bytes.Buffer{}))
	for _, p := range []string{"/healthz", "/api/v1/stocks/TCS", "/nope"} {
		rec := do(h, http.MethodGet, p, "", nil)
		for k, want := range map[string]string{
			"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Cache-Control": "no-store",
		} {
			if got := rec.Header().Get(k); got != want {
				t.Errorf("%s %s = %q, want %q", p, k, got, want)
			}
		}
		if !strings.Contains(rec.Header().Get("Strict-Transport-Security"), "max-age=") {
			t.Errorf("%s: missing HSTS", p)
		}
	}
	rec := do(h, http.MethodGet, StocksIndexPath, "", nil)
	if rec.Header().Get("Cache-Control") == "no-store" {
		t.Error("stocks/index must not be forced to no-store")
	}
}

func TestPanicRecoveredAsEnvelope(t *testing.T) {
	var buf bytes.Buffer
	d := testDeps(&buf)
	d.Pinger = nil
	h := RequestID(d.Log)(Recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom secret-detail") })))
	rec := do(h, http.MethodGet, "/", "", nil)
	if rec.Code != 500 || decodeErr(t, rec).Error.Code != CodeInternal || strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(buf.String(), "panic recovered") {
		t.Fatalf("panic not logged: %s", buf.String())
	}
}

func TestRequestIDAndAccessLog(t *testing.T) {
	var buf bytes.Buffer
	h := NewRouter(testDeps(&buf))
	rec := do(h, http.MethodGet, "/api/v1/stocks/TCS?token=querysecret", "", map[string]string{"X-Request-Id": "req-12345678", "Cookie": "session=cookiesecret"})
	if rec.Header().Get("X-Request-Id") != "req-12345678" {
		t.Fatalf("request id = %q", rec.Header().Get("X-Request-Id"))
	}
	rec = do(h, http.MethodGet, "/healthz", "", map[string]string{"X-Request-Id": "bad id with spaces!"})
	if id := rec.Header().Get("X-Request-Id"); len(id) != 24 {
		t.Fatalf("generated id = %q", id)
	}
	log := buf.String()
	if !strings.Contains(log, `"request_id":"req-12345678"`) || !strings.Contains(log, `"path":"/api/v1/stocks/TCS"`) {
		t.Fatalf("log: %s", log)
	}
	for _, leak := range []string{"querysecret", "cookiesecret"} {
		if strings.Contains(log, leak) {
			t.Fatalf("access log leaked %q: %s", leak, log)
		}
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.5:1234"
	if ClientIP(r) != "10.0.0.5" {
		t.Fatalf("peer: %s", ClientIP(r))
	}
	// SEC-10: hops 0 (default) ignores a forged X-Forwarded-For.
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.7")
	if got := ResolveClientIP(r, 0); got != "10.0.0.5" {
		t.Fatalf("hops 0 must ignore xff: %s", got)
	}
	if got := ResolveClientIP(r, 1); got != "203.0.113.7" {
		t.Fatalf("hops 1: %s", got)
	}
	r.Header.Set("X-Forwarded-For", "9.9.9.9, 1.2.3.4, 203.0.113.7")
	if got := ResolveClientIP(r, 2); got != "1.2.3.4" {
		t.Fatalf("hops 2: %s", got)
	}
	if got := ResolveClientIP(r, 4); got != "10.0.0.5" {
		t.Fatalf("header shorter than hops: %s", got)
	}
	r.Header.Set("X-Forwarded-For", "not-an-ip")
	if got := ResolveClientIP(r, 1); got != "10.0.0.5" {
		t.Fatalf("garbage xff: %s", got)
	}

	// Through the router: rotating the header must not mint new login buckets at hops 0.
	d := testDeps(&bytes.Buffer{})
	h := NewRouter(d)
	var last int
	for i := 1; i <= 11; i++ {
		last = do(h, http.MethodPost, "/api/v1/auth/login", `{}`, map[string]string{"X-Forwarded-For": "203.0.113." + strconv.Itoa(i)}).Code
	}
	if last != 429 {
		t.Fatalf("rotating X-Forwarded-For dodged the limiter: %d", last)
	}
}

func TestFailureGate(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	g := newFailureGate(3, time.Minute, 4*time.Minute, func() time.Time { return now })
	for i := 0; i < 2; i++ {
		g.Fail("k")
	}
	if b, _ := g.Blocked("k"); b {
		t.Fatal("blocked before threshold")
	}
	g.Fail("k")
	if b, w := g.Blocked("k"); !b || w != 60 {
		t.Fatalf("block 1: %v %d", b, w)
	}
	now = now.Add(61 * time.Second)
	for i := 0; i < 3; i++ {
		g.Fail("k")
	}
	if b, w := g.Blocked("k"); !b || w != 120 {
		t.Fatalf("block 2 should double: %v %d", b, w)
	}
	g.Fail("k") // during a block: does not extend it
	if _, w := g.Blocked("k"); w != 120 {
		t.Fatalf("extended during block: %d", w)
	}
	now = now.Add(121 * time.Second)
	g.Reset("k")
	if b, _ := g.Blocked("k"); b {
		t.Fatal("reset must clear")
	}
}

func TestRoutesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, rt := range routes {
		k := rt.Method + " " + rt.Path
		if seen[k] {
			t.Fatalf("duplicate route %s", k)
		}
		seen[k] = true
	}
	n := 0
	_ = chi.Walk(NewRouter(testDeps(&bytes.Buffer{})), func(string, string, http.Handler, ...func(http.Handler) http.Handler) error { n++; return nil })
	if n != len(routes)+1 { // + root /healthz alias
		t.Fatalf("router has %d routes, table has %d", n, len(routes))
	}
}
