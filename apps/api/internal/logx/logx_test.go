package logx

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// SEC-08: secrets never reach the log output.
func TestScrubberRedactsSecretPatterns(t *testing.T) {
	sc := NewScrubber("exact-config-secret-value")
	cases := []struct {
		name  string
		line  string
		leaks []string
	}{
		{"cookie header", `Cookie: session=abcDEF123456; theme=dark`, []string{"abcDEF123456"}},
		{"set-cookie json field", `{"set-cookie":"session=zzz999yyy888; HttpOnly"}`, []string{"zzz999yyy888"}},
		{"json password", `{"password":"Hunter2-Hunter2"}`, []string{"Hunter2-Hunter2"}},
		{"json token", `{"access_token":"tok_live_123456789"}`, []string{"tok_live_123456789"}},
		{"json authorization", `{"authorization":"Bearer abcdef.ghijkl"}`, []string{"abcdef.ghijkl"}},
		{"query password", `GET /x?password=p4ssw0rd-long&a=1`, []string{"p4ssw0rd-long"}},
		{"query token", `url=/cb?token=SECRETTOKEN123&x=1`, []string{"SECRETTOKEN123"}},
		{"bearer text", `sent header Authorization: Bearer abc.def.ghi-123456`, []string{"abc.def.ghi-123456"}},
		{"db url password", `connect postgres://analyzer:pg-pass-9999@db.example.test/app`, []string{"pg-pass-9999"}},
		{"argon2 hash", `hash $argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo`, []string{"c2FsdHNhbHQ", "aGFzaGhhc2hoYXNo"}},
		{"telegram bot token", `POST https://api.telegram.org/bot123456789:AAE_abcdefghijklmnopqrstuvwxyz012345/sendMessage`, []string{"AAE_abcdefghijklmnopqrstuvwxyz012345"}},
		{"jwt", `id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_value_xyz`, []string{"eyJzdWIiOiIxMjM0NTY3ODkwIn0"}},
		{"exact config secret", `worker call failed key=exact-config-secret-value end`, []string{"exact-config-secret-value"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := sc.Scrub(tc.line)
			for _, leak := range tc.leaks {
				if strings.Contains(out, leak) {
					t.Fatalf("leaked %q in %q", leak, out)
				}
			}
			if !strings.Contains(out, Redacted) {
				t.Fatalf("nothing redacted: %q", out)
			}
		})
	}
}

func TestScrubberKeepsHarmlessText(t *testing.T) {
	sc := NewScrubber("short")
	line := `{"level":"info","method":"GET","path":"/api/v1/stocks/TCS","status":200,"request_id":"abc123"}`
	if out := sc.Scrub(line); out != line {
		t.Fatalf("changed harmless line: %q", out)
	}
}

func TestLoggerEmitsScrubbedJSON(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, "info", NewScrubber("exact-config-secret-value"))
	log.Info().Str("password", "Hunter2-Hunter2").Str("note", "dsn postgres://u:pg-pass-9999@h/db").
		Str("other", "exact-config-secret-value").Msg("login attempt token=abcdef123456")
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatalf("not JSON: %v: %s", err, buf.String())
	}
	for _, leak := range []string{"Hunter2-Hunter2", "pg-pass-9999", "exact-config-secret-value", "abcdef123456"} {
		if strings.Contains(buf.String(), leak) {
			t.Fatalf("leaked %q: %s", leak, buf.String())
		}
	}
	if m["service"] != "api" || m["time"] == nil {
		t.Fatalf("missing standard fields: %v", m)
	}
}

func TestLoggerLevelFilter(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, "warn", nil)
	log.Info().Msg("hidden")
	if buf.Len() != 0 {
		t.Fatalf("info logged at warn level: %s", buf.String())
	}
}
