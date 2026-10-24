package portfolio

import (
	"math"
	"testing"
	"time"
)

func notStale(time.Time) (bool, float64) { return false, 0 }

func px(date, close string) *Price {
	return &Price{Date: dt(date), Close: dec(close)}
}

func oneStock(asOf string, txns []Txn, price *Price, actions ...CorporateAction) SummaryInput {
	return SummaryInput{AsOf: dt(asOf), Stale: notStale, Items: []InstrumentInput{
		{Symbol: "TCS", Name: "TCS Ltd", Status: "active", Txns: txns, Price: price, Actions: actions},
	}}
}

// docs/05 8.3 test vector: -1000 on 2020-01-01 and +1100 on 2021-01-01 -> 9.973% (tolerance 1e-4 as a fraction).
func TestXIRRTestVectorThroughSummary(t *testing.T) {
	s := BuildSummary(oneStock("2021-01-01", []Txn{buy(1, "2020-01-01", "10", "100", "0")}, px("2021-01-01", "110")))
	if s.Returns.XIRRPct == nil || math.Abs(*s.Returns.XIRRPct-9.973) > 0.01 {
		t.Fatalf("xirr = %v reason %v", s.Returns.XIRRPct, s.Returns.XIRRReason)
	}
	if s.Returns.AbsolutePct == nil || *s.Returns.AbsolutePct != 10 {
		t.Errorf("absolute = %v", s.Returns.AbsolutePct)
	}
	if *s.Totals.MarketValue != "1100.0000" || *s.Totals.Unrealized != "100.0000" || s.Totals.Invested != "1000.0000" {
		t.Errorf("totals = %+v", s.Totals)
	}
}

// PF-07: a span under 30 days gives no XIRR (reason) but still the absolute return; no sign change -> null.
func TestXIRRShortSpanAndUndefined(t *testing.T) {
	s := BuildSummary(oneStock("2024-01-20", []Txn{buy(1, "2024-01-02", "10", "100", "0")}, px("2024-01-19", "110")))
	if s.Returns.XIRRPct != nil || s.Returns.XIRRReason == nil || *s.Returns.XIRRReason != ReasonShortPeriod {
		t.Fatalf("short span: %+v", s.Returns)
	}
	if s.Returns.AbsolutePct == nil || *s.Returns.AbsolutePct != 10 {
		t.Errorf("absolute = %v", s.Returns.AbsolutePct)
	}
	// Holding that lost everything: all flows negative or terminal value 0 -> no inflow.
	s = BuildSummary(oneStock("2025-01-20", []Txn{buy(1, "2024-01-02", "10", "100", "0")}, px("2025-01-19", "0.0001")))
	if s.Returns.XIRRPct == nil && s.Returns.XIRRReason == nil {
		t.Error("a reason is required whenever xirr is null")
	}
	// No transactions at all.
	s = BuildSummary(SummaryInput{AsOf: dt("2025-01-20"), Stale: notStale})
	if s.Returns.XIRRPct != nil || s.Returns.XIRRReason == nil || *s.Returns.XIRRReason != ReasonNoTxns {
		t.Errorf("empty: %+v", s.Returns)
	}
	if s.Holdings == nil || s.AllocStock == nil {
		t.Error("lists must be [] not null")
	}
}

// PF-10: missing price -> null with reason, totals unavailable (never 0); stale flagged.
func TestMissingAndStalePrice(t *testing.T) {
	s := BuildSummary(oneStock("2024-06-01", []Txn{buy(1, "2024-01-02", "10", "100", "0")}, nil))
	h := s.Holdings[0]
	if h.LTP != nil || h.MarketValue != nil || h.LTPReason == nil || *h.LTPReason != ReasonNoPrice {
		t.Fatalf("holding = %+v", h)
	}
	if s.Totals.MarketValue != nil || s.Totals.MarketValueReason == nil || s.Totals.Unrealized != nil {
		t.Errorf("totals = %+v", s.Totals)
	}
	if s.Returns.XIRRPct != nil || s.Returns.XIRRReason == nil {
		t.Errorf("returns = %+v", s.Returns)
	}
	in := oneStock("2024-06-01", []Txn{buy(1, "2024-01-02", "10", "100", "0")}, px("2024-05-20", "105"))
	in.Stale = func(time.Time) (bool, float64) { return true, 300 }
	s = BuildSummary(in)
	if !s.Holdings[0].PriceStale || !s.Stale || s.StaleAgeHours != 300 || *s.Holdings[0].LTPAsOf != "2024-05-20" {
		t.Errorf("stale: %+v", s.Holdings[0])
	}
}

// PF-09: portfolio value is invariant under a confirmed split (same price path, adjusted qty).
func TestValueInvariantUnderConfirmedSplit(t *testing.T) {
	txns := []Txn{buy(1, "2024-01-02", "10", "1000", "0")}
	before := BuildSummary(oneStock("2024-06-30", txns, &Price{Date: dt("2024-05-31"), Close: dec("1500")}))
	n, d := ratio("10", "2")
	split := CorporateAction{ID: 1, ExDate: dt("2024-06-01"), Type: "split", Status: "confirmed", RatioNum: n, RatioDen: d}
	// Raw (unadjusted) bar after the split: 1500 / 5 = 300 per new share.
	after := BuildSummary(oneStock("2024-06-30", txns, &Price{Date: dt("2024-06-28"), Close: dec("300")}, split))
	if *before.Totals.MarketValue != "15000.0000" || *after.Totals.MarketValue != "15000.0000" {
		t.Fatalf("value before %v after %v", *before.Totals.MarketValue, *after.Totals.MarketValue)
	}
	h := after.Holdings[0]
	if h.Qty != "50.0000" || *h.AvgCost != "200.0000" || h.Invested != "10000.0000" {
		t.Errorf("holding = %+v", h)
	}
	if len(h.AdjustmentsApplied) != 1 || h.AdjustmentsApplied[0].Multiplier != "5" {
		t.Errorf("adjustments = %+v", h.AdjustmentsApplied)
	}
	// Last bar still pre-split while as_of is after the ex-date: price converted, value still invariant.
	stale := BuildSummary(oneStock("2024-06-30", txns, &Price{Date: dt("2024-05-31"), Close: dec("1500")}, split))
	if *stale.Totals.MarketValue != "15000.0000" {
		t.Errorf("pre-action bar value = %v", *stale.Totals.MarketValue)
	}
	// An unconfirmed (detected) action changes nothing and warns.
	det := split
	det.Status = "detected"
	w := BuildSummary(oneStock("2024-06-30", txns, px("2024-05-31", "1500"), det))
	if *w.Totals.MarketValue != "15000.0000" || !hasWarning(w, "UNCONFIRMED_ACTION") {
		t.Errorf("detected: %v %+v", *w.Totals.MarketValue, w.Warnings)
	}
}

func hasWarning(s Summary, code string) bool {
	for _, w := range s.Warnings {
		if w.Code == code {
			return true
		}
	}
	return false
}

// Day change: qty * (LTP - prev close); null with a reason across a split window.
func TestDayChange(t *testing.T) {
	prev := dec("98")
	pd := dt("2024-06-27")
	p := &Price{Date: dt("2024-06-28"), Close: dec("100"), PrevDate: &pd, PrevClose: &prev}
	s := BuildSummary(oneStock("2024-06-30", []Txn{buy(1, "2024-01-02", "10", "90", "0")}, p))
	if s.Holdings[0].DayChange == nil || *s.Holdings[0].DayChange != "20.0000" || *s.Totals.DayChange != "20.0000" {
		t.Fatalf("day change = %+v", s.Holdings[0])
	}
	n, d := ratio("2", "1")
	split := CorporateAction{ExDate: dt("2024-06-28"), Type: "split", Status: "confirmed", RatioNum: n, RatioDen: d}
	s = BuildSummary(oneStock("2024-06-30", []Txn{buy(1, "2024-01-02", "10", "90", "0")}, p, split))
	if s.Holdings[0].DayChange != nil || s.Holdings[0].DayChangeReason == nil || s.Totals.DayChange != nil {
		t.Fatalf("split window: %+v", s.Holdings[0])
	}
}

// PF-08: fully exited positions are hidden by default, realized retained in totals; shown on request.
func TestFullyExitedHiddenByDefault(t *testing.T) {
	txns := []Txn{buy(1, "2024-01-02", "10", "100", "0"), sell(2, "2024-02-01", "10", "150", "0")}
	s := BuildSummary(oneStock("2024-06-01", txns, px("2024-05-31", "160")))
	if len(s.Holdings) != 0 || s.Totals.Realized != "500.0000" || s.Totals.Invested != "0.0000" {
		t.Fatalf("%+v %+v", s.Holdings, s.Totals)
	}
	if s.Totals.MarketValue != nil || s.Totals.MarketValueReason == nil {
		t.Errorf("no open holdings should not show a market value of 0: %+v", s.Totals)
	}
	in := oneStock("2024-06-01", txns, px("2024-05-31", "160"))
	in.IncludeExited = true
	s = BuildSummary(in)
	if len(s.Holdings) != 1 || !s.Holdings[0].Exited || s.Holdings[0].Realized != "500.0000" {
		t.Fatalf("%+v", s.Holdings)
	}
}

// PF-13: a delisted holding is kept and flagged.
func TestDelistedHolding(t *testing.T) {
	in := oneStock("2024-06-01", []Txn{buy(1, "2024-01-02", "10", "100", "0")}, px("2024-03-01", "50"))
	in.Items[0].Status = "delisted"
	s := BuildSummary(in)
	if len(s.Holdings) != 1 || s.Holdings[0].Flags[0] != "delisted" || !hasWarning(s, "DELISTED_HOLDING") {
		t.Fatalf("%+v", s.Holdings)
	}
}

// Allocation by stock and sector sums to 100 over priced holdings.
func TestAllocation(t *testing.T) {
	it := func(sym string, sector *string, price string) InstrumentInput {
		return InstrumentInput{Symbol: sym, Name: sym, Sector: sector, Status: "active", Price: px("2024-05-31", price),
			Txns: []Txn{buy(1, "2024-01-02", "10", "100", "0")}}
	}
	it2, it3 := "IT", "Banks"
	s := BuildSummary(SummaryInput{AsOf: dt("2024-06-01"), Stale: notStale, Items: []InstrumentInput{
		it("A", &it2, "100"), it("B", &it3, "300"), it("C", nil, "100")}})
	sum := 0.0
	for _, a := range s.AllocSector {
		sum += a.WeightPct
	}
	if len(s.AllocSector) != 3 || math.Abs(sum-100) > 0.02 || s.AllocStock[0].Key != "B" || s.AllocStock[0].WeightPct != 60 {
		t.Fatalf("%+v %+v", s.AllocSector, s.AllocStock)
	}
}

// Estimated dividends: quantity at the record date x amount, separate from P&L and XIRR.
func TestEstimatedDividends(t *testing.T) {
	amt, rec := dec("5"), dt("2024-03-14")
	div := CorporateAction{ExDate: dt("2024-03-15"), RecordDay: &rec, Type: "dividend", Status: "confirmed", AmountPS: &amt}
	before := CorporateAction{ExDate: dt("2023-12-15"), Type: "dividend", Status: "confirmed", AmountPS: &amt}
	s := BuildSummary(oneStock("2024-06-01", []Txn{buy(1, "2024-01-02", "10", "100", "0")}, px("2024-05-31", "100"), div, before))
	if s.Dividends.Amount != "50.0000" || len(s.Dividends.Items) != 1 {
		t.Fatalf("%+v", s.Dividends)
	}
}

// ACT-08: a confirmed rights issue is listed as review needed and not applied.
func TestReviewNeeded(t *testing.T) {
	n, d := ratio("1", "4")
	rights := CorporateAction{ExDate: dt("2024-03-15"), Type: "rights", Status: "confirmed", RatioNum: n, RatioDen: d}
	s := BuildSummary(oneStock("2024-06-01", []Txn{buy(1, "2024-01-02", "10", "100", "0")}, px("2024-05-31", "100"), rights))
	h := s.Holdings[0]
	if h.Qty != "10.0000" || len(h.ReviewNeeded) != 1 || !hasWarning(s, "REVIEW_NEEDED") {
		t.Fatalf("%+v", h)
	}
}

// Benchmark: the same flows into NIFTY50; omitted with a reason when unavailable.
func TestBenchmark(t *testing.T) {
	in := oneStock("2021-01-01", []Txn{buy(1, "2020-01-01", "10", "100", "0")}, px("2021-01-01", "110"))
	s := BuildSummary(in)
	if s.Benchmark.XIRRPct != nil || s.Benchmark.Reason == nil || *s.Benchmark.Reason != ReasonNoBenchmark {
		t.Fatalf("no series: %+v", s.Benchmark)
	}
	in.Bench = []SeriesPoint{{dt("2019-12-31"), 10000}, {dt("2020-06-01"), 9000}, {dt("2021-01-01"), 11000}}
	s = BuildSummary(in)
	if s.Benchmark.XIRRPct == nil || math.Abs(*s.Benchmark.XIRRPct-9.973) > 0.01 { // 10000 -> 11000 over the same span
		t.Fatalf("bench = %+v", s.Benchmark)
	}
	in.Bench = []SeriesPoint{{dt("2020-06-01"), 9000}, {dt("2021-01-01"), 11000}}
	s = BuildSummary(in)
	if s.Benchmark.XIRRPct != nil || *s.Benchmark.Reason != ReasonBenchLate {
		t.Fatalf("late series: %+v", s.Benchmark)
	}
}

// Sum precision at the summary level (PF-12).
func TestSummaryPrecision(t *testing.T) {
	s := BuildSummary(SummaryInput{AsOf: dt("2024-06-01"), Stale: notStale, Items: []InstrumentInput{{
		Symbol: "X", Name: "X", Status: "active", Price: px("2024-05-31", "1"),
		Txns: []Txn{buy(1, "2024-01-02", "0.1", "1", "0"), buy(2, "2024-01-03", "0.2", "1", "0")}}}})
	if s.Holdings[0].Qty != "0.3000" || *s.Totals.MarketValue != "0.3000" {
		t.Fatalf("%+v", s.Holdings[0])
	}
}

// Owner decision (supersedes B11-8): the benchmark always computes, units may go negative.
func TestBenchmarkOutperformingSell(t *testing.T) {
	in := oneStock("2021-06-01", []Txn{
		buy(1, "2020-01-01", "1000", "100", "0"),  // 100k at NIFTY 20000 = 5 units
		sell(2, "2021-01-01", "1000", "200", "0"), // 200k at 22000 needs 9.09 units: 5 - 9.09 < 0
	}, nil)
	in.Bench = []SeriesPoint{{dt("2019-12-31"), 20000}, {dt("2021-01-01"), 22000}, {dt("2021-06-01"), 23000}}
	s := BuildSummary(in)
	if s.Benchmark.XIRRPct == nil || s.Benchmark.Reason != nil {
		t.Fatalf("benchmark must compute: %+v", s.Benchmark)
	}
}

// docs/05 8.3: the 30-day rule uses the total span; for a closed position that is first flow to
// last flow, not to the as-of date.
func TestXIRRClosedShortRoundTrip(t *testing.T) {
	txns := []Txn{buy(1, "2024-01-02", "10", "100", "0"), sell(2, "2024-01-06", "10", "110", "0")}
	s := BuildSummary(oneStock("2025-01-06", txns, nil))
	if s.Returns.XIRRPct != nil || s.Returns.XIRRReason == nil || *s.Returns.XIRRReason != ReasonShortPeriod {
		t.Fatalf("4-day closed round trip must not be annualised: %+v", s.Returns)
	}
	long := []Txn{buy(1, "2024-01-02", "10", "100", "0"), sell(2, "2024-03-02", "10", "110", "0")}
	s = BuildSummary(oneStock("2025-01-06", long, nil))
	if s.Returns.XIRRPct == nil {
		t.Fatalf("60-day closed round trip must compute: %+v", s.Returns)
	}
}
