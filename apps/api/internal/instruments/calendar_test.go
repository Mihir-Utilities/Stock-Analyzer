package instruments

import (
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

// ist builds an instant from an IST wall clock.
func ist(date string, hour int) time.Time {
	t := d(date)
	return time.Date(t.Year(), t.Month(), t.Day(), hour, 0, 0, 0, IST).UTC()
}

// API-27
func TestExpectedLastTradingDate(t *testing.T) {
	cal := NewCalendar([]time.Time{d("2026-10-20")}) // a Tuesday holiday
	cases := []struct {
		name string
		now  time.Time
		want string
	}{
		{"wednesday after cutoff", ist("2026-10-14", 19), "2026-10-14"},
		{"wednesday before cutoff", ist("2026-10-14", 10), "2026-10-13"},
		{"monday before cutoff skips weekend", ist("2026-10-12", 9), "2026-10-09"},
		{"saturday", ist("2026-10-17", 20), "2026-10-16"},
		{"sunday", ist("2026-10-18", 20), "2026-10-16"},
		{"day after holiday, morning", ist("2026-10-21", 9), "2026-10-19"},
		{"holiday itself, evening", ist("2026-10-20", 20), "2026-10-19"},
		{"IST date differs from UTC date", time.Date(2026, 10, 14, 19, 0, 0, 0, time.UTC), "2026-10-14"}, // 00:30 IST Thu: before cutoff -> Wed
	}
	for _, c := range cases {
		got := cal.ExpectedLastTradingDate(c.now).Format(time.DateOnly)
		if got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

// SYS-13
func TestPricesStaleness(t *testing.T) {
	cal := NewCalendar([]time.Time{d("2026-10-20")})
	lb := func(s string) *time.Time { x := d(s); return &x }
	cases := []struct {
		name     string
		now      time.Time
		last     *time.Time
		holidays bool
		stale    bool
		missing  bool
	}{
		{"holidays: bar equals expected", ist("2026-10-14", 19), lb("2026-10-14"), true, false, false},
		{"holidays: bar one trading day behind", ist("2026-10-14", 19), lb("2026-10-13"), true, true, false},
		{"holidays: morning, yesterday's bar is current", ist("2026-10-14", 9), lb("2026-10-13"), true, false, false},
		{"holidays: Friday bar on Monday morning", ist("2026-10-12", 9), lb("2026-10-09"), true, false, false},
		{"holidays: bar before the holiday on the day after", ist("2026-10-21", 9), lb("2026-10-19"), true, false, false},
		{"holidays: bar older than the holiday", ist("2026-10-21", 9), lb("2026-10-16"), true, true, false},
		{"holidays: no bars", ist("2026-10-14", 19), nil, true, false, false},
		{"no holidays: 3 days old is fresh", ist("2026-10-14", 19), lb("2026-10-11"), false, false, true},
		{"no holidays: exactly 4 days is fresh", ist("2026-10-14", 19), lb("2026-10-10"), false, false, true},
		{"no holidays: 5 days is stale", ist("2026-10-14", 19), lb("2026-10-09"), false, true, true},
		{"no holidays: no bars", ist("2026-10-14", 19), nil, false, false, true},
	}
	for _, c := range cases {
		s := cal.PricesStaleness(c.now, c.last, c.holidays)
		if s.Stale != c.stale || s.HolidaysMissed != c.missing {
			t.Errorf("%s: stale=%v missing=%v, want %v %v", c.name, s.Stale, s.HolidaysMissed, c.stale, c.missing)
		}
		if s.Stale && s.AgeHours <= 0 {
			t.Errorf("%s: stale with age %v", c.name, s.AgeHours)
		}
	}
}
