package portfolio

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/mfhold"
)

func rdt(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

func dc(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func dcp(s string) *decimal.Decimal { d := dc(s); return &d }

func rbuy(id int64, date, qty, price string) Txn {
	return Txn{ID: id, Side: "buy", Qty: dc(qty), Price: dc(price), Date: rdt(date)}
}

func rsell(id int64, date, qty, price string) Txn {
	return Txn{ID: id, Side: "sell", Qty: dc(qty), Price: dc(price), Date: rdt(date)}
}

// bars builds consecutive-day bars starting at start; an empty close string leaves that day without a bar.
func bars(start string, closes ...string) []Bar {
	var out []Bar
	d := rdt(start)
	for i, c := range closes {
		if c != "" {
			out = append(out, Bar{Date: d.AddDate(0, 0, i), Close: dc(c)})
		}
	}
	return out
}

func near(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

func fp(t *testing.T, name string, p *float64, want float64) {
	t.Helper()
	if p == nil {
		t.Fatalf("%s is nil, want %v", name, want)
	}
	near(t, name, *p, want, 1e-9)
}

func sv(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

var (
	c1 = []RiskHolding{
		{Key: "A", Name: "A Ltd", AssetClass: "equity", Group: "Banks", GroupKind: kindSector, Value: dcp("5000")},
		{Key: "B", Name: "B Ltd", AssetClass: "equity", Group: "Banks", GroupKind: kindSector, Value: dcp("3000")},
		{Key: "C", Name: "C Ltd", AssetClass: "equity", Group: "IT", GroupKind: kindSector, Value: dcp("1500")},
		{Key: "D", Name: "D Ltd", AssetClass: "equity", Group: GroupUnclassified, GroupKind: kindUnclassified, Value: dcp("500")},
	}
)

// PRK-C01 and PRK-S01: vectors C1 and S1.
func TestConcentrationVectorC1(t *testing.T) {
	c, s := BuildConcentration([]RiskHolding{c1[3], c1[1], c1[0], c1[2]}) // input order must not matter
	if sv(c.TotalValue) != "10000.0000" || c.HoldingsCount != 4 || c.TotalValueReason != nil {
		t.Fatalf("total %s count %d reason %v", sv(c.TotalValue), c.HoldingsCount, c.TotalValueReason)
	}
	fp(t, "top1", c.Top1Pct, 50)
	fp(t, "top3", c.Top3Pct, 95)
	fp(t, "top5", c.Top5Pct, 100)
	fp(t, "hhi", c.HHI, 0.365)
	fp(t, "effective", c.EffectiveCount, 2.74)
	fp(t, "group hhi", c.GroupHHI, 0.665)
	fp(t, "group top1", c.GroupTop1Pct, 80)
	wantW := []float64{50, 30, 15, 5}
	for i, h := range c.ByHolding {
		fp(t, "weight "+h.Key, h.WeightPct, wantW[i])
	}
	if c.ByHolding[0].Key != "A" || c.ByHolding[3].Key != "D" {
		t.Errorf("order %v", c.ByHolding)
	}
	wantG := map[string]float64{"Banks": 80, "IT": 15, GroupUnclassified: 5}
	if len(c.ByGroup) != 3 || c.ByGroup[0].Key != "Banks" || c.ByGroup[2].Kind != kindUnclassified {
		t.Fatalf("groups %+v", c.ByGroup)
	}
	for _, g := range c.ByGroup {
		fp(t, "group "+g.Key, g.WeightPct, wantG[g.Key])
	}
	// S1
	want := [][4]string{{"-500.0000", "-5", "-1000.0000", "-10"}, {"-300.0000", "-3", "-600.0000", "-6"},
		{"-150.0000", "-1.5", "-300.0000", "-3"}, {"-50.0000", "-0.5", "-100.0000", "-1"}}
	if s.Label == "" || len(s.FallsPct) != 2 || len(s.Items) != 4 {
		t.Fatalf("stress %+v", s)
	}
	for i, it := range s.Items {
		if sv(it.Impact10) != want[i][0] || sv(it.Impact20) != want[i][2] {
			t.Errorf("%s impacts %s %s", it.Key, sv(it.Impact10), sv(it.Impact20))
		}
		var p10, p20 float64
		_, _ = fmt.Sscan(want[i][1], &p10)
		_, _ = fmt.Sscan(want[i][3], &p20)
		fp(t, it.Key+" 10%", it.Impact10Pct, p10)
		fp(t, it.Key+" 20%", it.Impact20Pct, p20)
	}
}

// PRK-C02, PRK-S02: vector C2 (an unpriced holding blanks every weight, never a partial total).
func TestConcentrationUnpriced(t *testing.T) {
	hs := append([]RiskHolding(nil), c1...)
	hs[3].Value = nil
	c, s := BuildConcentration(hs)
	if c.TotalValue != nil || sv(c.TotalValueReason) != "missing_price: D" {
		t.Fatalf("total %v reason %s", c.TotalValue, sv(c.TotalValueReason))
	}
	if c.Top1Pct != nil || c.Top3Pct != nil || c.Top5Pct != nil || c.HHI != nil || c.EffectiveCount != nil || c.GroupHHI != nil || c.GroupTop1Pct != nil {
		t.Errorf("figures must be null: %+v", c)
	}
	if sv(c.SharesReason) != "missing_price: D" || sv(c.HHIReason) != "missing_price: D" || sv(c.GroupReason) != "missing_price: D" {
		t.Errorf("reasons %s %s %s", sv(c.SharesReason), sv(c.HHIReason), sv(c.GroupReason))
	}
	for _, h := range c.ByHolding {
		if h.WeightPct != nil || h.WeightReason == nil {
			t.Errorf("%s weight must be null with a reason", h.Key)
		}
	}
	if sv(c.ByHolding[0].Value) != "5000.0000" || c.ByHolding[3].Value != nil || c.ByHolding[3].Key != "D" {
		t.Errorf("priced values stay, unpriced last: %+v", c.ByHolding)
	}
	for _, g := range c.ByGroup {
		if g.WeightPct != nil {
			t.Errorf("group %s weight must be null", g.Key)
		}
		if (g.Key == GroupUnclassified) != (g.Value == nil) {
			t.Errorf("group %s value %v: only the group with the unpriced holding is null", g.Key, g.Value)
		}
	}
	// S2: rupees without a total show, the percent is null with the total's reason
	a := s.Items[0]
	if sv(a.Impact10) != "-500.0000" || a.Impact10Pct != nil || sv(a.ImpactReason) != "missing_price: D" {
		t.Errorf("A %+v", a)
	}
	d := s.Items[3]
	if d.Impact10 != nil || d.Value != nil || sv(d.ImpactReason) != ReasonNoPrice {
		t.Errorf("D %+v", d)
	}
	// a fund without a NAV
	hs[3] = RiskHolding{Key: "119", Name: "Fund X", AssetClass: "mf", Group: GroupFunds, GroupKind: kindFunds}
	c, s = BuildConcentration(hs)
	if sv(c.TotalValueReason) != "missing_nav: Fund X" || sv(s.Items[3].ImpactReason) != ReasonNoNAV {
		t.Errorf("fund reasons %s / %s", sv(c.TotalValueReason), sv(s.Items[3].ImpactReason))
	}
}

// PRK-C04, PRK-C05, PRK-C08.
func TestConcentrationEdges(t *testing.T) {
	c, _ := BuildConcentration([]RiskHolding{{Key: "A", Name: "A", AssetClass: "equity", Group: "X", GroupKind: kindSector, Value: dcp("700")}})
	fp(t, "w", c.ByHolding[0].WeightPct, 100)
	fp(t, "hhi", c.HHI, 1)
	fp(t, "eff", c.EffectiveCount, 1)
	fp(t, "top5", c.Top5Pct, 100)
	if c.HoldingsCount != 1 {
		t.Errorf("count %d", c.HoldingsCount)
	}
	c, s := BuildConcentration(nil)
	if sv(c.TotalValueReason) != ReasonNoOpenHoldings || len(c.ByHolding) != 0 || len(c.ByGroup) != 0 || len(s.Items) != 0 || c.Top1Pct != nil {
		t.Errorf("empty %+v", c)
	}
	var third []RiskHolding
	for _, k := range []string{"A", "B", "C"} {
		third = append(third, RiskHolding{Key: k, Name: k, AssetClass: "equity", Group: k, GroupKind: kindSector, Value: dcp("1234.5678")})
	}
	c, _ = BuildConcentration(third)
	sum := 0.0
	for _, h := range c.ByHolding {
		sum += *h.WeightPct
	}
	near(t, "sum of weights", sum, 100, 0.05)
	fp(t, "hhi thirds", c.HHI, 0.3333)
	fp(t, "eff thirds", c.EffectiveCount, 3)
}

// PRK-C03, PRK-C06: groups of a view summary.
func TestRiskHoldingsGrouping(t *testing.T) {
	blank, it := " ", "IT"
	cat := "Equity: Flexi Cap"
	mv := dc("100")
	sum := ViewSummary{}
	sum.Holdings = []Holding{
		{Symbol: "A", Name: "A", Sector: &it, MarketValue: strp("100.0000")},
		{Symbol: "B", Name: "B", Sector: &blank, MarketValue: strp("100.0000")},
		{Symbol: "C", Name: "C", MarketValue: strp("100.0000")},
		{Symbol: "X", Name: "Exited", Exited: true},
	}
	sum.MFHoldings = []mfhold.Holding{
		{SchemeCode: 1, SchemeName: "F1", Category: &cat, MV: &mv},
		{SchemeCode: 2, SchemeName: "F2", MV: &mv},
	}
	groups := func(view string) map[string]string {
		c, _ := BuildConcentration(riskHoldings(sum, view))
		out := map[string]string{}
		for _, g := range c.ByGroup {
			out[g.Key] = g.Kind
		}
		return out
	}
	all := groups(ViewAll)
	if all["IT"] != kindSector || all[GroupUnclassified] != kindUnclassified || all[GroupFunds] != kindFunds || len(all) != 3 {
		t.Errorf("all groups %v", all)
	}
	mf := groups(ViewMF)
	if mf["Equity: Flexi Cap"] != kindCategory || mf[GroupUnclassified] != kindUnclassified {
		t.Errorf("mf groups %v", mf)
	}
	c, _ := BuildConcentration(riskHoldings(sum, ViewAll))
	if c.HoldingsCount != 5 {
		t.Errorf("exited holding counted: %d", c.HoldingsCount)
	}
}

func hist(t *testing.T, in HistInput) (History, HistExtras) {
	t.Helper()
	in.AsOf = rdt("2024-12-31")
	return BuildHistory(in)
}

func points(h History) (idx []float64, val []string, dd []float64, dates []string) {
	for _, p := range h.Points {
		idx, val, dd, dates = append(idx, p.Index), append(val, p.Value), append(dd, p.DrawdownPct), append(dates, p.Date)
	}
	return
}

func eqf(t *testing.T, name string, got, want []float64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s len %v want %v", name, got, want)
	}
	for i := range got {
		near(t, fmt.Sprintf("%s[%d]", name, i), got[i], want[i], 1e-4)
	}
}

// PRK-H01 / PRK-H07: vector TW1 (a mid-period contribution; the raw value hides the fall).
func TestHistoryTW1(t *testing.T) {
	h, _ := hist(t, HistInput{Stocks: []HistStock{{Symbol: "A",
		Txns: []Txn{rbuy(1, "2024-01-01", "10", "100"), rbuy(2, "2024-01-02", "10", "110"), rbuy(3, "2024-01-03", "20", "99")},
		Bars: bars("2024-01-01", "100", "110", "99", "99", "108.9")}}})
	idx, val, dd, _ := points(h)
	eqf(t, "index", idx, []float64{100, 110, 99, 99, 108.9})
	eqf(t, "dd", dd, []float64{0, 0, -10, -10, -1})
	want := []string{"1000.0000", "2200.0000", "3960.0000", "3960.0000", "4356.0000"}
	for i := range want {
		if val[i] != want[i] {
			t.Errorf("value[%d] = %s want %s", i, val[i], want[i])
		}
	}
	fp(t, "current dd", h.CurrentDD, -1)
	if sv(h.PeakDate) != "2024-01-02" || *h.DaysUnderWater != 3 {
		t.Errorf("peak %s uw %d", sv(h.PeakDate), *h.DaysUnderWater)
	}
	m := h.MaxDrawdown
	if m == nil || m.DepthPct != -10 || sv(m.PeakDate) != "2024-01-02" || sv(m.TroughDate) != "2024-01-03" || m.Recovered || m.RecoveryDate != nil {
		t.Errorf("max dd %+v", m)
	}
	fp(t, "twr", h.TWRSinceStart, 8.9)
	if h.SeriesReason != nil || h.PointsCount != 5 || sv(h.From) != "2024-01-01" || sv(h.To) != "2024-01-05" || h.SkippedSteps != 0 {
		t.Errorf("meta %+v", h)
	}
	// the raw value never fell below its running maximum: this is the fall a raw drawdown would miss
	peak := 0.0
	for _, v := range val {
		f, _ := decimal.RequireFromString(v).Float64()
		if f < peak {
			t.Errorf("raw value fell: %v < %v", f, peak)
		}
		peak = math.Max(peak, f)
	}
}

// PRK-H07: a withdrawal cannot fake a fall.
func TestHistoryWithdrawalLeavesIndexFlat(t *testing.T) {
	h, _ := hist(t, HistInput{Stocks: []HistStock{{Symbol: "A",
		Txns: []Txn{rbuy(1, "2024-01-01", "10", "100"), rsell(2, "2024-01-03", "5", "100")},
		Bars: bars("2024-01-01", "100", "100", "100", "100")}}})
	idx, val, dd, _ := points(h)
	eqf(t, "index", idx, []float64{100, 100, 100, 100})
	eqf(t, "dd", dd, []float64{0, 0, 0, 0})
	if val[1] != "1000.0000" || val[2] != "500.0000" {
		t.Errorf("values %v", val)
	}
}

// PRK-H02: vector TW2 (full exit, empty day omitted, re-entry).
func TestHistoryTW2(t *testing.T) {
	h, _ := hist(t, HistInput{Stocks: []HistStock{{Symbol: "B",
		Txns: []Txn{rbuy(1, "2024-01-01", "10", "50"), rsell(2, "2024-01-02", "10", "55"), rbuy(3, "2024-01-04", "5", "60")},
		Bars: bars("2024-01-01", "50", "55", "56", "60", "54")}}})
	idx, val, _, dates := points(h)
	if strings.Join(dates, ",") != "2024-01-01,2024-01-02,2024-01-04,2024-01-05" {
		t.Fatalf("dates %v", dates)
	}
	eqf(t, "index", idx, []float64{100, 110, 110, 99})
	if val[0] != "500.0000" || val[1] != "0.0000" || val[2] != "300.0000" || val[3] != "270.0000" {
		t.Errorf("values %v", val)
	}
	fp(t, "current", h.CurrentDD, -10)
	if sv(h.PeakDate) != "2024-01-02" || *h.DaysUnderWater != 3 || h.MaxDrawdown.DepthPct != -10 || sv(h.MaxDrawdown.TroughDate) != "2024-01-05" {
		t.Errorf("stats %+v %s", h.MaxDrawdown, sv(h.PeakDate))
	}
	if h.GapDatesTotal != 0 {
		t.Errorf("an empty day is not a gap: %d", h.GapDatesTotal)
	}
}

func tw3Input(withSale bool) HistInput {
	a := HistStock{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-01", "10", "100")}, Bars: bars("2024-01-01", "100", "110", "121", "121")}
	if withSale {
		a.Txns = append(a.Txns, rsell(3, "2024-01-03", "5", "121"))
	}
	c := HistStock{Symbol: "C", Txns: []Txn{rbuy(2, "2024-01-01", "10", "200")}, Bars: bars("2024-01-01", "200", "200", "", "180")}
	return HistInput{Stocks: []HistStock{a, c}}
}

// PRK-H03: vector TW3 (a missing price date is a gap, never a partial sum).
func TestHistoryTW3Gap(t *testing.T) {
	h, ex := hist(t, tw3Input(false))
	idx, val, dd, dates := points(h)
	if strings.Join(dates, ",") != "2024-01-01,2024-01-02,2024-01-04" {
		t.Fatalf("dates %v", dates)
	}
	eqf(t, "index", idx, []float64{100, 103.3333, 100.3333})
	eqf(t, "dd", dd, []float64{0, 0, -2.9})
	if val[0] != "3000.0000" || val[1] != "3100.0000" || val[2] != "3010.0000" {
		t.Errorf("values %v", val)
	}
	if len(h.Gaps) != 1 || h.Gaps[0].From != "2024-01-03" || h.Gaps[0].To != "2024-01-03" || h.Gaps[0].Dates != 1 ||
		h.Gaps[0].Reason != "missing_price: C" || h.GapDatesTotal != 1 || h.GapsTruncated {
		t.Errorf("gaps %+v", h.Gaps)
	}
	if h.SkippedSteps != 0 || len(ex.SkippedDates) != 0 {
		t.Errorf("no step is skipped without a trade in the gap")
	}
}

// PRK-H04: vector TW3b (a trade inside the gap makes the step unknown, never a silent 0).
func TestHistoryTW3bSkippedStep(t *testing.T) {
	h, ex := hist(t, tw3Input(true))
	idx, val, _, _ := points(h)
	eqf(t, "index", idx, []float64{100, 103.3333, 103.3333})
	if val[2] != "2405.0000" {
		t.Errorf("value %v", val)
	}
	if h.SkippedSteps != 1 || len(ex.SkippedDates) != 1 || ex.SkippedDates[0] != "2024-01-04" {
		t.Errorf("skipped %d %v", h.SkippedSteps, ex.SkippedDates)
	}
	w := ex.Warnings(map[string]bool{})
	if len(w) != 1 || w[0].Code != "HISTORY_STEP_SKIPPED" {
		t.Errorf("warnings %+v", w)
	}
}

// PRK-H05: vector TW5 (a scheme NAV older than 4 days makes the date a gap).
func TestHistoryTW5NavGap(t *testing.T) {
	a := HistStock{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-01", "10", "100")}}
	for _, p := range [][2]string{{"2024-01-01", "100"}, {"2024-01-02", "100"}, {"2024-01-08", "110"}, {"2024-01-09", "110"}} {
		a.Bars = append(a.Bars, Bar{Date: rdt(p[0]), Close: dc(p[1])})
	}
	f := HistFund{Code: 1, Name: "S",
		Txns: []mfhold.Txn{{ID: 1, Scheme: 1, Folio: "f", Type: mfhold.TypePurchase, Date: rdt("2024-01-01"), Units: dc("100"), NAV: dc("10"), Amount: dc("1000")}},
		NAVs: []mfhold.NAV{{Date: rdt("2024-01-01"), Value: dc("10")}, {Date: rdt("2024-01-02"), Value: dc("10")}, {Date: rdt("2024-01-09"), Value: dc("10.2")}}}
	h, _ := hist(t, HistInput{Stocks: []HistStock{a}, Funds: []HistFund{f}})
	idx, _, _, dates := points(h)
	if strings.Join(dates, ",") != "2024-01-01,2024-01-02,2024-01-09" {
		t.Fatalf("dates %v", dates)
	}
	eqf(t, "index", idx, []float64{100, 100, 106})
	if len(h.Gaps) != 1 || h.Gaps[0].From != "2024-01-08" || h.Gaps[0].Reason != "nav_gap: S" {
		t.Errorf("gaps %+v", h.Gaps)
	}
}

// PRK-H06: vector TW6 (a split does not look like a fall; an adjusted-source bar is converted the same way).
func TestHistoryTW6Split(t *testing.T) {
	adj := []Adj{{Date: rdt("2024-01-02"), Type: "split", Multiplier: dc("2"), Source: "confirmed_action"}}
	h, _ := hist(t, HistInput{Stocks: []HistStock{{Symbol: "D", Adjs: adj,
		Txns: []Txn{rbuy(1, "2024-01-01", "10", "100")}, Bars: bars("2024-01-01", "100", "52", "55")}}})
	idx, val, _, _ := points(h)
	eqf(t, "index", idx, []float64{100, 104, 110})
	if val[0] != "1000.0000" || val[1] != "1040.0000" || val[2] != "1100.0000" {
		t.Errorf("values %v", val)
	}
	// the same history from back-adjusted closes (50, 52, 55 in current units)
	b := bars("2024-01-01", "50", "52", "55")
	for i := range b {
		b[i].SrcAdj = true
	}
	h2, _ := hist(t, HistInput{Stocks: []HistStock{{Symbol: "D", Adjs: adj, Txns: []Txn{rbuy(1, "2024-01-01", "10", "100")}, Bars: b}}})
	idx2, val2, _, _ := points(h2)
	eqf(t, "index adjusted", idx2, []float64{100, 104, 110})
	if val2[1] != "1040.0000" {
		t.Errorf("values %v", val2)
	}
}

// PRK-H12: drawdown definitions on VD1 closes used as the index (one unit bought on the first day).
func TestHistoryDrawdownVD1(t *testing.T) {
	closes := []string{"100", "90", "80", "85", "100", "95", "100", "110", "99", "88", "99", "110", "105"}
	h, _ := hist(t, HistInput{Stocks: []HistStock{{Symbol: "V", Txns: []Txn{rbuy(1, "2024-01-01", "1", "100")}, Bars: bars("2024-01-01", closes...)}}})
	_, _, dd, _ := points(h)
	eqf(t, "dd", dd, []float64{0, -10, -20, -15, 0, -5, 0, 0, -10, -20, -10, 0, -4.55})
	m := h.MaxDrawdown
	if m.DepthPct != -20 || sv(m.PeakDate) != "2024-01-01" || sv(m.TroughDate) != "2024-01-03" || !m.Recovered || sv(m.RecoveryDate) != "2024-01-05" {
		t.Errorf("max dd (ties: the earliest) %+v", m)
	}
	fp(t, "current", h.CurrentDD, -4.55)
	if sv(h.PeakDate) != "2024-01-12" || *h.DaysUnderWater != 1 {
		t.Errorf("peak %s uw %d", sv(h.PeakDate), *h.DaysUnderWater)
	}
	fp(t, "peak index", h.PeakIndex, 110)
}

// PRK-H08, H09, H10, H13.
func TestHistoryEdges(t *testing.T) {
	h, _ := hist(t, HistInput{})
	if sv(h.SeriesReason) != ReasonNoTransactions || len(h.Points) != 0 || h.CurrentDD != nil {
		t.Errorf("empty %+v", h)
	}
	// transactions but no price at all
	h, _ = hist(t, HistInput{Stocks: []HistStock{{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-01", "1", "100")}}}})
	if sv(h.SeriesReason) != ReasonNoPricedDates || sv(h.DrawdownReason) != ReasonTooFewPoints || len(h.Points) != 0 {
		t.Errorf("no prices %+v", h)
	}
	// prices start after the first buy: the leading dates are gaps and the index starts at the first valid date
	h, _ = hist(t, HistInput{Stocks: []HistStock{
		{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-01", "1", "100")}, Bars: bars("2024-01-03", "100", "110")},
		{Symbol: "B", Txns: []Txn{rbuy(2, "2024-01-01", "1", "50")}, Bars: bars("2024-01-01", "50", "50", "50", "55")},
	}})
	idx, _, _, dates := points(h)
	if strings.Join(dates, ",") != "2024-01-03,2024-01-04" {
		t.Fatalf("dates %v", dates)
	}
	eqf(t, "index", idx, []float64{100, 110 * 1.0})
	if len(h.Gaps) != 1 || h.Gaps[0].Dates != 2 || h.Gaps[0].Reason != "missing_price: A" || h.Gaps[0].From != "2024-01-01" || h.Gaps[0].To != "2024-01-02" {
		t.Errorf("leading gap %+v", h.Gaps)
	}
	// one point only
	h, _ = hist(t, HistInput{Stocks: []HistStock{{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-01", "1", "100")}, Bars: bars("2024-01-01", "100")}}})
	if h.PointsCount != 1 || h.CurrentDD != nil || h.MaxDrawdown != nil || sv(h.DrawdownReason) != ReasonTooFewPoints || h.Points[0].Index != 100 {
		t.Errorf("one point %+v", h)
	}
}

// PRK-H11: a past as_of ignores later transactions and bars.
func TestHistoryAsOf(t *testing.T) {
	in := HistInput{AsOf: rdt("2024-01-03"), Stocks: []HistStock{{Symbol: "A",
		Txns: []Txn{rbuy(1, "2024-01-01", "10", "100"), rbuy(2, "2024-01-04", "10", "100")},
		Bars: bars("2024-01-01", "100", "110", "120", "50", "60")}}}
	h, _ := BuildHistory(in)
	idx, val, _, dates := points(h)
	if strings.Join(dates, ",") != "2024-01-01,2024-01-02,2024-01-03" || sv(h.To) != "2024-01-03" {
		t.Fatalf("dates %v", dates)
	}
	eqf(t, "index", idx, []float64{100, 110, 120})
	if val[2] != "1200.0000" {
		t.Errorf("values %v", val)
	}
}

// PRK-H14: an oversold stored sequence is excluded and reported, the rest is served.
func TestHistoryOversoldExcluded(t *testing.T) {
	bad := HistStock{Symbol: "BAD", Txns: []Txn{rbuy(1, "2024-01-01", "1", "10"), rsell(2, "2024-01-02", "5", "10")}, Bars: bars("2024-01-01", "10", "10")}
	good := HistStock{Symbol: "OK", Txns: []Txn{rbuy(3, "2024-01-01", "1", "10")}, Bars: bars("2024-01-01", "10", "11")}
	h, ex := hist(t, HistInput{Stocks: []HistStock{bad, good}})
	if len(ex.Excluded) != 1 || ex.Excluded[0] != "BAD" || h.PointsCount != 2 {
		t.Errorf("excluded %v points %d", ex.Excluded, h.PointsCount)
	}
	if w := ex.Warnings(map[string]bool{}); len(w) != 1 || w[0].Code != "HOLDINGS_INCONSISTENT" {
		t.Errorf("warnings %+v", w)
	}
	if w := ex.Warnings(map[string]bool{"HOLDINGS_INCONSISTENT": true}); len(w) != 0 {
		t.Errorf("a code already present is not repeated: %+v", w)
	}
}

// PRK-H15: the gap list is bounded, the total is exact.
func TestHistoryGapsTruncated(t *testing.T) {
	// A has a bar every day; C is missing every second day: 80 separate gap ranges.
	n := 161
	closes := make([]string, n)
	cc := make([]string, n)
	for i := range closes {
		closes[i] = "100"
		if i%2 == 0 {
			cc[i] = "100"
		}
	}
	h, _ := hist(t, HistInput{Stocks: []HistStock{
		{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-01", "1", "100")}, Bars: bars("2024-01-01", closes...)},
		{Symbol: "C", Txns: []Txn{rbuy(2, "2024-01-01", "1", "100")}, Bars: bars("2024-01-01", cc...)},
	}})
	if h.GapDatesTotal != 80 || len(h.Gaps) != maxGapRanges || !h.GapsTruncated {
		t.Errorf("total %d ranges %d truncated %v", h.GapDatesTotal, len(h.Gaps), h.GapsTruncated)
	}
	if h.Gaps[len(h.Gaps)-1].From != "2024-06-08" { // the most recent ranges are kept
		t.Errorf("last gap %+v", h.Gaps[len(h.Gaps)-1])
	}
}

// PRK-H16, H17: a weekend-dated trade takes effect at the end of the next series date; a single stock's
// missing bar is a non-trading day.
func TestHistoryWeekendAndSingleStock(t *testing.T) {
	// 2024-01-06 is a Saturday: bars Fri 5th and Mon 8th
	a := HistStock{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-05", "10", "100"), rbuy(2, "2024-01-06", "10", "100")},
		Bars: []Bar{{Date: rdt("2024-01-05"), Close: dc("100")}, {Date: rdt("2024-01-08"), Close: dc("110")}}}
	h, _ := hist(t, HistInput{Stocks: []HistStock{a}})
	idx, val, _, _ := points(h)
	eqf(t, "index", idx, []float64{100, 110})
	if val[0] != "1000.0000" || val[1] != "2200.0000" {
		t.Errorf("values %v", val)
	}
	// one stock, a missing bar on the 3rd: no point and no gap (indistinguishable from a holiday)
	h, _ = hist(t, HistInput{Stocks: []HistStock{{Symbol: "A", Txns: []Txn{rbuy(1, "2024-01-01", "1", "100")}, Bars: bars("2024-01-01", "100", "101", "", "103")}}})
	_, _, _, dates := points(h)
	if strings.Join(dates, ",") != "2024-01-01,2024-01-02,2024-01-04" || h.GapDatesTotal != 0 {
		t.Errorf("dates %v gaps %d", dates, h.GapDatesTotal)
	}
}

// PRK-A02: nothing in the history marshals to NaN or Infinity.
func TestHistoryAllFinite(t *testing.T) {
	h, _ := hist(t, tw3Input(true))
	for _, p := range h.Points {
		for _, f := range []float64{p.Index, p.DrawdownPct} {
			if math.IsNaN(f) || math.IsInf(f, 0) {
				t.Errorf("non finite %+v", p)
			}
		}
	}
}

// benchInput is the owner-sized shape of PRK-A03: 40 stocks, 5 transactions each, 2,600 weekday bars.
func benchInput() HistInput {
	start := rdt("2016-12-01")
	var stocks []HistStock
	for s := 0; s < 40; s++ {
		var bs []Bar
		for d := 0; d < 3640; d++ {
			day := start.AddDate(0, 0, d)
			if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
				continue
			}
			bs = append(bs, Bar{Date: day, Close: decimal.New(int64(10000+s*100+(d*37)%2000), -2)})
		}
		var txns []Txn
		for k := 0; k < 5; k++ {
			side, qty := "buy", "10"
			if k == 4 {
				side, qty = "sell", "5"
			}
			txns = append(txns, Txn{ID: int64(s*10 + k), Side: side, Qty: dc(qty), Price: dc("100"), Date: start.AddDate(0, 0, 100+k*700+s)})
		}
		stocks = append(stocks, HistStock{Symbol: fmt.Sprintf("S%d", s), Txns: txns, Bars: bs})
	}
	return HistInput{AsOf: rdt("2026-11-11"), Stocks: stocks}
}

func BenchmarkBuildHistory(b *testing.B) {
	in := benchInput()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h, _ := BuildHistory(in)
		if h.PointsCount < 1000 {
			b.Fatalf("points %d", h.PointsCount)
		}
	}
}
