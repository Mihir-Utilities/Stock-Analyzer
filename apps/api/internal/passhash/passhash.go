// Package passhash hashes and verifies the owner password with argon2id (CLAUDE.md section 4).
// Encoded form: $argon2id$v=19$m=19456,t=2,p=1$<salt b64>$<hash b64> (the standard PHC string).
package passhash

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Parameters follow the OWASP minimum for argon2id (19 MiB, 2 iterations, 1 lane), which fits the
// Render free-tier memory limit.
const (
	memoryKiB  = 19456
	iterations = 2
	lanes      = 1
	saltLen    = 16
	keyLen     = 32
	prefix     = "$argon2id$"
	// MinPasswordLen is a floor for the helper; the real policy lives in the auth task.
	MinPasswordLen = 12
)

// ErrMalformed is returned when an encoded hash is not a valid argon2id PHC string.
var ErrMalformed = errors.New("passhash: not a valid argon2id encoded hash")

// Hash returns the argon2id PHC string for password.
func Hash(password string) (string, error) {
	if len(password) < MinPasswordLen {
		return "", fmt.Errorf("passhash: password must be at least %d characters", MinPasswordLen)
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("passhash: reading randomness: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, iterations, memoryKiB, lanes, keyLen)
	return fmt.Sprintf("%sv=%d$m=%d,t=%d,p=%d$%s$%s", prefix, argon2.Version, memoryKiB, iterations, lanes,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

type params struct {
	m, t uint32
	p    uint8
	salt []byte
	key  []byte
}

func parse(encoded string) (params, error) {
	var out params
	if !strings.HasPrefix(encoded, prefix) {
		return out, ErrMalformed
	}
	parts := strings.Split(encoded, "$") // "", "argon2id", "v=19", "m=..,t=..,p=..", salt, key
	if len(parts) != 6 {
		return out, ErrMalformed
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return out, ErrMalformed
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &out.m, &out.t, &out.p); err != nil {
		return out, ErrMalformed
	}
	if out.m == 0 || out.t == 0 || out.p == 0 {
		return out, ErrMalformed
	}
	var err error
	if out.salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil || len(out.salt) == 0 {
		return out, ErrMalformed
	}
	if out.key, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil || len(out.key) == 0 {
		return out, ErrMalformed
	}
	return out, nil
}

// Validate reports whether encoded is a well-formed argon2id hash (used by the seed command so a
// plaintext password in INITIAL_PASSWORD_HASH is rejected).
func Validate(encoded string) error {
	_, err := parse(encoded)
	return err
}

// Verify checks password against an encoded hash in constant time.
func Verify(password, encoded string) (bool, error) {
	p, err := parse(encoded)
	if err != nil {
		return false, err
	}
	key := argon2.IDKey([]byte(password), p.salt, p.t, p.m, p.p, uint32(len(p.key))) //nolint:gosec // key length parsed from base64, bounded by input size
	return subtle.ConstantTimeCompare(key, p.key) == 1, nil
}
