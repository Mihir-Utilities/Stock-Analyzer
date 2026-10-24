package ownerdata

import (
	"testing"
	"time"
)

func day(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

// FND-01: fiscal labels including the year and quarter boundaries.
func TestLabelFND01(t *testing.T) {
	cases := []struct{ end, typ, want string }{
		{"2026-09-30", "Q", "Q2 FY27"},
		{"2026-03-31", "Q", "Q4 FY26"},
		{"2026-06-30", "Q", "Q1 FY27"},
		{"2026-12-31", "Q", "Q3 FY27"},
		{"2027-03-31", "Q", "Q4 FY27"},
		{"2025-12-31", "Q", "Q3 FY26"},
		{"2000-03-31", "Q", "Q4 FY00"},
		{"2099-06-30", "Q", "Q1 FY00"},
		{"2026-03-31", "A", "FY26"},
		{"2026-04-01", "A", "FY27"},
		{"2025-12-31", "A", "FY26"}, // non-March annual date maps to the March that ends its year
	}
	for _, c := range cases {
		if got := Label(day(c.end), c.typ); got != c.want {
			t.Errorf("Label(%s,%s) = %q, want %q", c.end, c.typ, got, c.want)
		}
	}
}
