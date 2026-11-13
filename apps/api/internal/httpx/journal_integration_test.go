package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/journal"
)

// jrnNow is the pinned owner clock: Thursday 2026-11-12 12:00 IST.
var jrnNow = time.Date(2026, 11, 12, 6, 30, 0, 0, time.UTC)

type jrnEnv struct {
	*pfEnv
	now *time.Time
}

func newJrnEnv(t *testing.T) *jrnEnv {
	t.Helper()
	e := newAuthEnv(t)
	now := jrnNow
	svc := journal.New(e.pool)
	svc.Now = func() time.Time { return now }
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Journal: svc})
	return &jrnEnv{pfEnv: &pfEnv{authEnv: e, cookie: e.login(ownerPassword)}, now: &now}
}

type jrnItem struct {
	ID             int64   `json:"id"`
	Symbol         string  `json:"symbol"`
	NotedOn        string  `json:"noted_on"`
	Note           string  `json:"note"`
	PriceAtNote    *string `json:"price_at_note"`
	PriceAsOf      *string `json:"price_as_of"`
	PriceSource    string  `json:"price_source"`
	PriceReason    *string `json:"price_reason"`
	ReviewOn       *string `json:"review_on"`
	Status         string  `json:"status"`
	ReviewedAt     *string `json:"reviewed_at"`
	ReviewDue      bool    `json:"review_due"`
	PortfolioTxnID *int64  `json:"portfolio_txn_id"`
	Txn            *struct {
		ID        int64  `json:"id"`
		Side      string `json:"side"`
		Qty       string `json:"qty"`
		Price     string `json:"price"`
		TradeDate string `json:"trade_date"`
	} `json:"txn"`
}

type jrnPage struct {
	Items          []jrnItem `json:"items"`
	NextCursor     *string   `json:"next_cursor"`
	Today          string    `json:"today"`
	ReviewDueCount int       `json:"review_due_count"`
}

func (e *jrnEnv) create(sym, body string, hdr map[string]string) (resp, pfBody) {
	return e.req(http.MethodPost, "/stocks/"+sym+"/journal", body, hdr)
}

func (e *jrnEnv) mustCreate(sym, body string) jrnItem {
	e.t.Helper()
	r, b := e.create(sym, body, nil)
	if r.Code != http.StatusCreated {
		e.t.Fatalf("create %s: %d %s", body, r.Code, r.Body.String())
	}
	var it jrnItem
	b.into(e.t, &it)
	return it
}

func (e *jrnEnv) list(sym, query string) jrnPage {
	e.t.Helper()
	r, b := e.req(http.MethodGet, "/stocks/"+sym+"/journal"+query, "", nil)
	if r.Code != http.StatusOK {
		e.t.Fatalf("list: %d %s", r.Code, r.Body.String())
	}
	var p jrnPage
	b.into(e.t, &p)
	return p
}

func noteBody(note string) string {
	b, _ := json.Marshal(map[string]string{"note": note})
	return string(b)
}

func fieldOf(b pfBody) string {
	raw, _ := json.Marshal(b.Error.Details)
	return string(raw)
}

// JRN-03, JRN-04, JRN-05: the price at the time and the IST note date.
func TestJournalCreateAndPrice(t *testing.T) {
	e := newJrnEnv(t)
	id := e.instrument("ACME", "2010-01-01")
	e.bar(id, "2026-11-10", 100.5)
	e.bar(id, "2026-11-11", 101.25)
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source, suspect)
	        VALUES ($1, '2026-11-12', 1, 1, 1, 999, 999, 1, 'import', true)`, id) // suspect bar: ignored
	e.bar(id, "2026-11-13", 500) // after the note day: ignored

	it := e.mustCreate("ACME", noteBody("  Bought on weakness; thesis: margins recover.  "))
	if it.Note != "Bought on weakness; thesis: margins recover." || it.Status != "open" || it.NotedOn != "2026-11-12" {
		t.Fatalf("item = %+v", it)
	}
	if it.PriceAtNote == nil || *it.PriceAtNote != "101.2500" || it.PriceAsOf == nil || *it.PriceAsOf != "2026-11-11" ||
		it.PriceSource != "your imported prices" || it.PriceReason != nil {
		t.Fatalf("price = %v %v %v %v", it.PriceAtNote, it.PriceAsOf, it.PriceSource, it.PriceReason)
	}
	if it.ReviewDue || it.ReviewedAt != nil || it.Txn != nil || it.PortfolioTxnID != nil || it.Symbol != "ACME" {
		t.Fatalf("defaults = %+v", it)
	}

	// JRN-04: no imported price at all.
	e.instrument("NOBAR", "")
	nb := e.mustCreate("nobar", noteBody("watching"))
	if nb.PriceAtNote != nil || nb.PriceAsOf != nil || nb.PriceReason == nil || *nb.PriceReason != "no_price_imported" {
		t.Fatalf("no-price item = %+v", nb)
	}

	// JRN-03: the note date is the IST date (31 Dec 18:31 UTC is already 1 Jan in India).
	*e.now = time.Date(2026, 12, 31, 18, 31, 0, 0, time.UTC)
	if got := e.mustCreate("ACME", noteBody("new year")); got.NotedOn != "2027-01-01" {
		t.Fatalf("noted_on = %s", got.NotedOn)
	}
}

// JRN-06 / JRN-07 / JRN-08 / JRN-09 through the API.
func TestJournalValidationAndEscaping(t *testing.T) {
	e := newJrnEnv(t)
	e.instrument("ACME", "")
	cases := []struct {
		name, body, field string
	}{
		{"missing note", `{}`, "note"},
		{"blank", noteBody("   "), "note"},
		{"too long", noteBody(strings.Repeat("x", 1001)), "note"},
		{"control char", noteBody("a\u0007b"), "note"},
		{"past review", `{"note":"x","review_on":"2026-11-11"}`, "review_on"},
		{"bad review", `{"note":"x","review_on":"12/11/2026"}`, "review_on"},
		{"far review", `{"note":"x","review_on":"2037-01-01"}`, "review_on"},
		{"unknown txn", `{"note":"x","portfolio_txn_id":999}`, "portfolio_txn_id"},
	}
	for _, c := range cases {
		r, b := e.create("ACME", c.body, nil)
		if r.Code != http.StatusUnprocessableEntity || b.Error.Code != "UNPROCESSABLE" || !strings.Contains(fieldOf(b), `"field":"`+c.field+`"`) {
			t.Errorf("%s: %d %s", c.name, r.Code, r.Body.String())
		}
	}
	if r, _ := e.create("ACME", `{"note":"x","price_at_note":"1"}`, nil); r.Code != http.StatusBadRequest {
		t.Errorf("unknown key: %d", r.Code)
	}
	if n := e.count(`SELECT count(*) FROM journal_note`); n != 0 {
		t.Fatalf("%d rows after failures", n)
	}
	// Boundaries accepted: 1,000 characters (multi-byte), today as the review date, newline kept.
	long := strings.Repeat("₹", 1000)
	if it := e.mustCreate("ACME", noteBody(long)); it.Note != long {
		t.Fatal("1000 characters not kept")
	}
	if it := e.mustCreate("ACME", `{"note":"line one\nline two","review_on":"2026-11-12"}`); it.Note != "line one\nline two" || !it.ReviewDue {
		t.Fatalf("item = %+v", it)
	}
	// JRN-08: hostile text comes back byte for byte (the web renders it as text).
	evil := `<script>alert(1)</script> M&M "q" 'a' \ &lt;`
	it := e.mustCreate("ACME", noteBody(evil))
	if it.Note != evil {
		t.Fatalf("note = %q", it.Note)
	}
	if got := e.list("ACME", "").Items[0]; got.Note != evil {
		t.Fatalf("listed note = %q", got.Note)
	}
}

// JRN-10 / JRN-11: review due on the owner's IST date, count over all pages and filters.
func TestJournalReviewDue(t *testing.T) {
	e := newJrnEnv(t)
	e.instrument("ACME", "")
	e.instrument("OTHER", "")
	var ids []int64
	for _, d := range []string{"2026-11-13", "2026-11-13", "2026-11-14", ""} {
		body := `{"note":"n"}`
		if d != "" {
			body = fmt.Sprintf(`{"note":"n","review_on":%q}`, d)
		}
		ids = append(ids, e.mustCreate("ACME", body).ID)
	}
	e.mustCreate("OTHER", `{"note":"other","review_on":"2026-11-13"}`)

	*e.now = time.Date(2026, 11, 12, 18, 29, 0, 0, time.UTC) // 23:59 IST on the 12th
	if p := e.list("ACME", ""); p.Today != "2026-11-12" || p.ReviewDueCount != 0 {
		t.Fatalf("before midnight: %+v", p)
	}
	*e.now = time.Date(2026, 11, 12, 18, 30, 0, 0, time.UTC) // IST midnight: the 13th
	p := e.list("ACME", "")
	if p.Today != "2026-11-13" || p.ReviewDueCount != 2 {
		t.Fatalf("at midnight: %+v", p)
	}
	due := 0
	for _, it := range p.Items {
		if it.ReviewDue {
			due++
		}
	}
	if due != 2 {
		t.Fatalf("%d items due", due)
	}
	// The count ignores paging and filters.
	if q := e.list("ACME", "?limit=1&status=reviewed"); q.ReviewDueCount != 2 || len(q.Items) != 0 {
		t.Fatalf("filtered: %+v", q)
	}
	// Marking reviewed removes the marker; the overdue date stays editable.
	r, b := e.req(http.MethodPatch, fmt.Sprintf("/journal/%d", ids[0]), `{"status":"reviewed"}`, nil)
	if r.Code != 200 {
		t.Fatalf("patch: %d %s", r.Code, r.Body.String())
	}
	var it jrnItem
	b.into(t, &it)
	if it.ReviewDue || it.Status != "reviewed" || it.ReviewedAt == nil {
		t.Fatalf("after review: %+v", it)
	}
	if q := e.list("ACME", ""); q.ReviewDueCount != 1 {
		t.Fatalf("count after review = %d", q.ReviewDueCount)
	}
}

// JRN-12: the transaction link.
func TestJournalTxnLink(t *testing.T) {
	e := newJrnEnv(t)
	a := e.instrument("ACME", "")
	o := e.instrument("OTHER", "")
	var ta, to int64
	for _, row := range []struct {
		inst int
		dst  *int64
	}{{a, &ta}, {o, &to}} {
		if err := e.pool.QueryRow(context.Background(), `INSERT INTO portfolio_txn (instrument_id, side, qty, price, fees, trade_date)
			VALUES ($1, 'buy', 10, 3500, 0, '2026-09-01') RETURNING id`, row.inst).Scan(row.dst); err != nil {
			t.Fatal(err)
		}
	}
	it := e.mustCreate("ACME", fmt.Sprintf(`{"note":"x","portfolio_txn_id":%d}`, ta))
	if it.PortfolioTxnID == nil || *it.PortfolioTxnID != ta || it.Txn == nil || it.Txn.Side != "buy" ||
		it.Txn.Qty != "10.0000" || it.Txn.Price != "3500.0000" || it.Txn.TradeDate != "2026-09-01" {
		t.Fatalf("link = %+v", it)
	}
	r, b := e.create("ACME", fmt.Sprintf(`{"note":"x","portfolio_txn_id":%d}`, to), nil)
	if r.Code != 422 || !strings.Contains(fieldOf(b), "portfolio_txn_id") {
		t.Fatalf("other stock's txn: %d %s", r.Code, r.Body.String())
	}
	// PATCH: a foreign transaction is refused, null clears.
	if r, _ := e.req(http.MethodPatch, fmt.Sprintf("/journal/%d", it.ID), fmt.Sprintf(`{"portfolio_txn_id":%d}`, to), nil); r.Code != 422 {
		t.Fatalf("patch foreign: %d", r.Code)
	}
	r, b = e.req(http.MethodPatch, fmt.Sprintf("/journal/%d", it.ID), `{"portfolio_txn_id":null}`, nil)
	var cleared jrnItem
	b.into(t, &cleared)
	if r.Code != 200 || cleared.PortfolioTxnID != nil || cleared.Txn != nil {
		t.Fatalf("clear: %d %+v", r.Code, cleared)
	}
	// Deleting the transaction later leaves the note with a null link.
	it2 := e.mustCreate("ACME", fmt.Sprintf(`{"note":"y","portfolio_txn_id":%d}`, ta))
	e.exec(`DELETE FROM portfolio_txn WHERE id = $1`, ta)
	for _, got := range e.list("ACME", "").Items {
		if got.ID == it2.ID && (got.PortfolioTxnID != nil || got.Txn != nil) {
			t.Fatalf("dangling link: %+v", got)
		}
	}
}

// JRN-13: PATCH semantics.
func TestJournalPatch(t *testing.T) {
	e := newJrnEnv(t)
	id := e.instrument("ACME", "")
	e.bar(id, "2026-11-11", 50)
	it := e.mustCreate("ACME", `{"note":"first","review_on":"2026-12-01"}`)
	path := fmt.Sprintf("/journal/%d", it.ID)
	patch := func(body string) (resp, jrnItem, pfBody) {
		r, b := e.req(http.MethodPatch, path, body, nil)
		var got jrnItem
		if r.Code == 200 {
			b.into(t, &got)
		}
		return r, got, b
	}
	r, got, _ := patch(`{"note":"  edited  "}`)
	if r.Code != 200 || got.Note != "edited" || got.ReviewOn == nil || *got.ReviewOn != "2026-12-01" || got.PriceAtNote == nil || *got.PriceAtNote != "50.0000" {
		t.Fatalf("note edit: %d %+v", r.Code, got)
	}
	if _, got, _ = patch(`{"review_on":null}`); got.ReviewOn != nil || got.Note != "edited" {
		t.Fatalf("clear review: %+v", got)
	}
	if _, got, _ = patch(`{"review_on":"2027-01-05"}`); got.ReviewOn == nil || *got.ReviewOn != "2027-01-05" {
		t.Fatalf("set review: %+v", got)
	}
	if r, _, _ = patch(`{"review_on":"2026-10-01"}`); r.Code != 422 {
		t.Fatalf("past review: %d", r.Code)
	}
	if _, got, _ = patch(`{"status":"reviewed"}`); got.Status != "reviewed" || got.ReviewedAt == nil {
		t.Fatalf("reviewed: %+v", got)
	}
	first := *got.ReviewedAt
	if _, got, _ = patch(`{"status":"reviewed","note":"again"}`); got.ReviewedAt == nil || *got.ReviewedAt != first {
		t.Fatalf("reviewed_at moved: %+v", got)
	}
	if _, got, _ = patch(`{"status":"open"}`); got.Status != "open" || got.ReviewedAt != nil {
		t.Fatalf("reopen: %+v", got)
	}
	for _, bad := range []string{`{}`, `{"status":"done"}`, `{"note":""}`, `{"review_on":5}`, `{"portfolio_txn_id":"x"}`} {
		if r, _, _ = patch(bad); r.Code != 422 {
			t.Errorf("%s: %d", bad, r.Code)
		}
	}
	for _, bad := range []string{`{"price_at_note":"1"}`, `{"noted_on":"2026-01-01"}`, `{"symbol":"X"}`} {
		if r, _, _ = patch(bad); r.Code != 400 {
			t.Errorf("%s: %d", bad, r.Code)
		}
	}
	if r, _ := e.req(http.MethodPatch, "/journal/99999", `{"note":"x"}`, nil); r.Code != 404 {
		t.Fatalf("missing: %d", r.Code)
	}
	if r, _ := e.req(http.MethodPatch, "/journal/abc", `{"note":"x"}`, nil); r.Code != 404 {
		t.Fatalf("non numeric: %d", r.Code)
	}
}

// JRN-14: filter, order and keyset paging.
func TestJournalListPaging(t *testing.T) {
	e := newJrnEnv(t)
	id := e.instrument("ACME", "")
	e.exec(`INSERT INTO journal_note (instrument_id, noted_on, note_text, status, reviewed_at)
		SELECT $1, DATE '2026-01-01' + (g % 40), 'note ' || g, CASE WHEN g % 3 = 0 THEN 'reviewed' ELSE 'open' END,
		       CASE WHEN g % 3 = 0 THEN now() END FROM generate_series(1, 120) g`, id)
	seen := map[int64]bool{}
	cursor := ""
	var prevDate string
	var prevID int64
	pages := 0
	for {
		q := "?limit=50"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		p := e.list("ACME", q)
		pages++
		for _, it := range p.Items {
			if seen[it.ID] {
				t.Fatalf("id %d twice", it.ID)
			}
			seen[it.ID] = true
			if prevDate != "" && (it.NotedOn > prevDate || (it.NotedOn == prevDate && it.ID >= prevID)) {
				t.Fatalf("order broken at %s/%d after %s/%d", it.NotedOn, it.ID, prevDate, prevID)
			}
			prevDate, prevID = it.NotedOn, it.ID
		}
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	if len(seen) != 120 || pages != 3 {
		t.Fatalf("%d notes in %d pages", len(seen), pages)
	}
	if p := e.list("ACME", "?status=reviewed&limit=200"); len(p.Items) != 40 {
		t.Fatalf("reviewed = %d", len(p.Items))
	}
	if p := e.list("ACME", "?status=open&limit=500"); len(p.Items) != 80 {
		t.Fatalf("open (limit clamped) = %d", len(p.Items))
	}
	for _, q := range []string{"?status=bogus", "?limit=0", "?cursor=zzz"} {
		if r, _ := e.req(http.MethodGet, "/stocks/ACME/journal"+q, "", nil); r.Code != 422 {
			t.Errorf("%s: %d", q, r.Code)
		}
	}
}

// JRN-15: idempotency.
func TestJournalIdempotency(t *testing.T) {
	e := newJrnEnv(t)
	e.instrument("ACME", "")
	key := "0b6c4f3e-8f3a-4a52-9c0e-0d7d1d2f3a4b"
	h := map[string]string{"Idempotency-Key": key}
	r1, b1 := e.create("ACME", noteBody("once"), h)
	r2, b2 := e.create("acme", noteBody("once"), h)
	if r1.Code != 201 || r2.Code != 201 || r1.Header().Get("Idempotent-Replayed") != "" || r2.Header().Get("Idempotent-Replayed") != "true" {
		t.Fatalf("codes %d %d headers %q %q", r1.Code, r2.Code, r1.Header().Get("Idempotent-Replayed"), r2.Header().Get("Idempotent-Replayed"))
	}
	var i1, i2 jrnItem
	b1.into(t, &i1)
	b2.into(t, &i2)
	if i1.ID != i2.ID || e.count(`SELECT count(*) FROM journal_note`) != 1 {
		t.Fatalf("not idempotent: %d vs %d", i1.ID, i2.ID)
	}
	if r, b := e.create("ACME", noteBody("different"), h); r.Code != 409 || b.Error.Code != "CONFLICT" {
		t.Fatalf("different body: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.create("ACME", noteBody("x"), map[string]string{"Idempotency-Key": "not-a-uuid"}); r.Code != 422 {
		t.Fatalf("bad key: %d", r.Code)
	}
}

// JRN-16 / JRN-17 / JRN-19: delete, the per-stock cap, unknown symbols and aliases.
func TestJournalDeleteCapAndSymbols(t *testing.T) {
	e := newJrnEnv(t)
	id := e.instrument("ACME", "")
	e.instrument("OTHER", "")
	it := e.mustCreate("ACME", noteBody("to delete"))
	r, b := e.req(http.MethodDelete, fmt.Sprintf("/journal/%d", it.ID), "", nil)
	var d struct {
		ID      int64 `json:"id"`
		Deleted bool  `json:"deleted"`
	}
	b.into(t, &d)
	if r.Code != 200 || d.ID != it.ID || !d.Deleted {
		t.Fatalf("delete: %d %s", r.Code, r.Body.String())
	}
	for _, p := range []string{fmt.Sprintf("/journal/%d", it.ID), "/journal/abc", "/journal/0"} {
		if r, _ := e.req(http.MethodDelete, p, "", nil); r.Code != 404 {
			t.Errorf("DELETE %s: %d", p, r.Code)
		}
	}
	e.exec(`INSERT INTO journal_note (instrument_id, noted_on, note_text) SELECT $1, '2026-11-01', 'n' FROM generate_series(1, 500)`, id)
	if r, b := e.create("ACME", noteBody("501st"), nil); r.Code != 409 || b.Error.Code != "CONFLICT" {
		t.Fatalf("cap: %d %s", r.Code, r.Body.String())
	}
	if r, _ := e.create("OTHER", noteBody("fine"), nil); r.Code != 201 {
		t.Fatalf("other stock: %d", r.Code)
	}
	// JRN-19
	if r, _ := e.req(http.MethodGet, "/stocks/NOPE/journal", "", nil); r.Code != 404 {
		t.Fatalf("unknown get: %d", r.Code)
	}
	if r, _ := e.create("NOPE", noteBody("x"), nil); r.Code != 404 {
		t.Fatalf("unknown post: %d", r.Code)
	}
	var otherID int
	if err := e.pool.QueryRow(context.Background(), `SELECT id FROM instrument WHERE symbol = 'OTHER'`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	e.exec(`INSERT INTO symbol_alias (old_symbol, instrument_id, changed_on) VALUES ('OLDOTHER', $1, '2026-01-01')`, otherID)
	if r, b := e.create("oldother", noteBody("via alias"), nil); r.Code != 201 {
		t.Fatalf("alias: %d %s", r.Code, r.Body.String())
	} else {
		var got jrnItem
		b.into(t, &got)
		if got.Symbol != "OTHER" {
			t.Fatalf("alias symbol = %s", got.Symbol)
		}
	}
}

// JRN-18: every route needs the session and the CSRF header.
func TestJournalAuthAndCSRF(t *testing.T) {
	e := newJrnEnv(t)
	e.instrument("ACME", "")
	it := e.mustCreate("ACME", noteBody("x"))
	routes := []struct{ method, path, body string }{
		{http.MethodGet, "/stocks/ACME/journal", ""},
		{http.MethodPost, "/stocks/ACME/journal", noteBody("y")},
		{http.MethodPatch, fmt.Sprintf("/journal/%d", it.ID), `{"note":"z"}`},
		{http.MethodDelete, fmt.Sprintf("/journal/%d", it.ID), ""},
	}
	for _, rt := range routes {
		if r := e.do(rt.method, pfBase+rt.path, rt.body, "", nil); r.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without session: %d", rt.method, rt.path, r.Code)
		}
		if rt.method == http.MethodGet {
			continue
		}
		req := e.do(rt.method, pfBase+rt.path, rt.body, e.cookie, map[string]string{CSRFHeader: ""})
		if req.Code < 400 {
			t.Errorf("%s %s without CSRF header: %d", rt.method, rt.path, req.Code)
		}
	}
	if e.count(`SELECT count(*) FROM journal_note`) != 1 {
		t.Fatal("a refused request changed data")
	}
}

// JRN-02: the database refuses what the API would never send.
func TestJournalConstraints(t *testing.T) {
	e := newJrnEnv(t)
	id := e.instrument("ACME", "")
	bad := map[string]string{
		"blank text":       `INSERT INTO journal_note (instrument_id, noted_on, note_text) VALUES ($1, '2026-11-12', '   ')`,
		"1001 characters":  `INSERT INTO journal_note (instrument_id, noted_on, note_text) VALUES ($1, '2026-11-12', repeat('x', 1001))`,
		"price no date":    `INSERT INTO journal_note (instrument_id, noted_on, note_text, price_at_note) VALUES ($1, '2026-11-12', 'x', 10)`,
		"zero price":       `INSERT INTO journal_note (instrument_id, noted_on, note_text, price_at_note, price_as_of) VALUES ($1, '2026-11-12', 'x', 0, '2026-11-11')`,
		"bad status":       `INSERT INTO journal_note (instrument_id, noted_on, note_text, status) VALUES ($1, '2026-11-12', 'x', 'done')`,
		"reviewed no time": `INSERT INTO journal_note (instrument_id, noted_on, note_text, status) VALUES ($1, '2026-11-12', 'x', 'reviewed')`,
		"open with time":   `INSERT INTO journal_note (instrument_id, noted_on, note_text, reviewed_at) VALUES ($1, '2026-11-12', 'x', now())`,
	}
	for name, q := range bad {
		if _, err := e.pool.Exec(context.Background(), q, id); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := e.pool.Exec(context.Background(), `INSERT INTO journal_note (instrument_id, noted_on, note_text) VALUES ($1, '2026-11-12', repeat('x', 1000))`, id); err != nil {
		t.Fatalf("1000 characters refused: %v", err)
	}
	// JRN-05: an instrument with notes cannot be deleted silently.
	if _, err := e.pool.Exec(context.Background(), `DELETE FROM instrument WHERE id = $1`, id); err == nil {
		t.Fatal("instrument with notes was deleted")
	}
}

// JRN-24: only the journal package, the migration, the backup and housekeeping know the table; no other
// code (alerts, Telegram, importers, exports) reads notes.
func TestJournalNotReadElsewhere(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	allowed := func(path string) bool {
		p := filepath.ToSlash(path)
		for _, ok := range []string{
			"apps/api/internal/journal/", "apps/api/internal/httpx/journal_", "db/migrations/0015_", "docs/", "tasks/",
			"apps/worker/worker/backup.py", "apps/worker/worker/housekeeping.py", "apps/worker/tests/", "openapi.yaml",
			"packages/", "PROGRESS.md", "apps/web/", ".claude/",
		} {
			if strings.Contains(p, ok) {
				return true
			}
		}
		return false
	}
	var offenders []string
	for _, dir := range []string{"apps/api", "apps/worker/worker"} {
		_ = filepath.Walk(filepath.Join(root, dir), func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			if !strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".py") && !strings.HasSuffix(path, ".sql") {
				return nil
			}
			raw, rerr := os.ReadFile(path) //nolint:gosec // G304: test-only walk of repository files
			if rerr != nil {
				return nil
			}
			if strings.Contains(string(raw), "journal_note") && !allowed(path) {
				offenders = append(offenders, path)
			}
			return nil
		})
	}
	if len(offenders) > 0 {
		t.Fatalf("journal_note referenced outside the allowed places: %v", offenders)
	}
}

// N1: concurrent creates cannot both pass the 500-note cap.
func TestJournalCapIsSerialised(t *testing.T) {
	e := newJrnEnv(t)
	id := e.instrument("ACME", "")
	e.exec(`INSERT INTO journal_note (instrument_id, noted_on, note_text) SELECT $1, '2026-11-01', 'n' FROM generate_series(1, 498)`, id)
	codes := make(chan int, 6)
	for i := 0; i < 6; i++ {
		go func(i int) {
			r := e.do(http.MethodPost, pfBase+"/stocks/ACME/journal", noteBody(fmt.Sprintf("race %d", i)), e.cookie, nil)
			codes <- r.Code
		}(i)
	}
	created := 0
	for i := 0; i < 6; i++ {
		if <-codes == http.StatusCreated {
			created++
		}
	}
	if created != 2 || e.count(`SELECT count(*) FROM journal_note`) != 500 {
		t.Fatalf("created %d, rows %d", created, e.count(`SELECT count(*) FROM journal_note`))
	}
}

// N5: bidi overrides and invisible-only notes are refused through the API too.
func TestJournalBidiAndInvisible(t *testing.T) {
	e := newJrnEnv(t)
	e.instrument("ACME", "")
	for _, bad := range []string{"a\u202Eb", "x\u2066y\u2069", "\uFEFF", "\u200B\u200D"} {
		if r, _ := e.create("ACME", noteBody(bad), nil); r.Code != http.StatusUnprocessableEntity {
			t.Errorf("%q: %d", bad, r.Code)
		}
	}
	if r, _ := e.create("ACME", noteBody("\U0001F468\u200D\U0001F469 family"), nil); r.Code != http.StatusCreated {
		t.Errorf("zwj emoji refused: %d", r.Code)
	}
}
