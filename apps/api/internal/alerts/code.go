package alerts

import (
	"crypto/rand"
	"crypto/sha256"
	"strings"
)

// CodeAlphabet is unambiguous (no 0/O, 1/I). 32 symbols, so a random byte masked with 31 is unbiased.
const CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const codeLen = 8

// GenerateCode returns a new random link code: display form `A7K9-Q2XM` and the normalised form
// (8 characters) that is hashed.
func GenerateCode() (display, normalized string, err error) {
	var b [codeLen]byte
	if _, err = rand.Read(b[:]); err != nil {
		return "", "", err
	}
	out := make([]byte, codeLen)
	for i, v := range b {
		out[i] = CodeAlphabet[v&31]
	}
	n := string(out)
	return n[:4] + "-" + n[4:], n, nil
}

// NormalizeCode upper-cases the input, drops dashes and spaces and checks the shape (8 characters
// from CodeAlphabet). Anything else is not a code.
func NormalizeCode(s string) (string, bool) {
	s = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(s))
	if len(s) != codeLen {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		if !strings.ContainsRune(CodeAlphabet, rune(s[i])) {
			return "", false
		}
	}
	return s, true
}

// HashCode is what the database stores: sha256 of the normalised code.
func HashCode(normalized string) []byte {
	h := sha256.Sum256([]byte(normalized))
	return h[:]
}
