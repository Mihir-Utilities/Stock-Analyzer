// Package validate holds input checks shared by the read APIs.
package validate

import (
	"strings"
	"unicode/utf8"
)

// Text reports whether s can be sent to Postgres as a text parameter: valid UTF-8 and no NUL
// byte (Postgres rejects both, which would otherwise surface as a 500).
func Text(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}
