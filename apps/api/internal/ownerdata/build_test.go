package ownerdata

import (
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func row(end, key string, v float64, src string, fetched string) FundRow {
	return FundRow{PeriodEnd: day(end), Key: key, Value: v, Unit: "INR_CR", Source: src, FetchedAt: day(fetched)}
}

func build(t *testing.T, req, typ string, bases []BasisCount, rows []FundRow, snap string) Fundamentals {
	t.Helper()
	got, err := BuildFundamentals(FundamentalsInput{
		Requested: req, PeriodType: typ, CompanyType: "general", Bases: bases, Snapshot: json.RawMessage(snap),
		Rows: func(string) []FundRow { return rows },
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// FND-02: consolidated missing -> standalone, with a label (basis_note) and basis_available.
func TestFND02StandaloneFallback(t *testing.T) {
	bases := []BasisCount{{"standalone", 2}}
	rows := []FundRow{row("2026-06-30", "pnl.revenue", 10, "manual", "2026-07-20")}
	got := build(t, "auto", "Q", bases, rows, "")
	if got.BasisUsed != "standalone" || got.BasisNote == nil || len(got.BasisAvailable) != 1 || got.BasisAvailable[0] != "standalone" {
		t.Fatalf("%+v", got)
	}
	// explicit consolidated stays consolidated (and is empty), never silently swapped
	empty := build(t, "consolidated", "Q", bases, nil, "")
	if empty.BasisUsed != "consolidated" || empty.Status != "none" {
		t.Fatalf("%+v", empty)
	}
	// both present -> consolidated
	if b, n := ChooseBasis("auto", []BasisCount{{"consolidated", 1}, {"standalone", 9}}); b != "consolidated" || n != nil {
		t.Fatalf("%s %v", b, n)
	}
}

// FND-03: different bases for different periods are never mixed; a warning says what is hidden.
func TestFND03NeverMixesBases(t *testing.T) {
	bases := []BasisCount{{"consolidated", 1}, {"standalone", 3}}
	rows := []FundRow{row("2026-06-30", "pnl.revenue", 10, "manual", "2026-07-20")}
	got := build(t, "auto", "Q", bases, rows, "")
	if got.BasisUsed != "consolidated" || len(got.Periods) != 1 || len(got.Warnings) != 1 ||
		!strings.Contains(got.Warnings[0], "3 standalone") {
		t.Fatalf("%+v", got)
	}
}

// FND-11: no owner data -> null values with no_data_entered and an entry hint.
func TestFND11NoData(t *testing.T) {
	got := build(t, "auto", "Q", nil, nil, "")
	if got.Status != "none" || got.EntryHint == nil || *got.EntryHint != EntryHint {
		t.Fatalf("%+v", got)
	}
	for name, r := range map[string]*string{"metrics": got.MetricsReason, "derived": got.DerivedReason,
		"ratios": got.RatiosReason, "valuation": got.ValuationReason} {
		if r == nil || *r != ReasonNoData {
			t.Errorf("%s reason = %v", name, r)
		}
	}
	for k, v := range got.Ratios {
		if v != nil {
			t.Errorf("ratio %s = %v, want null", k, *v)
		}
	}
	for k, v := range got.Valuation {
		if k != "pe_basis" && v != nil {
			t.Errorf("valuation %s = %v, want null", k, v)
		}
	}
	if len(got.Periods) != 0 || len(got.Metrics) != 0 || got.LastUpdated != nil {
		t.Fatalf("%+v", got)
	}
	b, _ := json.Marshal(got)
	if strings.Contains(string(b), "NaN") || strings.Contains(string(b), `"periods":null`) {
		t.Fatalf("%s", b)
	}
}

// FND-12: two quarters -> tables render, growth stays null (no snapshot yet, reason not_computed).
func TestFND12PartialHistory(t *testing.T) {
	bases := []BasisCount{{"consolidated", 2}}
	rows := []FundRow{
		row("2026-03-31", "pnl.revenue", 100, "csv_import", "2026-05-01"),
		row("2026-06-30", "pnl.revenue", 110, "csv_import", "2026-08-01"),
		row("2026-06-30", "pnl.eps", 5.5, "csv_import", "2026-08-01"),
	}
	got := build(t, "auto", "Q", bases, rows, "")
	if got.Status != "partial" || len(got.Periods) != 2 || got.PeriodsAvailable != 2 {
		t.Fatalf("%+v", got)
	}
	if got.Labels[0] != "Q4 FY26" || got.Labels[1] != "Q1 FY27" {
		t.Fatalf("labels %v", got.Labels)
	}
	if eps := got.Metrics["pnl.eps"]; eps[0] != nil || eps[1] == nil || *eps[1] != 5.5 {
		t.Fatalf("eps must be null for the missing period, got %v", eps)
	}
	for k, s := range got.Derived {
		for _, v := range s {
			if v != nil {
				t.Errorf("derived %s must be null", k)
			}
		}
	}
	if got.DerivedReason == nil || *got.DerivedReason != ReasonNotComputed {
		t.Fatalf("derived reason %v", got.DerivedReason)
	}
}

func TestSourcePriorityAndSourceByMetric(t *testing.T) {
	bases := []BasisCount{{"consolidated", 1}}
	rows := []FundRow{
		row("2026-06-30", "pnl.revenue", 1, "screener_import", "2026-09-01"),
		row("2026-06-30", "pnl.revenue", 2, "csv_import", "2026-08-01"),
		row("2026-06-30", "pnl.revenue", 3, "manual", "2026-07-01"),
		row("2026-06-30", "pnl.net_profit", 4, "csv_import", "2026-08-01"),
		row("2026-06-30", "pnl.net_profit", 5, "csv_import", "2026-08-05"), // same source: newest entry wins
		row("2026-06-30", "pnl.ebitda", 6, "screener_import", "2026-08-01"),
	}
	got := build(t, "auto", "Q", bases, rows, "")
	if v := *got.Metrics["pnl.revenue"][0]; v != 3 || got.SourceByMetric["pnl.revenue"] != "manual" {
		t.Errorf("revenue %v %s", v, got.SourceByMetric["pnl.revenue"])
	}
	if v := *got.Metrics["pnl.net_profit"][0]; v != 5 {
		t.Errorf("net_profit %v", v)
	}
	if got.SourceByMetric["pnl.ebitda"] != "screener_import" {
		t.Errorf("ebitda %v", got.SourceByMetric)
	}
	if got.LastUpdated == nil || *got.LastUpdated != "2026-08-05T00:00:00Z" || got.LastUpdatedSource == nil || *got.LastUpdatedSource != "csv_import" {
		t.Errorf("last updated %v %v", got.LastUpdated, got.LastUpdatedSource)
	}
}

func TestDerivedAlignedFromSnapshot(t *testing.T) {
	bases := []BasisCount{{"consolidated", 2}}
	rows := []FundRow{
		row("2026-03-31", "pnl.revenue", 100, "manual", "2026-05-01"),
		row("2026-06-30", "pnl.revenue", 110, "manual", "2026-08-01"),
	}
	snap := `{"consolidated":{"Q":{"periods":["2025-12-31","2026-03-31","2026-06-30"],
	  "derived":{"revenue_yoy":[1.5,null,12.34]},"ratios":{"roe":15.2},
	  "valuation":{"pe_ttm":22.5,"pe_basis":"ttm"}}}}`
	got := build(t, "auto", "Q", bases, rows, snap)
	y := got.Derived["revenue_yoy"]
	if len(y) != 2 || y[0] != nil || y[1] == nil || *y[1] != 12.34 {
		t.Fatalf("yoy %v", y)
	}
	if got.Ratios["roe"] == nil || *got.Ratios["roe"] != 15.2 || got.Ratios["roce"] != nil {
		t.Fatalf("ratios %v", got.Ratios)
	}
	if got.Valuation["pe_ttm"] != 22.5 || got.Valuation["pe_basis"] != "ttm" || got.Valuation["pb"] != nil {
		t.Fatalf("valuation %v", got.Valuation)
	}
	if got.DerivedReason != nil {
		t.Fatalf("reason should be nil when computed")
	}
}

func TestPeriodWindowKeepsLatest(t *testing.T) {
	var rows []FundRow
	end := day("2020-03-31")
	for i := 0; i < 20; i++ {
		rows = append(rows, FundRow{PeriodEnd: end.AddDate(0, 3*i+1, 0).AddDate(0, 0, -1), Key: "pnl.revenue",
			Value: float64(i + 1), Unit: "INR_CR", Source: "manual", FetchedAt: day("2026-01-01")})
	}
	got := build(t, "auto", "Q", []BasisCount{{"consolidated", 20}}, rows, "")
	if len(got.Periods) != maxQuarters || got.PeriodsAvailable != 20 {
		t.Fatalf("%d %d", len(got.Periods), got.PeriodsAvailable)
	}
}

func f(v float64) *float64 { return &v }

func sh(q string, p, mf *float64) SHRow {
	return SHRow{QuarterEnd: day(q), Promoter: p, MF: mf, FetchedAt: day("2026-10-01"), Source: "csv_import"}
}

// SHP-01: MF figure missing -> mf_available=false with a note.
func TestSHP01MissingMF(t *testing.T) {
	got := BuildShareholding([]SHRow{sh("2026-06-30", f(50), nil)})
	if got.MFAvailable || got.Note == nil || !strings.Contains(*got.Note, "DII includes mutual funds") {
		t.Fatalf("%+v", got)
	}
	if got.MF[0] != nil {
		t.Fatal("mf must be null, not 0")
	}
	if ok := BuildShareholding([]SHRow{sh("2026-06-30", f(50), f(3.2))}); !ok.MFAvailable || ok.Note != nil {
		t.Fatalf("%+v", ok)
	}
}

// SHP-04: a single quarter has no QoQ (all null, with a reason).
func TestSHP04SingleQuarter(t *testing.T) {
	got := BuildShareholding([]SHRow{sh("2026-06-30", f(50), f(3))})
	if got.QoQReason == nil || *got.QoQReason != "single_quarter" {
		t.Fatalf("%+v", got)
	}
	for k, v := range got.QoQChange {
		if v != nil {
			t.Errorf("qoq %s = %v", k, *v)
		}
	}
}

func TestShareholdingQoQ(t *testing.T) {
	rows := []SHRow{sh("2026-03-31", f(50.5), f(3)), sh("2026-06-30", f(50.62), nil)}
	got := BuildShareholding(rows)
	if v := got.QoQChange["promoter"]; v == nil || *v != 0.12 {
		t.Fatalf("promoter qoq %v", v)
	}
	if got.QoQChange["mf"] != nil {
		t.Fatal("mf qoq needs both quarters")
	}
	if got.QoQReason != nil || got.Quarters[1] != "2026-06-30" {
		t.Fatalf("%+v", got)
	}
	// a missing quarter in between: no multi-quarter diff presented as QoQ
	gap := BuildShareholding([]SHRow{sh("2025-12-31", f(50), nil), sh("2026-06-30", f(51), nil)})
	if gap.QoQChange["promoter"] != nil || gap.QoQReason == nil {
		t.Fatalf("%+v", gap)
	}
}

func TestShareholdingEmpty(t *testing.T) {
	got := BuildShareholding(nil)
	b, _ := json.Marshal(got)
	if got.Reason == nil || *got.Reason != ReasonNoData || got.MFAvailable || !strings.Contains(string(b), `"quarters":[]`) {
		t.Fatalf("%s", b)
	}
}

func TestF32KeepsTypedDecimal(t *testing.T) {
	v := float32(12.3)
	if got := f32(&v); got == nil || *got != 12.3 {
		t.Fatalf("%v", got)
	}
	if f32(nil) != nil {
		t.Fatal("nil in, nil out")
	}
}

// SAF-06: the package that renders research links cannot make HTTP calls (no net/http import).
func TestSAF06NoNetworkImports(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, name := range files {
		if _, err := os.Stat(name); err != nil {
			continue
		}
		af, err := parser.ParseFile(token.NewFileSet(), name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range af.Imports {
			if p := strings.Trim(imp.Path.Value, `"`); p == "net/http" || p == "net" || strings.Contains(p, "egress") {
				t.Errorf("%s imports %s", name, p)
			}
		}
	}
}

var _ = time.Second
