// Package instruments serves the stock list, search and profile (docs/03-api-spec.md section 3).
package instruments

import "time"

// IST is the market time zone as a fixed offset (no tzdata dependency; India has no DST).
var IST = time.FixedZone("IST", 5*3600+30*60)

// EODCutoffHour is the IST hour after which today's bar counts as expected (docs/01 section 6.1:
// a bar for the current day is only final after 18:00 IST).
const EODCutoffHour = 18

// StaleCalendarDaysWithoutHolidays is the fallback rule when the year has no holiday rows
// (docs/03 section 3, SYS-13).
const StaleCalendarDaysWithoutHolidays = 4

// Calendar knows the trading holidays loaded from market_holiday.
type Calendar struct {
	holidays map[string]bool // YYYY-MM-DD
}

// NewCalendar builds a calendar from holiday dates.
func NewCalendar(holidays []time.Time) Calendar {
	m := make(map[string]bool, len(holidays))
	for _, h := range holidays {
		m[h.Format(time.DateOnly)] = true
	}
	return Calendar{holidays: m}
}

func (c Calendar) isTradingDay(d time.Time) bool {
	if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
		return false
	}
	return !c.holidays[d.Format(time.DateOnly)]
}

// ExpectedLastTradingDate is the latest trading date whose bar should exist at now: today (IST) if it
// is a trading day and the clock is past the EOD cutoff, otherwise the previous trading day. The
// result is a date at 00:00 UTC carrying the IST calendar date.
func (c Calendar) ExpectedLastTradingDate(now time.Time) time.Time {
	ist := now.In(IST)
	d := time.Date(ist.Year(), ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC)
	if !c.isTradingDay(d) || ist.Hour() < EODCutoffHour {
		d = d.AddDate(0, 0, -1)
	}
	// Bounded walk: no real calendar has a month without a trading day.
	for i := 0; i < 366 && !c.isTradingDay(d); i++ {
		d = d.AddDate(0, 0, -1)
	}
	return d
}

// Staleness is the result of the SYS-13 rule.
type Staleness struct {
	Stale          bool
	AgeHours       float64
	HolidaysMissed bool // holidays_missing
}

// PricesStaleness applies docs/03 section 3. lastBar is the last imported bar date (nil when none:
// not stale, the no_prices flag speaks instead). holidaysForYear says whether the IST year of now has
// any holiday row.
func (c Calendar) PricesStaleness(now time.Time, lastBar *time.Time, holidaysForYear bool) Staleness {
	s := Staleness{HolidaysMissed: !holidaysForYear}
	if lastBar == nil {
		return s
	}
	lb := time.Date(lastBar.Year(), lastBar.Month(), lastBar.Day(), 0, 0, 0, 0, time.UTC)
	ist := now.In(IST)
	today := time.Date(ist.Year(), ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC)
	if holidaysForYear {
		exp := c.ExpectedLastTradingDate(now)
		if lb.Before(exp) {
			s.Stale = true
			s.AgeHours = exp.Sub(lb).Hours()
		}
		return s
	}
	days := int(today.Sub(lb).Hours() / 24)
	if days > StaleCalendarDaysWithoutHolidays {
		s.Stale = true
		s.AgeHours = float64(days) * 24
	}
	return s
}
