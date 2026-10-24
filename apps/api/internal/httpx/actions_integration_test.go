package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/actions"
	"github.com/india-analyzer/api/internal/jobs"
)

// recEnqueuer records the queued targets (mutex-guarded: handlers run in parallel in one test).
type recEnqueuer struct {
	mu      sync.Mutex
	targets []string
	err     error
}

func (r *recEnqueuer) EnqueuePostImportTarget(_ context.Context, target string, symbols []string) (jobs.Job, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return jobs.Job{}, false, r.err
	}
	r.targets = append(r.targets, fmt.Sprintf("%s:%s", target, strings.Join(symbols, ",")))
	return jobs.Job{ID: int64(len(r.targets))}, true, nil
}

func (r *recEnqueuer) seen() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.targets...)
}

type actBody struct {
	Data  json.RawMessage `json:"data"`
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func (b actBody) into(t *testing.T, dst any) {
	t.Helper()
	if err := json.Unmarshal(b.Data, dst); err != nil {
		t.Fatalf("data: %v: %s", err, b.Data)
	}
}

type actEnv struct {
	*authEnv
	cookie string
	enq    *recEnqueuer
	svc    *actions.Service
}

func newActEnv(t *testing.T) *actEnv {
	t.Helper()
	e := newAuthEnv(t)
	enq := &recEnqueuer{}
	svc := actions.New(e.pool, enq, zerolog.Nop())
	svc.Now = func() time.Time { return time.Date(2026, 10, 23, 6, 30, 0, 0, time.UTC) }
	e.deps.Actions = svc
	e.rebuild()
	return &actEnv{authEnv: e, cookie: e.login(ownerPassword), enq: enq, svc: svc}
}

func (e *actEnv) patch(sym string, id int64, body string) (resp, actBody) {
	e.t.Helper()
	r := e.do(http.MethodPatch, fmt.Sprintf("/api/v1/stocks/%s/actions/%d", sym, id), body, e.cookie, nil)
	var b actBody
	if r.Body.Len() > 0 {
		if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
			e.t.Fatalf("decode: %v: %s", err, r.Body.String())
		}
	}
	return r, b
}

func (e *actEnv) stock(sym string) int {
	e.t.Helper()
	var id int
	if err := e.pool.QueryRow(context.Background(), `INSERT INTO instrument (symbol, name) VALUES ($1, $1 || ' Ltd') RETURNING id`, sym).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

// action inserts a corporate_action row and returns its id.
func (e *actEnv) action(inst int, exDate, typ, status, num, den, source string) int64 {
	e.t.Helper()
	var id int64
	err := e.pool.QueryRow(context.Background(), `INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, ratio_den, source)
		VALUES ($1, $2, $3, $4, NULLIF($5,'')::numeric, NULLIF($6,'')::numeric, $7) RETURNING id`, inst, exDate, typ, status, num, den, source).Scan(&id)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *actEnv) state(id int64) (status, typ string) {
	e.t.Helper()
	if err := e.pool.QueryRow(context.Background(), `SELECT status, action_type FROM corporate_action WHERE id = $1`, id).Scan(&status, &typ); err != nil {
		e.t.Fatal(err)
	}
	return
}

type actData struct {
	ID              int64   `json:"id"`
	Status          string  `json:"status"`
	ActionType      string  `json:"action_type"`
	Multiplier      *string `json:"multiplier"`
	FutureExDate    bool    `json:"future_ex_date"`
	Changed         bool    `json:"changed"`
	PostImportJobID *int64  `json:"post_import_job_id"`
	Warnings        []struct {
		Code string `json:"code"`
	} `json:"warnings"`
}

func (d actData) warned(code string) bool {
	for _, w := range d.Warnings {
		if w.Code == code {
			return true
		}
	}
	return false
}

const split102 = `{"status":"confirmed","action_type":"split","ratio_num":10,"ratio_den":"2"}`

// ACT-03: confirming a detected candidate stores the owner's type and numbers, sets the
// multiplier the portfolio math uses and queues the re-adjust and analysis chain.
func TestACT03_ConfirmSplitQueuesReadjust(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	r, b := e.patch("TCS", id, split102)
	if r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var d actData
	b.into(t, &d)
	if d.Status != "confirmed" || d.ActionType != "split" || !d.Changed || d.Multiplier == nil || *d.Multiplier != "5.0000" {
		t.Fatalf("%+v", d)
	}
	if len(d.Warnings) != 0 || d.FutureExDate || d.PostImportJobID == nil {
		t.Fatalf("%+v", d)
	}
	if got := e.enq.seen(); len(got) != 1 || got[0] != fmt.Sprintf("action:%d:TCS", id) {
		t.Fatalf("queued %v", got)
	}
	var num, den string
	if err := e.pool.QueryRow(context.Background(), `SELECT ratio_num::text, ratio_den::text FROM corporate_action WHERE id=$1`, id).Scan(&num, &den); err != nil || num != "10.0000" || den != "2.0000" {
		t.Fatalf("%s %s %v", num, den, err)
	}
	// A repeat is idempotent: same state, no second change.
	r, b = e.patch("TCS", id, split102)
	b.into(t, &d)
	if r.Code != 200 || d.Changed || d.Status != "confirmed" {
		t.Fatalf("%d %+v", r.Code, d)
	}
	// The same candidate with other numbers is refused: the history was already adjusted.
	if r, _ = e.patch("TCS", id, `{"status":"confirmed","action_type":"split","ratio_num":5,"ratio_den":1}`); r.Code != 409 {
		t.Fatalf("different numbers: %d", r.Code)
	}
}

// The real job chain: B09's Go enqueue writes a post_import refresh_job with target action:<id>.
func TestACT03_RealJobEnqueue(t *testing.T) {
	e := newActEnv(t)
	js := jobs.New(e.pool, nil, jobs.Config{}, zerolog.Nop())
	e.svc = actions.New(e.pool, js, zerolog.Nop())
	e.svc.Now = func() time.Time { return time.Date(2026, 10, 23, 6, 30, 0, 0, time.UTC) }
	e.deps.Actions = e.svc
	e.rebuild()
	inst := e.stock("INFY")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "2", "detected")
	if r, _ := e.patch("INFY", id, `{"status":"confirmed","action_type":"bonus","ratio_num":1,"ratio_den":1}`); r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var kind, status, target, rem string
	if err := e.pool.QueryRow(context.Background(), `SELECT kind, status, target, result->>'remaining' FROM refresh_job`).Scan(&kind, &status, &target, &rem); err != nil {
		t.Fatal(err)
	}
	if kind != "post_import" || status != "queued" || target != fmt.Sprintf("action:%d", id) || rem != `["INFY"]` {
		t.Fatalf("%s %s %s %s", kind, status, target, rem)
	}
}

// ACT-04: rejecting is sticky; a rejected candidate cannot be confirmed, a repeat reject is a no-op.
func TestACT04_RejectIsSticky(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "2", "detected")
	r, b := e.patch("TCS", id, `{"status":"rejected"}`)
	var d actData
	b.into(t, &d)
	if r.Code != 200 || d.Status != "rejected" || !d.Changed || d.Multiplier != nil {
		t.Fatalf("%d %+v", r.Code, d)
	}
	if r, b = e.patch("TCS", id, `{"status":"rejected"}`); r.Code != 200 {
		t.Fatalf("repeat %d", r.Code)
	}
	b.into(t, &d)
	if d.Changed {
		t.Fatal("repeat reported a change")
	}
	if r, _ = e.patch("TCS", id, split102); r.Code != 409 {
		t.Fatalf("confirm after reject: %d", r.Code)
	}
	if st, typ := e.state(id); st != "rejected" || typ != "split_or_bonus" {
		t.Fatalf("%s %s", st, typ)
	}
	// Rejecting re-runs the analysis (the UNCONFIRMED_ACTION warning clears).
	if len(e.enq.seen()) < 1 {
		t.Fatal("no recompute queued after reject")
	}
	// A confirmed action cannot be rejected.
	cid := e.action(inst, "2025-01-01", "split", "confirmed", "10", "2", "manual")
	if r, _ = e.patch("TCS", cid, `{"status":"rejected"}`); r.Code != 409 {
		t.Fatalf("reject confirmed: %d", r.Code)
	}
}

// ACT-06: a multiplier more than 3% away from the detected 1/r warns but is accepted; within 3% is silent.
func TestACT06_MultiplierDisagreesWarns(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected") // implied x5
	_, b := e.patch("TCS", id, `{"status":"confirmed","action_type":"split","ratio_num":10,"ratio_den":3}`)
	var d actData
	b.into(t, &d)
	if d.Status != "confirmed" || !d.warned("RATIO_DISAGREES_WITH_DETECTED") || d.Multiplier == nil || *d.Multiplier != "3.3333" {
		t.Fatalf("%+v", d)
	}
	id2 := e.action(inst, "2026-08-01", "split_or_bonus", "detected", "1", "2", "detected")                   // implied x2
	_, b = e.patch("TCS", id2, `{"status":"confirmed","action_type":"bonus","ratio_num":1,"ratio_den":1.03}`) // 1.9709 vs 2: 1.5%
	b.into(t, &d)
	if d.warned("RATIO_DISAGREES_WITH_DETECTED") {
		t.Fatalf("1.5%% off should not warn: %+v", d)
	}
}

// ACT-09: the unique key forbids duplicate rows; a double confirm (even concurrent) changes one
// row once, and a confirmed split on the same ex-date blocks confirming the detected twin (never
// adjust twice, B06b-12).
func TestACT09_NoDoubleConfirm(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	e.action(inst, "2024-06-12", "split", "confirmed", "10", "2", "manual")
	if _, err := e.pool.Exec(context.Background(), `INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source)
		VALUES ($1,'2024-06-12','split','confirmed','manual')`, inst); err == nil {
		t.Fatal("duplicate (stock, ex_date, type, purpose) was accepted")
	}
	twin := e.action(inst, "2024-06-12", "split_or_bonus", "detected", "1", "5", "detected")
	r, b := e.patch("TCS", twin, split102)
	if r.Code != 409 || !strings.Contains(b.Error.Message, "twice") {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	if st, _ := e.state(twin); st != "detected" {
		t.Fatalf("twin changed to %s", st)
	}
	// The owner resolves it by rejecting the candidate.
	if r, _ = e.patch("TCS", twin, `{"status":"rejected"}`); r.Code != 200 {
		t.Fatalf("reject twin %d", r.Code)
	}

	// Concurrent double confirm: one change, the rest are idempotent repeats; one confirmed row.
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "5", "detected")
	var wg sync.WaitGroup
	changed := make(chan bool, 8)
	codes := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := e.svc.Patch(context.Background(), "TCS", id, actions.Patch{Status: "confirmed", ActionType: "split", RatioNum: "10", RatioDen: "2"})
			if err != nil {
				codes <- 500
				return
			}
			codes <- 200
			changed <- res.Changed
		}()
	}
	wg.Wait()
	close(changed)
	close(codes)
	for c := range codes {
		if c != 200 {
			t.Fatalf("concurrent confirm failed: %d", c)
		}
	}
	n := 0
	for c := range changed {
		if c {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d requests changed the row, want 1", n)
	}
}

// ACT-10: a future ex-date can be confirmed (stored and flagged); applying waits for ex_date <= as_of in the worker.
func TestACT10_FutureExDateFlagged(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-12-01", "split_or_bonus", "detected", "1", "2", "detected")
	_, b := e.patch("TCS", id, `{"status":"confirmed","action_type":"split","ratio_num":2,"ratio_den":1}`)
	var d actData
	b.into(t, &d)
	if d.Status != "confirmed" || !d.FutureExDate {
		t.Fatalf("%+v", d)
	}
	past := e.action(inst, "2026-10-23", "split_or_bonus", "detected", "1", "2", "detected") // today: applies
	_, b = e.patch("TCS", past, `{"status":"confirmed","action_type":"split","ratio_num":2,"ratio_den":1}`)
	b.into(t, &d)
	if d.FutureExDate {
		t.Fatalf("today's ex-date flagged as future: %+v", d)
	}
}

func TestB07_ValidationAuthAndIDOR(t *testing.T) {
	e := newActEnv(t)
	tcs, infy := e.stock("TCS"), e.stock("INFY")
	id := e.action(tcs, "2026-09-01", "split_or_bonus", "detected", "1", "2", "detected")
	for name, tc := range map[string]struct {
		body, field string
	}{
		"no type":       {`{"status":"confirmed","ratio_num":2,"ratio_den":1}`, "action_type"},
		"dividend type": {`{"status":"confirmed","action_type":"dividend","ratio_num":2,"ratio_den":1}`, "action_type"},
		"no ratios":     {`{"status":"confirmed","action_type":"split"}`, "ratio_num"},
		"zero ratio":    {`{"status":"confirmed","action_type":"split","ratio_num":0,"ratio_den":1}`, "ratio_num"},
		"equal split":   {`{"status":"confirmed","action_type":"split","ratio_num":2,"ratio_den":2}`, "ratio_num"},
		"bad status":    {`{"status":"detected"}`, "status"},
		"reject+ratio":  {`{"status":"rejected","ratio_num":2}`, "status"},
	} {
		r, b := e.patch("TCS", id, tc.body)
		if r.Code != 422 || len(b.Error.Details) == 0 || !strings.Contains(r.Body.String(), `"`+tc.field+`"`) {
			t.Errorf("%s: %d %s", name, r.Code, r.Body.String())
		}
	}
	if r, _ := e.patch("TCS", id, `{"status":"confirmed","bogus":1}`); r.Code != 400 && r.Code != 422 {
		t.Errorf("unknown field: %d", r.Code)
	}
	if st, _ := e.state(id); st != "detected" {
		t.Fatalf("a refused request changed the row: %s", st)
	}
	// IDOR: the id of another stock's action under this symbol is a 404; so are unknown ids and symbols.
	other := e.action(infy, "2026-09-01", "split_or_bonus", "detected", "1", "2", "detected")
	for _, c := range []struct {
		sym string
		id  int64
	}{{"TCS", other}, {"TCS", 99999}, {"NOPE", id}, {"INFY", id}} {
		if r, _ := e.patch(c.sym, c.id, `{"status":"rejected"}`); r.Code != 404 {
			t.Errorf("%s/%d: %d", c.sym, c.id, r.Code)
		}
	}
	if st, _ := e.state(other); st != "detected" {
		t.Fatal("IDOR changed another stock's action")
	}
	// Auth and CSRF.
	url := fmt.Sprintf("/api/v1/stocks/TCS/actions/%d", id)
	if r := e.do(http.MethodPatch, url, `{"status":"rejected"}`, "", nil); r.Code != 401 {
		t.Errorf("anonymous: %d", r.Code)
	}
	if r := e.do(http.MethodPatch, url, `{"status":"rejected"}`, e.cookie, map[string]string{CSRFHeader: ""}); r.Code != 403 {
		t.Errorf("no csrf: %d", r.Code)
	}
}

// A queue failure never undoes the owner's decision; a repeat retries the enqueue.
func TestB07_QueueFailureKeepsDecision(t *testing.T) {
	e := newActEnv(t)
	inst := e.stock("TCS")
	id := e.action(inst, "2026-09-01", "split_or_bonus", "detected", "1", "2", "detected")
	e.enq.mu.Lock()
	e.enq.err = errors.New("db down")
	e.enq.mu.Unlock()
	r, b := e.patch("TCS", id, `{"status":"confirmed","action_type":"split","ratio_num":2,"ratio_den":1}`)
	var d actData
	b.into(t, &d)
	if r.Code != 200 || d.Status != "confirmed" || !d.warned("POST_IMPORT_NOT_QUEUED") || d.PostImportJobID != nil {
		t.Fatalf("%d %+v", r.Code, d)
	}
	e.enq.mu.Lock()
	e.enq.err = nil
	e.enq.mu.Unlock()
	_, b = e.patch("TCS", id, `{"status":"confirmed"}`)
	b.into(t, &d)
	if d.PostImportJobID == nil || d.Changed {
		t.Fatalf("retry: %+v", d)
	}
}
