package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/netip"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/passhash"
)

// Errors returned by Service. Callers must not reveal more than these categories.
var (
	// ErrInvalidCredentials covers a wrong password and an active lockout alike (identical message).
	ErrInvalidCredentials = errors.New("auth: invalid credentials or temporarily locked")
	// ErrNoSession means the cookie is absent, unknown, revoked or expired.
	ErrNoSession = errors.New("auth: no valid session")
	// ErrCurrentPassword means the current password given to ChangePassword is wrong.
	ErrCurrentPassword = errors.New("auth: current password is incorrect")
)

// LoginMessage is the one message used for every failed login (docs/03 section 2).
const LoginMessage = "Invalid credentials or temporarily locked"

const (
	tokenBytes     = 32
	touchInterval  = time.Hour
	baseLockout    = 15 * time.Minute
	maxLockout     = 24 * time.Hour
	maxLockoutExp  = 7 // 15 min * 2^7 = 32 h, above the 24 h cap; avoids overflow
	minFailDelayMs = 300
	maxFailDelayMs = 800
)

// DB is the pool surface the service needs (pgxpool.Pool satisfies it).
type DB interface {
	dbq.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Config tunes the service. Zero values fall back to the documented defaults.
type Config struct {
	SessionDays int // default 30
	MaxFails    int // LOGIN_MAX_FAILS, default 5
}

// Service is the auth use-case layer.
type Service struct {
	db  DB
	q   *dbq.Queries
	cfg Config
	log zerolog.Logger

	// Now, Delay and Sleep are overridable in tests. Delay returns the random 300-800 ms pause
	// applied to every failed login; Sleep waits for it (context aware).
	Now   func() time.Time
	Delay func() time.Duration
	Sleep func(ctx context.Context, d time.Duration)
	// OnVerify, when set (tests), is called for every verification whose result counts, i.e. not
	// for attempts refused because of a lockout.
	OnVerify func()
}

// New builds a Service.
func New(db DB, cfg Config, log zerolog.Logger) *Service {
	if cfg.SessionDays <= 0 {
		cfg.SessionDays = 30
	}
	if cfg.MaxFails <= 0 {
		cfg.MaxFails = 5
	}
	return &Service{
		db: db, q: dbq.New(db), cfg: cfg, log: log,
		Now: time.Now, Delay: RandomFailDelay, Sleep: sleepCtx,
	}
}

// RandomFailDelay returns a uniformly random duration in [300 ms, 800 ms].
func RandomFailDelay() time.Duration {
	n, err := rand.Int(rand.Reader, big.NewInt(maxFailDelayMs-minFailDelayMs+1))
	if err != nil {
		return maxFailDelayMs * time.Millisecond
	}
	return time.Duration(minFailDelayMs+n.Int64()) * time.Millisecond
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// HashToken returns the sha256 of the raw token as stored in session.token_hash.
func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

func ts(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t.UTC(), Valid: true} }

// Issued is a freshly created session. Token is the only copy of the secret; it goes in the cookie.
type Issued struct {
	Token     string
	ExpiresAt time.Time
}

// Session identifies an authenticated request.
type Session struct {
	ID        int64
	ExpiresAt time.Time
	Slid      bool // expiry was extended by this request; the cookie must be re-issued
}

// Profile is the payload of GET /auth/me.
type Profile struct {
	TelegramLinked bool
	Prefs          []byte // display_prefs JSON
}

type ctxKey struct{}

// WithSession stores the session on a context (set by the auth middleware).
func WithSession(ctx context.Context, s Session) context.Context {
	return context.WithValue(ctx, ctxKey{}, s)
}

// SessionFrom returns the session placed by WithSession.
func SessionFrom(ctx context.Context) (Session, bool) {
	s, ok := ctx.Value(ctxKey{}).(Session)
	return s, ok
}

// lockDuration is 15 min * 2^(lockouts-1) capped at 24 h, where lockouts is the 1-based number of
// lockouts since the last successful login.
func lockDuration(lockouts int) time.Duration {
	exp := lockouts - 1
	if exp < 0 {
		exp = 0
	}
	if exp > maxLockoutExp {
		exp = maxLockoutExp
	}
	d := baseLockout << exp
	if d > maxLockout {
		d = maxLockout
	}
	return d
}

// Login verifies the password and creates a session. Any failure (wrong password, lockout, no
// owner row) returns ErrInvalidCredentials after the random delay.
func (s *Service) Login(ctx context.Context, password string, ip netip.Addr, userAgent string) (Issued, error) {
	ok, err := s.attempt(ctx, password)
	if err != nil {
		return Issued{}, err
	}
	if !ok {
		s.Sleep(ctx, s.Delay()) // outside the transaction: the row lock is not held during the delay
		return Issued{}, ErrInvalidCredentials
	}
	return s.createSession(ctx, s.Now(), ip, userAgent)
}

var (
	dummyOnce sync.Once
	dummyHash string
)

// dummyVerify spends the cost of one argon2id verification so timing does not reveal whether the
// account is locked or absent.
func dummyVerify(password string) {
	dummyOnce.Do(func() { dummyHash, _ = passhash.Hash("dummy-password-for-constant-time") })
	if dummyHash != "" {
		_, _ = passhash.Verify(password, dummyHash)
	}
}

// attempt runs one password check under the owner row lock (SELECT ... FOR UPDATE), so parallel
// guesses are verified one at a time and a lockout that lands is seen by every later attempt: at
// most MaxFails verifications can happen after the lock threshold. The counter update is committed
// in the same transaction. A locked or unknown account still performs one (discarded) verification.
func (s *Service) attempt(ctx context.Context, password string) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("auth: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	u, err := q.GetAppUserForUpdate(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		dummyVerify(password)
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("auth: lock user: %w", err)
	}
	now := s.Now()
	if u.LockedUntil.Valid && u.LockedUntil.Time.After(now) {
		_, _ = passhash.Verify(password, u.PasswordHash) // constant-time: result discarded
		return false, nil
	}
	if s.OnVerify != nil {
		s.OnVerify()
	}
	// A malformed stored hash is a deployment fault, not a credential failure.
	ok, err := passhash.Verify(password, u.PasswordHash)
	if err != nil {
		return false, fmt.Errorf("auth: stored password hash unusable: %w", err)
	}
	if ok {
		if err := q.ResetLoginFailures(ctx); err != nil {
			return false, fmt.Errorf("auth: reset failures: %w", err)
		}
	} else if err := s.recordFailure(ctx, q, u, now); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("auth: commit: %w", err)
	}
	return ok, nil
}

// recordFailure increments failed_logins on the locked row u; every LoginMaxFails-th failure starts
// a lockout of 15 min * 2^(lockouts-1), capped at 24 h. The lockout number is derived from the
// counter (failed_logins / MaxFails), so no extra column is needed. Attempts made while locked do
// not count (an attacker must not be able to extend the lock).
func (s *Service) recordFailure(ctx context.Context, q *dbq.Queries, u dbq.AppUser, now time.Time) error {
	failed := u.FailedLogins + 1
	locked := u.LockedUntil
	if int(failed)%s.cfg.MaxFails == 0 {
		lockouts := int(failed) / s.cfg.MaxFails
		locked = ts(now.Add(lockDuration(lockouts)))
		s.log.Warn().Int("failed_logins", int(failed)).Time("locked_until", locked.Time).Msg("login lockout started")
	}
	if err := q.SetLoginFailure(ctx, dbq.SetLoginFailureParams{FailedLogins: failed, LockedUntil: locked}); err != nil {
		return fmt.Errorf("auth: record failure: %w", err)
	}
	return nil
}

func (s *Service) createSession(ctx context.Context, now time.Time, ip netip.Addr, ua string) (Issued, error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return Issued{}, fmt.Errorf("auth: randomness: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	expires := now.Add(time.Duration(s.cfg.SessionDays) * 24 * time.Hour)
	p := dbq.CreateSessionParams{TokenHash: HashToken(token), ExpiresAt: ts(expires)}
	if ip.IsValid() {
		p.Ip = &ip
	}
	if ua != "" {
		if len(ua) > 512 {
			ua = ua[:512]
		}
		p.UserAgent = pgtype.Text{String: ua, Valid: true}
	}
	if _, err := s.q.CreateSession(ctx, p); err != nil {
		return Issued{}, fmt.Errorf("auth: create session: %w", err)
	}
	return Issued{Token: token, ExpiresAt: expires}, nil
}

// Authenticate resolves a cookie token to a live session and slides its expiry (at most hourly).
func (s *Service) Authenticate(ctx context.Context, token string) (Session, error) {
	if len(token) == 0 || len(token) > 128 {
		return Session{}, ErrNoSession
	}
	row, err := s.q.GetSessionByHash(ctx, HashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNoSession
	}
	if err != nil {
		return Session{}, fmt.Errorf("auth: load session: %w", err)
	}
	now := s.Now()
	if row.RevokedAt.Valid || !row.ExpiresAt.Time.After(now) {
		return Session{}, ErrNoSession
	}
	expires := row.ExpiresAt.Time
	slid := false
	if now.Sub(row.LastSeenAt.Time) >= touchInterval {
		slid = true
		expires = now.Add(time.Duration(s.cfg.SessionDays) * 24 * time.Hour)
		if err := s.q.TouchSession(ctx, dbq.TouchSessionParams{ID: row.ID, Now: ts(now), ExpiresAt: ts(expires)}); err != nil {
			return Session{}, fmt.Errorf("auth: touch session: %w", err)
		}
	}
	return Session{ID: row.ID, ExpiresAt: expires, Slid: slid}, nil
}

// Logout revokes one session.
func (s *Service) Logout(ctx context.Context, sessionID int64) error {
	return s.q.RevokeSession(ctx, dbq.RevokeSessionParams{ID: sessionID, RevokedAt: ts(s.Now())})
}

// LogoutAll revokes every session.
func (s *Service) LogoutAll(ctx context.Context) error {
	_, err := s.q.RevokeAllSessions(ctx, ts(s.Now()))
	return err
}

// ChangePassword verifies the current password, applies the policy, stores the new argon2id hash
// and revokes every other session. It returns ErrCurrentPassword or a *PolicyViolation.
func (s *Service) ChangePassword(ctx context.Context, sessionID int64, current, next string) error {
	user, err := s.q.GetAppUser(ctx)
	if err != nil {
		return fmt.Errorf("auth: load user: %w", err)
	}
	ok, err := passhash.Verify(current, user.PasswordHash)
	if err != nil {
		return fmt.Errorf("auth: stored password hash unusable: %w", err)
	}
	if !ok {
		return ErrCurrentPassword
	}
	if v := CheckNewPassword(current, next); v != nil {
		return v
	}
	hash, err := passhash.Hash(next)
	if err != nil {
		return fmt.Errorf("auth: hash password: %w", err)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("auth: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.UpdatePasswordHash(ctx, hash); err != nil {
		return fmt.Errorf("auth: update password: %w", err)
	}
	if _, err := q.RevokeOtherSessions(ctx, dbq.RevokeOtherSessionsParams{ID: sessionID, RevokedAt: ts(s.Now())}); err != nil {
		return fmt.Errorf("auth: revoke sessions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: commit: %w", err)
	}
	return nil
}

// Profile returns the data of GET /auth/me.
func (s *Service) Profile(ctx context.Context) (Profile, error) {
	u, err := s.q.GetAppUser(ctx)
	if err != nil {
		return Profile{}, fmt.Errorf("auth: load user: %w", err)
	}
	return Profile{TelegramLinked: u.TelegramChatID.Valid, Prefs: u.DisplayPrefs}, nil
}
