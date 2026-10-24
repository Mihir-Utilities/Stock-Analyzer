package httpx

import (
	"math"
	"sync"
	"time"
)

// FailureGate throttles repeated failures per key (change-password guesses, per session and per
// IP). After `maxFails` consecutive failures the key is blocked for base * 2^(lockouts-1), capped
// at `maxBlock`; requests during a block are refused without being verified and do not extend it.
// A success clears the key. It is independent of the login lockout (docs/03 section 2).
type FailureGate struct {
	maxFails int
	base     time.Duration
	maxBlock time.Duration
	now      func() time.Time

	mu      sync.Mutex
	entries map[string]*gateEntry
}

type gateEntry struct {
	fails    int
	lockouts int
	until    time.Time
}

// NewFailureGate builds a gate: 5 failures start a 5 minute block that doubles up to 1 hour.
func NewFailureGate() *FailureGate { return newFailureGate(5, 5*time.Minute, time.Hour, time.Now) }

func newFailureGate(maxFails int, base, maxBlock time.Duration, now func() time.Time) *FailureGate {
	return &FailureGate{maxFails: maxFails, base: base, maxBlock: maxBlock, now: now, entries: map[string]*gateEntry{}}
}

// Blocked reports whether key is blocked and the seconds to wait (>= 1).
func (g *FailureGate) Blocked(key string) (bool, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.entries[key]
	if e == nil {
		return false, 0
	}
	if d := e.until.Sub(g.now()); d > 0 {
		return true, int(math.Ceil(d.Seconds()))
	}
	return false, 0
}

// Fail records one failure and starts a block when the threshold is reached.
func (g *FailureGate) Fail(key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.entries) >= maxBuckets {
		g.entries = map[string]*gateEntry{}
	}
	e := g.entries[key]
	if e == nil {
		e = &gateEntry{}
		g.entries[key] = e
	}
	now := g.now()
	if e.until.After(now) {
		return // already blocked; late concurrent failure
	}
	e.fails++
	if e.fails >= g.maxFails {
		e.fails = 0
		e.lockouts++
		d := g.base
		for i := 1; i < e.lockouts && d < g.maxBlock; i++ {
			d *= 2
		}
		if d > g.maxBlock {
			d = g.maxBlock
		}
		e.until = now.Add(d)
	}
}

// Reset clears key after a success.
func (g *FailureGate) Reset(key string) {
	g.mu.Lock()
	delete(g.entries, key)
	g.mu.Unlock()
}
