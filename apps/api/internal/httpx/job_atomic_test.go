package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/india-analyzer/api/internal/jobs"
)

type hmacVector struct {
	Name      string `json:"name"`
	Key       string `json:"key"`
	TS        int64  `json:"ts"`
	Method    string `json:"method"`
	Path      string `json:"path"`
	Body      string `json:"body"`
	Signature string `json:"signature"`
	SkewCase  bool   `json:"skew_case"`
}

// Shared golden vectors generated with the Python verifier (worker.http.sign); the Python side
// verifies the same file in apps/worker/tests/test_http.py.
func TestSharedHMACVectorsWithPythonVerifier(t *testing.T) {
	raw, err := os.ReadFile("../../../../fixtures/worker_hmac_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Signed   []hmacVector `json:"signed"`
		Rejected []hmacVector `json:"rejected"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Signed) < 3 || len(doc.Rejected) < 5 {
		t.Fatalf("vector file too small: %d/%d", len(doc.Signed), len(doc.Rejected))
	}
	for _, v := range doc.Signed {
		if got := jobs.Sign(v.Key, v.TS, v.Method, v.Path, []byte(v.Body)); got != v.Signature {
			t.Errorf("%s: Go signature %s != Python %s", v.Name, got, v.Signature)
		}
	}
	for _, v := range doc.Rejected {
		if v.SkewCase {
			continue // clock skew is the verifier's rule (TestWorkerHMACReplayAndSkew)
		}
		if got := jobs.Sign(v.Key, v.TS, v.Method, v.Path, []byte(v.Body)); got == v.Signature {
			t.Errorf("%s: changed inputs must not reproduce the old signature", v.Name)
		}
	}
}

// Parallel enqueues on different targets must not exceed REFRESH_GLOBAL_PER_HOUR (atomic check).
func TestGlobalLimitHoldsUnderParallelEnqueue(t *testing.T) {
	const limit, n = 7, 40
	e := newJobEnv(t, jobs.Config{Cooldown: 15 * time.Minute, GlobalHour: limit})
	var created, limited, other atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
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
	close(start)
	wg.Wait()
	e.svc.Wait()
	if created.Load() != limit || limited.Load() != n-limit || other.Load() != 0 {
		t.Fatalf("created=%d limited=%d other=%d", created.Load(), limited.Load(), other.Load())
	}
	if c := e.count(`kind = 'mf_refresh'`); c != limit {
		t.Fatalf("rows %d, want %d", c, limit)
	}
}
