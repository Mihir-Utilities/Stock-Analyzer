package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/portfolio"
)

const pfBase = "/api/v1"

// pfNow is the pinned clock: Friday 2026-10-23 12:00 IST (a trading day, before the EOD cutoff).
var pfNow = time.Date(2026, 10, 23, 6, 30, 0, 0, time.UTC)

type pfEnv struct {
	*authEnv
	cookie string
}

func newPFEnv(t *testing.T) *pfEnv {
	t.Helper()
	e := newAuthEnv(t)
	svc := portfolio.New(e.pool)
	svc.Now = func() time.Time { return pfNow }
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Portfolio: svc})
	return &pfEnv{authEnv: e, cookie: e.login(ownerPassword)}
}

func (e *pfEnv) req(method, path, body string, hdr map[string]string) (resp, pfBody) {
	e.t.Helper()
	r := e.do(method, pfBase+path, body, e.cookie, hdr)
	var b pfBody
	if r.Body.Len() > 0 {
		if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
			e.t.Fatalf("decode %s %s: %v: %s", method, path, err, r.Body.String())
		}
	}
	return r, b
}

func (e *pfEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *pfEnv) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

type pfBody struct {
	Data     json.RawMessage `json:"data"`
	Meta     map[string]any  `json:"meta"`
	Warnings []struct {
		Code string `json:"code"`
	} `json:"warnings"`
	Error struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func (b pfBody) warned(code string) bool {
	for _, w := range b.Warnings {
		if w.Code == code {
			return true
		}
	}
	return false
}

func (b pfBody) into(t *testing.T, dst any) {
	t.Helper()
	if err := json.Unmarshal(b.Data, dst); err != nil {
		t.Fatalf("data: %v: %s", err, b.Data)
	}
}

func (e *pfEnv) instrument(sym, listing string) int {
	e.t.Helper()
	var id int
	if err := e.pool.QueryRow(context.Background(), `INSERT INTO instrument (symbol, name, listing_date, sector) VALUES ($1, $2, NULLIF($3,'')::date, 'IT') RETURNING id`,
		sym, sym+" Ltd", listing).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *pfEnv) bar(id int, date string, close float64) {
	e.t.Helper()
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
	        VALUES ($1, $2, $3, $3, $3, $3, $3, 1000, 'import')`, id, date, close)
}

func txnBody(sym, side, qty, price, date string) string {
	return fmt.Sprintf(`{"symbol":%q,"side":%q,"qty":%q,"price":%q,"fees":"0","trade_date":%q}`, sym, side, qty, price, date)
}

func (e *pfEnv) post(body string, hdr map[string]string) (resp, pfBody) {
	return e.req(http.MethodPost, "/portfolio/txns", body, hdr)
}

type pfSummary struct {
	Holdings []struct {
		Symbol             string  `json:"symbol"`
		Qty                string  `json:"qty"`
		AvgCost            *string `json:"avg_cost"`
		LTP                *string `json:"ltp"`
		LTPReason          *string `json:"ltp_reason"`
		MarketValue        *string `json:"market_value"`
		PriceStale         bool    `json:"price_stale"`
		Realized           string  `json:"realized_pnl"`
		Flags              []string
		AdjustmentsApplied []struct {
			Multiplier string `json:"multiplier"`
		} `json:"adjustments_applied"`
		ReviewNeeded []struct{ Type string } `json:"review_needed"`
	} `json:"holdings"`
	Totals struct {
		Invested    string  `json:"invested"`
		MarketValue *string `json:"market_value"`
		Realized    string  `json:"realized_pnl"`
	} `json:"totals"`
	Returns struct {
		XIRRPct    *float64 `json:"xirr_pct"`
		XIRRReason *string  `json:"xirr_reason"`
	} `json:"returns"`
	Benchmark struct {
		XIRRPct *float64 `json:"xirr_pct"`
		Reason  *string  `json:"reason"`
	} `json:"benchmark"`
}

func (e *pfEnv) summary(q string) (pfSummary, pfBody) {
	e.t.Helper()
	r, b := e.req(http.MethodGet, "/portfolio/summary"+q, "", nil)
	if r.Code != 200 {
		e.t.Fatalf("summary: %d %s", r.Code, r.Body.String())
	}
	var s pfSummary
	b.into(e.t, &s)
	return s, b
}

func TestPortfolioRoutesNeedSessionAndCSRF(t *testing.T) { // CLAUDE.md section 4
	e := newPFEnv(t)
	for _, c := range [][2]string{{"GET", "/watchlist"}, {"POST", "/watchlist"}, {"PATCH", "/watchlist/1"}, {"DELETE", "/watchlist/1"},
		{"GET", "/portfolio/txns"}, {"POST", "/portfolio/txns"}, {"PATCH", "/portfolio/txns/1"}, {"DELETE", "/portfolio/txns/1"},
		{"GET", "/portfolio/summary"}, {"GET", "/portfolio/adjustments"}, {"POST", "/portfolio/adjustments"}} {
		if r := e.do(c[0], pfBase+c[1], "{}", "", nil); r.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without a session = %d", c[0], c[1], r.Code)
		}
	}
	r := e.do(http.MethodPost, pfBase+"/portfolio/txns", txnBody("X", "buy", "1", "1", "2026-01-01"), e.cookie, map[string]string{CSRFHeader: ""})
	if r.Code != http.StatusForbidden {
		t.Errorf("missing CSRF header = %d", r.Code)
	}
}

func TestTxnValidation(t *testing.T) { // PF-01, PF-03, PF-05, PF-06
	e := newPFEnv(t)
	id := e.instrument("TCS", "2004-08-25")
	e.instrument("NEWCO", "2026-10-01")
	e.exec(`INSERT INTO market_holiday (holiday_date, segment) VALUES ('2026-10-02', 'trading')`)
	cases := []struct {
		name, body, field string
	}{
		{"unknown symbol", txnBody("NOPE", "buy", "1", "1", "2026-10-01"), "symbol"},
		{"future date (PF-05)", txnBody("TCS", "buy", "1", "1", "2026-10-24"), "trade_date"},
		{"before listing (PF-05)", txnBody("NEWCO", "buy", "1", "1", "2026-09-30"), "trade_date"},
		{"zero qty", txnBody("TCS", "buy", "0", "1", "2026-10-01"), "qty"},
		{"5 decimal qty", txnBody("TCS", "buy", "1.00001", "1", "2026-10-01"), "qty"},
		{"qty over 1e9", txnBody("TCS", "buy", "1000000001", "1", "2026-10-01"), "qty"},
		{"negative-looking price", txnBody("TCS", "buy", "1", "-5", "2026-10-01"), "price"},
		{"zero price", txnBody("TCS", "buy", "1", "0", "2026-10-01"), "price"},
		{"bad side", txnBody("TCS", "hold", "1", "1", "2026-10-01"), "side"},
		{"bad date", txnBody("TCS", "buy", "1", "1", "01/10/2026"), "trade_date"},
		{"negative fees", `{"symbol":"TCS","side":"buy","qty":"1","price":"1","fees":"-1","trade_date":"2026-10-01"}`, "fees"},
	}
	for _, c := range cases {
		r, b := e.post(c.body, nil)
		if r.Code != 422 || b.Error.Code != "UNPROCESSABLE" || fmt.Sprint(b.Error.Details["fields"]) == "" {
			t.Errorf("%s: %d %s", c.name, r.Code, r.Body.String())
			continue
		}
		if !strings.Contains(r.Body.String(), `"field":"`+c.field+`"`) {
			t.Errorf("%s: expected field %s in %s", c.name, c.field, r.Body.String())
		}
	}
	// PF-03: fractional quantity with 4 decimals accepted; JSON numbers also accepted.
	if r, _ := e.post(txnBody("TCS", "buy", "1.2345", "3500.5", "2026-10-01"), nil); r.Code != 201 {
		t.Fatalf("fractional: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.post(`{"symbol":"TCS","side":"buy","qty":2,"price":3500,"trade_date":"2026-10-05"}`, nil); r.Code != 201 {
		t.Fatalf("numbers: %d %s", r.Code, r.Body.String())
	}
	// PF-06: a weekend or listed holiday is a warning, not an error.
	for _, d := range []string{"2026-10-03", "2026-10-02"} { // Saturday; listed holiday
		r, b := e.post(txnBody("TCS", "buy", "1", "10", d), nil)
		if r.Code != 201 || !b.warned("NON_TRADING_DAY") {
			t.Errorf("%s: %d %s", d, r.Code, r.Body.String())
		}
	}
	// PF-01: oversell -> 422 INSUFFICIENT_HOLDINGS with details.
	r, b := e.post(txnBody("TCS", "sell", "100", "10", "2026-10-10"), nil)
	if r.Code != 422 || b.Error.Code != "INSUFFICIENT_HOLDINGS" || b.Error.Details["held_qty"] == nil {
		t.Fatalf("oversell: %d %s", r.Code, r.Body.String())
	}
	// Tracking side effect: portfolio, no backfill job enqueued.
	if e.count(`SELECT count(*) FROM instrument WHERE id = $1 AND is_tracked AND tracked_reason = 'portfolio'`, id) != 1 {
		t.Error("TCS should be tracked with reason portfolio")
	}
	if e.count(`SELECT count(*) FROM refresh_job`) != 0 {
		t.Error("manual mode must not enqueue jobs")
	}
}

func TestEditAndDeleteRevalidateSequence(t *testing.T) { // PF-02
	e := newPFEnv(t)
	e.instrument("TCS", "")
	_, b1 := e.post(txnBody("TCS", "buy", "10", "100", "2026-09-01"), nil)
	var buy1 portfolio.TxnItem
	b1.into(t, &buy1)
	_, b2 := e.post(txnBody("TCS", "buy", "5", "100", "2026-09-02"), nil)
	var buy2 portfolio.TxnItem
	b2.into(t, &buy2)
	_, b3 := e.post(txnBody("TCS", "sell", "12", "110", "2026-09-10"), nil)
	var sell portfolio.TxnItem
	b3.into(t, &sell)

	if r, b := e.req(http.MethodDelete, fmt.Sprintf("/portfolio/txns/%d", buy1.ID), "", nil); r.Code != 422 || b.Error.Code != "INSUFFICIENT_HOLDINGS" {
		t.Fatalf("delete earlier buy: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.req(http.MethodPatch, fmt.Sprintf("/portfolio/txns/%d", buy1.ID), `{"qty":"3"}`, nil); r.Code != 422 {
		t.Fatalf("shrink earlier buy: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.req(http.MethodPatch, fmt.Sprintf("/portfolio/txns/%d", buy1.ID), `{"trade_date":"2026-09-20"}`, nil); r.Code != 422 {
		t.Fatalf("move earlier buy after the sell: %d %s", r.Code, r.Body.String())
	}
	if e.count(`SELECT count(*) FROM portfolio_txn`) != 3 {
		t.Fatal("rejected edits must not change anything")
	}
	if r, _ := e.req(http.MethodPatch, fmt.Sprintf("/portfolio/txns/%d", sell.ID), `{"qty":"4","note":"trimmed"}`, nil); r.Code != 200 {
		t.Fatalf("valid edit: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.req(http.MethodDelete, fmt.Sprintf("/portfolio/txns/%d", sell.ID), "", nil); r.Code != 200 {
		t.Fatalf("delete sell: %d", r.Code)
	}
	if r, _ := e.req(http.MethodDelete, "/portfolio/txns/999999", "", nil); r.Code != 404 {
		t.Fatalf("missing id: %d", r.Code)
	}
	if r, _ := e.req(http.MethodPatch, "/portfolio/txns/abc", `{}`, nil); r.Code != 404 {
		t.Fatalf("bad id: %d", r.Code)
	}
	// Deleting every transaction releases the portfolio tracking (no prices -> untracked).
	for _, id := range []int64{buy1.ID, buy2.ID} {
		if r, _ := e.req(http.MethodDelete, fmt.Sprintf("/portfolio/txns/%d", id), "", nil); r.Code != 200 {
			t.Fatalf("delete: %d", r.Code)
		}
	}
	if e.count(`SELECT count(*) FROM instrument WHERE symbol = 'TCS' AND NOT is_tracked AND tracked_reason IS NULL`) != 1 {
		t.Error("TCS should be untracked after the last transaction is deleted")
	}
}

func TestIdempotencyKey(t *testing.T) { // PF-11
	e := newPFEnv(t)
	e.instrument("TCS", "")
	key := "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
	hdr := map[string]string{"Idempotency-Key": key}
	r1, b1 := e.post(txnBody("TCS", "buy", "10", "100", "2026-09-01"), hdr)
	r2, b2 := e.post(txnBody("tcs", "buy", "10", "100.00", "2026-09-01"), hdr) // same request, normalised
	if r1.Code != 201 || r2.Code != 201 || string(b1.Data) != string(b2.Data) || r2.Header().Get("Idempotent-Replayed") != "true" {
		t.Fatalf("replay: %d/%d %s | %s", r1.Code, r2.Code, b1.Data, b2.Data)
	}
	if e.count(`SELECT count(*) FROM portfolio_txn`) != 1 {
		t.Fatal("a replay must not create a second row")
	}
	if r, b := e.post(txnBody("TCS", "buy", "11", "100", "2026-09-01"), hdr); r.Code != 409 || b.Error.Code != "CONFLICT" {
		t.Fatalf("different body under the same key: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.post(txnBody("TCS", "buy", "10", "100", "2026-09-01"), map[string]string{"Idempotency-Key": "not-a-uuid"}); r.Code != 422 {
		t.Fatalf("bad key: %d", r.Code)
	}
	// A failed request does not burn the key.
	k2 := map[string]string{"Idempotency-Key": "4f2504e0-4f89-41d3-9a0c-0305e82c3302"}
	if r, _ := e.post(txnBody("TCS", "sell", "500", "100", "2026-09-05"), k2); r.Code != 422 {
		t.Fatalf("oversell: %d", r.Code)
	}
	if r, _ := e.post(txnBody("TCS", "sell", "5", "100", "2026-09-05"), k2); r.Code != 201 {
		t.Fatalf("retry with the same key after a failure: %d", r.Code)
	}
	// Expired keys (older than 24 h) are ignored.
	e.exec(`UPDATE idempotency_key SET created_at = now() - interval '25 hours' WHERE key = $1::uuid`, key)
	if r, _ := e.post(txnBody("TCS", "buy", "1", "100", "2026-09-06"), hdr); r.Code != 201 || r.Header().Get("Idempotent-Replayed") != "" {
		t.Fatalf("expired key: %d", r.Code)
	}
	if e.count(`SELECT count(*) FROM portfolio_txn`) != 3 {
		t.Fatalf("rows = %d", e.count(`SELECT count(*) FROM portfolio_txn`))
	}
}

func TestIdempotencyConcurrent(t *testing.T) { // PF-11 under parallel retries (race-safe collection)
	e := newPFEnv(t)
	e.instrument("TCS", "")
	hdr := map[string]string{"Idempotency-Key": "5f2504e0-4f89-41d3-9a0c-0305e82c3303"}
	body := txnBody("TCS", "buy", "10", "100", "2026-09-01")
	const n = 6
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = e.do(http.MethodPost, pfBase+"/portfolio/txns", body, e.cookie, hdr).Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != 201 {
			t.Errorf("request %d = %d", i, c)
		}
	}
	if e.count(`SELECT count(*) FROM portfolio_txn`) != 1 {
		t.Fatalf("rows = %d, want 1", e.count(`SELECT count(*) FROM portfolio_txn`))
	}
}

func TestSymbolAliasFollows(t *testing.T) { // PF-15
	e := newPFEnv(t)
	id := e.instrument("NEWSYM", "")
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol, changed_on) VALUES ($1, 'OLDSYM', '2026-01-01')`, id)
	r, b := e.post(txnBody("OLDSYM", "buy", "10", "100", "2026-09-01"), nil)
	var it portfolio.TxnItem
	b.into(t, &it)
	if r.Code != 201 || it.Symbol != "NEWSYM" {
		t.Fatalf("alias: %d %+v", r.Code, it)
	}
	_, lb := e.req(http.MethodGet, "/portfolio/txns?symbol=OLDSYM", "", nil)
	var page struct{ Items []portfolio.TxnItem }
	lb.into(t, &page)
	if len(page.Items) != 1 {
		t.Fatalf("list by old symbol: %+v", page)
	}
}

func TestTxnListPagination(t *testing.T) {
	e := newPFEnv(t)
	e.instrument("TCS", "")
	for i := 1; i <= 5; i++ {
		e.post(txnBody("TCS", "buy", "1", "10", fmt.Sprintf("2026-09-%02d", i)), nil)
	}
	var seen []string
	cursor := ""
	for page := 0; page < 5; page++ {
		r, b := e.req(http.MethodGet, "/portfolio/txns?limit=2&cursor="+cursor, "", nil)
		if r.Code != 200 {
			t.Fatalf("page %d: %d %s", page, r.Code, r.Body.String())
		}
		var p struct {
			Items      []portfolio.TxnItem `json:"items"`
			NextCursor *string             `json:"next_cursor"`
		}
		b.into(t, &p)
		for _, it := range p.Items {
			seen = append(seen, it.TradeDate)
		}
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	want := []string{"2026-09-05", "2026-09-04", "2026-09-03", "2026-09-02", "2026-09-01"}
	if fmt.Sprint(seen) != fmt.Sprint(want) {
		t.Fatalf("seen %v", seen)
	}
	if r, _ := e.req(http.MethodGet, "/portfolio/txns?cursor=garbage", "", nil); r.Code != 422 {
		t.Fatalf("bad cursor: %d", r.Code)
	}
}

func TestSummaryXIRRAndTotals(t *testing.T) { // docs/05 8.3 vector, PF-07, PF-12, PF-14
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.post(`{"symbol":"TCS","side":"buy","qty":"10","price":"100","fees":"0","trade_date":"2025-10-23"}`, nil)
	e.bar(id, "2026-10-22", 100)
	e.bar(id, "2026-10-23", 110)
	s, b := e.summary("")
	if s.Returns.XIRRPct == nil || math.Abs(*s.Returns.XIRRPct-10) > 0.05 { // 1 year, +10 %
		t.Fatalf("xirr = %v %v", s.Returns.XIRRPct, s.Returns.XIRRReason)
	}
	if *s.Totals.MarketValue != "1100.0000" || s.Totals.Invested != "1000.0000" || s.Holdings[0].Qty != "10.0000" {
		t.Fatalf("%+v", s.Totals)
	}
	if b.Meta["stale"] != false || b.Meta["source"] == "" {
		t.Errorf("meta = %v", b.Meta)
	}
	// Short span (PF-07): XIRR null with a reason.
	e.exec(`DELETE FROM portfolio_txn`)
	e.post(txnBody("TCS", "buy", "10", "100", "2026-10-15"), nil)
	s, _ = e.summary("")
	if s.Returns.XIRRPct != nil || s.Returns.XIRRReason == nil || *s.Returns.XIRRReason != "period_too_short" {
		t.Fatalf("short span: %+v", s.Returns)
	}
	// Future as_of is rejected; malformed too.
	for _, q := range []string{"?as_of=2026-10-24", "?as_of=yesterday", "?include_exited=maybe"} {
		if r, _ := e.req(http.MethodGet, "/portfolio/summary"+q, "", nil); r.Code != 422 {
			t.Errorf("%s = %d", q, r.Code)
		}
	}
	// as_of in the past ignores later transactions and bars.
	s, _ = e.summary("?as_of=2026-10-10")
	if len(s.Holdings) != 0 {
		t.Errorf("as_of before the first transaction: %+v", s.Holdings)
	}
}

func TestSummaryMissingStaleDelisted(t *testing.T) { // PF-10, PF-13
	e := newPFEnv(t)
	a := e.instrument("AAA", "")
	e.instrument("BBB", "")
	d := e.instrument("DDD", "")
	e.post(txnBody("AAA", "buy", "10", "100", "2026-09-01"), nil)
	e.post(txnBody("BBB", "buy", "10", "100", "2026-09-01"), nil)
	e.post(txnBody("DDD", "buy", "10", "100", "2026-09-01"), nil)
	e.bar(a, "2026-09-30", 120) // old bar -> stale
	e.bar(d, "2026-10-23", 80)
	e.exec(`UPDATE instrument SET status = 'delisted' WHERE id = $1`, d)
	s, b := e.summary("")
	by := map[string]int{}
	for i, h := range s.Holdings {
		by[h.Symbol] = i
	}
	aaa, bbb, ddd := s.Holdings[by["AAA"]], s.Holdings[by["BBB"]], s.Holdings[by["DDD"]]
	if !aaa.PriceStale || *aaa.LTP != "120.0000" {
		t.Errorf("AAA: %+v", aaa)
	}
	if bbb.LTP != nil || bbb.MarketValue != nil || bbb.LTPReason == nil {
		t.Errorf("BBB (no price) must be null with a reason: %+v", bbb)
	}
	if len(ddd.Flags) == 0 || ddd.Flags[0] != "delisted" || !b.warned("DELISTED_HOLDING") {
		t.Errorf("DDD: %+v", ddd)
	}
	if s.Totals.MarketValue != nil || !b.warned("MISSING_PRICE") || b.Meta["stale"] != true {
		t.Errorf("totals with a missing price must be null: %+v meta=%v", s.Totals, b.Meta)
	}
}

func TestFullExitHiddenByDefault(t *testing.T) { // PF-08
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.bar(id, "2026-10-23", 160)
	e.post(txnBody("TCS", "buy", "10", "100", "2026-09-01"), nil)
	e.post(txnBody("TCS", "sell", "10", "150", "2026-09-10"), nil)
	s, _ := e.summary("")
	if len(s.Holdings) != 0 || s.Totals.Realized != "500.0000" {
		t.Fatalf("%+v", s)
	}
	s, _ = e.summary("?include_exited=true")
	if len(s.Holdings) != 1 || s.Holdings[0].Realized != "500.0000" {
		t.Fatalf("%+v", s.Holdings)
	}
}

func (e *pfEnv) action(id int, exDate, typ, status string, num, den any) {
	e.t.Helper()
	e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, ratio_den, source)
	        VALUES ($1, $2, $3, $4, $5, $6, 'manual')`, id, exDate, typ, status, num, den)
}

func TestSplitBonusAndReview(t *testing.T) { // PF-09, ACT-05, ACT-08
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.post(txnBody("TCS", "buy", "10", "1000", "2026-08-03"), nil)
	e.bar(id, "2026-08-28", 1500)
	before, _ := e.summary("")
	e.bar(id, "2026-10-23", 300) // raw post-split bar (1500 / 5)
	// Unconfirmed candidate: no effect, warns.
	e.action(id, "2026-09-01", "split_or_bonus", "detected", 1, 5)
	s, b := e.summary("")
	if s.Holdings[0].Qty != "10.0000" || !b.warned("UNCONFIRMED_ACTION") {
		t.Fatalf("detected must not apply: %+v %v", s.Holdings[0], b.Warnings)
	}
	e.exec(`DELETE FROM corporate_action`)
	e.action(id, "2026-09-01", "split", "confirmed", 10, 2)
	after, _ := e.summary("")
	if after.Holdings[0].Qty != "50.0000" || *after.Holdings[0].AvgCost != "200.0000" || after.Totals.Invested != "10000.0000" {
		t.Fatalf("after: %+v", after.Holdings[0])
	}
	if *after.Totals.MarketValue != "15000.0000" || before.Totals.MarketValue == nil || *before.Totals.MarketValue != "15000.0000" {
		t.Fatalf("value must be invariant: before %v after %v", before.Totals.MarketValue, after.Totals.MarketValue)
	}
	if len(after.Holdings[0].AdjustmentsApplied) != 1 || after.Holdings[0].AdjustmentsApplied[0].Multiplier != "5" {
		t.Errorf("adjustments_applied = %+v", after.Holdings[0].AdjustmentsApplied)
	}
	// A sell of 50 after the ex-date is valid; 51 is not.
	if r, _ := e.post(txnBody("TCS", "sell", "51", "300", "2026-10-10"), nil); r.Code != 422 {
		t.Errorf("sell 51: %d", r.Code)
	}
	// A sell of 11 before the ex-date exceeds the 10 held then.
	if r, _ := e.post(txnBody("TCS", "sell", "11", "1500", "2026-08-28"), nil); r.Code != 422 {
		t.Errorf("pre-split sell 11: %d", r.Code)
	}
	// ACT-05: bonus 1:2 multiplies by 1.5 on top.
	e.action(id, "2026-10-01", "bonus", "confirmed", 1, 2)
	s, _ = e.summary("")
	if s.Holdings[0].Qty != "75.0000" {
		t.Errorf("bonus 1:2 qty = %s", s.Holdings[0].Qty)
	}
	// ACT-08: rights are listed for review and not applied.
	e.action(id, "2026-10-05", "rights", "confirmed", 1, 4)
	s, b = e.summary("")
	if s.Holdings[0].Qty != "75.0000" || len(s.Holdings[0].ReviewNeeded) != 1 || !b.warned("REVIEW_NEEDED") {
		t.Errorf("rights: %+v %v", s.Holdings[0], b.Warnings)
	}
}

func TestAdjustmentOverrides(t *testing.T) { // docs/05 8.2 owner override precedence
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.post(txnBody("TCS", "buy", "10", "1000", "2026-08-03"), nil)
	e.action(id, "2026-09-01", "split", "confirmed", 10, 2)
	_, gb := e.req(http.MethodGet, "/portfolio/adjustments", "", nil)
	var list struct {
		Items []struct {
			Source     string  `json:"source"`
			Multiplier *string `json:"multiplier"`
			Applied    bool    `json:"applied"`
		} `json:"items"`
	}
	gb.into(t, &list)
	if len(list.Items) != 1 || list.Items[0].Source != "confirmed_action" || *list.Items[0].Multiplier != "5" || !list.Items[0].Applied {
		t.Fatalf("list = %+v", list)
	}
	for _, c := range []struct{ name, body string }{
		{"missing multiplier", `{"symbol":"TCS","effective_date":"2026-09-01"}`},
		{"zero multiplier", `{"symbol":"TCS","effective_date":"2026-09-01","qty_multiplier":"0"}`},
		{"future date", `{"symbol":"TCS","effective_date":"2026-12-01","qty_multiplier":"2"}`},
		{"unknown symbol", `{"symbol":"NOPE","effective_date":"2026-09-01","qty_multiplier":"2"}`},
		{"action date mismatch", `{"symbol":"TCS","effective_date":"2026-09-02","qty_multiplier":"2","corporate_action_id":1}`},
	} {
		if r, _ := e.req(http.MethodPost, "/portfolio/adjustments", c.body, nil); r.Code != 422 {
			t.Errorf("%s: %d %s", c.name, r.Code, r.Body.String())
		}
	}
	r, _ := e.req(http.MethodPost, "/portfolio/adjustments", `{"symbol":"TCS","effective_date":"2026-09-01","qty_multiplier":"4","note":"owner ratio"}`, nil)
	if r.Code != 201 {
		t.Fatalf("override: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.req(http.MethodPost, "/portfolio/adjustments", `{"symbol":"TCS","effective_date":"2026-09-01","qty_multiplier":"3"}`, nil); r.Code != 409 {
		t.Fatalf("duplicate override: %d", r.Code)
	}
	s, _ := e.summary("")
	if s.Holdings[0].Qty != "40.0000" {
		t.Errorf("override must win: qty %s", s.Holdings[0].Qty)
	}
	// An override that would make a stored sell exceed holdings is rejected and not stored.
	e.post(txnBody("TCS", "sell", "40", "300", "2026-10-01"), nil)
	e.exec(`DELETE FROM portfolio_adjustment`)
	e.exec(`DELETE FROM corporate_action`)
	if r, b := e.req(http.MethodPost, "/portfolio/adjustments", `{"symbol":"TCS","effective_date":"2026-09-01","qty_multiplier":"2"}`, nil); r.Code != 422 || b.Error.Code != "INSUFFICIENT_HOLDINGS" {
		t.Fatalf("breaking override: %d %s", r.Code, r.Body.String())
	}
	if e.count(`SELECT count(*) FROM portfolio_adjustment`) != 0 {
		t.Error("rejected override must not be stored")
	}
}

func TestBenchmarkFromMarketSeries(t *testing.T) {
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.post(txnBody("TCS", "buy", "10", "100", "2025-10-23"), nil)
	e.bar(id, "2026-10-23", 110)
	if s, _ := e.summary(""); s.Benchmark.XIRRPct != nil || s.Benchmark.Reason == nil || *s.Benchmark.Reason != "benchmark_unavailable" {
		t.Fatalf("no series: %+v", s.Benchmark)
	}
	e.exec(`INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50','2025-10-22',20000),('NIFTY50','2026-10-23',22000)`)
	if s, _ := e.summary(""); s.Benchmark.XIRRPct == nil || math.Abs(*s.Benchmark.XIRRPct-10) > 0.05 {
		t.Fatalf("series: %+v", s.Benchmark)
	}
}

func TestWatchlist(t *testing.T) {
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.instrument("INFY", "")
	e.bar(id, "2026-10-22", 100)
	e.bar(id, "2026-10-23", 103)
	e.exec(`INSERT INTO mf_scheme (code, name) VALUES (120503, 'Test Fund - Direct - Growth')`)
	e.exec(`INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES (120503,'2026-10-21',50),(120503,'2026-10-22',51)`)

	r, b := e.req(http.MethodPost, "/watchlist", `{"type":"stock","symbol":"tcs","note":"core"}`, nil)
	if r.Code != 201 {
		t.Fatalf("add: %d %s", r.Code, r.Body.String())
	}
	var entry portfolio.WatchEntry
	b.into(t, &entry)
	if *entry.Symbol != "TCS" || entry.Note != "core" {
		t.Fatalf("%+v", entry)
	}
	if e.count(`SELECT count(*) FROM instrument WHERE id=$1 AND is_tracked AND tracked_reason='watchlist'`, id) != 1 {
		t.Error("tracking not set")
	}
	if r, b := e.req(http.MethodPost, "/watchlist", `{"type":"stock","symbol":"TCS"}`, nil); r.Code != 409 || b.Error.Code != "CONFLICT" {
		t.Errorf("duplicate: %d", r.Code)
	}
	if r, _ := e.req(http.MethodPost, "/watchlist", `{"type":"stock","symbol":"NOPE"}`, nil); r.Code != 404 {
		t.Errorf("unknown: %d", r.Code)
	}
	if r, _ := e.req(http.MethodPost, "/watchlist", `{"type":"x"}`, nil); r.Code != 422 {
		t.Errorf("bad type: %d", r.Code)
	}
	if r, _ := e.req(http.MethodPost, "/watchlist", `{"type":"mf","code":120503}`, nil); r.Code != 201 {
		t.Errorf("mf add: %d", r.Code)
	}
	if r, _ := e.req(http.MethodPost, "/watchlist", `{"type":"mf","code":120503}`, nil); r.Code != 409 {
		t.Errorf("mf duplicate: %d", r.Code)
	}
	_, lb := e.req(http.MethodGet, "/watchlist", "", nil)
	var wl struct {
		Stocks []struct {
			Symbol    string   `json:"symbol"`
			LTP       *float64 `json:"ltp"`
			ChangePct *float64 `json:"change_pct"`
		} `json:"stocks"`
		Funds []struct {
			Code      int      `json:"code"`
			NAV       *float64 `json:"nav"`
			ChangePct *float64 `json:"change_pct"`
		} `json:"funds"`
	}
	lb.into(t, &wl)
	if len(wl.Stocks) != 1 || *wl.Stocks[0].LTP != 103 || math.Abs(*wl.Stocks[0].ChangePct-3) > 1e-9 {
		t.Fatalf("stocks = %+v", wl.Stocks)
	}
	if len(wl.Funds) != 1 || *wl.Funds[0].NAV != 51 || math.Abs(*wl.Funds[0].ChangePct-2) > 1e-9 {
		t.Fatalf("funds = %+v", wl.Funds)
	}
	if e.count(`SELECT count(*) FROM mf_scheme WHERE code=120503 AND is_tracked`) != 1 {
		t.Error("mf tracking not set")
	}
	// Note patch: max 500 characters.
	if r, _ := e.req(http.MethodPatch, fmt.Sprintf("/watchlist/%d", entry.ID), `{"note":"new"}`, nil); r.Code != 200 {
		t.Errorf("patch: %d", r.Code)
	}
	long := make([]byte, 501)
	for i := range long {
		long[i] = 'x'
	}
	if r, _ := e.req(http.MethodPatch, fmt.Sprintf("/watchlist/%d", entry.ID), `{"note":"`+string(long)+`"}`, nil); r.Code != 422 {
		t.Errorf("long note: %d", r.Code)
	}
	// Remove: prices are kept (D-C) and imported prices keep the stock tracked as 'imported'.
	bars := e.count(`SELECT count(*) FROM price_daily WHERE instrument_id=$1`, id)
	if r, _ := e.req(http.MethodDelete, fmt.Sprintf("/watchlist/%d", entry.ID), "", nil); r.Code != 200 {
		t.Fatalf("delete: %d", r.Code)
	}
	if e.count(`SELECT count(*) FROM price_daily WHERE instrument_id=$1`, id) != bars {
		t.Error("imported prices must never be deleted")
	}
	if e.count(`SELECT count(*) FROM instrument WHERE id=$1 AND is_tracked AND tracked_reason='imported'`, id) != 1 {
		t.Error("imported prices keep the stock tracked")
	}
	if r, _ := e.req(http.MethodDelete, fmt.Sprintf("/watchlist/%d", entry.ID), "", nil); r.Code != 404 {
		t.Errorf("second delete: %d", r.Code)
	}
}

func TestWatchlistRemoveKeepsPortfolioAndUntracksBare(t *testing.T) {
	e := newPFEnv(t)
	a := e.instrument("AAA", "")
	bare := e.instrument("BBB", "")
	e.post(txnBody("AAA", "buy", "1", "10", "2026-09-01"), nil)
	_, ba := e.req(http.MethodPost, "/watchlist", `{"type":"stock","symbol":"AAA"}`, nil)
	_, bb := e.req(http.MethodPost, "/watchlist", `{"type":"stock","symbol":"BBB"}`, nil)
	var ea, eb portfolio.WatchEntry
	ba.into(t, &ea)
	bb.into(t, &eb)
	if e.count(`SELECT count(*) FROM instrument WHERE id=$1 AND tracked_reason='portfolio'`, a) != 1 {
		t.Error("watchlist add must not downgrade a portfolio stock")
	}
	e.req(http.MethodDelete, fmt.Sprintf("/watchlist/%d", ea.ID), "", nil)
	e.req(http.MethodDelete, fmt.Sprintf("/watchlist/%d", eb.ID), "", nil)
	if e.count(`SELECT count(*) FROM instrument WHERE id=$1 AND is_tracked AND tracked_reason='portfolio'`, a) != 1 {
		t.Error("portfolio keeps tracking")
	}
	if e.count(`SELECT count(*) FROM instrument WHERE id=$1 AND NOT is_tracked`, bare) != 1 {
		t.Error("a stock with nothing keeping it becomes untracked")
	}
}
