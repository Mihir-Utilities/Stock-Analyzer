package auth

import (
	"strings"
	"testing"
	"time"
)

// SEC-12: minimum 12 characters (runes, not bytes), must differ from the current password.
func TestCheckNewPassword(t *testing.T) {
	cases := []struct {
		name, current, next, wantMsg string
	}{
		{"11 chars", "old-password-1", "abcdefghijk", "at least 12"},
		{"12 chars ok", "old-password-1", "abcdefghijkl", ""},
		{"12 multibyte runes ok", "old-password-1", strings.Repeat("é", 12), ""},
		{"11 multibyte runes rejected", "old-password-1", strings.Repeat("é", 11), "at least 12"},
		{"same as current", "same-password-123", "same-password-123", "differ"},
		{"empty", "old-password-1", "", "at least 12"},
		{"200 ok", "old-password-1", strings.Repeat("a", 200), ""},
		{"201 rejected", "old-password-1", strings.Repeat("a", 201), "at most 200"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := CheckNewPassword(tc.current, tc.next)
			if tc.wantMsg == "" {
				if v != nil {
					t.Fatalf("unexpected violation %v", v)
				}
				return
			}
			if v == nil || v.Field != "new" || !strings.Contains(v.Message, tc.wantMsg) {
				t.Fatalf("violation = %v, want message containing %q", v, tc.wantMsg)
			}
		})
	}
}

// SEC-06: only same-origin relative paths survive.
func TestSafeNext(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/stocks/TCS", "/stocks/TCS"},
		{"/stocks/M%26M?tab=chart#top", "/stocks/M%26M?tab=chart#top"},
		{"/", "/"},
		{"", "/"},
		{"https://evil.example/x", "/"},
		{"http://evil.example", "/"},
		{"//evil.example", "/"},
		{"///evil.example", "/"},
		{"/\\evil.example", "/"},
		{"\\\\evil.example", "/"},
		{"/%2F%2Fevil.example", "/"},
		{"/%5Cevil.example", "/"},
		{"javascript:alert(1)", "/"},
		{"evil.example/path", "/"},
		{"/path\r\nSet-Cookie: x=1", "/"},
		{"/pa\tth", "/"},
		{"/ok" + strings.Repeat("a", 3000), "/"},
		{"/%zz", "/"},
	}
	for _, tc := range cases {
		if got := SafeNext(tc.in); got != tc.want {
			t.Errorf("SafeNext(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// SEC-01: 15 min doubling per lockout, capped at 24 h.
func TestLockDuration(t *testing.T) {
	cases := []struct {
		lockouts int
		want     time.Duration
	}{
		{0, 15 * time.Minute}, {1, 15 * time.Minute}, {2, 30 * time.Minute}, {3, time.Hour},
		{4, 2 * time.Hour}, {5, 4 * time.Hour}, {6, 8 * time.Hour}, {7, 16 * time.Hour},
		{8, 24 * time.Hour}, {9, 24 * time.Hour}, {1000, 24 * time.Hour},
	}
	for _, tc := range cases {
		if got := lockDuration(tc.lockouts); got != tc.want {
			t.Errorf("lockDuration(%d) = %v, want %v", tc.lockouts, got, tc.want)
		}
	}
}

// SEC-01: the failure delay is always within 300-800 ms and is not constant.
func TestRandomFailDelayRange(t *testing.T) {
	seen := map[time.Duration]bool{}
	for i := 0; i < 500; i++ {
		d := RandomFailDelay()
		if d < 300*time.Millisecond || d > 800*time.Millisecond {
			t.Fatalf("delay %v outside 300-800 ms", d)
		}
		seen[d] = true
	}
	if len(seen) < 20 {
		t.Fatalf("delay not random enough: %d distinct values", len(seen))
	}
}
