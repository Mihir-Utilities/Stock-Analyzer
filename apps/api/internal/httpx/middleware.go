package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

const (
	// DefaultBodyLimit applies to every route unless a route group raises it.
	DefaultBodyLimit int64 = 1 << 20 // 1 MiB (JSON bodies)
	// ImportBodyLimit is for multipart import uploads: 25 MB file limit plus multipart overhead
	// (docs/03 section 14).
	ImportBodyLimit int64 = 26 << 20
	// DefaultTimeout bounds one request (Render free tier).
	DefaultTimeout = 30 * time.Second

	// StocksIndexPath is the one response that is cacheable (docs/03 section 16).
	StocksIndexPath = "/api/v1/stocks/index"
)

type ctxKey int

const requestIDKey ctxKey = 1

var validRequestID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// RequestIDFrom returns the request id stored by RequestID.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// RequestID assigns (or accepts a well-formed inbound) X-Request-Id, echoes it and adds a request
// scoped logger to the context.
func RequestID(base zerolog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get("X-Request-Id")
			if !validRequestID.MatchString(id) {
				id = newID()
			}
			w.Header().Set("X-Request-Id", id)
			ctx := context.WithValue(r.Context(), requestIDKey, id)
			l := base.With().Str("request_id", id).Logger()
			ctx = l.WithContext(ctx)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(p []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(p)
	s.bytes += n
	return n, err
}

// AccessLog writes one line per request: method, path (never the query string, never headers or
// bodies), status, duration, bytes.
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		if sw.status == 0 {
			sw.status = http.StatusOK
		}
		ev := zerolog.Ctx(r.Context()).Info()
		if sw.status >= 500 {
			ev = zerolog.Ctx(r.Context()).Error()
		}
		ev.Str("method", r.Method).Str("path", r.URL.Path).Int("status", sw.status).
			Int64("duration_ms", time.Since(start).Milliseconds()).Int("bytes", sw.bytes).Msg("request")
	})
}

// Recoverer turns a panic into the INTERNAL envelope and logs the stack with the request id.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler { //nolint:errorlint // sentinel compared by identity per net/http docs
					panic(rec)
				}
				zerolog.Ctx(r.Context()).Error().Interface("panic", rec).Bytes("stack", debug.Stack()).Msg("panic recovered")
				WriteError(w, r, ErrInternal())
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// SecurityHeaders sets the headers of docs/03 section 16 on every response. Cache-Control is
// `no-store` except for /stocks/index, whose handler sets its own ETag and private cache policy.
// The CSP is set at the Next.js layer.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		if r.URL.Path != StocksIndexPath {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// Timeout bounds the request context; handlers must honour ctx.
func Timeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// MaxBody limits the request body size; reads beyond it fail and DecodeJSON maps that to 413.
// A declared Content-Length above the limit is rejected immediately.
func MaxBody(limit int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > limit {
				WriteError(w, r, errBodyTooLarge())
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			next.ServeHTTP(w, r)
		})
	}
}

type clientIPKey struct{}

// ClientIPMiddleware resolves the caller address once (see ResolveClientIP) and stores it on the
// request context for ClientIP.
func ClientIPMiddleware(hops int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), clientIPKey{}, ResolveClientIP(r, hops))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClientIP returns the caller address used as the rate-limit key: the value resolved by
// ClientIPMiddleware, or the socket address when the middleware did not run.
func ClientIP(r *http.Request) string {
	if ip, ok := r.Context().Value(clientIPKey{}).(string); ok {
		return ip
	}
	return ResolveClientIP(r, 0)
}

// ResolveClientIP implements TRUSTED_PROXY_HOPS. With hops <= 0 X-Forwarded-For is ignored and the
// socket peer address is used (a client can forge the header). With hops = N the Nth entry from the
// right (appended by the Nth trusted proxy) is used; if the header is shorter than N or the entry is
// not an IP, the socket address is used.
func ResolveClientIP(r *http.Request, hops int) string {
	if hops > 0 {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if len(parts) >= hops {
				if ip := strings.TrimSpace(parts[len(parts)-hops]); net.ParseIP(ip) != nil {
					return ip
				}
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
