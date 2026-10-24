// Package ownerdata serves the read side of owner-supplied fundamentals, shareholding, corporate
// events and research links (B05; docs/03 section 5, docs/05 sections 2 and 5).
package ownerdata

import (
	"fmt"
	"time"
)

// FiscalYear returns the Indian fiscal year of a date: FY = the year of the March that ends it
// (FY27 = Apr 2026 - Mar 2027), docs/05 section 5.
func FiscalYear(d time.Time) int {
	if d.Month() >= time.April {
		return d.Year() + 1
	}
	return d.Year()
}

// FiscalQuarter returns 1..4 for the quarter containing the date (Q1 = Apr-Jun ... Q4 = Jan-Mar).
func FiscalQuarter(d time.Time) int {
	switch m := d.Month(); {
	case m >= time.April && m <= time.June:
		return 1
	case m >= time.July && m <= time.September:
		return 2
	case m >= time.October:
		return 3
	default:
		return 4
	}
}

// Label is the fiscal label of a period end: "Q2 FY27" for quarterly, "FY26" for annual
// (period type "Q" or "A").
func Label(periodEnd time.Time, periodType string) string {
	fy := FiscalYear(periodEnd) % 100
	if periodType == "A" {
		return fmt.Sprintf("FY%02d", fy)
	}
	return fmt.Sprintf("Q%d FY%02d", FiscalQuarter(periodEnd), fy)
}
