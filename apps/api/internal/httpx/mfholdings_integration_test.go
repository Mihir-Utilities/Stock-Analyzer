package httpx

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/importers"
	"github.com/india-analyzer/api/internal/jobs"
	"github.com/india-analyzer/api/internal/mfhold"
	"github.com/india-analyzer/api/internal/portfolio"
)

// B15 integration tests (docs/07 MFH-V, MFH-I, MFH-F rows). Every fixture is SYNTHETIC: made-up fund
// names, folio numbers and amounts; no real statement row appears anywhere in the repository.

var mfhNow = time.Date(2026, 11, 11, 6, 30, 0, 0, time.UTC) // Wednesday 2026-11-11, 12:00 IST

type mfhEnv struct {
	*importEnv
	mfh *mfhold.Service
}

func newMFHEnv(t *testing.T) *mfhEnv {
	t.Helper()
	e := newAuthEnv(t)
	js := jobs.New(e.pool, nil, jobs.Config{Cooldown: 15 * time.Minute, GlobalHour: 30}, zerolog.Nop())
	imp := importers.New(e.pool, js, 380, zerolog.Nop())
	imp.Now = func() time.Time { return mfhNow }
	imp.DBSize = func(context.Context) (int64, error) { return 10 << 20, nil }
	mfh := mfhold.New(e.pool)
	mfh.Now = func() time.Time { return mfhNow }
	pf := portfolio.New(e.pool)
	pf.Now = func() time.Time { return mfhNow }
	pf.MF = mfh
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Jobs: js, Imports: imp, Portfolio: pf, MFHoldings: mfh})
	return &mfhEnv{importEnv: &importEnv{authEnv: e, cookie: e.login(ownerPassword), svc: imp, jobs: js}, mfh: mfh}
}

type mfhBody struct {
	Data     json.RawMessage `json:"data"`
	Meta     map[string]any  `json:"meta"`
	Warnings []struct {
		Code string `json:"code"`
	} `json:"warnings"`
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func (b mfhBody) warned(code string) bool {
	for _, w := range b.Warnings {
		if w.Code == code {
			return true
		}
	}
	return false
}

func (e *mfhEnv) api(method, path, body string, hdr map[string]string) (resp, mfhBody) {
	e.t.Helper()
	r := e.do(method, "/api/v1"+path, body, e.cookie, hdr)
	var b mfhBody
	if r.Body.Len() > 0 {
		if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
			e.t.Fatalf("%s %s: %v: %s", method, path, err, r.Body.String())
		}
	}
	return r, b
}

func (b mfhBody) into(t *testing.T, dst any) {
	t.Helper()
	if err := json.Unmarshal(b.Data, dst); err != nil {
		t.Fatalf("data: %v: %s", err, b.Data)
	}
}

// scheme seeds an mf_scheme row and NAV rows ("date=nav" pairs).
func (e *mfhEnv) scheme(code int, name, plan, option string, navs ...string) {
	e.t.Helper()
	e.exec(`INSERT INTO mf_scheme (code, name, fund_house, category, plan, option_type, isin_growth, status)
		VALUES ($1, $2, 'Test AMC', 'Equity: Flexi Cap', $3, $4, $5, 'active')`, code, name, plan, option, fmt.Sprintf("INF%09dX", code))
	for _, p := range navs {
		parts := strings.SplitN(p, "=", 2)
		e.exec(`INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES ($1, $2::date, $3::float8)`, code, parts[0], parts[1])
	}
}

func mfhTxnJSON(code int, folio, typ, date, units, nav, amount, stamp string) string {
	return fmt.Sprintf(`{"scheme_code":%d,"folio":%q,"txn_type":%q,"txn_date":%q,"units":%q,"nav":%q,"amount":%q,"stamp_duty":%q}`,
		code, folio, typ, date, units, nav, amount, stamp)
}

func (e *mfhEnv) mustTxn(code int, folio, typ, date, units, nav, amount, stamp string) int64 {
	e.t.Helper()
	r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(code, folio, typ, date, units, nav, amount, stamp), nil)
	if r.Code != 201 {
		e.t.Fatalf("create txn: %d %s", r.Code, r.Body.String())
	}
	var it struct {
		ID int64 `json:"id"`
	}
	b.into(e.t, &it)
	return it.ID
}

func mfFieldsOf(b mfhBody) []string {
	var out []string
	raw, _ := json.Marshal(b.Error.Details["fields"])
	var fs []struct {
		Field string `json:"field"`
	}
	_ = json.Unmarshal(raw, &fs)
	for _, f := range fs {
		out = append(out, f.Field)
	}
	return out
}

// MFH-V01 / V02 / V03 / V04 / V14.
func TestMFTxnValidation(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund Direct Growth", "direct", "growth", "2026-11-10=20")
	post := func(body string) (resp, mfhBody) { return e.api(http.MethodPost, "/portfolio/mf/txns", body, nil) }
	good := func(mod func(m map[string]any)) string {
		m := map[string]any{"scheme_code": 101, "folio": "F1", "txn_type": "sip", "txn_date": "2026-10-01", "units": "10", "nav": "10", "amount": "100", "stamp_duty": "0"}
		mod(m)
		b, _ := json.Marshal(m)
		return string(b)
	}
	// V01
	for name, mod := range map[string]func(map[string]any){
		"zero units":      func(m map[string]any) { m["units"] = "0" },
		"negative nav":    func(m map[string]any) { m["nav"] = "-1" },
		"zero amount":     func(m map[string]any) { m["amount"] = 0 },
		"units too big":   func(m map[string]any) { m["units"] = "1000000001" },
		"5 decimals":      func(m map[string]any) { m["units"] = "1.23456" },
		"exponent":        func(m map[string]any) { m["amount"] = "1e3" },
		"non numeric":     func(m map[string]any) { m["nav"] = "abc" },
		"negative stamp":  func(m map[string]any) { m["stamp_duty"] = "-0.05" },
		"empty folio":     func(m map[string]any) { m["folio"] = "  " },
		"41 char folio":   func(m map[string]any) { m["folio"] = strings.Repeat("9", 41) },
		"future date":     func(m map[string]any) { m["txn_date"] = "2026-11-12" },
		"before 1990":     func(m map[string]any) { m["txn_date"] = "1989-12-31" },
		"bad date":        func(m map[string]any) { m["txn_date"] = "11/10/2026" },
		"unknown type":    func(m map[string]any) { m["txn_type"] = "gift" },
		"note too long":   func(m map[string]any) { m["note"] = strings.Repeat("x", 501) },
		"missing scheme":  func(m map[string]any) { delete(m, "scheme_code") },
		"source supplied": func(m map[string]any) { m["source"] = "import" },
	} {
		r, b := post(good(mod))
		if r.Code != 422 || b.Error.Code != "UNPROCESSABLE" || len(mfFieldsOf(b)) == 0 {
			t.Errorf("%s: %d %s", name, r.Code, r.Body.String())
		}
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 0 {
		t.Fatalf("rejected rows were stored: %d", n)
	}
	// V02: unsupported types.
	for _, typ := range []string{"switch_in", "switch_out", "bonus_merger"} {
		r, b := post(good(func(m map[string]any) { m["txn_type"] = typ }))
		if r.Code != 422 || b.Error.Code != "MF_TXN_TYPE_NOT_SUPPORTED" || b.Error.Message != mfhold.TypeUnsupportedMessage {
			t.Errorf("%s: %d %s", typ, r.Code, r.Body.String())
		}
	}
	// V04: unknown scheme is 404.
	if r, b := post(good(func(m map[string]any) { m["scheme_code"] = 999 })); r.Code != 404 || b.Error.Code != "NOT_FOUND" {
		t.Errorf("unknown scheme: %d %s", r.Code, r.Body.String())
	}
	// A plain valid row, a number given as a JSON number, and a folio with a slash.
	if r, _ := post(good(func(m map[string]any) { m["units"] = 10.5; m["amount"] = 105; m["folio"] = "12345678/90" })); r.Code != 201 {
		t.Fatalf("valid: %d %s", r.Code, r.Body.String())
	}
	var folio string
	if err := e.pool.QueryRow(context.Background(), `SELECT folio FROM mf_txn`).Scan(&folio); err != nil || folio != "12345678/90" {
		t.Errorf("folio must stay text: %q %v", folio, err)
	}
	// V14: PATCH cannot change scheme_code or source.
	id := e.mustTxn(101, "F1", "sip", "2026-10-02", "10", "10", "100", "0")
	for _, body := range []string{`{"scheme_code":101}`, `{"source":"import"}`} {
		if r, b := e.api(http.MethodPatch, fmt.Sprintf("/portfolio/mf/txns/%d", id), body, nil); r.Code != 422 || b.Error.Code != "UNPROCESSABLE" {
			t.Errorf("patch %s: %d %s", body, r.Code, r.Body.String())
		}
	}
	// Unknown id is 404; a non numeric id too.
	if r, _ := e.api(http.MethodPatch, "/portfolio/mf/txns/9999", `{"note":"x"}`, nil); r.Code != 404 {
		t.Errorf("unknown id: %d", r.Code)
	}
}

// MFH-V05 / V06 / V07 / V08.
func TestMFRedemptionSequence(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	buy := e.mustTxn(101, "F1", "purchase", "2026-01-05", "10.0000", "10", "100", "0")
	// Another folio of the same scheme does not cover the redemption (V05).
	e.mustTxn(101, "F2", "purchase", "2026-01-05", "50", "10", "500", "0")
	r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "redemption", "2026-02-01", "10.5", "11", "115.5", "0"), nil)
	if r.Code != 422 || b.Error.Code != "INSUFFICIENT_UNITS" {
		t.Fatalf("oversell: %d %s", r.Code, r.Body.String())
	}
	d := b.Error.Details
	if d["held_units"] != "10.0000" || d["redeem_units"] != "10.5000" || d["date"] != "2026-02-01" || d["transaction_id"] == nil {
		t.Errorf("details %v", d)
	}
	// Redemption before any purchase.
	if r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "redemption", "2026-01-01", "1", "11", "11", "0"), nil); r.Code != 422 || b.Error.Code != "INSUFFICIENT_UNITS" {
		t.Errorf("redemption before purchase: %d %s", r.Code, r.Body.String())
	}
	// V08: dust is accepted and clamped, 0.01 is rejected.
	if r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "redemption", "2026-02-01", "10.0100", "11", "110", "0"), nil); r.Code != 422 {
		t.Errorf("0.01 over: %d %s", r.Code, b.Error.Code)
	}
	r, b = e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "redemption", "2026-02-01", "10.0005", "11", "110", "0"), nil)
	if r.Code != 201 || !b.warned("UNITS_ROUNDED") {
		t.Fatalf("dust: %d %s", r.Code, r.Body.String())
	}
	var h struct {
		Items []struct {
			SchemeCode int      `json:"scheme_code"`
			Units      string   `json:"units"`
			Exited     bool     `json:"exited"`
			Realized   string   `json:"realized_pnl"`
			XIRR       *float64 `json:"xirr_pct"`
		} `json:"items"`
	}
	_, hb := e.api(http.MethodGet, "/portfolio/mf/holdings", "", nil)
	hb.into(t, &h)
	if len(h.Items) != 1 || h.Items[0].Units != "50.0000" {
		t.Fatalf("exited folio must not hide the other folio: %+v", h.Items)
	}
	// V06: edits and deletes that would leave a later redemption oversold are refused and change nothing.
	if r, b := e.api(http.MethodDelete, fmt.Sprintf("/portfolio/mf/txns/%d", buy), "", nil); r.Code != 422 || b.Error.Code != "INSUFFICIENT_UNITS" {
		t.Errorf("delete: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.api(http.MethodPatch, fmt.Sprintf("/portfolio/mf/txns/%d", buy), `{"units":"5"}`, nil); r.Code != 422 {
		t.Errorf("patch units: %d", r.Code)
	}
	// Moving the purchase to another folio re-validates old and new folio.
	if r, b := e.api(http.MethodPatch, fmt.Sprintf("/portfolio/mf/txns/%d", buy), `{"folio":"F2"}`, nil); r.Code != 422 || b.Error.Code != "INSUFFICIENT_UNITS" {
		t.Errorf("patch folio: %d %s", r.Code, r.Body.String())
	}
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE id = $1 AND folio = 'F1' AND units = 10`, buy); n != 1 {
		t.Error("a refused edit changed the row")
	}
}

// MFH-V07 on its own: a same-day purchase and a full redemption entered redemption first is refused (no units
// yet at the time of entry) but accepted when the purchase exists, whatever the ids.
func TestMFSameDay(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mustTxn(101, "F1", "purchase", "2026-03-03", "10", "10", "100", "0")
	e.mustTxn(101, "F1", "redemption", "2026-03-03", "10", "11", "110", "0")
	_, hb := e.api(http.MethodGet, "/portfolio/mf/holdings?include_exited=true", "", nil)
	var h struct {
		Items []struct {
			Exited   bool   `json:"exited"`
			Realized string `json:"realized_pnl"`
		} `json:"items"`
	}
	hb.into(t, &h)
	if len(h.Items) != 1 || !h.Items[0].Exited || h.Items[0].Realized != "10.0000" {
		t.Errorf("same-day round trip: %+v", h.Items)
	}
}

// MFH-V09 / V10.
func TestMFWarnings(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-03-01=10", "2026-11-10=20")
	// Amount 999.95 + stamp duty 0.05, units x nav = 999.95: no mismatch.
	if r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "sip", "2026-03-05", "12.3450", "81.0000", "999.9500", "0.0500"), nil); r.Code != 201 || b.warned("AMOUNT_MISMATCH") {
		t.Errorf("exact row: %d %s", r.Code, r.Body.String())
	}
	// Far from units x nav: warning, still stored.
	if r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "sip", "2026-03-06", "12.3450", "81.0000", "1100", "0"), nil); r.Code != 201 || !b.warned("AMOUNT_MISMATCH") {
		t.Errorf("mismatch: %d %s", r.Code, r.Body.String())
	}
	// Saturday, NAV feed starting after the transaction, and a repeated row.
	r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "sip", "2026-02-28", "10", "10", "100", "0"), nil)
	if r.Code != 201 || !b.warned("NON_BUSINESS_DAY") || !b.warned("NAV_FEED_STARTS_AFTER_TXN") {
		t.Errorf("weekend/nav feed: %d %s", r.Code, r.Body.String())
	}
	r, b = e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "sip", "2026-02-28", "10", "10", "100", "0"), nil)
	if r.Code != 201 || !b.warned("DUPLICATE_LOOKING_TXN") {
		t.Errorf("duplicate-looking: %d %s", r.Code, r.Body.String())
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 4 {
		t.Errorf("warnings never block: %d rows", n)
	}
	// A listed holiday.
	e.exec(`INSERT INTO market_holiday (holiday_date, segment, description) VALUES ('2026-08-18', 'trading', 'test')`)
	if _, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "sip", "2026-08-18", "10", "10", "100", "0"), nil); !b.warned("NON_BUSINESS_DAY") {
		t.Error("listed holiday must warn")
	}
}

// MFH-V11 / V12 / V13.
func TestMFIdempotencyAuthTracking(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	body := mfhTxnJSON(101, "F1", "sip", "2026-10-05", "10", "10", "100", "0")
	key := "11111111-1111-4111-8111-111111111111"
	r1, _ := e.api(http.MethodPost, "/portfolio/mf/txns", body, map[string]string{"Idempotency-Key": key})
	r2, _ := e.api(http.MethodPost, "/portfolio/mf/txns", body, map[string]string{"Idempotency-Key": key})
	if r1.Code != 201 || r2.Code != 201 || r2.Header().Get("Idempotent-Replayed") != "true" || r1.Header().Get("Idempotent-Replayed") != "" {
		t.Fatalf("replay: %d %d %q", r1.Code, r2.Code, r2.Header().Get("Idempotent-Replayed"))
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 1 {
		t.Errorf("replay must not store a second row: %d", n)
	}
	if r, b := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(101, "F1", "sip", "2026-10-06", "10", "10", "100", "0"), map[string]string{"Idempotency-Key": key}); r.Code != 409 || b.Error.Code != "CONFLICT" {
		t.Errorf("same key, other body: %d %s", r.Code, r.Body.String())
	}
	// A key used by the equity scope is not replayable here.
	// Without a key two identical rows are stored (a legitimate repeat SIP).
	e.api(http.MethodPost, "/portfolio/mf/txns", body, nil)
	e.api(http.MethodPost, "/portfolio/mf/txns", body, nil)
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 3 {
		t.Errorf("identical rows without a key: %d", n)
	}
	if r, _ := e.api(http.MethodPost, "/portfolio/mf/txns", body, map[string]string{"Idempotency-Key": "nope"}); r.Code != 422 {
		t.Errorf("bad key: %d", r.Code)
	}
	if n := e.count(`SELECT count(*) FROM idempotency_key WHERE scope = 'mf_txn'`); n != 1 {
		t.Errorf("scope mf_txn: %d", n)
	}
	// V12: no session, no CSRF header.
	noSess := e.do(http.MethodPost, "/api/v1/portfolio/mf/txns", body, "", nil)
	if noSess.Code != 401 {
		t.Errorf("no session: %d", noSess.Code)
	}
	if r := e.do(http.MethodGet, "/api/v1/portfolio/mf/holdings", "", "", nil); r.Code != 401 {
		t.Errorf("holdings without session: %d", r.Code)
	}
	for _, m := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete} {
		path := "/api/v1/portfolio/mf/txns"
		if m != http.MethodPost {
			path += "/1"
		}
		req := e.doNoCSRF(m, path, body)
		if req.Code != 403 {
			t.Errorf("%s without CSRF: %d", m, req.Code)
		}
	}
	// V13: tracking.
	var tracked bool
	q := func() bool {
		if err := e.pool.QueryRow(context.Background(), `SELECT is_tracked FROM mf_scheme WHERE code = 101`).Scan(&tracked); err != nil {
			t.Fatal(err)
		}
		return tracked
	}
	if !q() {
		t.Error("the first transaction must track the scheme")
	}
	e.exec(`DELETE FROM idempotency_key`)
	e.exec(`DELETE FROM mf_txn`)
	e.exec(`UPDATE mf_scheme SET is_tracked = true WHERE code = 101`)
	id := e.mustTxn(101, "F1", "sip", "2026-10-05", "10", "10", "100", "0")
	e.api(http.MethodDelete, fmt.Sprintf("/portfolio/mf/txns/%d", id), "", nil)
	if q() {
		t.Error("deleting the last transaction re-derives is_tracked to false when nothing else keeps it")
	}
	e.exec(`INSERT INTO watchlist_item (mf_scheme_code) VALUES (101)`)
	id = e.mustTxn(101, "F1", "sip", "2026-10-05", "10", "10", "100", "0")
	e.api(http.MethodDelete, fmt.Sprintf("/portfolio/mf/txns/%d", id), "", nil)
	if !q() {
		t.Error("a watchlist entry keeps the scheme tracked")
	}
	// Removing the watchlist entry must not untrack a scheme that has holdings.
	e.mustTxn(101, "F1", "sip", "2026-10-05", "10", "10", "100", "0")
	var wid int64
	if err := e.pool.QueryRow(context.Background(), `SELECT id FROM watchlist_item WHERE mf_scheme_code = 101`).Scan(&wid); err != nil {
		t.Fatal(err)
	}
	e.api(http.MethodDelete, fmt.Sprintf("/watchlist/%d", wid), "", nil)
	if !q() {
		t.Error("holdings keep the scheme tracked after the watchlist entry is removed")
	}
}

func (e *mfhEnv) doNoCSRF(method, path, body string) resp {
	req, _ := http.NewRequest(method, path, strings.NewReader(body))
	req.Header.Add("Cookie", SessionCookie+"="+e.cookie)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return resp{rec}
}

// MFH-V15 / F40-F59 over HTTP: the three views.
func TestMFSummaryViews(t *testing.T) {
	e := newMFHEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name, listing_date, sector) VALUES ('TCS', 'TCS Ltd', '2010-01-01', 'IT')`)
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
		SELECT id, d, 120, 120, 120, 120, 120, 1000, 'import' FROM instrument, (VALUES ('2026-11-09'::date), ('2026-11-10'::date)) v(d)`)
	e.api(http.MethodPost, "/portfolio/txns", `{"symbol":"TCS","side":"buy","qty":"10","price":"100","fees":"0","trade_date":"2025-01-02"}`, nil)
	type view struct {
		View   string `json:"view"`
		Totals struct {
			Invested     string  `json:"invested"`
			MarketValue  *string `json:"market_value"`
			TotalPnL     *string `json:"total_pnl"`
			PurchaseCash string  `json:"purchase_cash"`
			IDCW         *string `json:"idcw_income"`
		} `json:"totals"`
		Returns struct {
			XIRR   *float64 `json:"xirr_pct"`
			Reason *string  `json:"xirr_reason"`
			Abs    *float64 `json:"absolute_return_pct"`
			Span   *int     `json:"span_days"`
		} `json:"returns"`
		Holdings            []map[string]any `json:"holdings"`
		MFHoldings          []map[string]any `json:"mf_holdings"`
		Breakdown           []map[string]any `json:"breakdown"`
		AssetClassesPresent []string         `json:"asset_classes_present"`
		AllocAsset          []struct {
			Key string  `json:"key"`
			W   float64 `json:"weight_pct"`
		} `json:"allocation_by_asset_class"`
		Benchmark map[string]any `json:"benchmark"`
	}
	get := func(q string) (view, mfhBody, resp) {
		r, b := e.api(http.MethodGet, "/portfolio/summary"+q, "", nil)
		if r.Code != 200 {
			t.Fatalf("summary%s: %d %s", q, r.Code, r.Body.String())
		}
		var v view
		b.into(t, &v)
		return v, b, r
	}
	// No MF rows: all equals equity (F54).
	eqOnly, _, _ := get("")
	allOnly, _, _ := get("?view=all")
	if allOnly.Totals.Invested != eqOnly.Totals.Invested || *allOnly.Totals.MarketValue != *eqOnly.Totals.MarketValue ||
		*allOnly.Totals.TotalPnL != *eqOnly.Totals.TotalPnL || *allOnly.Returns.XIRR != *eqOnly.Returns.XIRR {
		t.Errorf("all != equity without MF rows: %+v vs %+v", allOnly, eqOnly)
	}
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=15", "2026-11-09=14.5")
	e.mustTxn(101, "F1", "sip", "2025-01-02", "10", "10", "99.95", "0.05")
	// V15: unknown view, missing view, each view echoed.
	if r, b := e.api(http.MethodGet, "/portfolio/summary?view=bogus", "", nil); r.Code != 422 || mfFieldsOf(b)[0] != "view" {
		t.Errorf("unknown view: %d %s", r.Code, r.Body.String())
	}
	def, _, _ := get("")
	eq, _, _ := get("?view=equity")
	all, allBody, _ := get("?view=all")
	mf, mfb, _ := get("?view=mf")
	if def.View != "equity" || eq.View != "equity" || all.View != "all" || mf.View != "mf" {
		t.Errorf("view echo: %q %q %q %q", def.View, eq.View, all.View, mf.View)
	}
	dj, _ := json.Marshal(def)
	ej, _ := json.Marshal(eq)
	if string(dj) != string(ej) {
		t.Error("a missing view must equal view=equity")
	}
	// Equity is unchanged by the MF rows (F50) and keeps the legacy contract.
	if eq.Totals.Invested != "1000.0000" || *eq.Totals.MarketValue != "1200.0000" || *eq.Returns.XIRR != *eqOnly.Returns.XIRR || len(eq.MFHoldings) != 0 || len(eq.Holdings) != 1 {
		t.Errorf("equity view changed: %+v", eq)
	}
	if eq.Totals.IDCW != nil {
		t.Error("idcw_income is null for equity")
	}
	if eq.Benchmark["code"] != "NIFTY50" {
		t.Errorf("equity benchmark: %v", eq.Benchmark)
	}
	// MF view: cost is amount + stamp duty = 100.
	if mf.Totals.Invested != "100.0000" || mf.Totals.PurchaseCash != "100.0000" || *mf.Totals.MarketValue != "150.0000" || len(mf.Holdings) != 0 || len(mf.MFHoldings) != 1 {
		t.Errorf("mf view: %+v", mf)
	}
	if mf.Benchmark["code"] != nil || mf.Benchmark["reason"] != "not_defined_for_view" || all.Benchmark["reason"] != "not_defined_for_view" {
		t.Errorf("benchmark: %v %v", mf.Benchmark, all.Benchmark)
	}
	if mfb.Meta["source"] != "mfapi.in" || allBody.Meta["source"] != "mixed" {
		t.Errorf("meta source: %v %v", mfb.Meta["source"], allBody.Meta["source"])
	}
	// All: decimal sums, pooled XIRR (never the average, F50), breakdown of two rows, shares sum to 100 (F59).
	if all.Totals.Invested != "1100.0000" || *all.Totals.MarketValue != "1350.0000" || *all.Totals.TotalPnL != "250.0000" || all.Totals.PurchaseCash != "1100.0000" {
		t.Errorf("all totals: %+v", all.Totals)
	}
	if len(all.Breakdown) != 2 || len(all.AssetClassesPresent) != 2 {
		t.Errorf("breakdown/present: %v %v", all.Breakdown, all.AssetClassesPresent)
	}
	avg := (*eq.Returns.XIRR + *mf.Returns.XIRR) / 2
	if all.Returns.XIRR == nil || math.Abs(*all.Returns.XIRR-avg) < 0.01 {
		t.Errorf("pooled XIRR %v must not equal the average %v", all.Returns.XIRR, avg)
	}
	sum := 0.0
	for _, a := range all.AllocAsset {
		sum += a.W
	}
	if math.Abs(sum-100) > 0.02 {
		t.Errorf("allocation by asset class sums to %v", sum)
	}
	// One year rule on every view (MFH-3 / F51): a ledger started 200 days ago shows absolute return only.
	e.exec(`DELETE FROM mf_txn`)
	e.exec(`DELETE FROM portfolio_txn`)
	e.mustTxn(101, "F1", "sip", "2026-04-25", "10", "10", "100", "0")
	short, _, _ := get("?view=mf")
	if short.Returns.XIRR != nil || short.Returns.Reason == nil || *short.Returns.Reason != "under_one_year" || short.Returns.Abs == nil || *short.Returns.Span != 200 {
		t.Errorf("under one year: %+v", short.Returns)
	}
	// MF only: all equals mf (F54).
	allMF, _, _ := get("?view=all")
	if allMF.Totals.Invested != short.Totals.Invested || *allMF.Totals.MarketValue != *short.Totals.MarketValue || *allMF.Returns.Abs != *short.Returns.Abs {
		t.Errorf("all != mf without equity rows: %+v vs %+v", allMF.Totals, short.Totals)
	}
	// Nothing at all.
	e.exec(`DELETE FROM mf_txn`)
	if v, _, _ := get("?view=all"); len(v.AssetClassesPresent) != 0 || v.Returns.XIRR != nil {
		t.Errorf("empty ledger: %+v", v)
	}
}

// MFH-F40.. over HTTP: holdings, NAV reasons and the three group modes.
func TestMFHoldingsHTTP(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=20", "2026-11-09=19")
	e.scheme(102, "Beta Fund", "regular", "idcw") // no NAV rows: no_nav
	e.mustTxn(101, "F1", "sip", "2025-01-05", "10", "10", "99.95", "0.05")
	e.mustTxn(101, "F2", "sip", "2025-02-05", "5", "10", "50", "0")
	e.mustTxn(102, "F1", "sip", "2025-01-05", "4", "10", "40", "0")
	type item struct {
		SchemeCode int      `json:"scheme_code"`
		Folio      *string  `json:"folio"`
		Folios     []string `json:"folios"`
		Units      string   `json:"units"`
		Invested   string   `json:"invested"`
		Value      *string  `json:"market_value"`
		NAVReason  *string  `json:"nav_reason"`
		XIRRReason *string  `json:"xirr_reason"`
		Plan       string   `json:"plan"`
		Option     string   `json:"option"`
		Flags      []string `json:"flags"`
		DayChange  *string  `json:"day_change"`
		AvgCost    *string  `json:"avg_cost"`
	}
	var res struct {
		Items  []item `json:"items"`
		Totals struct {
			Value  *string `json:"market_value"`
			Reason *string `json:"market_value_reason"`
		} `json:"totals"`
	}
	_, b := e.api(http.MethodGet, "/portfolio/mf/holdings", "", nil)
	b.into(t, &res)
	if len(res.Items) != 2 || res.Items[0].SchemeCode != 101 {
		t.Fatalf("items %+v", res.Items)
	}
	a, beta := res.Items[0], res.Items[1]
	if a.Units != "15.0000" || a.Invested != "150.0000" || *a.Value != "300.0000" || len(a.Folios) != 2 || a.Folio != nil || *a.DayChange != "15.0000" || *a.AvgCost != "10.0000" {
		t.Errorf("alpha %+v", a)
	}
	if beta.Value != nil || *beta.NAVReason != "no_nav" || *beta.XIRRReason != "no_nav" || beta.Units != "4.0000" || beta.Plan != "regular" || beta.Option != "idcw" {
		t.Errorf("beta %+v", beta)
	}
	if res.Totals.Value != nil || res.Totals.Reason == nil || *res.Totals.Reason != "missing_nav: Beta Fund" {
		t.Errorf("totals must not be a partial sum: %+v", res.Totals)
	}
	if !b.warned("IDCW_PAYOUTS_NOT_RECORDED") {
		t.Error("IDCW scheme without payouts must warn")
	}
	_, b = e.api(http.MethodGet, "/portfolio/mf/holdings?group=folio", "", nil)
	b.into(t, &res)
	if len(res.Items) != 3 || res.Items[0].Folio == nil {
		t.Errorf("group=folio: %+v", res.Items)
	}
	// as_of before the purchases: nothing; an invalid group or date is 422.
	_, b = e.api(http.MethodGet, "/portfolio/mf/holdings?as_of=2024-01-01", "", nil)
	b.into(t, &res)
	if len(res.Items) != 0 {
		t.Errorf("as_of before purchases: %+v", res.Items)
	}
	if r, _ := e.api(http.MethodGet, "/portfolio/mf/holdings?group=x", "", nil); r.Code != 422 {
		t.Error("bad group")
	}
	if r, _ := e.api(http.MethodGet, "/portfolio/mf/holdings?as_of=2030-01-01", "", nil); r.Code != 422 {
		t.Error("future as_of")
	}
	// Listing and filters.
	_, b = e.api(http.MethodGet, "/portfolio/mf/txns?scheme_code=101&limit=1", "", nil)
	var page struct {
		Items []struct {
			TxnDate string `json:"txn_date"`
			Source  string `json:"source"`
			Plan    string `json:"plan"`
		} `json:"items"`
		Next *string `json:"next_cursor"`
	}
	b.into(t, &page)
	if len(page.Items) != 1 || page.Items[0].TxnDate != "2025-02-05" || page.Next == nil || page.Items[0].Source != "manual" {
		t.Errorf("list %+v", page)
	}
	_, b = e.api(http.MethodGet, "/portfolio/mf/txns?scheme_code=101&limit=1&cursor="+*page.Next, "", nil)
	b.into(t, &page)
	if len(page.Items) != 1 || page.Items[0].TxnDate != "2025-01-05" {
		t.Errorf("page 2 %+v", page)
	}
	if r, _ := e.api(http.MethodGet, "/portfolio/mf/txns?type=nope", "", nil); r.Code != 422 {
		t.Error("bad type filter")
	}
}

// ---- importer over HTTP ----

const mfhHdr = "Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty\n"

func (e *mfhEnv) uploadMF(name, ctype, content string) resp {
	return e.upload("mf_statement", upload{filename: name, ctype: ctype, content: content}, e.cookie, true)
}

func (e *mfhEnv) validateMF(csv string) map[string]any {
	e.t.Helper()
	r := e.uploadMF("statement.csv", "text/csv", csv)
	if r.Code != 200 {
		e.t.Fatalf("validate %d %s", r.Code, r.Body.String())
	}
	return decodeData(e.t, r)
}

func mfhInt(v any) int { f, _ := v.(float64); return int(f) }

func (e *mfhEnv) mapFund(name string, code int) resp {
	r, _ := e.api(http.MethodPut, "/portfolio/mf/fund-mappings", fmt.Sprintf(`{"fund_name":%q,"scheme_code":%d}`, name, code), nil)
	return r
}

func (e *mfhEnv) commitMF(uploadID string, excluded ...int) (resp, map[string]any) {
	body := map[string]any{"upload_id": uploadID}
	if len(excluded) > 0 {
		body["excluded_rows"] = excluded
	}
	b, _ := json.Marshal(body)
	r := e.post("/imports/mf_statement/commit", string(b))
	var env struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(r.Body.Bytes(), &env)
	return r, env.Data
}

// MFH-I34 / MFH-23: unmapped names list candidates (watchlist first, plan and option explicit), mapping is
// saved and the stored upload is re-validated without re-uploading; later files reuse the mapping.
func TestMFMappingFlow(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Flexi Cap Fund - Direct Plan - Growth Option", "direct", "growth", "2026-11-10=20")
	e.scheme(202, "Alpha Flexi Cap Fund - Regular Plan - Growth Option", "regular", "growth", "2026-11-10=19")
	e.scheme(203, "Alpha Flexi Cap Fund - Direct Plan - IDCW Option", "direct", "idcw", "2026-11-10=18")
	e.scheme(204, "Beta Bond Fund - Direct Plan - Growth", "direct", "growth", "2026-11-10=30")
	e.exec(`INSERT INTO watchlist_item (mf_scheme_code) VALUES (202)`)
	csv := mfhHdr + ",,,,,,,\n" +
		"05-Nov-2026,Alpha Flexi Cap Fund,Purchase,1234567/89,12.345,81.000,999.95,0.05\n" +
		"05-Nov-2026,Beta Bond Fund Direct Growth,Purchase,1234567/89,10.000,30.000,300.00,0.02\n"
	v := e.validateMF(csv)
	mf := v["mf"].(map[string]any)
	un := mf["unmapped_funds"].([]any)
	if len(un) != 2 || mfhInt(v["error_count"]) != 2 {
		t.Fatalf("unmapped %v errors %v", un, v["errors"])
	}
	first := un[0].(map[string]any)
	cands := first["candidates"].([]any)
	if len(cands) != 3 {
		t.Fatalf("candidates %v", cands)
	}
	top := cands[0].(map[string]any)
	if mfhInt(top["scheme_code"]) != 202 || top["on_watchlist"] != true || top["plan"] != "regular" || top["option"] != "growth" || top["has_nav"] != true {
		t.Errorf("watchlist scheme must come first with plan and option: %v", top)
	}
	errs := v["errors"].([]any)
	if errs[0].(map[string]any)["code"] != "UNMAPPED_FUND" {
		t.Errorf("error code: %v", errs[0])
	}
	id := v["upload_id"].(string)
	// Commit is blocked while any name is unmapped.
	if r, _ := e.commitMF(id); r.Code != 422 {
		t.Errorf("commit with unmapped funds: %d", r.Code)
	}
	// The failed commit consumed the upload: validate again, then map and revalidate in place.
	v = e.validateMF(csv)
	id = v["upload_id"].(string)
	if r := e.mapFund("Alpha Flexi Cap Fund", 201); r.Code != 200 {
		t.Fatalf("map: %d %s", r.Code, r.Body.String())
	}
	r := e.post("/imports/mf_statement/revalidate", fmt.Sprintf(`{"upload_id":%q}`, id))
	rv := decodeData(t, r)
	if rv["upload_id"] != id || mfhInt(rv["error_count"]) != 1 || len(rv["mf"].(map[string]any)["unmapped_funds"].([]any)) != 1 {
		t.Fatalf("revalidate: %v", rv)
	}
	e.mapFund("  BETA bond fund   direct growth ", 204)
	rv = decodeData(t, e.post("/imports/mf_statement/revalidate", fmt.Sprintf(`{"upload_id":%q}`, id)))
	if mfhInt(rv["error_count"]) != 0 {
		t.Fatalf("after mapping: %v", rv["errors"])
	}
	if r := e.post("/imports/mf_statement/revalidate", `{"upload_id":"22222222-2222-4222-8222-222222222222"}`); r.Code != 404 {
		t.Errorf("unknown upload: %d", r.Code)
	}
	cr, cd := e.commitMF(id)
	if cr.Code != 200 || mfhInt(cd["inserted"]) != 2 || cd["post_import_job_id"] != nil {
		t.Fatalf("commit: %d %v", cr.Code, cd)
	}
	// Rows landed on the mapped schemes; scheme tracking and fund names are stored.
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE scheme_code = 201 AND fund_name = 'Alpha Flexi Cap Fund' AND source = 'import' AND import_batch_id IS NOT NULL`); n != 1 {
		t.Error("row not stored under the mapped scheme")
	}
	if n := e.count(`SELECT count(*) FROM mf_scheme WHERE code IN (201, 204) AND is_tracked`); n != 2 {
		t.Error("imported schemes must be tracked")
	}
	// A later file reuses the mappings: no unmapped names.
	later := e.validateMF(mfhHdr + "05-Oct-2026,alpha flexi cap fund,Purchase,1234567/89,12.000,80.000,960.00,0.05\n")
	if mfhInt(later["error_count"]) != 0 || len(later["mf"].(map[string]any)["fund_mappings"].([]any)) != 1 {
		t.Errorf("later file: %v", later)
	}
}

// MFH-V16: the mapping API, including the re-map rules.
func TestMFFundMappingAPI(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund Direct Growth", "direct", "growth", "2026-11-10=20")
	e.scheme(202, "Alpha Fund Regular Growth", "regular", "growth", "2026-11-10=19")
	if r := e.mapFund("Alpha Fund", 201); r.Code != 200 {
		t.Fatalf("create: %d %s", r.Code, r.Body.String())
	}
	if r := e.mapFund("alpha  FUND", 201); r.Code != 200 || e.count(`SELECT count(*) FROM mf_fund_name_map`) != 1 {
		t.Errorf("same scheme again must be a no-op: %d", r.Code)
	}
	if r := e.mapFund("Alpha Fund", 202); r.Code != 200 { // no transaction depends on it yet
		t.Errorf("change with no rows: %d %s", r.Code, r.Body.String())
	}
	if r := e.mapFund("Alpha Fund", 9999); r.Code != 404 {
		t.Errorf("unknown scheme: %d", r.Code)
	}
	for _, body := range []string{`{"fund_name":"  ","scheme_code":201}`, fmt.Sprintf(`{"fund_name":%q,"scheme_code":201}`, strings.Repeat("a", 201)), `{"fund_name":"x"}`, `{"scheme_code":201}`} {
		if r, _ := e.api(http.MethodPut, "/portfolio/mf/fund-mappings", body, nil); r.Code != 422 {
			t.Errorf("bad body %.30s: %d", body, r.Code)
		}
	}
	// The mapping now points at 202. Import a row under it; then a change needs remap=true.
	csv := mfhHdr + "05-Nov-2026,Alpha Fund,Purchase,F1,10.000,10.000,100.00,0\n"
	id := e.validateMF(csv)["upload_id"].(string)
	if r, d := e.commitMF(id); r.Code != 200 || mfhInt(d["inserted"]) != 1 {
		t.Fatalf("commit: %d", r.Code)
	}
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE scheme_code = 202`); n != 1 {
		t.Fatal("the row must follow the mapping")
	}
	r, b := e.api(http.MethodPut, "/portfolio/mf/fund-mappings", `{"fund_name":"Alpha Fund","scheme_code":201}`, nil)
	if r.Code != 409 || b.Error.Code != "FUND_MAPPING_IN_USE" || b.Error.Details["rows"] != float64(1) {
		t.Fatalf("in use: %d %s", r.Code, r.Body.String())
	}
	if r, _ = e.api(http.MethodPut, "/portfolio/mf/fund-mappings", `{"fund_name":"Alpha Fund","scheme_code":201,"remap":true}`, nil); r.Code != 200 {
		t.Fatalf("remap: %d %s", r.Code, r.Body.String())
	}
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE scheme_code = 201`); n != 1 {
		t.Error("remap must rewrite the dependent rows")
	}
	var note string
	if err := e.pool.QueryRow(context.Background(), `SELECT audit_note FROM mf_fund_name_map`).Scan(&note); err != nil || !strings.Contains(note, "remapped 2026-11-11: 202 -> 201 (1 rows)") {
		t.Errorf("audit note: %q %v", note, err)
	}
	// Re-importing the same file after the re-map adds nothing (the key follows the fund name, MFH-I24).
	id = e.validateMF(csv)["upload_id"].(string)
	if _, d := e.commitMF(id); mfhInt(d["inserted"]) != 0 || mfhInt(d["skipped_duplicates"]) != 1 {
		t.Errorf("re-import after remap: %v", d)
	}
	// A re-map that would oversell a sequence is refused and changes nothing: a manual redemption on 201
	// would lose its units when the imported purchase moves to 202.
	e.mustTxn(201, "F1", "redemption", "2026-11-06", "10", "11", "110", "0")
	r, b = e.api(http.MethodPut, "/portfolio/mf/fund-mappings", `{"fund_name":"Alpha Fund","scheme_code":202,"remap":true}`, nil)
	if r.Code != 422 || b.Error.Code != "INSUFFICIENT_UNITS" {
		t.Errorf("oversell by remap: %d %s", r.Code, r.Body.String())
	}
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE scheme_code = 201`); n != 2 {
		t.Error("a refused re-map changed rows")
	}
	_, lb := e.api(http.MethodGet, "/portfolio/mf/fund-mappings", "", nil)
	var list struct {
		Items []struct {
			Rows int `json:"rows"`
		} `json:"items"`
	}
	lb.into(t, &list)
	if len(list.Items) != 1 || list.Items[0].Rows != 1 {
		t.Errorf("list %+v", list)
	}
}

// MFH-I35 / MFH-24: identical rows are separate transactions; re-import adds nothing; one more adds one;
// a ticked-off row is skipped; commit warnings are informational only.
func TestMFIdenticalRowsImport(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	row := "05-Nov-2026,Alpha Fund,Purchase,F1,12.345,81.000,999.95,0.05\n"
	two := mfhHdr + row + row
	v := e.validateMF(two)
	if mfhInt(v["error_count"]) != 0 || mfhInt(v["warning_count"]) != 2 {
		t.Fatalf("validate: %v", v)
	}
	groups := v["mf"].(map[string]any)["duplicate_groups"].([]any)
	if len(groups) != 1 || mfhInt(groups[0].(map[string]any)["count"]) != 2 {
		t.Errorf("duplicate groups %v", groups)
	}
	for _, w := range v["warnings"].([]any) {
		if w.(map[string]any)["code"] != "DUPLICATE_IN_FILE" {
			t.Errorf("warning %v", w)
		}
	}
	r, d := e.commitMF(v["upload_id"].(string))
	if r.Code != 200 || mfhInt(d["inserted"]) != 2 || mfhInt(d["skipped_duplicates"]) != 0 {
		t.Fatalf("both identical rows must commit: %d %v", r.Code, d)
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 2 {
		t.Fatalf("rows %d", n)
	}
	// Re-import of the same file: 0 inserted.
	v = e.validateMF(two)
	if mfhInt(v["mf"].(map[string]any)["duplicates_in_db"]) != 2 {
		t.Errorf("duplicates_in_db %v", v["mf"])
	}
	if _, d := e.commitMF(v["upload_id"].(string)); mfhInt(d["inserted"]) != 0 || mfhInt(d["skipped_duplicates"]) != 2 {
		t.Errorf("re-import: %v", d)
	}
	// A file with one more identical row adds exactly one.
	v = e.validateMF(two + row)
	if _, d := e.commitMF(v["upload_id"].(string)); mfhInt(d["inserted"]) != 1 || mfhInt(d["skipped_duplicates"]) != 2 {
		t.Errorf("three rows: %v", d)
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 3 {
		t.Fatalf("rows %d", n)
	}
	// Unticking one row of a duplicate group (line 3) imports the other and leaves the occurrence index alone.
	e.exec(`DELETE FROM mf_txn`)
	v = e.validateMF(two)
	r, d = e.commitMF(v["upload_id"].(string), 3)
	if r.Code != 200 || mfhInt(d["inserted"]) != 1 {
		t.Fatalf("excluded row: %d %v", r.Code, d)
	}
	var key string
	if err := e.pool.QueryRow(context.Background(), `SELECT dedupe_key FROM mf_txn`).Scan(&key); err != nil || key == "" {
		t.Fatal(err)
	}
	v = e.validateMF(two) // the full file later: row 2 is known, row 3 (occurrence 2) is new
	if _, d := e.commitMF(v["upload_id"].(string)); mfhInt(d["inserted"]) != 1 || mfhInt(d["skipped_duplicates"]) != 1 {
		t.Errorf("full file after an excluded row: %v", d)
	}
	// An unknown excluded line is a 422; excluded_rows on another kind too.
	v = e.validateMF(two)
	if r, _ := e.commitMF(v["upload_id"].(string), 99); r.Code != 422 {
		t.Errorf("unknown line: %d", r.Code)
	}
}

// MFH-I36: shared folio across two funds of one AMC, shared fund name across plans, weekend date,
// several purchases a month.
func TestMFDataFacts(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund Direct Growth", "direct", "growth", "2026-11-10=20")
	e.scheme(202, "Beta Fund Direct Growth", "direct", "growth", "2026-11-10=30")
	e.mapFund("Alpha Fund", 201)
	e.mapFund("Beta Fund", 202)
	csv := mfhHdr +
		"02-Nov-2026,Alpha Fund,Purchase,555/1,10.000,10.000,100.00,0\n" +
		"07-Nov-2026,Alpha Fund,Purchase,555/1,10.000,10.000,100.00,0\n" + // Saturday
		"09-Nov-2026,Alpha Fund,Purchase,555/1,10.000,10.000,100.00,0\n" +
		"09-Nov-2026,Beta Fund,Purchase,555/1,5.000,20.000,100.00,0\n" // the same folio number under another fund
	v := e.validateMF(csv)
	if mfhInt(v["error_count"]) != 0 || mfhInt(v["warning_count"]) != 1 {
		t.Fatalf("validate: %v %v", v["errors"], v["warnings"])
	}
	if w := v["warnings"].([]any)[0].(map[string]any); w["code"] != "NON_BUSINESS_DAY" {
		t.Errorf("weekend warning: %v", w)
	}
	if _, d := e.commitMF(v["upload_id"].(string)); mfhInt(d["inserted"]) != 4 {
		t.Fatalf("commit: %v", d)
	}
	// Two separate ledgers: Beta's redemption of 5 units works, Alpha's folio units do not cover it.
	if r, _ := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(202, "555/1", "redemption", "2026-11-10", "5", "20", "100", "0"), nil); r.Code != 201 {
		t.Errorf("beta redemption: %d", r.Code)
	}
	if r, _ := e.api(http.MethodPost, "/portfolio/mf/txns", mfhTxnJSON(202, "555/1", "redemption", "2026-11-10", "1", "20", "20", "0"), nil); r.Code != 422 {
		t.Errorf("beta folio is empty now: %d", r.Code)
	}
	var h struct {
		Items []struct {
			Units string `json:"units"`
		} `json:"items"`
	}
	_, b := e.api(http.MethodGet, "/portfolio/mf/holdings", "", nil)
	b.into(t, &h)
	if len(h.Items) != 1 || h.Items[0].Units != "30.0000" {
		t.Errorf("holdings %+v", h.Items)
	}
}

// MFH-I27 / I29 / I31 / V02 / I30 over HTTP: any row error blocks the commit; counts and ranges come back.
func TestMFImportErrorsAndPreview(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	csv := "Client Name,PAN,Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty,Balance\n" +
		"Jane Sample,ABCDE1234F,05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0,99999\n" +
		"Jane Sample,ABCDE1234F,06-Nov-2026,Alpha Fund,Switch In,F1,1.000,10.000,10.00,0,99999\n" +
		"Jane Sample,ABCDE1234F,06-Nov-2026,Alpha Fund,Purchase,F1,-1.000,10.000,10.00,0,99999\n" +
		"Jane Sample,ABCDE1234F,03-Nov-2026,Alpha Fund,SIP,F1,1.000,10.000,10.00,0,99999\n"
	r := e.uploadMF("s.csv", "text/csv", csv)
	if r.Code != 200 {
		t.Fatal(r.Code)
	}
	body := r.Body.String()
	for _, secret := range []string{"Jane Sample", "ABCDE1234F", "99999"} {
		if strings.Contains(body, secret) {
			t.Errorf("MFH-I30: %q is in the validate response", secret)
		}
	}
	v := decodeData(t, r)
	if mfhInt(v["error_count"]) != 2 || mfhInt(v["rows"]) != 4 {
		t.Fatalf("counts: %v", v)
	}
	codes := map[string]string{}
	for _, x := range v["errors"].([]any) {
		m := x.(map[string]any)
		codes[m["code"].(string)] = m["message"].(string)
		if mfhInt(m["row"]) < 2 || m["column"] == "" {
			t.Errorf("error needs row and column: %v", m)
		}
	}
	if !strings.Contains(codes["MF_TXN_TYPE_NOT_SUPPORTED"], "redemption plus a purchase") || codes["NEGATIVE_OR_REVERSAL_ROW"] == "" {
		t.Errorf("codes %v", codes)
	}
	mf := v["mf"].(map[string]any)
	if mf["date_from"] != "2026-11-03" || mf["date_to"] != "2026-11-05" || mf["rows_by_type"].(map[string]any)["purchase"] == nil {
		t.Errorf("mf summary: %v", mf)
	}
	if rr, _ := e.commitMF(v["upload_id"].(string)); rr.Code != 422 {
		t.Errorf("commit with row errors: %d", rr.Code)
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 0 {
		t.Error("nothing may be stored")
	}
	// Preview shows at most 20 rows.
	var big strings.Builder
	big.WriteString(mfhHdr)
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&big, "05-Nov-2026,Alpha Fund,Purchase,F%d,1.000,10.000,10.00,0\n", i)
	}
	if pv := e.validateMF(big.String())["preview"].([]any); len(pv) != 20 {
		t.Errorf("preview %d rows", len(pv))
	}
	// CSV-injection text is stored as written.
	inj := mfhHdr + "05-Nov-2026,Alpha Fund,Purchase,=1+1,1.000,10.000,10.00,0\n"
	id := e.validateMF(inj)["upload_id"].(string)
	if rr, _ := e.commitMF(id); rr.Code != 200 {
		t.Fatal(rr.Code)
	}
	var folio string
	_ = e.pool.QueryRow(context.Background(), `SELECT folio FROM mf_txn`).Scan(&folio)
	if folio != "=1+1" {
		t.Errorf("folio stored as %q", folio)
	}
}

func mfhXLSX(rows [][]string) string {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(n, b string) { w, _ := zw.Create(n); _, _ = w.Write([]byte(b)) }
	add("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`)
	add("xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`)
	add("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>`)
	var s strings.Builder
	s.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for ri, row := range rows {
		fmt.Fprintf(&s, `<row r="%d">`, ri+1)
		for ci, c := range row {
			fmt.Fprintf(&s, `<c r="%c%d" t="inlineStr"><is><t>%s</t></is></c>`, 'A'+ci, ri+1, c)
		}
		s.WriteString(`</row>`)
	}
	s.WriteString(`</sheetData></worksheet>`)
	add("xl/worksheets/sheet1.xml", s.String())
	_ = zw.Close()
	return buf.String()
}

// MFH-I20: type by content, limits, empty files.
func TestMFUploadLimitsAndTypes(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	xl := mfhXLSX([][]string{{"Date", "Fund Name", "Transaction Type", "Folio No", "Units Traded", "NAV", "Amount", "Stamp Duty"},
		{"05-Nov-2026", "Alpha Fund", "Purchase", "F1", "1.000", "10.000", "10.00", "0"}})
	xlsxType := "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	if r := e.uploadMF("s.xlsx", xlsxType, xl); r.Code != 200 || mfhInt(decodeData(t, r)["rows"]) != 1 {
		t.Errorf("xlsx: %d %s", r.Code, r.Body.String())
	}
	if r := e.uploadMF("s.csv", "text/csv", xl); r.Code != 200 { // an xlsx renamed .csv: content decides
		t.Errorf("xlsx named .csv: %d %s", r.Code, r.Body.String())
	}
	csv := mfhHdr + "05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0\n"
	if r := e.uploadMF("s.xlsx", xlsxType, csv); r.Code != 200 { // a CSV renamed .xlsx is read as CSV
		t.Errorf("csv named .xlsx: %d %s", r.Code, r.Body.String())
	}
	for name, c := range map[string]struct{ file, ctype, content string }{
		"exe renamed csv": {"s.csv", "text/csv", "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00"},
		"zip not xlsx":    {"s.xlsx", xlsxType, "PK\x03\x04not a workbook"},
		"empty":           {"s.csv", "text/csv", ""},
		"exe extension":   {"s.exe", "application/octet-stream", csv},
		"pdf type":        {"s.csv", "application/pdf", csv},
	} {
		if r := e.uploadMF(c.file, c.ctype, c.content); r.Code != 422 {
			t.Errorf("%s: %d %s", name, r.Code, r.Body.String())
		}
	}
	big := mfhHdr + strings.Repeat("05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0\n", 5001)
	if r := e.uploadMF("s.csv", "text/csv", big); r.Code != 422 {
		t.Errorf("5,001 rows: %d", r.Code)
	}
	over := mfhHdr + strings.Repeat("x", 2<<20)
	if r := e.uploadMF("s.csv", "text/csv", over); r.Code != 413 {
		t.Errorf("over 2 MB: %d", r.Code)
	}
	// Template: header plus two synthetic rows.
	tr := e.do(http.MethodGet, "/api/v1/imports/templates/mf_statement", "", e.cookie, nil)
	if tr.Code != 200 || !strings.HasPrefix(tr.Body.String(), "Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty\n") || strings.Count(tr.Body.String(), "\n") != 3 {
		t.Errorf("template: %d %q", tr.Code, tr.Body.String())
	}
}

// MFH-I28: undo.
func TestMFUndo(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	csv := mfhHdr + "05-Oct-2026,Alpha Fund,Purchase,F1,10.000,10.000,100.00,0\n05-Nov-2026,Alpha Fund,Purchase,F1,10.000,10.000,100.00,0\n"
	v := e.validateMF(csv)
	_, d := e.commitMF(v["upload_id"].(string))
	batch := int64(d["batch_id"].(float64))
	// A later manual redemption of 15 units: undoing would leave it oversold -> 409, nothing changes.
	red := e.mustTxn(201, "F1", "redemption", "2026-11-09", "15", "11", "165", "0")
	r := e.post(fmt.Sprintf("/imports/batches/%d/undo", batch), "")
	if r.Code != 409 || errCode(t, r) != "UNDO_BREAKS_HOLDINGS" {
		t.Fatalf("undo breaking holdings: %d %s", r.Code, r.Body.String())
	}
	var env struct {
		Error struct {
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.Body.Bytes(), &env)
	if env.Error.Details["scheme_code"] != float64(201) || env.Error.Details["folio"] != "F1" || env.Error.Details["date"] == nil {
		t.Errorf("details %v", env.Error.Details)
	}
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE import_batch_id = $1`, batch); n != 2 || e.count(`SELECT count(*) FROM import_batch WHERE id = $1 AND undone_at IS NULL`, batch) != 1 {
		t.Error("a refused undo changed data")
	}
	e.api(http.MethodDelete, fmt.Sprintf("/portfolio/mf/txns/%d", red), "", nil)
	r = e.post(fmt.Sprintf("/imports/batches/%d/undo", batch), "")
	if r.Code != 200 {
		t.Fatalf("undo: %d %s", r.Code, r.Body.String())
	}
	ud := decodeData(t, r)
	if mfhInt(ud["removed"]) != 2 || ud["post_import_job_id"] != nil {
		t.Errorf("undo result %v", ud)
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 0 {
		t.Error("rows remain")
	}
	if r := e.post(fmt.Sprintf("/imports/batches/%d/undo", batch), ""); r.Code != 409 {
		t.Errorf("second undo: %d", r.Code)
	}
	// After 30 days.
	v = e.validateMF(csv)
	_, d = e.commitMF(v["upload_id"].(string))
	old := int64(d["batch_id"].(float64))
	e.exec(`UPDATE import_batch SET created_at = $2 WHERE id = $1`, old, mfhNow.AddDate(0, 0, -31))
	if r := e.post(fmt.Sprintf("/imports/batches/%d/undo", old), ""); r.Code != 409 {
		t.Errorf("undo after 30 days: %d", r.Code)
	}
}

// A commit whose redemption row would oversell is refused as a whole (MFH-V05 for imports).
func TestMFImportRedemptionOversell(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	csv := mfhHdr + "05-Oct-2026,Alpha Fund,Purchase,F1,10.000,10.000,100.00,0\n06-Oct-2026,Alpha Fund,Redemption,F1,11.000,10.000,110.00,0\n"
	v := e.validateMF(csv)
	r, _ := e.commitMF(v["upload_id"].(string))
	if r.Code != 422 || errCode(t, r) != "INSUFFICIENT_UNITS" {
		t.Errorf("oversell by import: %d %s", r.Code, r.Body.String())
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`) + e.count(`SELECT count(*) FROM import_batch WHERE kind = 'mf_statement'`); n != 0 {
		t.Error("the failed commit must roll back everything")
	}
}
