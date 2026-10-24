// Package mf serves the mutual fund endpoints (docs/03 section 10, docs/05 section 9). It reads
// only the database filled by the worker (D04); it never calls mfapi.in or AMFI.
package mf

import (
	"math"
	"sort"
	"time"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/finmath"
	"github.com/india-analyzer/api/internal/prices"
)

// Attribution is the text every MF response carries (docs/00 section 1, item 6).
const Attribution = "NAV data: AMFI, via mfapi.in"

// MaxPoints is the downsampling cap of the NAV series (docs/03 section 10).
const MaxPoints = 2000

// NavPoint is one NAV (INR per unit) on a date.
type NavPoint struct {
	Date time.Time
	NAV  float64
}

// SubtractMonths is the calendar offset d - months, clamping the day to the month length (same
// rule as the worker's subtract_months).
func SubtractMonths(d time.Time, months int) time.Time {
	total := d.Year()*12 + int(d.Month()) - 1 - months
	y, m := total/12, total%12+1
	last := time.Date(y, time.Month(m)+1, 0, 0, 0, 0, 0, time.UTC).Day()
	day := d.Day()
	if day > last {
		day = last
	}
	return time.Date(y, time.Month(m), day, 0, 0, 0, 0, time.UTC)
}

// rangeMonths maps the `range` parameter to months; MAX is 0 (everything).
var rangeMonths = map[string]int{"1M": 1, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "MAX": 0}

// RangeStart returns the first date of the window ending at end; the zero time for MAX.
func RangeStart(rng string, end time.Time) (time.Time, bool) {
	m, ok := rangeMonths[rng]
	if !ok {
		return time.Time{}, false
	}
	if m == 0 {
		return time.Time{}, true
	}
	return SubtractMonths(end, m), true
}

// Downsample keeps at most max points, always including the first and last, with LTTB
// (Largest-Triangle-Three-Buckets, shared with the price series) so NAV peaks and troughs survive.
// Every kept point is a real NAV. Series at or under the cap are returned unchanged.
func Downsample(p []NavPoint, max int) []NavPoint {
	n := len(p)
	if max < 2 || n <= max {
		return p
	}
	if max == 2 {
		return []NavPoint{p[0], p[n-1]}
	}
	bars := make([]prices.Bar, n)
	for i, x := range p {
		bars[i] = prices.Bar{Date: x.Date, Close: x.NAV}
	}
	kept := prices.LTTB(bars, max)
	out := make([]NavPoint, len(kept))
	for i, k := range kept {
		out[i] = NavPoint{Date: k.Date, NAV: k.Close}
	}
	return out
}

// onOrBefore is the index of the last NAV dated <= d, or -1 (docs/05 9.1).
func onOrBefore(p []NavPoint, d time.Time) int {
	return sort.Search(len(p), func(i int) bool { return p[i].Date.After(d) }) - 1
}

// onOrAfter is the index of the first NAV dated >= d, or len(p).
func onOrAfter(p []NavPoint, d time.Time) int {
	return sort.Search(len(p), func(i int) bool { return !p[i].Date.Before(d) })
}

// ---- SIP (docs/05 section 9.4) ----

// SIPInput are the validated simulation inputs.
type SIPInput struct {
	Amount decimal.Decimal
	Start  time.Time
	End    time.Time
	Day    int // 1-28
}

// Installment is one executed installment.
type Installment struct {
	Date    time.Time // scheduled installment date
	NavDate time.Time // date of the NAV it was executed at (first NAV date >= Date)
	NAV     float64
	Units   decimal.Decimal
}

// SIPResult is the simulation outcome. Value/Return/XIRR are nil when no installment executed.
type SIPResult struct {
	Installments []Installment
	Skipped      int // installments with no NAV to execute at inside [first NAV, End] (MF-10)
	Invested     decimal.Decimal
	Units        decimal.Decimal
	Value        *decimal.Decimal
	EndNavDate   *time.Time
	EndNAV       *float64
	AbsReturnPct *float64
	XIRRPct      *float64
	XIRRReason   string // why XIRRPct is nil
}

const minXIRRDays = 30 // docs/05 8.3: shorter spans show the absolute return only

// SimulateSIP runs the monthly SIP over navs (ascending). Installment dates are `Day` of each
// month within [Start, End]; each executes at the first NAV dated on or after it; units =
// amount/NAV with no load modelling; value = total units * the NAV on or before End. The XIRR
// cash flows are dated at the execution NAV date.
func SimulateSIP(navs []NavPoint, in SIPInput) SIPResult {
	res := SIPResult{Invested: decimal.Zero, Units: decimal.Zero}
	if len(navs) == 0 {
		return res
	}
	first := navs[0].Date
	var flows []finmath.CashFlow
	y, m := in.Start.Year(), in.Start.Month()
	for {
		d := time.Date(y, m, in.Day, 0, 0, 0, 0, time.UTC)
		if d.After(in.End) {
			break
		}
		if !d.Before(in.Start) {
			idx := onOrAfter(navs, d)
			// An installment whose executing NAV falls after End is not executed: it would be
			// bought at a post-End NAV but valued at the End NAV (OQ-B03B10-4).
			if d.Before(first) || idx >= len(navs) || navs[idx].Date.After(in.End) {
				res.Skipped++
			} else {
				p := navs[idx]
				units := in.Amount.Div(decimal.NewFromFloat(p.NAV))
				res.Installments = append(res.Installments, Installment{Date: d, NavDate: p.Date, NAV: p.NAV, Units: units})
				res.Invested = res.Invested.Add(in.Amount)
				res.Units = res.Units.Add(units)
				f, _ := in.Amount.Float64()
				flows = append(flows, finmath.CashFlow{Date: p.Date, Amount: -f})
			}
		}
		m++
		if m > time.December {
			m, y = time.January, y+1
		}
	}
	if len(res.Installments) == 0 {
		return res
	}
	ei := onOrBefore(navs, in.End)
	if ei < 0 {
		return res
	}
	end := navs[ei]
	value := res.Units.Mul(decimal.NewFromFloat(end.NAV))
	res.Value, res.EndNavDate, res.EndNAV = &value, &end.Date, &end.NAV
	inv, _ := res.Invested.Float64()
	val, _ := value.Float64()
	abs := round2((val/inv - 1) * 100)
	res.AbsReturnPct = &abs

	firstFlow := flows[0].Date
	if end.Date.Sub(firstFlow).Hours()/24 < minXIRRDays {
		res.XIRRReason = "period_too_short"
		return res
	}
	flows = append(flows, finmath.CashFlow{Date: end.Date, Amount: val})
	r, err := finmath.XIRR(flows)
	if err != nil {
		res.XIRRReason = "no_solution"
		return res
	}
	x := round2(r * 100)
	res.XIRRPct = &x
	return res
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// ---- Compare (docs/03 section 10; docs/05 sections 9.2, 9.3) ----

// Stats are the compare-table figures for one scheme over the compared window.
type Stats struct {
	ReturnPct       *float64 // CAGR when the window is >= 1 year, absolute otherwise
	ReturnBasis     string   // "cagr" | "absolute"
	VolatilityPct   *float64
	VolatilityNote  string // reason when VolatilityPct is nil
	MaxDrawdownPct  *float64
	WindowStart     time.Time
	WindowEnd       time.Time
	VolatilityYears float64
}

const weeklyGapDays = 3.0

// ComputeStats works on one scheme's own NAVs from the common start to the common end.
func ComputeStats(p []NavPoint) Stats {
	var s Stats
	if len(p) < 2 {
		s.VolatilityNote = "insufficient_history"
		return s
	}
	s.WindowStart, s.WindowEnd = p[0].Date, p[len(p)-1].Date
	days := s.WindowEnd.Sub(s.WindowStart).Hours() / 24
	ratio := p[len(p)-1].NAV / p[0].NAV
	if days >= 365 {
		v := round2((math.Pow(ratio, 365/days) - 1) * 100)
		s.ReturnPct, s.ReturnBasis = &v, "cagr"
	} else {
		v := round2((ratio - 1) * 100)
		s.ReturnPct, s.ReturnBasis = &v, "absolute"
	}
	peak, worst := p[0].NAV, 0.0
	for _, x := range p {
		peak = math.Max(peak, x.NAV)
		worst = math.Min(worst, x.NAV/peak-1)
	}
	dd := round2(worst * 100)
	s.MaxDrawdownPct = &dd

	// Volatility over the last 3Y of the window (or all of it when shorter, but >= 1Y).
	w := p
	if cut := SubtractMonths(s.WindowEnd, 36); p[0].Date.Before(cut) {
		w = p[onOrAfter(p, cut):]
	}
	years := w[len(w)-1].Date.Sub(w[0].Date).Hours() / 24 / 365
	switch {
	case len(w) < 3 || w[len(w)-1].Date.Sub(w[0].Date).Hours()/24 < 365:
		s.VolatilityNote = "insufficient_history"
	case medianGapDays(w) > weeklyGapDays:
		s.VolatilityNote = "weekly_nav" // MF-07
	default:
		logs := make([]float64, 0, len(w)-1)
		for i := 1; i < len(w); i++ {
			logs = append(logs, math.Log(w[i].NAV/w[i-1].NAV))
		}
		v := round2(stdev(logs) * math.Sqrt(252) * 100)
		s.VolatilityPct, s.VolatilityYears = &v, math.Round(years*100)/100
	}
	return s
}

func medianGapDays(p []NavPoint) float64 {
	gaps := make([]float64, 0, len(p)-1)
	for i := 1; i < len(p); i++ {
		gaps = append(gaps, p[i].Date.Sub(p[i-1].Date).Hours()/24)
	}
	sort.Float64s(gaps)
	n := len(gaps)
	if n%2 == 1 {
		return gaps[n/2]
	}
	return (gaps[n/2-1] + gaps[n/2]) / 2
}

func stdev(x []float64) float64 {
	n := float64(len(x))
	if n < 2 {
		return 0
	}
	mean := 0.0
	for _, v := range x {
		mean += v
	}
	mean /= n
	ss := 0.0
	for _, v := range x {
		ss += (v - mean) * (v - mean)
	}
	return math.Sqrt(ss / (n - 1))
}

// CommonDates returns, ascending, the dates present in every series.
func CommonDates(series [][]NavPoint) []time.Time {
	if len(series) == 0 {
		return nil
	}
	count := map[time.Time]int{}
	for _, s := range series {
		for _, p := range s {
			count[p.Date]++
		}
	}
	var out []time.Time
	for _, p := range series[0] {
		if count[p.Date] == len(series) {
			out = append(out, p.Date)
		}
	}
	return out
}

// Rebase returns the series values on dates scaled to 100 at dates[0].
func Rebase(p []NavPoint, dates []time.Time) []float64 {
	byDate := make(map[time.Time]float64, len(p))
	for _, x := range p {
		byDate[x.Date] = x.NAV
	}
	base := byDate[dates[0]]
	out := make([]float64, len(dates))
	for i, d := range dates {
		out[i] = byDate[d] / base * 100
	}
	return out
}
