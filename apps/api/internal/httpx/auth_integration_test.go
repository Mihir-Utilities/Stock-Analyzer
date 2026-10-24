package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/auth"
	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/passhash"
	"github.com/india-analyzer/api/internal/testdb"
)

const (
	ownerPassword = "correct horse battery staple"
	otherPassword = "a different long passphrase"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type authEnv struct {
	t      *testing.T
	pool   *pgxpool.Pool
	q      *dbq.Queries
	svc    *auth.Service
	h      http.Handler
	clk    *clock
	logs   *bytes.Buffer
	delays []time.Duration
	deps   Deps
}

func newAuthEnv(t *testing.T) *authEnv {
	t.Helper()
	dsn := testdb.New(t)
	if err := testdb.Migrate(testdb.OpenSQL(t, dsn), testdb.MigrationsDir()); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	hash, err := passhash.Hash(ownerPassword)
	if err != nil {
		t.Fatal(err)
	}
	q := dbq.New(pool)
	if _, err := q.InsertAppUser(context.Background(), hash); err != nil {
		t.Fatal(err)
	}
	e := &authEnv{t: t, pool: pool, q: q, logs: &bytes.Buffer{}, clk: &clock{t: time.Now().UTC().Truncate(time.Second)}}
	log := zerolog.New(e.logs)
	e.svc = auth.New(pool, auth.Config{SessionDays: 30, MaxFails: 5}, log)
	e.svc.Now = e.clk.now
	e.svc.Sleep = func(_ context.Context, d time.Duration) { e.delays = append(e.delays, d) }
	// Generous login limiter: tests that exercise the lockout must not trip SEC-10 from one address.
	e.deps = Deps{Log: log, Accounts: e.svc, Pinger: &fakePinger{}, LoginLimiter: NewLimiter(1000)}
	e.rebuild()
	return e
}

func (e *authEnv) rebuild() { e.h = NewRouter(e.deps) }

type resp struct {
	*httptest.ResponseRecorder
}

func (r resp) cookie(name string) *http.Cookie {
	for _, c := range r.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func (e *authEnv) do(method, path, body string, cookie string, hdr map[string]string) resp {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if method != http.MethodGet {
		req.Header.Set(CSRFHeader, CSRFValue)
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Add("Cookie", SessionCookie+"="+cookie)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return resp{rec}
}

func pw(p string) string { b, _ := json.Marshal(map[string]string{"password": p}); return string(b) }

// login returns the raw session token.
func (e *authEnv) login(p string) string {
	e.t.Helper()
	rec := e.do(http.MethodPost, "/api/v1/auth/login", pw(p), "", nil)
	if rec.Code != 200 {
		e.t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	c := rec.cookie(SessionCookie)
	if c == nil || c.Value == "" {
		e.t.Fatal("no session cookie")
	}
	return c.Value
}

func (e *authEnv) user() dbq.AppUser {
	e.t.Helper()
	u, err := e.q.GetAppUser(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	return u
}

func (e *authEnv) code(method, path, body, cookie string) int {
	return e.do(method, path, body, cookie, nil).Code
}

// SEC-01: lockout with doubling delay, identical messages, random 300-800 ms delay.
func TestLoginLockoutAndDelay(t *testing.T) {
	e := newAuthEnv(t)
	var firstBody string
	for i := 1; i <= 5; i++ {
		rec := e.do(http.MethodPost, "/api/v1/auth/login", pw("wrong password "+string(rune('a'+i))), "", nil)
		if rec.Code != 401 {
			t.Fatalf("attempt %d: %d", i, rec.Code)
		}
		e1 := decodeErr(t, rec.ResponseRecorder)
		if e1.Error.Code != CodeUnauthenticated || e1.Error.Message != "Invalid credentials or temporarily locked" {
			t.Fatalf("attempt %d: %+v", i, e1)
		}
		if firstBody == "" {
			firstBody = rec.Body.String()
		} else if rec.Body.String() != firstBody {
			t.Fatalf("response differs between attempts:\n%s\n%s", firstBody, rec.Body.String())
		}
	}
	if len(e.delays) != 5 {
		t.Fatalf("delays = %d, want one per failure", len(e.delays))
	}
	u := e.user()
	if u.FailedLogins != 5 || !u.LockedUntil.Valid {
		t.Fatalf("after 5 failures: failed=%d locked=%v", u.FailedLogins, u.LockedUntil)
	}
	if got := u.LockedUntil.Time.Sub(e.clk.now()); got != 15*time.Minute {
		t.Fatalf("first lockout = %v, want 15m", got)
	}

	// While locked the correct password is refused with the identical response, the counter does
	// not move, and the delay still applies.
	rec := e.do(http.MethodPost, "/api/v1/auth/login", pw(ownerPassword), "", nil)
	if rec.Code != 401 || rec.Body.String() != firstBody {
		t.Fatalf("locked login: %d %s", rec.Code, rec.Body.String())
	}
	if rec.cookie(SessionCookie) != nil {
		t.Fatal("locked login must not set a cookie")
	}
	if e.user().FailedLogins != 5 || len(e.delays) != 6 {
		t.Fatalf("locked attempt changed state: failed=%d delays=%d", e.user().FailedLogins, len(e.delays))
	}
	for _, d := range e.delays {
		if d < 300*time.Millisecond || d > 800*time.Millisecond {
			t.Fatalf("delay %v outside 300-800 ms", d)
		}
	}

	// After the lock expires, five more failures lock for 30 minutes (doubling).
	e.clk.add(15*time.Minute + time.Second)
	for i := 0; i < 5; i++ {
		e.do(http.MethodPost, "/api/v1/auth/login", pw("still wrong password"), "", nil)
	}
	u = e.user()
	if u.FailedLogins != 10 {
		t.Fatalf("failed = %d, want 10", u.FailedLogins)
	}
	if got := u.LockedUntil.Time.Sub(e.clk.now()); got != 30*time.Minute {
		t.Fatalf("second lockout = %v, want 30m", got)
	}

	// A successful login after the lock resets the counter.
	e.clk.add(31 * time.Minute)
	e.login(ownerPassword)
	u = e.user()
	if u.FailedLogins != 0 || u.LockedUntil.Valid {
		t.Fatalf("not reset: failed=%d locked=%v", u.FailedLogins, u.LockedUntil)
	}
	if strings.Contains(e.logs.String(), ownerPassword) || strings.Contains(e.logs.String(), "still wrong password") {
		t.Fatal("log output contains a password")
	}
}

// Login input validation: 1..200 chars, strict JSON.
func TestLoginValidation(t *testing.T) {
	e := newAuthEnv(t)
	for name, body := range map[string]string{
		"empty":    pw(""),
		"too long": pw(strings.Repeat("x", 201)),
	} {
		if rec := e.do(http.MethodPost, "/api/v1/auth/login", body, "", nil); rec.Code != 422 {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	if rec := e.do(http.MethodPost, "/api/v1/auth/login", `{"password":"x","extra":1}`, "", nil); rec.Code != 400 {
		t.Errorf("unknown field: %d", rec.Code)
	}
	if e.user().FailedLogins != 0 {
		t.Error("validation errors must not count as failed logins")
	}
}

// SEC-02: cookie flags, hashed tokens, revocation on password change.
func TestSessionCookieHashedTokenAndRevocation(t *testing.T) {
	e := newAuthEnv(t)
	rec := e.do(http.MethodPost, "/api/v1/auth/login", pw(ownerPassword), "", nil)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	c := rec.cookie(SessionCookie)
	if c == nil || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" {
		t.Fatalf("cookie flags: %+v", c)
	}
	if got := c.Expires.Sub(e.clk.now()); got < 29*24*time.Hour || got > 31*24*time.Hour {
		t.Fatalf("cookie expiry %v, want about SESSION_DAYS", got)
	}
	if strings.Contains(rec.Body.String(), c.Value) {
		t.Fatal("token leaked into the response body")
	}

	// Only the sha256 of the token is stored.
	row, err := e.q.GetSessionByHash(context.Background(), auth.HashToken(c.Value))
	if err != nil {
		t.Fatalf("hash lookup: %v", err)
	}
	var raw int
	if err := e.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session WHERE token_hash = convert_to($1,'UTF8') OR encode(token_hash,'escape') LIKE '%'||$1||'%'`, c.Value).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != 0 || row.ID == 0 {
		t.Fatal("raw token found in the session table")
	}

	// Three sessions; change the password from the first; only it survives.
	t1, t2, t3 := c.Value, e.login(ownerPassword), e.login(ownerPassword)
	body := `{"current":"` + ownerPassword + `","new":"` + otherPassword + `"}`
	if rec := e.do(http.MethodPost, "/api/v1/auth/change-password", body, t1, nil); rec.Code != 200 {
		t.Fatalf("change-password: %d %s", rec.Code, rec.Body.String())
	}
	if e.code(http.MethodGet, "/api/v1/auth/me", "", t1) != 200 {
		t.Fatal("current session must survive a password change")
	}
	for i, tok := range []string{t2, t3} {
		if got := e.code(http.MethodGet, "/api/v1/auth/me", "", tok); got != 401 {
			t.Fatalf("other session %d still valid: %d", i, got)
		}
	}
	// The new password works, the old one does not.
	if rec := e.do(http.MethodPost, "/api/v1/auth/login", pw(ownerPassword), "", nil); rec.Code != 401 {
		t.Fatalf("old password accepted: %d", rec.Code)
	}
	e.login(otherPassword)
	if err := passhash.Validate(e.user().PasswordHash); err != nil {
		t.Fatalf("stored hash is not argon2id: %v", err)
	}
	for _, secret := range []string{ownerPassword, otherPassword, t1, t2, t3} {
		if strings.Contains(e.logs.String(), secret) {
			t.Fatal("log output contains a secret")
		}
	}
}

// Logout revokes the current session only and clears the cookie; logout-all revokes everything.
func TestLogoutAndLogoutAll(t *testing.T) {
	e := newAuthEnv(t)
	a, b := e.login(ownerPassword), e.login(ownerPassword)
	rec := e.do(http.MethodPost, "/api/v1/auth/logout", "", a, nil)
	if rec.Code != 200 {
		t.Fatalf("logout: %d", rec.Code)
	}
	if c := rec.cookie(SessionCookie); c == nil || c.MaxAge >= 0 || c.Value != "" {
		t.Fatalf("cookie not cleared: %+v", c)
	}
	if e.code(http.MethodGet, "/api/v1/auth/me", "", a) != 401 || e.code(http.MethodGet, "/api/v1/auth/me", "", b) != 200 {
		t.Fatal("logout must revoke only the current session")
	}
	c := e.login(ownerPassword)
	rec = e.do(http.MethodPost, "/api/v1/auth/logout-all", "", b, nil)
	if rec.Code != 200 || rec.cookie(SessionCookie) == nil {
		t.Fatalf("logout-all: %d", rec.Code)
	}
	if e.code(http.MethodGet, "/api/v1/auth/me", "", b) != 401 || e.code(http.MethodGet, "/api/v1/auth/me", "", c) != 401 {
		t.Fatal("logout-all must revoke every session")
	}
}

func TestMe(t *testing.T) {
	e := newAuthEnv(t)
	tok := e.login(ownerPassword)
	rec := e.do(http.MethodGet, "/api/v1/auth/me", "", tok, nil)
	var out struct {
		Data struct {
			Authenticated  bool           `json:"authenticated"`
			TelegramLinked bool           `json:"telegram_linked"`
			Prefs          map[string]any `json:"prefs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if !out.Data.Authenticated || out.Data.TelegramLinked || out.Data.Prefs["theme"] != "dark" {
		t.Fatalf("me = %+v", out.Data)
	}
	if _, err := e.pool.Exec(context.Background(), `UPDATE app_user SET telegram_chat_id = 42`); err != nil {
		t.Fatal(err)
	}
	rec = e.do(http.MethodGet, "/api/v1/auth/me", "", tok, nil)
	if !strings.Contains(rec.Body.String(), `"telegram_linked":true`) {
		t.Fatalf("telegram_linked not true: %s", rec.Body.String())
	}
}

// SEC-12 at the API: policy errors are 422 with details.fields and never change the password.
func TestChangePasswordPolicy(t *testing.T) {
	e := newAuthEnv(t)
	tok := e.login(ownerPassword)
	before := e.user().PasswordHash
	cases := []struct{ name, body, field string }{
		{"too short", `{"current":"` + ownerPassword + `","new":"short"}`, "new"},
		{"11 chars", `{"current":"` + ownerPassword + `","new":"abcdefghijk"}`, "new"},
		{"same as current", `{"current":"` + ownerPassword + `","new":"` + ownerPassword + `"}`, "new"},
		{"wrong current", `{"current":"not the password","new":"` + otherPassword + `"}`, "current"},
		{"missing current", `{"current":"","new":"` + otherPassword + `"}`, "current"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := e.do(http.MethodPost, "/api/v1/auth/change-password", tc.body, tok, nil)
			er := decodeErr(t, rec.ResponseRecorder)
			if rec.Code != 422 || er.Error.Code != CodeUnprocessable {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			fields, _ := er.Error.Details["fields"].([]any)
			if len(fields) != 1 || fields[0].(map[string]any)["field"] != tc.field {
				t.Fatalf("fields = %v", er.Error.Details)
			}
		})
	}
	if e.user().PasswordHash != before {
		t.Fatal("a rejected change altered the password hash")
	}
	if e.code(http.MethodPost, "/api/v1/auth/change-password", `{"current":"x","new":"`+otherPassword+`"}`, "") != 401 {
		t.Fatal("change-password needs a session")
	}
}

// SEC-03: every non-GET request needs X-Requested-With: fetch; GET does not; the Telegram webhook
// (authenticated by its own secret header in B12) is exempt.
func TestCSRFHeader(t *testing.T) {
	e := newAuthEnv(t)
	tok := e.login(ownerPassword)
	nonGet := []struct{ method, path string }{
		{http.MethodPost, "/api/v1/auth/login"},
		{http.MethodPost, "/api/v1/auth/logout"},
		{http.MethodPost, "/api/v1/auth/logout-all"},
		{http.MethodPost, "/api/v1/auth/change-password"},
		{http.MethodPost, "/api/v1/watchlist"},
		{http.MethodPatch, "/api/v1/watchlist/1"},
		{http.MethodPut, "/api/v1/settings/prices-adjustment"},
		{http.MethodDelete, "/api/v1/watchlist/1"},
	}
	for _, tc := range nonGet {
		for name, hdr := range map[string]map[string]string{
			"missing": {CSRFHeader: ""},
			"wrong":   {CSRFHeader: "XMLHttpRequest"},
		} {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(pw(ownerPassword)))
			req.Header.Add("Cookie", SessionCookie+"="+tok)
			for k, v := range hdr {
				if v != "" {
					req.Header.Set(k, v)
				}
			}
			rec := httptest.NewRecorder()
			e.h.ServeHTTP(rec, req)
			if rec.Code != 403 || decodeErr(t, rec).Error.Code != CodeForbidden {
				t.Errorf("%s %s (%s header): %d %s", tc.method, tc.path, name, rec.Code, rec.Body.String())
			}
		}
	}
	// A rejected login attempt must not have been evaluated (no failure counted, no session).
	if e.user().FailedLogins != 0 {
		t.Error("CSRF-rejected login counted as a failure")
	}
	// Still alive: the missing header did not log the user out.
	if e.code(http.MethodGet, "/api/v1/auth/me", "", tok) != 200 {
		t.Fatal("session should survive rejected requests")
	}
	// Exempt: GET without header; webhook POST without header reaches its (stub) handler.
	if rec := e.do(http.MethodPost, "/api/v1/telegram/webhook", "{}", "", map[string]string{CSRFHeader: ""}); rec.Code == 403 {
		t.Fatalf("telegram webhook must not require the CSRF header: %d", rec.Code)
	}
}

// SEC-09: every protected route answers 401 without a valid session; public routes stay open.
func TestUnauthenticatedAccess(t *testing.T) {
	e := newAuthEnv(t)
	valid := e.login(ownerPassword)
	revoked := e.login(ownerPassword)
	e.do(http.MethodPost, "/api/v1/auth/logout", "", revoked, nil)
	expired := e.login(ownerPassword)
	if _, err := e.pool.Exec(context.Background(), `UPDATE session SET expires_at = $1 WHERE token_hash = $2`,
		e.clk.now().Add(-time.Minute), auth.HashToken(expired)); err != nil {
		t.Fatal(err)
	}

	protected := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/auth/me"},
		{http.MethodPost, "/api/v1/auth/logout"},
		{http.MethodPost, "/api/v1/auth/logout-all"},
		{http.MethodPost, "/api/v1/auth/change-password"},
		{http.MethodGet, "/api/v1/readyz"},
		{http.MethodGet, "/api/v1/admin/status"},
		{http.MethodGet, "/api/v1/stocks/TCS"},
		{http.MethodGet, "/api/v1/portfolio/summary"},
		{http.MethodPost, "/api/v1/imports/prices/validate"},
		{http.MethodGet, "/api/v1/broker/status"},
		{http.MethodDelete, "/api/v1/broker/session"},
	}
	for _, tc := range protected {
		for name, cookie := range map[string]string{"no cookie": "", "garbage": "not-a-token", "revoked": revoked, "expired": expired} {
			rec := e.do(tc.method, tc.path, "{}", cookie, nil)
			if rec.Code != 401 || decodeErr(t, rec.ResponseRecorder).Error.Code != CodeUnauthenticated {
				t.Errorf("%s %s (%s): %d %s", tc.method, tc.path, name, rec.Code, rec.Body.String())
			}
		}
	}
	// A valid session passes the gate (the stub answers 501, not 401).
	if got := e.code(http.MethodGet, "/api/v1/stocks/TCS", "", valid); got != http.StatusNotImplemented {
		t.Fatalf("valid session: %d", got)
	}
	// Public routes.
	if e.code(http.MethodGet, "/healthz", "", "") != 200 || e.code(http.MethodGet, "/api/v1/healthz", "", "") != 200 {
		t.Fatal("healthz must be public")
	}
	if got := e.code(http.MethodGet, "/api/v1/broker/callback", "", ""); got == 401 {
		t.Fatal("broker callback must be public")
	}
	if got := e.code(http.MethodPost, "/api/v1/telegram/webhook", "{}", ""); got == 401 {
		t.Fatal("telegram webhook must be public")
	}
}

// Sliding expiry: last_seen_at / expires_at move at most once per hour.
func TestSlidingExpiryAtMostHourly(t *testing.T) {
	e := newAuthEnv(t)
	tok := e.login(ownerPassword)
	read := func() (seen, exp time.Time) {
		row, err := e.q.GetSessionByHash(context.Background(), auth.HashToken(tok))
		if err != nil {
			t.Fatal(err)
		}
		return row.LastSeenAt.Time, row.ExpiresAt.Time
	}
	// created_at/last_seen_at come from the database clock (now()); align our clock with it.
	seen0, exp0 := read()
	e.clk.t = seen0
	e.clk.add(30 * time.Minute)
	if e.code(http.MethodGet, "/api/v1/auth/me", "", tok) != 200 {
		t.Fatal("expected 200")
	}
	seen1, exp1 := read()
	if !seen1.Equal(seen0) || !exp1.Equal(exp0) {
		t.Fatalf("touched within the hour: seen %v->%v exp %v->%v", seen0, seen1, exp0, exp1)
	}
	e.clk.add(31 * time.Minute) // 61 minutes after the last touch
	if e.code(http.MethodGet, "/api/v1/auth/me", "", tok) != 200 {
		t.Fatal("expected 200")
	}
	seen2, exp2 := read()
	if !seen2.Equal(e.clk.now()) || !exp2.Equal(e.clk.now().Add(30*24*time.Hour)) {
		t.Fatalf("not extended after an hour: seen %v exp %v (now %v)", seen2, exp2, e.clk.now())
	}
	// Past expiry the session is dead.
	e.clk.add(31 * 24 * time.Hour)
	if e.code(http.MethodGet, "/api/v1/auth/me", "", tok) != 401 {
		t.Fatal("expired session accepted")
	}
}

// SEC-10: the real login route is limited to 10 per minute per IP (429 + Retry-After).
func TestLoginRateLimitWithRealService(t *testing.T) {
	e := newAuthEnv(t)
	e.deps.LoginLimiter = nil // default 10/min
	e.rebuild()
	for i := 1; i <= 10; i++ {
		if got := e.code(http.MethodPost, "/api/v1/auth/login", pw("nope nope nope"), ""); got != 401 {
			t.Fatalf("request %d: %d", i, got)
		}
	}
	rec := e.do(http.MethodPost, "/api/v1/auth/login", pw(ownerPassword), "", nil)
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" || decodeErr(t, rec.ResponseRecorder).Error.Code != CodeRateLimited {
		t.Fatalf("11th request: %d %s", rec.Code, rec.Body.String())
	}
}

// SEC-02: a sliding extension re-issues the cookie so the browser keeps it as long as the row.
func TestSlidingExpiryReissuesCookie(t *testing.T) {
	e := newAuthEnv(t)
	tok := e.login(ownerPassword)
	row, err := e.q.GetSessionByHash(context.Background(), auth.HashToken(tok))
	if err != nil {
		t.Fatal(err)
	}
	e.clk.t = row.LastSeenAt.Time.UTC()
	e.clk.add(30 * time.Minute)
	if rec := e.do(http.MethodGet, "/api/v1/auth/me", "", tok, nil); rec.Code != 200 || rec.cookie(SessionCookie) != nil {
		t.Fatalf("within the hour must not re-issue: %d", rec.Code)
	}
	e.clk.add(29 * 24 * time.Hour)
	rec := e.do(http.MethodGet, "/api/v1/auth/me", "", tok, nil)
	c := rec.cookie(SessionCookie)
	if rec.Code != 200 || c == nil || c.Value != tok || !c.HttpOnly || !c.Secure {
		t.Fatalf("cookie not re-issued after sliding: %d %+v", rec.Code, c)
	}
	want := e.clk.now().Add(30 * 24 * time.Hour)
	if d := c.Expires.Sub(want); d < -2*time.Second || d > 2*time.Second {
		t.Fatalf("new cookie expiry %v, want %v", c.Expires, want)
	}
}

// SEC-02/N5: after change-password every other session fails (also asserted with revoked_at set).
func TestRevokedSessionFailsAfterChangePassword(t *testing.T) {
	e := newAuthEnv(t)
	keep, other := e.login(ownerPassword), e.login(ownerPassword)
	body := `{"current":"` + ownerPassword + `","new":"` + otherPassword + `"}`
	if rec := e.do(http.MethodPost, "/api/v1/auth/change-password", body, keep, nil); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	row, err := e.q.GetSessionByHash(context.Background(), auth.HashToken(other))
	if err != nil || !row.RevokedAt.Valid {
		t.Fatalf("other session not revoked: %v %+v", err, row.RevokedAt)
	}
	if e.code(http.MethodGet, "/api/v1/auth/me", "", other) != 401 || e.code(http.MethodGet, "/api/v1/auth/me", "", keep) != 200 {
		t.Fatal("revoked session must fail, current must survive")
	}
}

// Wrong current passwords are throttled (429 + Retry-After) without touching the login lockout.
func TestChangePasswordFailureThrottle(t *testing.T) {
	e := newAuthEnv(t)
	tok, tok2 := e.login(ownerPassword), e.login(ownerPassword)
	bad := `{"current":"not the password","new":"` + otherPassword + `"}`
	for i := 1; i <= 5; i++ {
		if got := e.code(http.MethodPost, "/api/v1/auth/change-password", bad, tok); got != 422 {
			t.Fatalf("guess %d: %d", i, got)
		}
	}
	good := `{"current":"` + ownerPassword + `","new":"` + otherPassword + `"}`
	rec := e.do(http.MethodPost, "/api/v1/auth/change-password", good, tok, nil)
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" || decodeErr(t, rec.ResponseRecorder).Error.Code != CodeRateLimited {
		t.Fatalf("6th attempt must be blocked even with the right password: %d %s", rec.Code, rec.Body.String())
	}
	// The per-IP gate also blocks a second session from the same address.
	if got := e.code(http.MethodPost, "/api/v1/auth/change-password", good, tok2); got != 429 {
		t.Fatalf("other session from same IP: %d", got)
	}
	u := e.user()
	if u.FailedLogins != 0 || u.LockedUntil.Valid {
		t.Fatalf("change-password failures must not count toward login lockout: %d %v", u.FailedLogins, u.LockedUntil)
	}
	e.login(ownerPassword) // login unaffected; password unchanged
}

// SEC-01: the 24 h cap, locked_until stable during a lock, and constant work while locked.
func TestLockoutCapAndStableLock(t *testing.T) {
	e := newAuthEnv(t)
	// 39 prior failures = lock 7 was the last; the next failure is the 40th -> lock 8 = 32 h -> capped.
	if _, err := e.pool.Exec(context.Background(), `UPDATE app_user SET failed_logins = 39 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	e.do(http.MethodPost, "/api/v1/auth/login", pw("wrong again"), "", nil)
	u := e.user()
	if u.FailedLogins != 40 || !u.LockedUntil.Valid {
		t.Fatalf("failed=%d locked=%v", u.FailedLogins, u.LockedUntil)
	}
	if got := u.LockedUntil.Time.Sub(e.clk.now()); got != 24*time.Hour {
		t.Fatalf("lock = %v, want the 24h cap", got)
	}
	// Attempts during the lock (right or wrong) leave counter and locked_until untouched.
	for i := 0; i < 3; i++ {
		e.do(http.MethodPost, "/api/v1/auth/login", pw("wrong during lock"), "", nil)
		e.do(http.MethodPost, "/api/v1/auth/login", pw(ownerPassword), "", nil)
	}
	u2 := e.user()
	if u2.FailedLogins != 40 || !u2.LockedUntil.Time.Equal(u.LockedUntil.Time) {
		t.Fatalf("lock changed: failed=%d until %v -> %v", u2.FailedLogins, u.LockedUntil.Time, u2.LockedUntil.Time)
	}
}

// N1: a locked attempt does the same argon2 work as an unlocked failure (timing hides the lock).
func TestLockedAttemptCostsAVerification(t *testing.T) {
	e := newAuthEnv(t)
	start := time.Now()
	e.do(http.MethodPost, "/api/v1/auth/login", pw("wrong one"), "", nil)
	unlocked := time.Since(start)
	if _, err := e.pool.Exec(context.Background(), `UPDATE app_user SET locked_until = now() + interval '1 hour' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	e.clk.t = time.Now().UTC()
	start = time.Now()
	e.do(http.MethodPost, "/api/v1/auth/login", pw("wrong two"), "", nil)
	locked := time.Since(start)
	if locked < unlocked/2 {
		t.Fatalf("locked attempt too cheap: %v vs %v", locked, unlocked)
	}
}

// S4: parallel guesses are serialised on the owner row; once the threshold is hit no further
// guess is verified (exactly MaxFails verifications), and the lock is in place afterwards.
func TestConcurrentLoginsRespectLockout(t *testing.T) {
	e := newAuthEnv(t)
	var verifies atomic.Int32
	e.svc.OnVerify = func() { verifies.Add(1) }
	e.svc.Sleep = func(context.Context, time.Duration) {} // e.delays is not goroutine safe
	var wg sync.WaitGroup
	var created atomic.Int32
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := e.do(http.MethodPost, "/api/v1/auth/login", pw("wrong guess "+strconv.Itoa(i)), "", nil)
			if rec.Code == 200 {
				created.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if v := verifies.Load(); v != 5 {
		t.Fatalf("verifications that counted = %d, want exactly MaxFails=5", v)
	}
	u := e.user()
	if u.FailedLogins != 5 || !u.LockedUntil.Valid || created.Load() != 0 {
		t.Fatalf("failed=%d locked=%v created=%d", u.FailedLogins, u.LockedUntil, created.Load())
	}
}

// SEC-14 (updated): with the real checker, a request before login is denied, and without any
// checker configured everything protected stays closed.
func TestFailClosedWithoutAccounts(t *testing.T) {
	h := NewRouter(Deps{Log: zerolog.Nop()})
	if rec := do(h, http.MethodGet, "/api/v1/auth/me", "", nil); rec.Code != 401 {
		t.Fatalf("me without service: %d", rec.Code)
	}
	if rec := do(h, http.MethodPost, "/api/v1/auth/login", pw("x"), nil); rec.Code != http.StatusNotImplemented {
		t.Fatalf("login without service: %d", rec.Code)
	}
}
