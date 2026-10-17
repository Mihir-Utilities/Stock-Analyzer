// Package auth implements the single-user login: argon2id password check, hashed session tokens,
// sliding expiry, lockout with doubling delay and the password policy (docs/03-api-spec.md section 2).
// It knows nothing about HTTP; internal/httpx maps its errors onto the envelope.
package auth

import (
	"net/url"
	"strings"
	"unicode/utf8"
)

const (
	// MinPasswordLen and MaxPasswordLen bound a new password. The upper bound equals the login
	// body limit (1..200 chars, docs/03 section 2) so a password that was accepted can always log in.
	MinPasswordLen = 12
	MaxPasswordLen = 200
)

// PolicyViolation describes why a new password was rejected (a 422 field message).
type PolicyViolation struct{ Field, Message string }

// Error implements error so a *PolicyViolation can be returned from ChangePassword.
func (v *PolicyViolation) Error() string { return v.Field + " " + v.Message }

// CheckNewPassword applies the policy: at least 12 characters and different from the current one.
// Lengths count characters (runes), not bytes.
func CheckNewPassword(current, next string) *PolicyViolation {
	n := utf8.RuneCountInString(next)
	switch {
	case n < MinPasswordLen:
		return &PolicyViolation{"new", "must be at least 12 characters"}
	case n > MaxPasswordLen:
		return &PolicyViolation{"new", "must be at most 200 characters"}
	case next == current:
		return &PolicyViolation{"new", "must differ from the current password"}
	}
	return nil
}

// SafeNext returns next when it is a same-origin relative path ("/stocks/TCS?tab=1"), otherwise
// "/". Absolute URLs, scheme-relative ("//evil"), backslash tricks and control characters are
// rejected (SEC-06).
func SafeNext(next string) string {
	const fallback = "/"
	if next == "" || next[0] != '/' || len(next) > 2048 {
		return fallback
	}
	if strings.HasPrefix(next, "//") || strings.Contains(next, "\\") {
		return fallback
	}
	for _, r := range next {
		if r < 0x20 || r == 0x7f {
			return fallback
		}
	}
	// Re-parse: the result must have no scheme or host and, after decoding, still must not start
	// with "//" or contain a backslash.
	u, err := url.Parse(next)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil {
		return fallback
	}
	if dec, err := url.PathUnescape(u.Path); err != nil || strings.HasPrefix(dec, "//") || strings.Contains(dec, "\\") {
		return fallback
	}
	return next
}
