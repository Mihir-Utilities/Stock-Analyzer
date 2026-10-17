package jobs

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/india-analyzer/api/internal/egress"
)

// RunPath is the worker-http route (docs/04 section 4).
const RunPath = "/run"

// Sign returns hex(HMAC_SHA256(key, "{ts}.{method}.{path}.{sha256_hex(body)}")) exactly as
// worker-http verifies it (docs/04 section 4, D01-A3). ts is unix seconds.
func Sign(key string, ts int64, method, path string, body []byte) string {
	sum := sha256.Sum256(body)
	msg := strconv.FormatInt(ts, 10) + "." + method + "." + path + "." + hex.EncodeToString(sum[:])
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(msg))
	return hex.EncodeToString(mac.Sum(nil))
}

// Worker signals worker-http. Every call uses a fresh timestamp and is never retried with the same
// signature (the worker accepts an identical signature only once inside the 120 s window).
type Worker struct {
	Base *url.URL
	Key  string
	HC   *egress.Client // the only outbound HTTP client (decision D-N)
	Now  func() time.Time
}

// Trigger sends POST /run {"job_id": id}. worker-http answers 202 and runs the job in the
// background; any other answer is an error (the row stays queued for the next cron).
func (w *Worker) Trigger(ctx context.Context, jobID int64) error {
	body, err := json.Marshal(map[string]int64{"job_id": jobID})
	if err != nil {
		return err
	}
	u := *w.Base
	u.Path = strings.TrimRight(u.Path, "/") + RunPath
	u.RawPath, u.RawQuery, u.Fragment = "", "", ""
	now := time.Now
	if w.Now != nil {
		now = w.Now
	}
	ts := now().Unix()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Timestamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-Signature", Sign(w.Key, ts, http.MethodPost, u.Path, body))
	resp, err := w.HC.Do(req)
	if err != nil {
		return fmt.Errorf("worker call failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("worker answered HTTP %d", resp.StatusCode)
	}
	return nil
}
