package mf

import (
	"math"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func d(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

// daily builds a NAV per calendar day from start, growing by pct per day.
func daily(start string, n int, nav0, pct float64) []NavPoint {
	out := make([]NavPoint, n)
	v := nav0
	for i := range out {
		out[i] = NavPoint{Date: d(start).AddDate(0, 0, i), NAV: v}
		v *= 1 + pct
	}
	return out
}

func TestSubtractMonthsClamps(t *testing.T) {
	cases := map[string]string{"2024-03-31": "2024-02-29", "2025-03-31": "2025-02-28", "2024-01-15": "2023-12-15"}
	for in, want := range cases {
		if got := SubtractMonths(d(in), 1); !got.Equal(d(want)) {
			t.Errorf("%s -1M = %s, want %s", in, got.Format(time.DateOnly), want)
		}
	}
}

func TestRangeStart(t *testing.T) {
	end := d("2026-09-30")
	if s, ok := RangeStart("1Y", end); !ok || !s.Equal(d("2025-09-30")) {
		t.Fatalf("1Y = %v %v", s, ok)
	}
	if s, ok := RangeStart("MAX", end); !ok || !s.IsZero() {
		t.Fatalf("MAX = %v %v", s, ok)
	}
	if _, ok := RangeStart("2Y", end); ok {
		t.Fatal("2Y must be rejected")
	}
}

func TestDownsample(t *testing.T) {
	p := daily("2000-01-01", 10000, 10, 0.0001)
	out := Downsample(p, MaxPoints)
	if len(out) != MaxPoints || out[0] != p[0] || out[len(out)-1] != p[len(p)-1] {
		t.Fatalf("len=%d first/last kept=%v", len(out), out[0] == p[0])
	}
	for i := 1; i < len(out); i++ {
		if !out[i].Date.After(out[i-1].Date) {
			t.Fatal("not strictly ascending")
		}
	}
	if short := Downsample(p[:50], MaxPoints); len(short) != 50 {
		t.Fatal("short series must be unchanged")
	}
}

// A single NAV spike between stride samples must survive downsampling (LTTB, not an even stride).
func TestDownsampleKeepsNavPeak(t *testing.T) {
	p := daily("2000-01-01", 10000, 10, 0)
	p[4321].NAV = 500
	out := Downsample(p, MaxPoints)
	found := false
	for _, x := range out {
		found = found || x.NAV == 500
	}
	if !found || len(out) != MaxPoints {
		t.Fatalf("peak lost (found=%v, len=%d)", found, len(out))
	}
}

func sipIn(amount, start, end string, day int) SIPInput {
	return SIPInput{Amount: decimal.RequireFromString(amount), Start: d(start), End: d(end), Day: day}
}

func TestSIPBasic(t *testing.T) {
	// Flat NAV 10 for 2 years: 12 installments of 1000 = 100 units each, value = invested, XIRR 0.
	navs := daily("2023-12-01", 800, 10, 0)
	r := SimulateSIP(navs, sipIn("1000", "2024-01-01", "2024-12-31", 5))
	if len(r.Installments) != 12 || r.Skipped != 0 {
		t.Fatalf("installments=%d skipped=%d", len(r.Installments), r.Skipped)
	}
	if !r.Invested.Equal(decimal.NewFromInt(12000)) || !r.Value.Equal(decimal.NewFromInt(12000)) {
		t.Fatalf("invested=%s value=%s", r.Invested, r.Value)
	}
	if r.XIRRPct == nil || math.Abs(*r.XIRRPct) > 0.01 || *r.AbsReturnPct != 0 {
		t.Fatalf("xirr=%v abs=%v", r.XIRRPct, r.AbsReturnPct)
	}
}

// MF-10: installments before the first NAV are skipped and counted.
func TestSIPStartBeforeFirstNAV(t *testing.T) {
	navs := daily("2024-03-10", 400, 10, 0)
	r := SimulateSIP(navs, sipIn("500", "2024-01-01", "2024-06-30", 1))
	// Jan 1, Feb 1, Mar 1 precede 2024-03-10; Apr, May, Jun execute.
	if r.Skipped != 3 || len(r.Installments) != 3 {
		t.Fatalf("skipped=%d executed=%d", r.Skipped, len(r.Installments))
	}
}

// An installment on a date without a NAV runs at the next available NAV date.
func TestSIPNextAvailableNAV(t *testing.T) {
	navs := []NavPoint{{d("2024-01-01"), 10}, {d("2024-01-04"), 20}, {d("2024-02-02"), 25}, {d("2024-03-01"), 30}}
	r := SimulateSIP(navs, sipIn("100", "2024-01-02", "2024-03-01", 2))
	if len(r.Installments) != 2 { // Jan 2 -> Jan 4, Feb 2 -> Feb 2; Mar 2 is after End
		t.Fatalf("executed=%d", len(r.Installments))
	}
	if !r.Installments[0].NavDate.Equal(d("2024-01-04")) || r.Installments[0].NAV != 20 {
		t.Fatalf("first = %+v", r.Installments[0])
	}
	if !r.Units.Equal(decimal.NewFromInt(5).Add(decimal.NewFromInt(4))) {
		t.Fatalf("units = %s", r.Units)
	}
	if r.EndNAV == nil || *r.EndNAV != 30 {
		t.Fatalf("end nav = %v", r.EndNAV)
	}
}

func TestSIPNoInstallmentsAndShortPeriod(t *testing.T) {
	navs := daily("2024-03-10", 100, 10, 0)
	r := SimulateSIP(navs, sipIn("500", "2024-01-01", "2024-02-28", 1))
	if r.Value != nil || r.XIRRPct != nil || r.Skipped != 2 {
		t.Fatalf("%+v", r)
	}
	short := SimulateSIP(navs, sipIn("500", "2024-03-12", "2024-03-30", 15))
	if short.XIRRPct != nil || short.XIRRReason != "period_too_short" || short.AbsReturnPct == nil {
		t.Fatalf("%+v", short)
	}
}

func TestComputeStats(t *testing.T) {
	navs := daily("2021-01-01", 1500, 10, 0.0004)
	s := ComputeStats(navs)
	if s.ReturnBasis != "cagr" || s.ReturnPct == nil || s.VolatilityPct == nil || *s.VolatilityPct != 0 {
		t.Fatalf("%+v", s)
	}
	if s.MaxDrawdownPct == nil || *s.MaxDrawdownPct != 0 {
		t.Fatalf("dd = %v", s.MaxDrawdownPct)
	}
	short := ComputeStats(navs[:200])
	if short.ReturnBasis != "absolute" || short.VolatilityPct != nil || short.VolatilityNote != "insufficient_history" {
		t.Fatalf("%+v", short)
	}
	var weekly []NavPoint
	for i := 0; i < 120; i++ {
		weekly = append(weekly, NavPoint{d("2022-01-07").AddDate(0, 0, 7*i), 10 + float64(i%5)})
	}
	if w := ComputeStats(weekly); w.VolatilityPct != nil || w.VolatilityNote != "weekly_nav" || w.MaxDrawdownPct == nil {
		t.Fatalf("%+v", w) // MF-07 / MF-84
	}
}

func TestCommonDatesAndRebase(t *testing.T) {
	a := []NavPoint{{d("2024-01-01"), 10}, {d("2024-01-02"), 11}, {d("2024-01-03"), 12}}
	b := []NavPoint{{d("2024-01-02"), 50}, {d("2024-01-03"), 40}, {d("2024-01-04"), 60}}
	cd := CommonDates([][]NavPoint{a, b})
	if len(cd) != 2 || !cd[0].Equal(d("2024-01-02")) {
		t.Fatalf("common = %v", cd)
	}
	ra, rb := Rebase(a, cd), Rebase(b, cd)
	if ra[0] != 100 || rb[0] != 100 || math.Abs(ra[1]-12.0/11*100) > 1e-9 || math.Abs(rb[1]-80) > 1e-9 {
		t.Fatalf("%v %v", ra, rb)
	}
}

// MF-10 variant (MF-96): `end` is a Saturday and the installment day equals it. The next NAV
// (Monday) is after End, so the installment is not executed (no post-End purchase valued at the
// End NAV, no XIRR flow dated after the terminal flow).
func TestSIPInstallmentOnNonNAVDayAtEndIsSkipped(t *testing.T) {
	var navs []NavPoint
	for day := d("2024-01-01"); !day.After(d("2024-03-31")); day = day.AddDate(0, 0, 1) {
		if wd := day.Weekday(); wd != time.Saturday && wd != time.Sunday {
			navs = append(navs, NavPoint{Date: day, NAV: 10 + float64(day.YearDay())/10})
		}
	}
	// 2024-03-02 is a Saturday; installments on day 2: Jan 2, Feb 2 (Fri), Mar 2 (Sat).
	r := SimulateSIP(navs, sipIn("1000", "2024-01-01", "2024-03-02", 2))
	if len(r.Installments) != 2 || r.Skipped != 1 {
		t.Fatalf("executed=%d skipped=%d", len(r.Installments), r.Skipped)
	}
	for _, in := range r.Installments {
		if in.NavDate.After(d("2024-03-02")) {
			t.Fatalf("installment executed after End: %+v", in)
		}
	}
	if r.EndNavDate == nil || !r.EndNavDate.Equal(d("2024-03-01")) {
		t.Fatalf("end nav date = %v", r.EndNavDate)
	}
}
