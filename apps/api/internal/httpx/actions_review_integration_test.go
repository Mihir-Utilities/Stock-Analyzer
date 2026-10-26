package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/actions"
	"github.com/india-analyzer/api/internal/importers"
)

// B07 review fixes (B07R-1..7). The manual and CSV entry paths share the env of the PATCH tests.

func newActImportEnv(t *testing.T) (*actEnv, *importers.Service) {
	t.Helper()
	e := newActEnv(t)
	svc := importers.New(e.pool, nil, 380, zerolog.Nop())
	svc.DBSize = func(context.Context) (int64, error) { return 10 << 20, nil }
	e.deps.Imports = svc
	e.rebuild()
	return e, svc
}

type manualData struct {
	ID       *int64 `json:"id"`
	Warnings []struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"warnings"`
}

func (m manualData) warning(code string) string {
	for _, w := range m.Warnings {
		if w.Code == code {
			return w.Message
		}
	}
	return ""
}

func (e *actEnv) manual(sym, body string) (resp, manualData) {
	e.t.Helper()
	r := e.do(http.MethodPost, "/api/v1/stocks/"+sym+"/actions", body, e.cookie, nil)
	var b struct {
		Data manualData `json:"data"`
	}
	if r.Body.Len() > 0 {
		if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
			e.t.Fatalf("decode: %v: %s", err, r.Body.String())
		}
	}
	return r, b.Data
}

func (e *actEnv) confirmedCount(inst int, exDate string) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM corporate_action WHERE instrument_id = $1 AND ex_date = $2
		AND status = 'confirmed' AND action_type IN ('split','bonus')`, inst, exDate).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// ACT-27b (B07R-1a): a manual split/bonus entered on the ex-date of an already confirmed candidate
// is stored but warns DUPLICATE_EX_DATE_ACTION with the existing id; the worker applies only one
// (apps/worker test_act27b). A repeat of the same manual key, or another date, stays silent.
func TestACT27b_ManualActionAfterConfirmWarns(t *testing.T) {
	e, _ := newActImportEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	if r, _ := e.patch("TCS", id, split102); r.Code != 200 {
		t.Fatalf("confirm %d %s", r.Code, r.Body.String())
	}
	r, m := e.manual("TCS", `{"ex_date":"2026-09-01","type":"split","ratio_num":10,"ratio_den":2,"purpose_text":"Stock split"}`)
	if r.Code != 201 {
		t.Fatalf("manual %d %s", r.Code, r.Body.String())
	}
	if msg := m.warning("DUPLICATE_EX_DATE_ACTION"); msg == "" || !strings.Contains(msg, fmt.Sprintf("action id %d", id)) {
		t.Fatalf("warning missing or without the existing id %d: %+v", id, m.Warnings)
	}
	if n := e.confirmedCount(inst, "2026-09-01"); n != 2 {
		t.Fatalf("the row is still stored: %d confirmed", n)
	}
	// A bonus on the same day warns too.
	if _, m = e.manual("TCS", `{"ex_date":"2026-09-01","type":"bonus","ratio_num":1,"ratio_den":1}`); m.warning("DUPLICATE_EX_DATE_ACTION") == "" {
		t.Fatalf("bonus: %+v", m.Warnings)
	}
	// Another date and a non-split type are silent.
	if _, m = e.manual("TCS", `{"ex_date":"2026-08-01","type":"split","ratio_num":2,"ratio_den":1}`); m.warning("DUPLICATE_EX_DATE_ACTION") != "" {
		t.Fatalf("other date: %+v", m.Warnings)
	}
	if _, m = e.manual("TCS", `{"ex_date":"2026-09-01","type":"dividend","amount_per_share":5}`); m.warning("DUPLICATE_EX_DATE_ACTION") != "" {
		t.Fatalf("dividend: %+v", m.Warnings)
	}
	// ACT-09 repeat of the same manual row updates it and does not warn against itself.
	if _, m = e.manual("TCS", `{"ex_date":"2026-08-01","type":"split","ratio_num":3,"ratio_den":1}`); m.warning("DUPLICATE_EX_DATE_ACTION") != "" {
		t.Fatalf("repeat: %+v", m.Warnings)
	}
	// A pending candidate on the date counts as well.
	e.action(inst, "2026-07-01", "split_or_bonus", "detected", "1", "2", "detected")
	if _, m = e.manual("TCS", `{"ex_date":"2026-07-01","type":"split","ratio_num":2,"ratio_den":1}`); m.warning("DUPLICATE_EX_DATE_ACTION") == "" {
		t.Fatalf("pending candidate: %+v", m.Warnings)
	}
}

// B07R-1a CSV path: a committed corporate_actions.csv that lands a second split/bonus on a date
// warns (once per file), also for two rows of the same file; rows are stored as entered.
func TestACT27b_CSVCommitWarnsOnDuplicateExDate(t *testing.T) {
	e, svc := newActImportEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	if r, _ := e.patch("TCS", id, split102); r.Code != 200 {
		t.Fatalf("confirm %d", r.Code)
	}
	commit := func(csv string) *importers.CommitResult {
		t.Helper()
		v, err := svc.Validate(context.Background(), "corporate_actions", []byte(csv), "")
		if err != nil || v.ErrorCount != 0 {
			t.Fatalf("validate: %v %+v", err, v)
		}
		res, err := svc.Commit(context.Background(), "corporate_actions", importers.CommitRequest{UploadIDs: []string{v.UploadID}})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	const hdr = "symbol,ex_date,type,ratio_num,ratio_den,amount_per_share,purpose_text\n"
	res := commit(hdr + "TCS,2026-09-01,split,10,2,,CSV split\n")
	if !containsStr(res.Warnings, "DUPLICATE_EX_DATE_ACTION") || e.confirmedCount(inst, "2026-09-01") != 2 {
		t.Fatalf("%+v", res.Warnings)
	}
	// Two rows of one file on a fresh date.
	res = commit(hdr + "TCS,2026-05-01,split,2,1,,a\nTCS,2026-05-01,bonus,1,1,,b\n")
	if !containsStr(res.Warnings, "DUPLICATE_EX_DATE_ACTION") {
		t.Fatalf("same-file duplicate: %+v", res.Warnings)
	}
	// A clean file stays silent.
	res = commit(hdr + "TCS,2026-04-01,split,2,1,,c\n")
	if containsStr(res.Warnings, "DUPLICATE_EX_DATE_ACTION") {
		t.Fatalf("clean file warned: %+v", res.Warnings)
	}
}

func containsStr(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// B07R-1b: confirming a candidate and entering a manual split for the same (stock, ex-date)
// are serialised by an advisory lock. The test holds that lock in its own transaction, starts both
// calls, waits (polling pg_locks, no fixed sleeps) until both are queued behind it or one finishes
// (= no lock taken: failure), then releases. Whichever runs first, the invariant is: confirm 200
// means the manual call warned; a manual row that landed first means confirm is a 409.
func TestACT27b_ConcurrentConfirmAndManualInsertAreSerialised(t *testing.T) {
	e, svc := newActImportEnv(t)
	for round := 0; round < 4; round++ {
		sym := fmt.Sprintf("RC%d", round)
		inst := e.stock(sym)
		id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
		ctx := context.Background()
		hold, err := e.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = hold.Rollback(ctx) }() // a failing round must not leave the lock held
		if err := importers.LockActionDate(ctx, hold, int32(inst), time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)); err != nil { //nolint:gosec // a fresh test row id fits int32
			t.Fatal(err)
		}
		type manualOut struct {
			warned bool
			err    error
		}
		confirmErr := make(chan error, 1)
		manual := make(chan manualOut, 1)
		go func() {
			_, err := e.svc.Patch(ctx, sym, id, actions.Patch{Status: "confirmed", ActionType: "split", RatioNum: "10", RatioDen: "2"})
			confirmErr <- err
		}()
		go func() {
			res, err := svc.AddAction(ctx, sym, importers.ActionEntry{ActionInput: importers.ActionInput{
				ExDate: "2026-09-01", Type: "split", RatioNum: "10", RatioDen: "2", Purpose: "Stock split"}})
			w := false
			if res != nil {
				for _, x := range res.Warnings {
					if x.Code == importers.WarnDuplicateExDateAction {
						w = true
					}
				}
			}
			manual <- manualOut{w, err}
		}()
		deadline := time.Now().Add(15 * time.Second)
		for {
			var waiting int
			if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting >= 2 {
				break
			}
			if len(confirmErr) > 0 || len(manual) > 0 {
				t.Fatalf("round %d: a call finished while the lock was held: it does not take the advisory lock", round)
			}
			if time.Now().After(deadline) {
				t.Fatalf("round %d: only %d waiters behind the lock", round, waiting)
			}
			time.Sleep(10 * time.Millisecond)
		}
		if err := hold.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		m, cerr := <-manual, <-confirmErr
		if m.err != nil {
			t.Fatalf("round %d: manual insert failed: %v", round, m.err)
		}
		var ce *actions.ConflictError
		switch {
		case cerr == nil && !m.warned:
			t.Fatalf("round %d: both went through and nothing warned (history adjusted twice unseen)", round)
		case cerr != nil && !errors.As(cerr, &ce):
			t.Fatalf("round %d: confirm failed unexpectedly: %v", round, cerr)
		}
		if n := e.confirmedCount(inst, "2026-09-01"); n < 1 || n > 2 {
			t.Fatalf("round %d: %d confirmed rows", round, n)
		}
	}
}

// ACT-26 (B07R-3): confirm without a type or ratios is 422; a confirmed row of manual source and a
// confirmed candidate with other numbers or another type are 409; a reverse split works end to end.
func TestACT26_ConfirmEdgeCases(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	r, b := e.patch("TCS", id, `{"status":"confirmed"}`)
	if r.Code != 422 || !strings.Contains(r.Body.String(), `"action_type"`) {
		t.Fatalf("empty confirm: %d %s", r.Code, r.Body.String())
	}
	_ = b
	if st, _ := e.state(id); st != "detected" {
		t.Fatalf("422 changed the row: %s", st)
	}
	// Manual-source confirmed row: a confirm with numbers is a 409, a plain confirm is an idempotent 200.
	man := e.action(inst, "2025-01-01", "split", "confirmed", "10", "2", "manual")
	if r, _ = e.patch("TCS", man, split102); r.Code != 409 {
		t.Fatalf("manual-source confirm: %d", r.Code)
	}
	if r, _ = e.patch("TCS", man, `{"status":"confirmed"}`); r.Code != 200 {
		t.Fatalf("plain confirm of confirmed: %d", r.Code)
	}
	// Confirmed candidate: other numbers and another type are both refused, the same request repeats.
	if r, _ = e.patch("TCS", id, split102); r.Code != 200 {
		t.Fatalf("confirm %d", r.Code)
	}
	for name, body := range map[string]string{
		"other numbers": `{"status":"confirmed","action_type":"split","ratio_num":5,"ratio_den":1}`,
		"other type":    `{"status":"confirmed","action_type":"bonus","ratio_num":10,"ratio_den":2}`,
	} {
		if r, _ = e.patch("TCS", id, body); r.Code != 409 {
			t.Errorf("%s: %d", name, r.Code)
		}
	}
	// Reverse split 2:10 gives multiplier 0.2 and no warning against a detected rise of x5 (1/r = 0.2).
	rev := e.action(inst, "2024-03-01", "split_or_bonus", "detected", "5", "1", "detected")
	_, b = e.patch("TCS", rev, `{"status":"confirmed","action_type":"split","ratio_num":2,"ratio_den":10}`)
	var d actData
	b.into(t, &d)
	if d.Status != "confirmed" || d.Multiplier == nil || *d.Multiplier != "0.2000" || len(d.Warnings) != 0 {
		t.Fatalf("reverse split %+v", d)
	}
	// A detected row with NULL ratios confirms silently.
	nul := e.action(inst, "2023-03-01", "split_or_bonus", "detected", "", "", "detected")
	_, b = e.patch("TCS", nul, `{"status":"confirmed","action_type":"bonus","ratio_num":1,"ratio_den":1}`)
	b.into(t, &d)
	if d.Status != "confirmed" || len(d.Warnings) != 0 {
		t.Fatalf("NULL ratios %+v", d)
	}
}

// ACT-06 boundary over HTTP: the band is 3% of the detected implied multiplier (5.0000 here).
func TestACT06_ThreePercentBoundaryOverHTTP(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	for i, tc := range []struct {
		num  string
		warn bool
	}{{"5.1450", false}, {"5.1500", false}, {"5.1550", true}, {"4.8500", false}, {"4.8450", true}} {
		id := e.action(inst, fmt.Sprintf("2026-0%d-01", i+1), "split_or_bonus", "detected", "1", "5", "detected")
		_, b := e.patch("TCS", id, fmt.Sprintf(`{"status":"confirmed","action_type":"split","ratio_num":"%s","ratio_den":1}`, tc.num))
		var d actData
		b.into(t, &d)
		if d.Status != "confirmed" || d.warned("RATIO_DISAGREES_WITH_DETECTED") != tc.warn {
			t.Errorf("%s: want warn=%v, got %+v", tc.num, tc.warn, d)
		}
	}
}

// Numeric limits: ratio_num 1e8 is refused (422, the decimalCell limit); the largest accepted value
// fits numeric(12,4) and raises RATIO_EXTREME. RATIO_EXTREME thresholds (B07R-2): above 100 or below 0.01.
func TestACT26_OverflowAndExtremeMultiplier(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	r, _ := e.patch("TCS", id, `{"status":"confirmed","action_type":"split","ratio_num":100000000,"ratio_den":1}`)
	if r.Code != 422 || !strings.Contains(r.Body.String(), `"ratio_num"`) {
		t.Fatalf("1e8: %d %s", r.Code, r.Body.String())
	}
	if st, _ := e.state(id); st != "detected" {
		t.Fatal("overflow changed the row")
	}
	for i, tc := range []struct {
		num, den string
		extreme  bool
	}{{"99999999.9999", "1", true}, {"101", "1", true}, {"100", "1", false}, {"9", "1000", true}, {"1", "100", false}} {
		rid := e.action(inst, fmt.Sprintf("2025-0%d-01", i+1), "split_or_bonus", "detected", "", "", "detected")
		_, b := e.patch("TCS", rid, fmt.Sprintf(`{"status":"confirmed","action_type":"split","ratio_num":"%s","ratio_den":"%s"}`, tc.num, tc.den))
		var d actData
		b.into(t, &d)
		if d.Status != "confirmed" || d.warned("RATIO_EXTREME") != tc.extreme {
			t.Errorf("%s:%s want extreme=%v, got %+v", tc.num, tc.den, tc.extreme, d)
		}
	}
}

// ACT-10 (IST rollover): 18:30 UTC is 00:00 IST of the next day, so an ex-date of that next day is
// today (not future); one minute earlier it is still tomorrow.
func TestACT10_ISTDateRollover(t *testing.T) {
	e := newActEnv(t)
	body := `{"status":"confirmed","action_type":"split","ratio_num":2,"ratio_den":1}`
	for i, tc := range []struct {
		now    time.Time
		exDate string
		future bool
	}{
		{time.Date(2026, 10, 23, 18, 30, 0, 0, time.UTC), "2026-10-24", false},
		{time.Date(2026, 10, 23, 18, 29, 0, 0, time.UTC), "2026-10-24", true},
		{time.Date(2026, 10, 23, 18, 30, 0, 0, time.UTC), "2026-10-25", true},
		{time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC), "2026-10-23", false},
	} {
		now := tc.now
		e.svc.Now = func() time.Time { return now }
		sym := fmt.Sprintf("IST%d", i)
		id := e.action(e.stock(sym), tc.exDate, "split_or_bonus", "detected", "1", "2", "detected")
		_, b := e.patch(sym, id, body)
		var d actData
		b.into(t, &d)
		if d.Status != "confirmed" {
			t.Fatalf("%d: %+v", i, d)
		}
		if d.FutureExDate != tc.future {
			t.Errorf("%d: now=%s ex=%s future=%v want %v", i, tc.now.Format(time.RFC3339), tc.exDate, d.FutureExDate, tc.future)
		}
	}
}

// D-K / B07R-3 (interim): confirming an action whose ex-date bars were imported as already adjusted
// is a no-op on prices; the response says so. Raw bars give no such warning.
func TestACT11_ConfirmOverSrcAdjustedBarsWarns(t *testing.T) {
	e := newActEnv(t)
	adj, raw := e.stock("ADJ"), e.stock("RAW")
	for _, c := range []struct {
		inst int
		src  bool
	}{{adj, true}, {raw, false}} {
		if _, err := e.pool.Exec(context.Background(), `INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source, src_adjusted)
			VALUES ($1,'2026-08-31',10,10,10,10,10,1000,'import',$2), ($1,'2026-09-01',10,10,10,10,10,1000,'import',$2)`, c.inst, c.src); err != nil {
			t.Fatal(err)
		}
	}
	ida := e.action(adj, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	idr := e.action(raw, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	_, b := e.patch("ADJ", ida, split102)
	var d actData
	b.into(t, &d)
	if d.Status != "confirmed" || !d.warned("ADJUSTMENT_SKIPPED_SRC_ADJUSTED") {
		t.Fatalf("adjusted bars: %+v", d)
	}
	_, b = e.patch("RAW", idr, split102)
	b.into(t, &d)
	if d.Status != "confirmed" || d.warned("ADJUSTMENT_SKIPPED_SRC_ADJUSTED") {
		t.Fatalf("raw bars: %+v", d)
	}
}

// B07R-5: a repeat (confirm or reject) enqueues post_import again on purpose: it is the retry path
// of a failed queueing (B07-6). The repeat reuses the active job, so no second job is created.
func TestB07_RepeatRequestsEnqueueAgain(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	cid := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	rid := e.action(inst, "2026-08-01", "split_or_bonus", "detected", "1", "5", "detected")
	var d actData
	for i := 1; i <= 2; i++ {
		_, b := e.patch("TCS", cid, split102)
		b.into(t, &d)
		if d.PostImportJobID == nil || d.Changed == (i == 2) {
			t.Fatalf("confirm %d: %+v", i, d)
		}
		_, b = e.patch("TCS", rid, `{"status":"rejected"}`)
		b.into(t, &d)
		if d.PostImportJobID == nil || d.Changed == (i == 2) {
			t.Fatalf("reject %d: %+v", i, d)
		}
	}
	if got := e.enq.seen(); len(got) != 4 {
		t.Fatalf("enqueue calls %v, want 4 (confirm x2, reject x2)", got)
	}
}
