package instruments

import (
	"testing"
	"time"
)

// MKTX-05: trading-day arithmetic used by the movers date pair and the read-time action window.
func TestCalendarTradingDayArithmetic(t *testing.T) {
	cal := NewCalendar([]time.Time{d("2026-10-16")}) // a Friday holiday
	if got := cal.PreviousTradingDate(d("2026-10-19")).Format(time.DateOnly); got != "2026-10-15" {
		t.Errorf("previous trading date of Mon after a Fri holiday = %s", got)
	}
	if got := NewCalendar(nil).PreviousTradingDate(d("2026-10-19")).Format(time.DateOnly); got != "2026-10-16" {
		t.Errorf("previous trading date of Mon = %s", got)
	}
	cases := []struct {
		from string
		n    int
		want string
	}{
		{"2026-10-19", 5, "2026-10-26"}, // 20 21 22 23 26
		{"2026-10-19", -1, "2026-10-15"},
		{"2026-10-19", 0, "2026-10-19"},
		{"2026-10-17", 1, "2026-10-19"}, // from a Saturday
	}
	for _, c := range cases {
		if got := cal.AddTradingDays(d(c.from), c.n).Format(time.DateOnly); got != c.want {
			t.Errorf("AddTradingDays(%s, %d) = %s want %s", c.from, c.n, got, c.want)
		}
	}
	if n := cal.TradingDaysBetween(d("2026-10-14"), d("2026-10-19")); n != 2 { // Thu 15, Mon 19
		t.Errorf("TradingDaysBetween = %d", n)
	}
	if n := cal.TradingDaysBetween(d("2026-10-19"), d("2026-10-19")); n != 0 {
		t.Errorf("same day = %d", n)
	}
}
