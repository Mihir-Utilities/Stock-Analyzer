package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/india-analyzer/api/internal/auth"
)

// SessionCookie is the name of the session cookie (docs/03 section 1).
const SessionCookie = "session"

// CSRFHeader and CSRFValue are the non-GET guard (docs/03 section 1).
const (
	CSRFHeader = "X-Requested-With"
	CSRFValue  = "fetch"
)

// AccountService is the auth use-case surface the handlers need; *auth.Service implements it.
type AccountService interface {
	Login(ctx context.Context, password string, ip netip.Addr, userAgent string) (auth.Issued, error)
	Authenticate(ctx context.Context, token string) (auth.Session, error)
	Logout(ctx context.Context, sessionID int64) error
	LogoutAll(ctx context.Context) error
	ChangePassword(ctx context.Context, sessionID int64, current, next string) error
	Profile(ctx context.Context) (auth.Profile, error)
}

// CookieChecker is the real SessionChecker: it resolves the session cookie through the service and
// puts the session on the request context. Anything that is not a live session is a 401.
type CookieChecker struct{ Svc AccountService }

// Check implements SessionChecker.
func (c CookieChecker) Check(r *http.Request) error {
	_, err := c.CheckContext(r)
	return err
}

// CheckContext implements ContextChecker.
func (c CookieChecker) CheckContext(r *http.Request) (context.Context, error) {
	ck, err := r.Cookie(SessionCookie)
	if err != nil || ck.Value == "" {
		return nil, ErrUnauthenticated("Authentication required")
	}
	s, err := c.Svc.Authenticate(r.Context(), ck.Value)
	if errors.Is(err, auth.ErrNoSession) {
		return nil, ErrUnauthenticated("Authentication required")
	}
	if err != nil {
		return nil, err // fail closed: 500 INTERNAL, never access
	}
	return auth.WithSession(r.Context(), s), nil
}

func setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: token, Path: "/", Expires: expires.UTC(),
		MaxAge: int(time.Until(expires).Seconds()), HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: "", Path: "/", Expires: time.Unix(0, 0), MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
}

func clientAddr(r *http.Request) netip.Addr {
	a, err := netip.ParseAddr(ClientIP(r))
	if err != nil {
		return netip.Addr{}
	}
	return a
}

func notImplemented() error {
	return NewError(http.StatusNotImplemented, CodeNotImplemented, "Not implemented yet", nil)
}

func authHandler(d Deps, k handlerKind) http.Handler {
	svc := d.Accounts
	if svc == nil {
		return Adapt(func(http.ResponseWriter, *http.Request) error { return notImplemented() })
	}
	switch k {
	case kindAuthLogin:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return login(svc, w, r) })
	case kindAuthLogout:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			s, err := currentSession(r)
			if err != nil {
				return err
			}
			if err := svc.Logout(r.Context(), s.ID); err != nil {
				return err
			}
			clearSessionCookie(w)
			WriteData(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	case kindAuthLogoutAll:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			if err := svc.LogoutAll(r.Context()); err != nil {
				return err
			}
			clearSessionCookie(w)
			WriteData(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	case kindAuthMe:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			p, err := svc.Profile(r.Context())
			if err != nil {
				return err
			}
			prefs := json.RawMessage(p.Prefs)
			if !json.Valid(prefs) {
				prefs = json.RawMessage(`{}`)
			}
			WriteData(w, http.StatusOK, map[string]any{"authenticated": true, "telegram_linked": p.TelegramLinked, "prefs": prefs})
			return nil
		})
	default: // kindAuthChangePassword
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return changePassword(svc, d.ChangePwGate, w, r) })
	}
}

func currentSession(r *http.Request) (auth.Session, error) {
	s, ok := auth.SessionFrom(r.Context())
	if !ok {
		return auth.Session{}, ErrUnauthenticated("Authentication required")
	}
	return s, nil
}

type loginBody struct {
	Password string `json:"password"`
}

func login(svc AccountService, w http.ResponseWriter, r *http.Request) error {
	var b loginBody
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	if n := utf8.RuneCountInString(b.Password); n < 1 || n > auth.MaxPasswordLen {
		return ErrValidation(FieldError{Field: "password", Message: "must be 1 to 200 characters"})
	}
	issued, err := svc.Login(r.Context(), b.Password, clientAddr(r), r.UserAgent())
	if errors.Is(err, auth.ErrInvalidCredentials) {
		return ErrUnauthenticated(auth.LoginMessage)
	}
	if err != nil {
		return err
	}
	setSessionCookie(w, issued.Token, issued.ExpiresAt)
	WriteData(w, http.StatusOK, map[string]any{"authenticated": true, "expires_at": issued.ExpiresAt.UTC().Format(time.RFC3339)})
	return nil
}

type changePasswordBody struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

func changePassword(svc AccountService, gate *FailureGate, w http.ResponseWriter, r *http.Request) error {
	s, err := currentSession(r)
	if err != nil {
		return err
	}
	// Wrong-current-password guesses are throttled per session and per IP (they do not count toward
	// the login lockout). A blocked caller is refused before any verification.
	sessKey, ipKey := "session:"+strconv.FormatInt(s.ID, 10), "ip:"+ClientIP(r)
	for _, k := range []string{sessKey, ipKey} {
		if blocked, wait := gate.Blocked(k); blocked {
			return ErrRateLimited(wait)
		}
	}
	var b changePasswordBody
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	if b.Current == "" {
		return ErrValidation(FieldError{Field: "current", Message: "is required"})
	}
	if v := auth.CheckNewPassword(b.Current, b.New); v != nil {
		return ErrValidation(FieldError{Field: v.Field, Message: v.Message})
	}
	err = svc.ChangePassword(r.Context(), s.ID, b.Current, b.New)
	var pv *auth.PolicyViolation
	switch {
	case errors.Is(err, auth.ErrCurrentPassword):
		gate.Fail(sessKey)
		gate.Fail(ipKey)
		return ErrValidation(FieldError{Field: "current", Message: "is incorrect"})
	case errors.As(err, &pv):
		return ErrValidation(FieldError{Field: pv.Field, Message: pv.Message})
	case err != nil:
		return err
	}
	gate.Reset(sessKey)
	gate.Reset(ipKey)
	WriteData(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

// RequireCSRFHeader rejects non-GET requests that lack `X-Requested-With: fetch` with 403 FORBIDDEN
// (docs/03 section 1). GET, HEAD and OPTIONS are exempt.
func RequireCSRFHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if r.Header.Get(CSRFHeader) != CSRFValue {
				WriteError(w, r, ErrForbidden("Missing CSRF header"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
