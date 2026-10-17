package httpx

import (
	"math"
	"net/http"
	"sync"
	"time"
)

// Limiter is an in-memory token bucket per key (docs/03 section 16: login 10/min per IP,
// authenticated general 120/min). Buckets refill continuously at perMinute/60 tokens per second.
type Limiter struct {
	capacity float64
	rate     float64 // tokens per second
	now      func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

const maxBuckets = 10000

// NewLimiter allows `perMinute` requests per minute per key with a burst of the same size.
func NewLimiter(perMinute int) *Limiter { return newLimiter(perMinute, time.Now) }

func newLimiter(perMinute int, now func() time.Time) *Limiter {
	return &Limiter{
		capacity: float64(perMinute),
		rate:     float64(perMinute) / 60,
		now:      now,
		buckets:  map[string]*bucket{},
	}
}

// Allow consumes one token. When none is left it returns false and the seconds to wait (>= 1).
func (l *Limiter) Allow(key string) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= maxBuckets {
			l.prune(now)
		}
		b = &bucket{tokens: l.capacity, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.capacity, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := int(math.Ceil((1 - b.tokens) / l.rate))
	if wait < 1 {
		wait = 1
	}
	return false, wait
}

// prune drops buckets that have fully refilled (idle keys). Caller holds the lock.
func (l *Limiter) prune(now time.Time) {
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.capacity {
			delete(l.buckets, k)
		}
	}
	if len(l.buckets) >= maxBuckets { // still full of active keys: start over rather than grow
		l.buckets = map[string]*bucket{}
	}
}

// RateLimit returns middleware that answers 429 RATE_LIMITED with Retry-After when the caller's
// bucket is empty. key derives the bucket key from the request (ClientIP for login).
func RateLimit(l *Limiter, key func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if ok, wait := l.Allow(key(r)); !ok {
				WriteError(w, r, ErrRateLimited(wait))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
