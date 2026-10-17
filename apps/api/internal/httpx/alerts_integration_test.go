package httpx

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/alerts"
	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/testdb"
)

const (
	alrSecret   = "webhook-secret-for-tests-0123456789"
	alrBotToken = "999999:BOT-TOKEN-MUST-NOT-LEAK"
)

type alrSent struct {
	chat int64
	text string
}

type alrFakeSender struct {
	mu   sync.Mutex
	sent []alrSent
	fail error
}

func (f *alrFakeSender) SendMessage(_ context.Context, chatID int64, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return f.fail
	}
	f.sent = append(f.sent, alrSent{chatID, text})
	return nil
}

func (f *alrFakeSender) messages() []alrSent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]alrSent(nil), f.sent...)
}

type alrEnv struct {
	t      *testing.T
	pool   *pgxpool.Pool
	q      *dbq.Queries
	svc    *alerts.Service
	h      http.Handler
	sender *alrFakeSender
	logs   *bytes.Buffer
	now    time.Time
	mu     sync.Mutex
}

func newAlrEnv(t *testing.T) *alrEnv {
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
	e := &alrEnv{t: t, pool: pool, q: dbq.New(pool), sender: &alrFakeSender{}, logs: &bytes.Buffer{},
		now: time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)}
	if _, err := e.q.InsertAppUser(context.Background(), "hash"); err != nil {
		t.Fatal(err)
	}
	log := zerolog.New(e.logs)
	e.svc = alerts.New(pool, log)
	e.svc.Sender = e.sender
	e.svc.BotUsername = "AnalyzerTestBot"
	e.svc.Now = func() time.Time { e.mu.Lock(); defer e.mu.Unlock(); return e.now }
	e.h = NewRouter(Deps{
		Log: log, Auth: allowAll{}, Pinger: &fakePinger{},
		Alerts: AlertsDeps{Svc: e.svc, WebhookSecret: alrSecret, BotUsername: "AnalyzerTestBot"},
	})
	return e
}

func (e *alrEnv) advance(d time.Duration) { e.mu.Lock(); e.now = e.now.Add(d); e.mu.Unlock() }

func (e *alrEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *alrEnv) addStock(symbol string) int {
	e.t.Helper()
	var id int
	if err := e.pool.QueryRow(context.Background(),
		`INSERT INTO instrument (symbol, name) VALUES ($1, $2) RETURNING id`, symbol, symbol+" Ltd").Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *alrEnv) addBar(id int, date string, close float64) {
	e.t.Helper()
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source)
	        VALUES ($1, $2::date, $3, $3, $3, $3, $3, 'import')`, id, date, close)
}

func (e *alrEnv) call(method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	return do(e.h, method, "/api/v1"+target, body, hdr)
}

func (e *alrEnv) postJSON(target, body string) *httptest.ResponseRecorder {
	return e.call(http.MethodPost, target, body, nil)
}

func (e *alrEnv) webhook(secret string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	hdr := map[string]string{"X-Requested-With": ""} // Telegram sends no CSRF header
	if secret != "" {
		hdr[WebhookSecretHeader] = secret
	}
	return e.call(http.MethodPost, "/telegram/webhook", string(b), hdr)
}

func alrUpdate(chatType string, chat int64, text string) map[string]any {
	return map[string]any{"update_id": 1, "message": map[string]any{"message_id": 1, "text": text, "chat": map[string]any{"id": chat, "type": chatType}}}
}

func (e *alrEnv) chatID() (int64, bool) {
	e.t.Helper()
	v, err := e.q.GetTelegramChat(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	return v.Int64, v.Valid
}

func (e *alrEnv) linkCode() string {
	e.t.Helper()
	rec := e.postJSON("/telegram/link-code", "")
	if rec.Code != http.StatusOK {
		e.t.Fatalf("link-code: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Data alerts.LinkCode `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		e.t.Fatal(err)
	}
	return out.Data.Code
}

func alrData[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", rec.Body, err)
	}
	return out.Data
}

func alertBody(symbol, kind, params string) string {
	return fmt.Sprintf(`{"target":{"type":"stock","symbol":%q},"kind":%q,"params":%s}`, symbol, kind, params)
}

// ALR-01: creating a threshold that is already true at the last imported bar is a 422
// THRESHOLD_ALREADY_MET whose message names the bar date; nothing is stored.
func TestALR01ThresholdAlreadyMet(t *testing.T) {
	e := newAlrEnv(t)
	id := e.addStock("TCS")
	e.addBar(id, "2026-10-08", 90)
	e.addBar(id, "2026-10-09", 100)
	e.addBar(id, "2026-10-10", 5000) // suspect bar: ignored
	e.exec(`UPDATE price_daily SET suspect = true WHERE instrument_id = $1 AND trade_date = '2026-10-10'`, id)

	for _, tc := range []struct{ kind, price string }{
		{"price_above", "100"}, {"price_above", "99.5"}, {"price_below", "100"}, {"price_below", "150"},
	} {
		rec := e.postJSON("/alerts", alertBody("TCS", tc.kind, `{"price":`+tc.price+`}`))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s %s: status %d %s", tc.kind, tc.price, rec.Code, rec.Body)
		}
		er := decodeErr(t, rec)
		if er.Error.Code != "THRESHOLD_ALREADY_MET" || !strings.Contains(er.Error.Message, "last imported bar of 2026-10-09") {
			t.Fatalf("%s %s: %+v", tc.kind, tc.price, er)
		}
		if er.Error.Details["as_of"] != "2026-10-09" {
			t.Fatalf("details %v", er.Error.Details)
		}
	}
	// Not yet true: accepted (201).
	for _, tc := range []struct{ kind, price string }{{"price_above", "100.01"}, {"price_below", "99.99"}} {
		if rec := e.postJSON("/alerts", alertBody("TCS", tc.kind, `{"price":`+tc.price+`}`)); rec.Code != http.StatusCreated {
			t.Fatalf("%s %s: %d %s", tc.kind, tc.price, rec.Code, rec.Body)
		}
	}
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM alert`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("stored alerts = %d (%v), want 2: rejected creations must store nothing", n, err)
	}
	// No bars yet: nothing can be said, so the alert is accepted.
	e.addStock("INFY")
	if rec := e.postJSON("/alerts", alertBody("INFY", "price_above", `{"price":1}`)); rec.Code != http.StatusCreated {
		t.Fatalf("no bars: %d %s", rec.Code, rec.Body)
	}
	// Changing the threshold through PATCH is checked the same way.
	rec := e.call(http.MethodPatch, "/alerts/1", `{"params":{"price":50}}`, nil)
	if rec.Code != http.StatusUnprocessableEntity || decodeErr(t, rec).Error.Code != "THRESHOLD_ALREADY_MET" {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}
}

// ALR-61: the same rule for mutual fund NAV alerts, against the latest imported NAV.
func TestALR61NavThresholdAlreadyMet(t *testing.T) {
	e := newAlrEnv(t)
	e.exec(`INSERT INTO mf_scheme (code, name) VALUES (120503, 'Test Fund')`)
	e.exec(`INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES (120503, '2026-10-09', 50)`)
	body := func(kind, nav string) string {
		return `{"target":{"type":"mf","code":120503},"kind":"` + kind + `","params":{"nav":` + nav + `}}`
	}
	rec := e.postJSON("/alerts", body("nav_above", "49"))
	er := decodeErr(t, rec)
	if rec.Code != 422 || er.Error.Code != "THRESHOLD_ALREADY_MET" || !strings.Contains(er.Error.Message, "NAV of 2026-10-09") {
		t.Fatalf("%d %+v", rec.Code, er)
	}
	if rec := e.postJSON("/alerts", body("nav_above", "51")); rec.Code != http.StatusCreated {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

// ALR-62: create validates shape: unknown target, kind/target mismatch, params, expiry, cooldown.
func TestALR62CreateValidation(t *testing.T) {
	e := newAlrEnv(t)
	e.addStock("TCS")
	e.addStock("M&M")
	cases := []struct {
		name, body  string
		status      int
		code, field string
	}{
		{"unknown symbol", alertBody("NOPE", "wk52_high", `{}`), 404, "NOT_FOUND", ""},
		{"unknown fund", `{"target":{"type":"mf","code":1},"kind":"nav_above","params":{"nav":1}}`, 404, "NOT_FOUND", ""},
		{"nav on stock", alertBody("TCS", "nav_above", `{"nav":1}`), 422, "UNPROCESSABLE", "target.type"},
		{"price on fund", `{"target":{"type":"mf","code":5},"kind":"price_above","params":{"price":1}}`, 422, "UNPROCESSABLE", "target.type"},
		{"bad kind", alertBody("TCS", "teleport", `{}`), 422, "UNPROCESSABLE", "kind"},
		{"bad params", alertBody("TCS", "rsi_above", `{"level":120}`), 422, "UNPROCESSABLE", "params.level"},
		{"unknown param", alertBody("TCS", "wk52_low", `{"a":1}`), 422, "UNPROCESSABLE", "params.a"},
		{"stock without symbol", `{"target":{"type":"stock"},"kind":"wk52_high"}`, 422, "UNPROCESSABLE", "target.symbol"},
		{"expired expiry", `{"target":{"type":"stock","symbol":"TCS"},"kind":"wk52_high","expires_on":"2026-10-11"}`, 422, "UNPROCESSABLE", "expires_on"},
		{"bad date", `{"target":{"type":"stock","symbol":"TCS"},"kind":"wk52_high","expires_on":"31/03/2027"}`, 422, "UNPROCESSABLE", "expires_on"},
		{"negative cooldown", `{"target":{"type":"stock","symbol":"TCS"},"kind":"wk52_high","cooldown_minutes":-1}`, 422, "UNPROCESSABLE", "cooldown_minutes"},
		{"unknown field", `{"target":{"type":"stock","symbol":"TCS"},"kind":"wk52_high","bogus":1}`, 400, "BAD_REQUEST", ""},
		{"not json", `nope`, 400, "BAD_REQUEST", ""},
	}
	for _, tc := range cases {
		rec := e.postJSON("/alerts", tc.body)
		er := decodeErr(t, rec)
		if rec.Code != tc.status || er.Error.Code != tc.code {
			t.Errorf("%s: %d %+v", tc.name, rec.Code, er)
			continue
		}
		if tc.field != "" {
			fs, _ := er.Error.Details["fields"].([]any)
			found := false
			for _, f := range fs {
				if m, ok := f.(map[string]any); ok && m["field"] == tc.field {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: field %s missing in %v", tc.name, tc.field, er.Error.Details)
			}
		}
	}
	// Valid: symbol matched case-insensitively, `M&M` works, expiry today is allowed (today = 12 Oct IST).
	for _, body := range []string{
		alertBody("tcs", "wk52_high", `{}`),
		alertBody("M&M", "day_change_pct", `{"pct":3,"direction":"either"}`),
		`{"target":{"type":"stock","symbol":"TCS"},"kind":"ma_cross","params":{"fast":50,"slow":200,"direction":"golden"},"one_shot":false,"cooldown_minutes":60,"expires_on":"2026-10-12"}`,
	} {
		if rec := e.postJSON("/alerts", body); rec.Code != http.StatusCreated {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body)
		}
	}
	a := alrData[alerts.Alert](t, e.postJSON("/alerts", alertBody("TCS", "rsi_below", `{"level":30}`)))
	if a.Status != "active" || !a.OneShot || a.CooldownMinutes != 1440 || a.Target.Symbol == nil || *a.Target.Symbol != "TCS" || a.ExpiresOn != nil {
		t.Errorf("defaults wrong: %+v", a)
	}
}

// ALR-15: at most 200 active alerts; the 201st is a 409 CONFLICT. Paused alerts do not count and
// resuming into a full set is refused too.
func TestALR15ActiveAlertLimit(t *testing.T) {
	e := newAlrEnv(t)
	id := e.addStock("TCS")
	e.exec(`INSERT INTO alert (target_type, instrument_id, kind, params)
	        SELECT 'stock', $1, 'wk52_high', '{}' FROM generate_series(1, 200)`, id)
	rec := e.postJSON("/alerts", alertBody("TCS", "wk52_low", `{}`))
	if rec.Code != http.StatusConflict || decodeErr(t, rec).Error.Code != "CONFLICT" {
		t.Fatalf("201st alert: %d %s", rec.Code, rec.Body)
	}
	// Pause one: room for exactly one more.
	if rec := e.call(http.MethodPatch, "/alerts/1", `{"status":"paused"}`, nil); rec.Code != 200 {
		t.Fatalf("pause: %d %s", rec.Code, rec.Body)
	}
	if rec := e.postJSON("/alerts", alertBody("TCS", "wk52_low", `{}`)); rec.Code != http.StatusCreated {
		t.Fatalf("after pause: %d %s", rec.Code, rec.Body)
	}
	rec = e.call(http.MethodPatch, "/alerts/1", `{"status":"active"}`, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("resume into a full set: %d %s", rec.Code, rec.Body)
	}
	// Deleting frees a slot again.
	if rec := e.call(http.MethodDelete, "/alerts/2", "", nil); rec.Code != 200 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := e.call(http.MethodPatch, "/alerts/1", `{"status":"active"}`, nil); rec.Code != 200 {
		t.Fatalf("resume: %d %s", rec.Code, rec.Body)
	}
}

// ALR-63: list/filter/patch/delete/history.
func TestALR63CrudAndHistory(t *testing.T) {
	e := newAlrEnv(t)
	e.addStock("TCS")
	for i := 0; i < 3; i++ {
		if rec := e.postJSON("/alerts", alertBody("TCS", "rsi_above", fmt.Sprintf(`{"level":%d}`, 60+i))); rec.Code != 201 {
			t.Fatal(rec.Body)
		}
	}
	// Pagination: newest first, stable cursor.
	page := alrData[alerts.Page[alerts.Alert]](t, e.call(http.MethodGet, "/alerts?limit=2", "", nil))
	if len(page.Items) != 2 || page.Items[0].ID != 3 || page.NextCursor == nil {
		t.Fatalf("page 1: %+v", page)
	}
	page2 := alrData[alerts.Page[alerts.Alert]](t, e.call(http.MethodGet, "/alerts?limit=2&cursor="+*page.NextCursor, "", nil))
	if len(page2.Items) != 1 || page2.Items[0].ID != 1 || page2.NextCursor != nil {
		t.Fatalf("page 2: %+v", page2)
	}
	if rec := e.call(http.MethodGet, "/alerts?limit=0", "", nil); rec.Code != 422 {
		t.Fatalf("limit 0: %d", rec.Code)
	}
	if rec := e.call(http.MethodGet, "/alerts?cursor=garbage", "", nil); rec.Code != 422 {
		t.Fatalf("bad cursor: %d", rec.Code)
	}
	if rec := e.call(http.MethodGet, "/alerts?status=bogus", "", nil); rec.Code != 422 {
		t.Fatalf("bad status: %d", rec.Code)
	}

	// Patch: pause, params change (resets last_state), validation, unknown field.
	e.exec(`UPDATE alert SET last_state = '{"last_bar_date":"2026-10-09"}' WHERE id = 1`)
	a := alrData[alerts.Alert](t, e.call(http.MethodPatch, "/alerts/1", `{"status":"paused","params":{"level":75}}`, nil))
	if a.Status != "paused" || string(a.Params) != `{"level":75}` {
		t.Fatalf("patched: %+v", a)
	}
	var ls *string
	if err := e.pool.QueryRow(context.Background(), `SELECT last_state::text FROM alert WHERE id = 1`).Scan(&ls); err != nil || ls != nil {
		t.Fatalf("last_state after a params change = %v (%v), want NULL", ls, err)
	}
	paused := alrData[alerts.Page[alerts.Alert]](t, e.call(http.MethodGet, "/alerts?status=paused", "", nil))
	if len(paused.Items) != 1 || paused.Items[0].ID != 1 {
		t.Fatalf("paused filter: %+v", paused)
	}
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{}`, 422}, {`{"status":"fired"}`, 422}, {`{"params":{"level":0}}`, 422},
		{`{"status":"active","one_shot":false}`, 400},
	} {
		if rec := e.call(http.MethodPatch, "/alerts/1", tc.body, nil); rec.Code != tc.status {
			t.Errorf("%s: %d %s", tc.body, rec.Code, rec.Body)
		}
	}
	if rec := e.call(http.MethodPatch, "/alerts/99", `{"status":"paused"}`, nil); rec.Code != 404 {
		t.Errorf("missing: %d", rec.Code)
	}
	// Fired and expired alerts are final.
	e.exec(`UPDATE alert SET status = 'fired' WHERE id = 2`)
	if rec := e.call(http.MethodPatch, "/alerts/2", `{"status":"active"}`, nil); rec.Code != 409 {
		t.Errorf("fired alert: %d %s", rec.Code, rec.Body)
	}

	// History with delivery status.
	e.exec(`INSERT INTO alert_event (alert_id, dedupe_key, payload, delivery_status, delivery_attempts, last_error)
	        VALUES (2, 'k1', '{"close":101.5}', 'failed', 5, 'chat not found'),
	               (2, 'k2', '{"close":102.5}', 'pending', 0, NULL)`)
	ev := alrData[alerts.Page[alerts.Event]](t, e.call(http.MethodGet, "/alerts/events?limit=1", "", nil))
	if len(ev.Items) != 1 || ev.Items[0].DeliveryStatus != "pending" || ev.NextCursor == nil || ev.Items[0].Target.Symbol == nil {
		t.Fatalf("events page 1: %+v", ev)
	}
	ev2 := alrData[alerts.Page[alerts.Event]](t, e.call(http.MethodGet, "/alerts/events?limit=1&cursor="+*ev.NextCursor, "", nil))
	if len(ev2.Items) != 1 || ev2.Items[0].DeliveryStatus != "failed" || ev2.Items[0].DeliveryAttempts != 5 ||
		ev2.Items[0].LastError == nil || ev2.Items[0].Kind != "rsi_above" {
		t.Fatalf("events page 2: %+v", ev2)
	}
	empty := alrData[alerts.Page[alerts.Event]](t, newAlrEnv(t).call(http.MethodGet, "/alerts/events", "", nil))
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("empty history must be [] not null: %+v", empty)
	}

	// Delete.
	if rec := e.call(http.MethodDelete, "/alerts/3", "", nil); rec.Code != 200 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := e.call(http.MethodDelete, "/alerts/3", "", nil); rec.Code != 404 {
		t.Fatalf("delete twice: %d", rec.Code)
	}
	if rec := e.call(http.MethodDelete, "/alerts/abc", "", nil); rec.Code != 404 {
		t.Fatalf("delete non-numeric: %d", rec.Code)
	}
}

// ALR-64: a link code is stored only as sha256, lives 15 minutes, and without a configured bot
// the response says so instead of inventing a deep link.
func TestALR64LinkCodeStorage(t *testing.T) {
	e := newAlrEnv(t)
	rec := e.postJSON("/telegram/link-code", "")
	lc := alrData[alerts.LinkCode](t, rec)
	if len(lc.Code) != 9 || lc.BotUsername == nil || *lc.BotUsername != "AnalyzerTestBot" ||
		lc.DeepLink == nil || *lc.DeepLink != "https://t.me/AnalyzerTestBot?start="+lc.Code {
		t.Fatalf("link code: %+v", lc)
	}
	if exp, err := time.Parse(time.RFC3339, lc.ExpiresAt); err != nil || !exp.Equal(e.now.Add(15*time.Minute)) {
		t.Fatalf("expires_at %s (%v)", lc.ExpiresAt, err)
	}
	norm, _ := alerts.NormalizeCode(lc.Code)
	want := sha256.Sum256([]byte(norm))
	var hash []byte
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*), (SELECT code_hash FROM telegram_link_code LIMIT 1) FROM telegram_link_code`).Scan(&n, &hash); err != nil {
		t.Fatal(err)
	}
	if n != 1 || !bytes.Equal(hash, want[:]) {
		t.Fatalf("stored rows %d, hash match %v", n, bytes.Equal(hash, want[:]))
	}
	var plain int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM telegram_link_code WHERE convert_from(code_hash, 'LATIN1') ILIKE '%' || $1 || '%'`, norm).Scan(&plain); err != nil || plain != 0 {
		t.Fatalf("plaintext code found in the table (%d, %v)", plain, err)
	}

	// Bot not configured (D-9): the code is still issued, with a warning and no deep link.
	e.svc.BotUsername = ""
	rec = e.postJSON("/telegram/link-code", "")
	var env struct {
		Data     alerts.LinkCode `json:"data"`
		Warnings []Warning       `json:"warnings"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Data.DeepLink != nil || env.Data.BotUsername != nil || len(env.Warnings) != 1 || env.Warnings[0].Code != "BOT_NOT_CONFIGURED" {
		t.Fatalf("no-bot response: %s", rec.Body)
	}
	// Old used/expired codes are purged (more than a day past expiry).
	e.advance(26 * time.Hour)
	e.linkCode()
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM telegram_link_code`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("purge: %d rows (%v)", n, err)
	}
}

// ALR-11: a webhook call with a missing or wrong secret is 401 and stores nothing (the chat is not
// linked and the code is not consumed); an unconfigured secret refuses everything.
func TestALR11WebhookSecretMismatch(t *testing.T) {
	e := newAlrEnv(t)
	code := e.linkCode()
	upd := alrUpdate("private", 4242, "/start "+code)
	for name, secret := range map[string]string{"missing": "", "wrong": "wrong-secret", "prefix": alrSecret[:10], "padded": alrSecret + "x", "case": strings.ToUpper(alrSecret)} {
		rec := e.webhook(secret, upd)
		if rec.Code != http.StatusUnauthorized || decodeErr(t, rec).Error.Code != "UNAUTHENTICATED" {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body)
		}
	}
	if _, linked := e.chatID(); linked {
		t.Fatal("chat linked by an unauthenticated webhook call")
	}
	var used int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM telegram_link_code WHERE used_at IS NOT NULL`).Scan(&used); err != nil || used != 0 {
		t.Fatalf("code consumed by an unauthenticated call (%d, %v)", used, err)
	}
	if len(e.sender.messages()) != 0 {
		t.Fatal("a message was sent in answer to an unauthenticated call")
	}
	// Right secret works (control).
	if rec := e.webhook(alrSecret, upd); rec.Code != 200 {
		t.Fatalf("right secret: %d %s", rec.Code, rec.Body)
	}
	if id, linked := e.chatID(); !linked || id != 4242 {
		t.Fatalf("chat id %d %v", id, linked)
	}
	// No configured secret: fail closed even for an empty header.
	h := NewRouter(Deps{Log: zerolog.New(e.logs), Auth: allowAll{}, Alerts: AlertsDeps{Svc: e.svc, WebhookSecret: ""}})
	if rec := do(h, http.MethodPost, "/api/v1/telegram/webhook", `{}`, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unconfigured secret: %d", rec.Code)
	}
	// The webhook needs no CSRF header (SEC-18) but every other non-GET still does.
	if rec := e.call(http.MethodPost, "/alerts", alertBody("TCS", "wk52_high", `{}`), map[string]string{"X-Requested-With": ""}); rec.Code != http.StatusForbidden {
		t.Fatalf("csrf: %d", rec.Code)
	}
}

// ALR-12: /start with a used, expired, unknown or malformed code fails politely (a fixed message),
// links nothing; a code works exactly once.
func TestALR12StartWithBadCode(t *testing.T) {
	e := newAlrEnv(t)
	code := e.linkCode()
	if rec := e.webhook(alrSecret, alrUpdate("private", 111, "/start "+code)); rec.Code != 200 {
		t.Fatal(rec.Body)
	}
	if id, ok := e.chatID(); !ok || id != 111 {
		t.Fatalf("first use did not link: %d %v", id, ok)
	}
	if m := e.sender.messages(); len(m) != 1 || m[0].chat != 111 || m[0].text != alerts.MsgLinked {
		t.Fatalf("confirmation: %+v", m)
	}
	// Used code from another chat: refused, the link stays on chat 111.
	if rec := e.webhook(alrSecret, alrUpdate("private", 222, "/start "+code)); rec.Code != 200 {
		t.Fatalf("used code must still be acknowledged with 200: %d", rec.Code)
	}
	if id, _ := e.chatID(); id != 111 {
		t.Fatalf("a used code changed the link to %d", id)
	}
	// Expired.
	code2 := e.linkCode()
	e.advance(15*time.Minute + time.Second)
	e.webhook(alrSecret, alrUpdate("private", 333, "/start "+code2))
	// Unknown but well-formed, and malformed.
	e.webhook(alrSecret, alrUpdate("private", 444, "/start ZZZZ-ZZZZ"))
	e.webhook(alrSecret, alrUpdate("private", 555, "/start not-a-code!"))
	if id, _ := e.chatID(); id != 111 {
		t.Fatalf("link changed to %d", id)
	}
	msgs := e.sender.messages()
	if len(msgs) != 5 {
		t.Fatalf("messages: %+v", msgs)
	}
	for _, m := range msgs[1:] {
		if m.text != alerts.MsgInvalidCode {
			t.Errorf("polite failure text = %q", m.text)
		}
	}
	// Just inside the 15 minutes works; a code is accepted in lower case and without the dash.
	code3 := e.linkCode()
	e.advance(15*time.Minute - time.Second)
	e.webhook(alrSecret, alrUpdate("private", 666, "/start "+strings.ToLower(strings.ReplaceAll(code3, "-", ""))))
	if id, _ := e.chatID(); id != 666 {
		t.Fatalf("code inside the window not accepted: %d", id)
	}
	// A failing reply does not fail the webhook (Telegram would retry and re-run the update).
	e.sender.fail = errors.New("boom")
	if rec := e.webhook(alrSecret, alrUpdate("private", 777, "/start ZZZZ-ZZZZ")); rec.Code != 200 {
		t.Fatalf("reply failure: %d", rec.Code)
	}
}

// ALR-13: messages from any chat other than a `/start <code>` are ignored: nothing stored, nothing
// sent back, always 200.
func TestALR13OtherChatMessagesIgnored(t *testing.T) {
	e := newAlrEnv(t)
	code := e.linkCode()
	for name, upd := range map[string]any{
		"hello":         alrUpdate("private", 9, "hello bot"),
		"start no code": alrUpdate("private", 9, "/start"),
		"help":          alrUpdate("private", 9, "/help "+code),
		"group start":   alrUpdate("group", -9, "/start "+code),
		"channel":       alrUpdate("channel", -9, "/start "+code),
		"edited":        map[string]any{"update_id": 3, "edited_message": map[string]any{"chat": map[string]any{"id": 9, "type": "private"}, "text": "/start " + code}},
		"callback":      map[string]any{"update_id": 4, "callback_query": map[string]any{"id": "x"}},
		"empty":         map[string]any{},
	} {
		rec := e.webhook(alrSecret, upd)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body)
		}
	}
	if rec := e.call(http.MethodPost, "/telegram/webhook", `not json`, map[string]string{WebhookSecretHeader: alrSecret, "X-Requested-With": ""}); rec.Code != 200 {
		t.Errorf("garbage body: %d", rec.Code)
	}
	if _, linked := e.chatID(); linked {
		t.Fatal("an ignored message linked a chat")
	}
	if len(e.sender.messages()) != 0 {
		t.Fatalf("replied to ignored messages: %+v", e.sender.messages())
	}
	var used int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM telegram_link_code WHERE used_at IS NOT NULL`).Scan(&used); err != nil || used != 0 {
		t.Fatalf("code consumed (%d, %v)", used, err)
	}
	// Oversized webhook bodies are refused before parsing.
	big := strings.Repeat("x", int(WebhookBodyLimit)+10)
	if rec := e.call(http.MethodPost, "/telegram/webhook", big, map[string]string{WebhookSecretHeader: alrSecret, "X-Requested-With": ""}); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized: %d", rec.Code)
	}
}

// ALR-65: unlink clears the chat id; the test message needs a linked chat, is HTML-escaped and is
// limited to one per minute.
func TestALR65UnlinkAndTestMessage(t *testing.T) {
	e := newAlrEnv(t)
	if rec := e.postJSON("/telegram/test", ""); rec.Code != http.StatusConflict {
		t.Fatalf("not linked: %d %s", rec.Code, rec.Body)
	}
	e.webhook(alrSecret, alrUpdate("private", 31337, "/start "+e.linkCode()))
	e.sender.mu.Lock()
	e.sender.sent = nil
	e.sender.mu.Unlock()

	if rec := e.postJSON("/telegram/test", ""); rec.Code != 200 {
		t.Fatalf("test message: %d %s", rec.Code, rec.Body)
	}
	m := e.sender.messages()
	if len(m) != 1 || m[0].chat != 31337 || !strings.Contains(m[0].text, "Stock &amp; MF Analyzer") {
		t.Fatalf("sent: %+v", m)
	}
	rec := e.postJSON("/telegram/test", "")
	er := decodeErr(t, rec)
	if rec.Code != http.StatusTooManyRequests || er.Error.Code != "RATE_LIMITED" || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("second within a minute: %d %+v", rec.Code, er)
	}
	e.advance(61 * time.Second)
	if rec := e.postJSON("/telegram/test", ""); rec.Code != 200 {
		t.Fatalf("after a minute: %d", rec.Code)
	}
	// A send failure is a 503 SOURCE_DOWN without the cause.
	e.advance(61 * time.Second)
	e.sender.fail = errors.New("telegram: sendMessage status 403: bot was blocked")
	rec = e.postJSON("/telegram/test", "")
	if rec.Code != 503 || strings.Contains(rec.Body.String(), "blocked") {
		t.Fatalf("send failure: %d %s", rec.Code, rec.Body)
	}
	// Unlink.
	if rec := e.call(http.MethodDelete, "/telegram/link", "", nil); rec.Code != 200 {
		t.Fatalf("unlink: %d", rec.Code)
	}
	if _, linked := e.chatID(); linked {
		t.Fatal("still linked")
	}
	// No bot configured (D-9): 503, never a crash.
	e.svc.Sender = nil
	if rec := e.postJSON("/telegram/test", ""); rec.Code != 503 {
		t.Fatalf("no sender: %d", rec.Code)
	}
}

// SEC-62: neither the webhook secret nor the bot token ever appears in responses or logs, even on
// failures.
func TestSEC62NoSecretsInLogsOrResponses(t *testing.T) {
	e := newAlrEnv(t)
	e.sender.fail = errors.New("telegram: request failed")
	var bodies strings.Builder
	for _, rec := range []*httptest.ResponseRecorder{
		e.webhook("wrong-"+alrSecret, alrUpdate("private", 1, "/start AAAA-AAAA")),
		e.webhook(alrSecret, alrUpdate("private", 1, "/start AAAA-AAAA")),
		e.postJSON("/telegram/test", ""),
		e.postJSON("/telegram/link-code", ""),
	} {
		bodies.WriteString(rec.Body.String())
	}
	all := bodies.String() + e.logs.String()
	for _, secret := range []string{alrSecret, alrBotToken} {
		if strings.Contains(all, secret) {
			t.Fatalf("secret %q found in responses/logs: %s", secret[:8], all)
		}
	}
	if !strings.Contains(e.logs.String(), "secret header rejected") {
		t.Fatalf("a rejected webhook call should be logged (without the value): %s", e.logs)
	}
}

// ALR-66: with no alerts service wired the routes answer 501 (not a panic), and the webhook still
// needs no CSRF header.
func TestALR66RoutesWithoutService(t *testing.T) {
	h := NewRouter(Deps{Log: zerolog.New(&bytes.Buffer{}), Auth: allowAll{}})
	for _, p := range []string{"/alerts", "/alerts/events", "/telegram/link-code", "/telegram/webhook"} {
		method := http.MethodPost
		if strings.HasPrefix(p, "/alerts") {
			method = http.MethodGet
		}
		if rec := do(h, method, "/api/v1"+p, "{}", map[string]string{"X-Requested-With": "fetch"}); rec.Code != http.StatusNotImplemented {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
}
