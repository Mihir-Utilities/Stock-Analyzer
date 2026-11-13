package journal

import (
	"strings"
	"testing"
	"time"
)

func d(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

func sp(s string) *string { return &s }

// JRN-06 / JRN-07: length is counted in characters; control characters are refused.
func TestValidateNote(t *testing.T) {
	tests := []struct {
		name    string
		in      *string
		want    string
		wantErr string
	}{
		{"missing", nil, "", "is required"},
		{"empty", sp(""), "", "must not be blank"},
		{"blank", sp(" \n\t "), "", "must not be blank"},
		{"trimmed", sp("  why I bought  "), "why I bought", ""},
		{"1000 ascii", sp(strings.Repeat("a", 1000)), strings.Repeat("a", 1000), ""},
		{"1001 ascii", sp(strings.Repeat("a", 1001)), "", "at most 1000"},
		{"1000 multibyte", sp(strings.Repeat("\u20b9", 1000)), strings.Repeat("\u20b9", 1000), ""},
		{"1001 multibyte", sp(strings.Repeat("\u20b9", 1001)), "", "at most 1000"},
		{"newline and tab kept", sp("a\n\tb"), "a\n\tb", ""},
		{"crlf normalised", sp("a\r\nb\rc"), "a\nb\nc", ""},
		{"nul", sp("a\x00b"), "", "control characters"},
		{"bel", sp("a\x07b"), "", "control characters"},
		{"escape", sp("a\x1bb"), "", "control characters"},
		{"html kept verbatim", sp("<script>alert(1)</script> M&M"), "<script>alert(1)</script> M&M", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, fe := ValidateNote(tc.in)
			if tc.wantErr == "" {
				if len(fe) != 0 || got != tc.want {
					t.Fatalf("got %q, %v; want %q", got, fe, tc.want)
				}
				return
			}
			if len(fe) != 1 || fe[0].Field != "note" || !strings.Contains(fe[0].Message, tc.wantErr) {
				t.Fatalf("got %v, want error containing %q", fe, tc.wantErr)
			}
		})
	}
}

// JRN-09: review date rules.
func TestParseReviewOn(t *testing.T) {
	today := d("2026-11-12")
	stored := d("2026-11-01")
	tests := []struct {
		name    string
		raw     string
		keep    *time.Time
		wantErr string
	}{
		{"today", "2026-11-12", nil, ""},
		{"tomorrow", "2026-11-13", nil, ""},
		{"yesterday", "2026-11-11", nil, "today or later"},
		{"ten years exactly", "2036-11-12", nil, ""},
		{"ten years and a day", "2036-11-13", nil, "within 10 years"},
		{"invalid", "2026-02-30", nil, "YYYY-MM-DD"},
		{"not a date", "soon", nil, "YYYY-MM-DD"},
		{"empty", "", nil, "YYYY-MM-DD"},
		{"past equal to stored", "2026-11-01", &stored, ""},
		{"past different from stored", "2026-10-31", &stored, "today or later"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, fe := ParseReviewOn(tc.raw, today, tc.keep)
			if tc.wantErr == "" && fe != nil {
				t.Fatalf("unexpected error %v", fe)
			}
			if tc.wantErr != "" && (fe == nil || !strings.Contains(fe.Message, tc.wantErr)) {
				t.Fatalf("got %v, want %q", fe, tc.wantErr)
			}
		})
	}
}

// JRN-10: the review-due rule on the boundaries (today 2026-11-12).
func TestReviewDue(t *testing.T) {
	today := d("2026-11-12")
	day := func(s string) *time.Time { v := d(s); return &v }
	tests := []struct {
		name   string
		status string
		on     *time.Time
		want   bool
	}{
		{"open yesterday", "open", day("2026-11-11"), true},
		{"open today counts", "open", day("2026-11-12"), true},
		{"open tomorrow", "open", day("2026-11-13"), false},
		{"reviewed past", "reviewed", day("2026-11-01"), false},
		{"open no date", "open", nil, false},
	}
	for _, tc := range tests {
		if got := ReviewDue(tc.status, tc.on, today); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

// JRN-03 / JRN-11: the owner's date is the IST date of the injected clock.
func TestToday(t *testing.T) {
	tests := []struct{ utc, want string }{
		{"2026-12-31T18:29:59Z", "2026-12-31"},
		{"2026-12-31T18:30:00Z", "2027-01-01"},
		{"2026-12-31T18:31:00Z", "2027-01-01"},
		{"2026-11-12T00:00:00Z", "2026-11-12"},
	}
	for _, tc := range tests {
		now, err := time.Parse(time.RFC3339, tc.utc)
		if err != nil {
			t.Fatal(err)
		}
		if got := ymd(Today(now)); got != tc.want {
			t.Errorf("%s: got %s want %s", tc.utc, got, tc.want)
		}
	}
}

func TestIdempotencyKeyValid(t *testing.T) {
	if !IdempotencyKeyValid("0b6c4f3e-8f3a-4a52-9c0e-0d7d1d2f3a4b") || IdempotencyKeyValid("nope") || IdempotencyKeyValid("") {
		t.Fatal("uuid check wrong")
	}
}
