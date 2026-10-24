package httpx

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/egress"
	"github.com/india-analyzer/api/internal/jobs"
)

const testHMACKey = "0123456789abcdef0123456789abcdef-test-key"

// fakeWorker mirrors worker-http's verification (apps/worker/worker/http.py): fresh unix-second
// timestamp within 120 s, constant-time HMAC compare, single-use signatures, 202 on success.
type fakeWorker struct {
	t    *testing.T
	mu   sync.Mutex
	seen map[string]bool
	now  func() time.Time

	calls    atomic.Int32
	rejected atomic.Int32
	lastReq  struct {
		hdr  http.Header
		body []byte
		path string
	}
	status int // forced status after auth succeeds (0 = 202)
}

func newFakeWorker(t *testing.T) (*fakeWorker, *httptest.Server) {
	fw := &fakeWorker{t: t, seen: map[string]bool{}, now: time.Now}
	srv := httptest.NewServer(http.HandlerFunc(fw.serve))
	t.Cleanup(srv.Close)
	return fw, srv
}

func (f *fakeWorker) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	ts := r.Header.Get("X-Timestamp")
	sig := r.Header.Get("X-Signature")
	n, err := strconv.ParseInt(ts, 10, 64)
	ok := err == nil && r.Method == http.MethodPost && r.URL.Path == "/run"
	if ok {
		d := f.now().Unix() - n
		if d < -120 || d > 120 {
			ok = false
		}
	}
	if ok {
		want := jobs.Sign(testHMACKey, n, r.Method, r.URL.Path, body)
		ok = hmac.Equal([]byte(want), []byte(strings.ToLower(sig)))
	}
	f.mu.Lock()
	if ok {
		if f.seen[sig] {
			ok = false // replay
		}
		f.seen[sig] = true
	}
	f.lastReq.hdr, f.lastReq.body, f.lastReq.path = r.Header.Clone(), body, r.URL.Path
	f.mu.Unlock()
	if !ok {
		f.rejected.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	f.calls.Add(1)
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte(`{"status":"running"}`))
}

type jobEnv struct {
	*authEnv
	fw     *fakeWorker
	srv    *httptest.Server
	svc    *jobs.Service
	cookie string
}

func newJobEnv(t *testing.T, cfg jobs.Config) *jobEnv {
	t.Helper()
	a := newAuthEnv(t)
	fw, srv := newFakeWorker(t)
	base, _ := url.Parse(srv.URL)
	eg, err := egress.New(egress.FromURL(base))
	if err != nil {
		t.Fatal(err)
	}
	svc := jobs.New(a.pool, &jobs.Worker{Base: base, Key: testHMACKey, HC: eg}, cfg, zerolog.New(io.Discard))
	a.h = NewRouter(Deps{Log: zerolog.New(io.Discard), Accounts: a.svc, Pinger: &fakePinger{}, Jobs: svc})
	e := &jobEnv{authEnv: a, fw: fw, srv: srv, svc: svc}
	e.cookie = a.login(ownerPassword)
	return e
}

func (e *jobEnv) mustExec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *jobEnv) seedScheme(code int) {
	e.mustExec(`INSERT INTO mf_scheme (code, name) VALUES ($1, $2)`, code, "Test Fund "+strconv.Itoa(code))
}

func (e *jobEnv) count(where string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM refresh_job WHERE `+where, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

var defaultJobCfg = jobs.Config{Cooldown: 15 * time.Minute, GlobalHour: 30}

// Golden vector computed with worker.http.sign (Python) for the same inputs: the Go caller signs
// exactly as worker-http verifies (docs/04 section 4, D01-A3).
func TestSignMatchesWorkerGoldenVector(t *testing.T) {
	got := jobs.Sign("k-0123456789abcdef0123456789abcdef", 1790000000, "POST", "/run", []byte(`{"job_id":12}`))
	const want = "0c38f644ed5abdc7a33dbad8c06e36d97358a54614bafb3f527786d21a228c90"
	if got != want {
		t.Fatalf("signature %s does not match the Python reference %s", got, want)
	}
}

// API-06: concurrent refresh clicks create a single job and a single worker call.
func TestConcurrentRefreshSingleJob(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	e.seedScheme(120503)
	const n = 25
	var wg sync.WaitGroup
	codes := make([]int, n)
	ids := make([]float64, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := e.do(http.MethodPost, "/api/v1/mf/schemes/120503/refresh", "", e.cookie, nil)
			codes[i] = rec.Code
			var env struct {
				Data map[string]any `json:"data"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &env)
			if v, ok := env.Data["job_id"].(float64); ok {
				ids[i] = v
			} else if v, ok := env.Data["id"].(float64); ok {
				ids[i] = v
			}
		}(i)
	}
	wg.Wait()
	e.svc.Wait()
	created := 0
	for i := range codes {
		switch codes[i] {
		case http.StatusAccepted:
			created++
		case http.StatusOK:
		default:
			t.Fatalf("click %d: unexpected status %d", i, codes[i])
		}
		if ids[i] != ids[0] || ids[i] == 0 {
			t.Fatalf("clicks returned different job ids: %v", ids)
		}
	}
	if created != 1 {
		t.Fatalf("%d clicks created a job, want exactly 1", created)
	}
	if c := e.count(`kind='mf_refresh' AND target='120503'`); c != 1 {
		t.Fatalf("%d rows, want 1", c)
	}
	if c := e.fw.calls.Load(); c != 1 {
		t.Fatalf("worker called %d times, want 1", c)
	}
}

func TestMFRefreshResponseShapeAndWorkerRequest(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	e.seedScheme(100001)
	rec := e.do(http.MethodPost, "/api/v1/mf/schemes/100001/refresh", "", e.cookie, nil)
	if rec.Code != 202 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var env struct {
		Data struct {
			JobID   int64  `json:"job_id"`
			Status  string `json:"status"`
			Expect  int    `json:"expected_wait_seconds"`
			Unknown any    `json:"x"`
		} `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	if env.Data.JobID < 1 || env.Data.Status != "queued" || env.Data.Expect != 90 {
		t.Fatalf("unexpected body %s", rec.Body)
	}
	e.svc.Wait()
	var sent struct {
		JobID int64 `json:"job_id"`
	}
	if err := json.Unmarshal(e.fw.lastReq.body, &sent); err != nil || sent.JobID != env.Data.JobID {
		t.Fatalf("worker body %q", e.fw.lastReq.body)
	}
	if e.fw.lastReq.path != "/run" || e.fw.calls.Load() != 1 {
		t.Fatalf("worker path %q calls %d", e.fw.lastReq.path, e.fw.calls.Load())
	}
}

// Active job returned (200) rather than a second one, even if the first one is already running.
func TestActiveJobReturned(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	e.seedScheme(100002)
	e.mustExec(`INSERT INTO refresh_job (kind, target, status, started_at) VALUES ('mf_refresh','100002','running', now())`)
	rec := e.do(http.MethodPost, "/api/v1/mf/schemes/100002/refresh", "", e.cookie, nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"status":"running"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	e.svc.Wait()
	if e.fw.calls.Load() != 0 || e.count(`target='100002'`) != 1 {
		t.Fatal("an active job must not create a row or signal the worker")
	}
}

func TestCooldown429(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	e.seedScheme(100003)
	e.mustExec(`INSERT INTO refresh_job (kind, target, status, started_at, finished_at, requested_at)
		VALUES ('mf_refresh','100003','ok', now() - interval '6 minutes', now() - interval '5 minutes', now() - interval '7 minutes')`)
	rec := e.do(http.MethodPost, "/api/v1/mf/schemes/100003/refresh", "", e.cookie, nil)
	if rec.Code != 429 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	er := decodeErr(t, rec.ResponseRecorder)
	secs, _ := er.Error.Details["retry_after_seconds"].(float64)
	if er.Error.Code != CodeRateLimited || secs < 590 || secs > 601 {
		t.Fatalf("details %+v", er.Error)
	}
	if h := rec.Header().Get("Retry-After"); h != strconv.Itoa(int(secs)) {
		t.Fatalf("Retry-After %q", h)
	}
	// past the cooldown it is allowed again
	e.mustExec(`UPDATE refresh_job SET finished_at = now() - interval '16 minutes' WHERE target='100003'`)
	if c := e.code(http.MethodPost, "/api/v1/mf/schemes/100003/refresh", "", e.cookie); c != 202 {
		t.Fatalf("after cooldown: %d", c)
	}
	e.svc.Wait()
}

func TestGlobalHourlyLimit429(t *testing.T) {
	e := newJobEnv(t, jobs.Config{Cooldown: 15 * time.Minute, GlobalHour: 3})
	for i := 0; i < 3; i++ {
		e.seedScheme(200000 + i)
		e.mustExec(`INSERT INTO refresh_job (kind, target, status, finished_at, requested_at)
			VALUES ('mf_refresh', $1, 'ok', now() - interval '40 minutes', now() - interval '50 minutes')`, strconv.Itoa(200000+i))
	}
	e.seedScheme(200010)
	rec := e.do(http.MethodPost, "/api/v1/mf/schemes/200010/refresh", "", e.cookie, nil)
	if rec.Code != 429 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	secs, _ := decodeErr(t, rec.ResponseRecorder).Error.Details["retry_after_seconds"].(float64)
	if secs < 590 || secs > 601 { // the oldest request leaves the window in about 10 minutes
		t.Fatalf("retry_after_seconds %v", secs)
	}
	if e.count(`target='200010'`) != 0 {
		t.Fatal("no row may be created when rate limited")
	}
	// post_import is event-driven and exempt
	if _, created, err := e.svc.EnqueuePostImport(context.Background(), 1, []string{"TCS"}); err != nil || !created {
		t.Fatalf("post_import blocked by the global limit: %v %v", created, err)
	}
	e.svc.Wait()
}

// The cooldown/global-hour check and the insert are atomic: 40 parallel enqueues for different
// targets never exceed REFRESH_GLOBAL_PER_HOUR (check-then-insert race, B09 review).
func TestParallelEnqueueHonoursGlobalLimit(t *testing.T) {
	const limit, n = 5, 40
	e := newJobEnv(t, jobs.Config{Cooldown: 15 * time.Minute, GlobalHour: limit})
	var created, limited, other atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		e.seedScheme(300000 + i)
	}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, ok, err := e.svc.Enqueue(context.Background(), jobs.KindMFRefresh, strconv.Itoa(300000+i))
			var rl *jobs.RateLimitedError
			switch {
			case err == nil && ok:
				created.Add(1)
			case errors.As(err, &rl):
				limited.Add(1)
			default:
				other.Add(1)
			}
		}(i)
	}
	wg.Wait()
	e.svc.Wait()
	if created.Load() != limit || limited.Load() != n-limit || other.Load() != 0 {
		t.Fatalf("created %d, limited %d, other %d; want %d, %d, 0", created.Load(), limited.Load(), other.Load(), limit, n-limit)
	}
	if c := e.count(`kind='mf_refresh'`); c != limit {
		t.Fatalf("%d rows, want %d", c, limit)
	}
}

// BRK-12: manual price mode.
func TestPriceModeManual(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	rec := e.do(http.MethodPost, "/api/v1/stocks/TCS/refresh", "", e.cookie, nil)
	if rec.Code != 422 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if er := decodeErr(t, rec.ResponseRecorder); er.Error.Code != "PRICE_MODE_MANUAL" {
		t.Fatalf("%+v", er)
	}
	for _, k := range []string{jobs.KindStockRefresh, jobs.KindStockBackfill} {
		if _, _, err := e.svc.Enqueue(context.Background(), k, "TCS"); err != jobs.ErrPriceModeManual {
			t.Fatalf("%s: %v", k, err)
		}
	}
	e.svc.Wait()
	if e.count(`true`) != 0 || e.fw.calls.Load() != 0 {
		t.Fatal("manual mode must create no job and call no worker")
	}
	// auth and CSRF still come first
	if c := e.code(http.MethodPost, "/api/v1/stocks/TCS/refresh", "", ""); c != 401 {
		t.Fatalf("unauthenticated: %d", c)
	}
}

func TestMFRefreshValidation(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	for _, bad := range []string{"abc", "0", "-5", "99999999999"} {
		if c := e.code(http.MethodPost, "/api/v1/mf/schemes/"+bad+"/refresh", "", e.cookie); c != 422 {
			t.Fatalf("%q: %d", bad, c)
		}
	}
	rec := e.do(http.MethodPost, "/api/v1/mf/schemes/999999/refresh", "", e.cookie, nil)
	if rec.Code != 404 || decodeErr(t, rec.ResponseRecorder).Error.Code != CodeNotFound {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	// CSRF header required on POST
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mf/schemes/1/refresh", nil)
	req.Header.Add("Cookie", SessionCookie+"="+e.cookie)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	if rr.Code != 403 {
		t.Fatalf("missing CSRF header: %d", rr.Code)
	}
}

// A failed worker call leaves the row queued (docs/03 section 7); the request still succeeds.
func TestWorkerFailureLeavesJobQueued(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	e.seedScheme(100004)
	e.fw.status = http.StatusInternalServerError
	rec := e.do(http.MethodPost, "/api/v1/mf/schemes/100004/refresh", "", e.cookie, nil)
	if rec.Code != 202 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	e.svc.Wait()
	if e.count(`target='100004' AND status='queued'`) != 1 {
		t.Fatal("row must stay queued")
	}
	// worker completely down: same behaviour
	e.srv.Close()
	e.seedScheme(100005)
	if c := e.code(http.MethodPost, "/api/v1/mf/schemes/100005/refresh", "", e.cookie); c != 202 {
		t.Fatalf("worker down: %d", c)
	}
	e.svc.Wait()
	if e.count(`target='100005' AND status='queued'`) != 1 {
		t.Fatal("row must stay queued when the worker is down")
	}
}

// SEC-07: the verifier the Go caller talks to rejects stale timestamps, bad signatures and replays.
func TestWorkerHMACReplayAndSkew(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	e.seedScheme(100006)
	if c := e.code(http.MethodPost, "/api/v1/mf/schemes/100006/refresh", "", e.cookie); c != 202 {
		t.Fatal(c)
	}
	e.svc.Wait()
	if e.fw.calls.Load() != 1 || e.fw.rejected.Load() != 0 {
		t.Fatalf("signed call must verify: calls=%d rejected=%d", e.fw.calls.Load(), e.fw.rejected.Load())
	}
	hdr := e.fw.lastReq.hdr
	if _, err := strconv.ParseInt(hdr.Get("X-Timestamp"), 10, 64); err != nil {
		t.Fatalf("X-Timestamp must be unix seconds, got %q", hdr.Get("X-Timestamp"))
	}
	send := func(ts int64, sigOverride string, body []byte) int {
		sig := sigOverride
		if sig == "" {
			sig = jobs.Sign(testHMACKey, ts, "POST", "/run", body)
		}
		req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/run", strings.NewReader(string(body)))
		req.Header.Set("X-Timestamp", strconv.FormatInt(ts, 10))
		req.Header.Set("X-Signature", sig)
		resp, err := http.DefaultClient.Do(req) //nolint:forbidigo // test client for the fake worker
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	body := []byte(`{"job_id":901}`)
	now := time.Now().Unix()
	if c := send(now, "", body); c != 202 {
		t.Fatalf("fresh: %d", c)
	}
	if c := send(now, "", body); c != 401 {
		t.Fatalf("replay: %d", c)
	}
	if c := send(now-121, "", []byte(`{"job_id":902}`)); c != 401 {
		t.Fatalf("old timestamp: %d", c)
	}
	if c := send(now+121, "", []byte(`{"job_id":903}`)); c != 401 {
		t.Fatalf("future timestamp: %d", c)
	}
	if c := send(now, strings.Repeat("0", 64), []byte(`{"job_id":904}`)); c != 401 {
		t.Fatalf("bad signature: %d", c)
	}
	// body tampering invalidates the signature
	sig := jobs.Sign(testHMACKey, now, "POST", "/run", []byte(`{"job_id":905}`))
	if c := send(now, sig, []byte(`{"job_id":906}`)); c != 401 {
		t.Fatalf("tampered body: %d", c)
	}
}

func TestEgressOnlyWorkerHost(t *testing.T) {
	base, _ := url.Parse("http://127.0.0.1:1")
	other, _ := url.Parse("http://127.0.0.1:2/x")
	eg, err := egress.New(egress.FromURL(base))
	if err != nil {
		t.Fatal(err)
	}
	if eg.Allowed(other) {
		t.Fatal("only the worker base URL may be allowed")
	}
}

func TestGetJob(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	e.mustExec(`INSERT INTO refresh_job (kind, target, status, started_at, result) VALUES
		('post_import','batch:7','running', now(), '{"symbols_total":80,"symbols_done":40,"remaining":["A"]}')`)
	var id int64
	if err := e.pool.QueryRow(context.Background(), `SELECT id FROM refresh_job WHERE target='batch:7'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	rec := e.do(http.MethodGet, "/api/v1/jobs/"+strconv.FormatInt(id, 10), "", e.cookie, nil)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var env struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	d := env.Data
	res, _ := d["result"].(map[string]any)
	if d["kind"] != "post_import" || d["target"] != "batch:7" || d["status"] != "running" ||
		d["finished_at"] != nil || d["error"] != nil || d["started_at"] == nil ||
		res["symbols_total"] != float64(80) || res["symbols_done"] != float64(40) {
		t.Fatalf("unexpected job view %s", rec.Body)
	}
	for _, k := range []string{"id", "kind", "target", "status", "requested_at", "started_at", "finished_at", "error", "result"} {
		if _, ok := d[k]; !ok {
			t.Fatalf("missing key %s", k)
		}
	}
	if c := e.code(http.MethodGet, "/api/v1/jobs/999999", "", e.cookie); c != 404 {
		t.Fatalf("unknown id: %d", c)
	}
	if c := e.code(http.MethodGet, "/api/v1/jobs/abc", "", e.cookie); c != 422 {
		t.Fatalf("bad id: %d", c)
	}
	if c := e.code(http.MethodGet, "/api/v1/jobs/"+strconv.FormatInt(id, 10), "", ""); c != 401 {
		t.Fatalf("unauthenticated: %d", c)
	}
}

func TestEnqueuePostImport(t *testing.T) {
	e := newJobEnv(t, defaultJobCfg)
	ctx := context.Background()
	j, created, err := e.svc.EnqueuePostImport(ctx, 7, []string{"TCS", "INFY", "RELIANCE"})
	if err != nil || !created || j.Kind != "post_import" || j.Target != "batch:7" || j.Status != "queued" {
		t.Fatalf("%+v %v %v", j, created, err)
	}
	var res jobs.PostImportResult
	if err := json.Unmarshal(j.Result, &res); err != nil || res.SymbolsTotal != 3 || res.SymbolsDone != 0 ||
		strings.Join(res.Remaining, ",") != "TCS,INFY,RELIANCE" {
		t.Fatalf("result %s", j.Result)
	}
	e.svc.Wait()
	if e.fw.calls.Load() != 1 {
		t.Fatalf("worker calls %d", e.fw.calls.Load())
	}
	// the active job dedupes a second enqueue for the same target
	j2, created2, err := e.svc.EnqueuePostImport(ctx, 7, []string{"TCS"})
	if err != nil || created2 || j2.ID != j.ID {
		t.Fatalf("dedupe failed: %+v %v %v", j2, created2, err)
	}
	// once the first job is partial a continuation row may exist (04 3.12)
	e.mustExec(`UPDATE refresh_job SET status='partial', finished_at=now() WHERE id=$1`, j.ID)
	j3, created3, err := e.svc.EnqueuePostImport(ctx, 7, []string{"INFY", "RELIANCE"})
	if err != nil || !created3 || j3.ID == j.ID {
		t.Fatalf("continuation: %+v %v %v", j3, created3, err)
	}
	// an empty symbol list serialises as [] not null
	j4, _, err := e.svc.EnqueuePostImport(ctx, 8, nil)
	var raw map[string]any
	if err != nil || json.Unmarshal(j4.Result, &raw) != nil || raw["remaining"] == nil || len(raw["remaining"].([]any)) != 0 {
		t.Fatalf("%s %v", j4.Result, err)
	}
	e.svc.Wait()
}
