// Package logx builds the zerolog JSON logger and the secret scrubber (docs/03-api-spec.md section 16:
// log lines never contain passwords, cookies, tokens or full request bodies; CLAUDE.md 0.7).
package logx

import (
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

// Redacted replaces every secret found in a log line.
const Redacted = "[REDACTED]"

const minSecretLen = 6

var (
	// "password": "x" style JSON members whose key names a secret.
	jsonSecret = regexp.MustCompile(`(?i)("[^"\\]*(?:password|passwd|pwd|token|secret|cookie|authorization|session|api_?key|totp|csrf)[^"\\]*"\s*:\s*)"(?:[^"\\]|\\.)*"`)
	// password=x, token=x, session=x in free text, query strings and Cookie headers.
	kvSecret = regexp.MustCompile(`(?i)\b([a-z_]*(?:password|passwd|pwd|token|secret|session|api_?key|totp)[a-z_]*)=("[^"]*"|[^&;\s"\\,]+)`)
	bearer   = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}`)
	userinfo = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@"\\]+):[^@\s"\\/]+@`)
	argon    = regexp.MustCompile(`\$argon2[a-z]*\$[^\s"\\]+`)
	botToken = regexp.MustCompile(`\d{6,}:[A-Za-z0-9_-]{30,}`)
	jwt      = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*`)
)

// Scrubber redacts secrets from serialized log lines. Register exact secret values (config secrets)
// with Add so they are removed even when they appear without a recognisable key.
type Scrubber struct {
	mu      sync.RWMutex
	secrets []string
}

// NewScrubber returns a scrubber that already knows the given exact secret values.
func NewScrubber(secrets ...string) *Scrubber {
	s := &Scrubber{}
	s.Add(secrets...)
	return s
}

// Add registers exact secret values; values shorter than six characters are ignored (too many false hits).
func (s *Scrubber) Add(values ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range values {
		if len(v) >= minSecretLen {
			s.secrets = append(s.secrets, v)
		}
	}
}

// Scrub returns line with secrets replaced by Redacted.
func (s *Scrubber) Scrub(line string) string {
	s.mu.RLock()
	for _, sec := range s.secrets {
		line = strings.ReplaceAll(line, sec, Redacted)
		// A secret inside a JSON string is escaped; catch the common escapes too.
		if esc := jsonEscape(sec); esc != sec {
			line = strings.ReplaceAll(line, esc, Redacted)
		}
	}
	s.mu.RUnlock()
	line = jsonSecret.ReplaceAllString(line, `$1"`+Redacted+`"`)
	line = kvSecret.ReplaceAllString(line, `$1=`+Redacted)
	line = bearer.ReplaceAllString(line, `$1 `+Redacted)
	line = userinfo.ReplaceAllString(line, `$1:`+Redacted+`@`)
	line = argon.ReplaceAllString(line, Redacted)
	line = botToken.ReplaceAllString(line, Redacted)
	line = jwt.ReplaceAllString(line, Redacted)
	return line
}

func jsonEscape(v string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`, "\r", `\r`)
	return r.Replace(v)
}

// Writer wraps w so every Write (zerolog emits one event per Write) is scrubbed first.
func (s *Scrubber) Writer(w io.Writer) io.Writer { return &scrubWriter{s: s, w: w} }

type scrubWriter struct {
	s *Scrubber
	w io.Writer
}

func (sw *scrubWriter) Write(p []byte) (int, error) {
	if _, err := sw.w.Write([]byte(sw.s.Scrub(string(p)))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// New returns a JSON logger writing scrubbed lines to w with UTC RFC 3339 timestamps.
func New(w io.Writer, level string, s *Scrubber) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339
	zerolog.TimestampFunc = func() time.Time { return time.Now().UTC() }
	lvl, err := zerolog.ParseLevel(strings.ToLower(level))
	if err != nil || level == "" {
		lvl = zerolog.InfoLevel
	}
	if s == nil {
		s = NewScrubber()
	}
	return zerolog.New(s.Writer(w)).Level(lvl).With().Timestamp().Str("service", "api").Logger()
}
