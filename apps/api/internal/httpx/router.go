package httpx

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
)

// BasePath is the prefix of every API route (docs/03 title).
const BasePath = "/api/v1"

// Pinger checks database reachability (pgxpool.Pool satisfies it).
type Pinger interface {
	Ping(ctx context.Context) error
}

// SessionChecker authenticates a request. B02 provides the real implementation (cookie session);
// B01 ships DenyAll so that every protected route fails closed until then.
type SessionChecker interface {
	Check(r *http.Request) error
}

// ContextChecker is an optional extension of SessionChecker: it also returns a context carrying
// the authenticated session (the cookie checker uses it so handlers know the current session).
type ContextChecker interface {
	CheckContext(r *http.Request) (context.Context, error)
}

// DenyAll rejects every request with UNAUTHENTICATED.
type DenyAll struct{}

// Check implements SessionChecker.
func (DenyAll) Check(*http.Request) error { return ErrUnauthenticated("Authentication required") }

// Deps are the collaborators of the router.
type Deps struct {
	Log    zerolog.Logger
	Pinger Pinger
	Auth   SessionChecker
	// Accounts serves /auth/*. When set and Auth is nil, Auth becomes the cookie checker over it;
	// when nil, /auth/* answer 501 and (with Auth nil) every protected route stays 401.
	Accounts AccountService
	Timeout  time.Duration
	// Jobs serves the refresh-job routes (B09); nil keeps them at 501.
	Jobs JobService

	// Alerts serves /alerts/* and /telegram/* (B12); those routes answer 501 while Alerts.Svc is nil.
	Alerts AlertsDeps

	// Stocks serves GET /stocks, /stocks/index and /stocks/{symbol} (B03); nil keeps them 501 stubs.
	Stocks StockService

	// OwnerData serves GET /stocks/{symbol}/fundamentals|shareholding|events|links (B05); nil keeps them 501 stubs.
	OwnerData OwnerDataService

	// LoginLimiter (default 10/min per IP) guards POST /auth/login; GeneralLimiter (default
	// 120/min) guards authenticated routes (docs/03 section 16).
	LoginLimiter   *Limiter
	GeneralLimiter *Limiter

	// PingBackoff is the pause before the single readyz retry (SYS-01); default 750 ms.
	PingBackoff time.Duration
	// PingTimeout bounds one ping attempt; default 5 s.
	PingTimeout time.Duration
}

func (d *Deps) defaults() {
	if d.Auth == nil {
		if d.Accounts != nil {
			d.Auth = CookieChecker{Svc: d.Accounts}
		} else {
			d.Auth = DenyAll{}
		}
	}
	if d.Timeout <= 0 {
		d.Timeout = DefaultTimeout
	}
	if d.LoginLimiter == nil {
		d.LoginLimiter = NewLimiter(10)
	}
	if d.GeneralLimiter == nil {
		d.GeneralLimiter = NewLimiter(120)
	}
	if d.PingBackoff <= 0 {
		d.PingBackoff = 750 * time.Millisecond
	}
	if d.PingTimeout <= 0 {
		d.PingTimeout = 5 * time.Second
	}
}

// NewRouter builds the chi router: global middleware, error-envelope 404/405, /healthz, and every
// documented route (see routes.go).
func NewRouter(d Deps) chi.Router {
	d.defaults()
	r := chi.NewRouter()
	r.Use(RequestID(d.Log), Recoverer, AccessLog, SecurityHeaders, Timeout(d.Timeout))
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		WriteError(w, req, ErrNotFound("Route not found", nil))
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, req *http.Request) {
		WriteError(w, req, NewError(http.StatusMethodNotAllowed, CodeBadRequest, "Method not allowed", nil))
	})

	// Render's health check uses the root path; the same handler is served under the base path.
	r.Get("/healthz", healthz)

	require := requireAuth(d.Auth)
	general := RateLimit(d.GeneralLimiter, ClientIP)
	login := RateLimit(d.LoginLimiter, ClientIP)

	r.Route(BasePath, func(api chi.Router) {
		for _, rt := range routes {
			h := rt.handler(d)
			mws := []func(http.Handler) http.Handler{MaxBody(rt.bodyLimit())}
			if !rt.NoCSRF {
				mws = append(mws, RequireCSRFHeader)
			}
			if rt.Limit == limitLogin {
				mws = append(mws, login)
			}
			if !rt.Public {
				mws = append(mws, require, general)
			}
			api.With(mws...).Method(rt.Method, rt.Path, h)
		}
	})
	return r
}

func requireAuth(c SessionChecker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if cc, ok := c.(ContextChecker); ok {
				ctx, err := cc.CheckContext(r)
				if err != nil {
					WriteError(w, r, err)
					return
				}
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			if err := c.Check(r); err != nil {
				WriteError(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// healthz answers `{"ok":true}` and never touches the database (docs/03 section 15).
func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// readyz pings the database. Neon scales to zero, so one failed attempt is retried once after a
// short backoff before reporting SOURCE_DOWN (SYS-01).
func readyz(d Deps) http.HandlerFunc {
	return Adapt(func(w http.ResponseWriter, r *http.Request) error {
		if d.Pinger == nil {
			return ErrSourceDown("Database not configured")
		}
		if err := pingWithRetry(r.Context(), d.Pinger, d.PingTimeout, d.PingBackoff); err != nil {
			zerolog.Ctx(r.Context()).Warn().Err(err).Msg("readyz: database ping failed")
			return ErrSourceDown("Database unavailable")
		}
		WriteData(w, http.StatusOK, map[string]any{"ok": true, "db": "ok"})
		return nil
	})
}

func pingWithRetry(ctx context.Context, p Pinger, perAttempt, backoff time.Duration) error {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		actx, cancel := context.WithTimeout(ctx, perAttempt)
		err = p.Ping(actx)
		cancel()
		if err == nil {
			return nil
		}
	}
	return err
}
