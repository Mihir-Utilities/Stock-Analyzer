package ownerdata

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// workerSnapshot is indicators.fundamentals exactly as the worker (apps/worker D05b, DEMOCO of the
// worker tests) writes it, including its text array derived.op_margin_source.
func workerSnapshot(t *testing.T) json.RawMessage {
	t.Helper()
	b, err := os.ReadFile("testdata/worker_democo_fundamentals.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func annualRows(fetched string) []FundRow {
	var rows []FundRow
	for _, e := range []string{"2023-03-31", "2024-03-31", "2025-03-31", "2026-03-31"} {
		rows = append(rows, row(e, "pnl.revenue", 100, "csv_import", fetched))
	}
	return rows
}

func buildD05b(t *testing.T, snap, meta json.RawMessage, asOf *time.Time, rows []FundRow) Fundamentals {
	t.Helper()
	got, err := BuildFundamentals(FundamentalsInput{
		Requested: "auto", PeriodType: "A", CompanyType: "general", Bases: []BasisCount{{"consolidated", 4}},
		Snapshot: snap, SnapshotMeta: meta, SnapshotAsOf: asOf, Rows: func(string) []FundRow { return rows },
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// D05b-9: everything the worker writes that the contract names is passed through unchanged.
func TestWorkerSnapshotPassThrough(t *testing.T) {
	got := buildD05b(t, workerSnapshot(t), nil, nil, annualRows("2026-10-01"))
	if v, _ := got.Valuation["ev_ebitda"].(float64); v != 29.0 {
		t.Fatalf("ev_ebitda %v", got.Valuation["ev_ebitda"])
	}
	if v, _ := got.Valuation["market_cap_cr"].(float64); v != 36000.0 {
		t.Fatalf("market_cap_cr %v", got.Valuation["market_cap_cr"])
	}
	if got.Valuation["pb_source"] != "computed" || got.Valuation["pe_basis"] != "ttm" || got.Valuation["eps_ttm"] != 32.3 {
		t.Fatalf("valuation %v", got.Valuation)
	}
	if r := got.Ratios["roe"]; r == nil || *r != 33.65853658536586 {
		t.Fatalf("roe %v", r)
	}
	if r := got.Ratios["revenue_cagr_3y"]; r == nil || *r != 11.102644857564847 {
		t.Fatalf("cagr %v", r)
	}
	if got.Ratios["cfo_to_pat_avg"] != nil || got.NullReasons.Ratios["cfo_to_pat_avg"] != "insufficient_history" {
		t.Fatalf("cfo_to_pat_avg %v %v", got.Ratios["cfo_to_pat_avg"], got.NullReasons.Ratios)
	}
	if got.NullReasons.Valuation["div_yield"] != "no_dividend_data" || got.Valuation["div_yield"] != nil {
		t.Fatalf("div_yield %v %v", got.Valuation["div_yield"], got.NullReasons.Valuation)
	}
	if got.NullReasons.Derived["revenue_yoy"]["2023-03-31"] != "n/m" {
		t.Fatalf("derived reasons %v", got.NullReasons.Derived)
	}
	if got.RatioMeta.RoeBasis == nil || *got.RatioMeta.RoeBasis != "average" || got.RatioMeta.RatioPeriod["roe"] != "2026-03-31" {
		t.Fatalf("ratio_meta %+v", got.RatioMeta)
	}
	// the text array op_margin_source must not break decoding of the numeric ones
	if y := got.Derived["revenue_yoy"]; len(y) != 4 || y[0] != nil || y[3] == nil || *y[3] != 9.090909090909083 {
		t.Fatalf("revenue_yoy %v", y)
	}
	if _, ok := got.Derived["op_margin_source"]; ok {
		t.Fatalf("text arrays are not returned")
	}
	if _, ok := got.Derived["revenue_qoq"]; ok {
		t.Fatalf("annual node has no qoq")
	}
	if got.DerivedReason != nil || got.RatiosReason != nil {
		t.Fatalf("block reasons must stay nil when computed")
	}
}

// Quarterly node: optional QoQ keys are returned when the worker wrote them.
func TestWorkerSnapshotQuarterlyOptionalKeys(t *testing.T) {
	rows := []FundRow{}
	for _, e := range []string{"2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"} {
		rows = append(rows, row(e, "pnl.revenue", 100, "csv_import", "2026-10-01"))
	}
	got, err := BuildFundamentals(FundamentalsInput{
		Requested: "auto", PeriodType: "Q", CompanyType: "general", Bases: []BasisCount{{"consolidated", 4}},
		Snapshot: workerSnapshot(t), Rows: func(string) []FundRow { return rows },
	})
	if err != nil {
		t.Fatal(err)
	}
	q, ok := got.Derived["revenue_qoq"]
	if !ok || len(q) != 4 || got.NullReasons.Derived["revenue_qoq"]["2025-06-30"] != "missing_input" {
		t.Fatalf("qoq %v %v", q, got.NullReasons.Derived["revenue_qoq"])
	}
}

// Stocks without a D05b snapshot keep null/not_computed and empty reasons (never 0).
func TestNoSnapshotKeepsNullsAndEmptyReasons(t *testing.T) {
	got := buildD05b(t, nil, nil, nil, annualRows("2026-10-01"))
	if got.RatiosReason == nil || *got.RatiosReason != ReasonNotComputed {
		t.Fatalf("reason %v", got.RatiosReason)
	}
	for _, k := range []string{"ev_ebitda", "market_cap_cr", "pe_ttm"} {
		if v, ok := got.Valuation[k]; !ok || v != nil {
			t.Fatalf("%s = %v", k, v)
		}
	}
	if got.NullReasons.Derived == nil || got.NullReasons.Ratios == nil || got.NullReasons.Valuation == nil ||
		got.RatioMeta.RatioPeriod == nil || got.RatioMeta.RoeBasis != nil {
		t.Fatalf("empty maps expected: %+v %+v", got.NullReasons, got.RatioMeta)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if json.Unmarshal(b, &back) != nil || back["null_reasons"] == nil || back["ratio_meta"] == nil {
		t.Fatalf("json %s", b)
	}
}

// D05b-10: stale iff the newest entry is later than the run's computed_at; the last bar date is not used.
func TestDerivedStaleUsesComputedAt(t *testing.T) {
	lastBar := day("2026-11-06")
	snap := workerSnapshot(t)
	meta := json.RawMessage(`{"computed_at":"2026-11-08T10:00:00+00:00","inputs_fetched_at":"2026-11-07T09:00:00+00:00"}`)
	cases := []struct {
		name    string
		fetched string
		meta    json.RawMessage
		stale   bool
		asOf    string
	}{
		{"entry after last bar, before recompute", "2026-11-07T09:00:00Z", json.RawMessage(`{"computed_at":"2026-11-06T09:00:00+00:00"}`), true, "2026-11-06T09:00:00Z"},
		{"right after recompute", "2026-11-07T09:00:00Z", meta, false, "2026-11-08T10:00:00Z"},
		{"entry equal to computed_at is not stale", "2026-11-08T10:00:00Z", meta, false, "2026-11-08T10:00:00Z"},
		{"old snapshot without computed_at, entry after last bar", "2026-11-07T09:00:00Z", nil, true, "2026-11-06"},
		{"old snapshot without computed_at, entry before last bar", "2026-11-05T09:00:00Z", json.RawMessage(`{"version":"d05b-1"}`), false, "2026-11-06"},
	}
	for _, c := range cases {
		ft, err := time.Parse(time.RFC3339, c.fetched)
		if err != nil {
			t.Fatal(err)
		}
		rows := annualRows("2026-01-01")
		rows[3].FetchedAt = ft
		got := buildD05b(t, snap, c.meta, &lastBar, rows)
		if got.DerivedStale != c.stale {
			t.Errorf("%s: stale=%v want %v", c.name, got.DerivedStale, c.stale)
		}
		if got.DerivedAsOf == nil || *got.DerivedAsOf != c.asOf {
			t.Errorf("%s: derived_as_of=%v want %s", c.name, got.DerivedAsOf, c.asOf)
		}
	}
}
