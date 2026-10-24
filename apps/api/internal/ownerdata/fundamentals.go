package ownerdata

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Reasons for null values (docs/03 section 1).
const (
	ReasonNoData      = "no_data_entered"
	ReasonNotComputed = "not_computed" // derived values are written by the worker (compute_analysis)
)

// Limits of the periods returned (docs/03 is silent: B05-3).
const (
	maxQuarters = 12
	maxAnnuals  = 10
)

// FundRow is one stored value (fundamental_value) after filtering out `derived` and NULL values.
type FundRow struct {
	PeriodEnd time.Time
	Key       string
	Value     float64
	Unit      string
	Source    string
	FetchedAt time.Time
}

// BasisCount is how many periods the owner entered for a basis.
type BasisCount struct {
	Basis   string
	Periods int
}

// FundamentalsInput is everything the pure builder needs.
type FundamentalsInput struct {
	Requested   string // consolidated | standalone | auto
	PeriodType  string // Q | A
	CompanyType string
	Bases       []BasisCount
	Rows        func(basis string) []FundRow // rows of the chosen basis (called at most once)
	MetaStatus  string                       // fundamental_meta.status, "" when absent
	Snapshot    json.RawMessage              // analysis_snapshot.indicators.fundamentals, may be empty
}

// Fundamentals is `data` of GET /stocks/{symbol}/fundamentals.
type Fundamentals struct {
	BasisUsed         string                `json:"basis_used"`
	BasisAvailable    []string              `json:"basis_available"`
	BasisNote         *string               `json:"basis_note"`
	PeriodType        string                `json:"period_type"`
	PeriodsAvailable  int                   `json:"periods_available"`
	Unit              string                `json:"unit"`
	UnitByMetric      map[string]string     `json:"unit_by_metric"`
	SourceByMetric    map[string]string     `json:"source_by_metric"`
	Periods           []string              `json:"periods"`
	Labels            []string              `json:"labels"`
	Metrics           map[string][]*float64 `json:"metrics"`
	MetricsReason     *string               `json:"metrics_reason"`
	Derived           map[string][]*float64 `json:"derived"`
	DerivedReason     *string               `json:"derived_reason"`
	Ratios            map[string]*float64   `json:"ratios"`
	RatiosReason      *string               `json:"ratios_reason"`
	Valuation         map[string]any        `json:"valuation"`
	ValuationReason   *string               `json:"valuation_reason"`
	CompanyType       string                `json:"company_type"`
	Status            string                `json:"status"`
	EntryHint         *string               `json:"entry_hint"`
	LastUpdated       *string               `json:"last_updated"`
	LastUpdatedSource *string               `json:"last_updated_source"`
	Warnings          []string              `json:"-"`
	updatedAt         time.Time
}

// UpdatedAt is the newest fetched_at among the returned values (zero when none).
func (f *Fundamentals) UpdatedAt() time.Time { return f.updatedAt }

// Derived growth/margin keys (docs/03 section 5) and ratio/valuation keys; always present.
var (
	derivedKeys   = []string{"revenue_yoy", "net_profit_yoy", "op_margin", "net_margin"}
	ratioKeys     = []string{"roe", "roce", "debt_equity", "interest_coverage", "cfo_to_pat", "fcf"}
	valuationKeys = []string{"pe_ttm", "pb", "div_yield", "peg", "pe_percentile_5y"}
)

// EntryHint is shown when the owner has entered nothing for the stock.
const EntryHint = "Add results via Import or the manual form"

// SourceRank is the priority of a source: manual > csv_import > screener_import (docs/05 section 2).
// Lower wins; unknown sources lose.
func SourceRank(s string) int {
	switch s {
	case "manual":
		return 0
	case "csv_import":
		return 1
	case "screener_import":
		return 2
	}
	return 9
}

// ChooseBasis implements `basis=auto` (consolidated if present else standalone) and honours an
// explicit choice. The second result is a note when auto fell back to standalone.
func ChooseBasis(requested string, bases []BasisCount) (string, *string) {
	has := map[string]bool{}
	for _, b := range bases {
		has[b.Basis] = b.Periods > 0
	}
	switch requested {
	case "consolidated", "standalone":
		return requested, nil
	}
	if has["consolidated"] || !has["standalone"] {
		return "consolidated", nil
	}
	n := "Consolidated results are not entered; showing standalone figures"
	return "standalone", &n
}

// BuildFundamentals assembles the response from stored rows and the worker snapshot. It never
// invents a value: gaps are nil with a block-level reason (FND-11, FND-12).
func BuildFundamentals(in FundamentalsInput) (Fundamentals, error) {
	basis, note := ChooseBasis(in.Requested, in.Bases)
	out := Fundamentals{
		BasisUsed: basis, BasisNote: note, PeriodType: in.PeriodType, Unit: "INR_CR",
		BasisAvailable: []string{}, UnitByMetric: map[string]string{}, SourceByMetric: map[string]string{},
		Periods: []string{}, Labels: []string{}, Metrics: map[string][]*float64{},
		Derived: map[string][]*float64{}, Ratios: map[string]*float64{}, Valuation: map[string]any{},
		CompanyType: in.CompanyType, Status: "none",
	}
	for _, b := range in.Bases {
		if b.Periods > 0 {
			out.BasisAvailable = append(out.BasisAvailable, b.Basis)
		}
	}
	var rows []FundRow
	if in.Rows != nil {
		rows = in.Rows(basis)
	}
	win := winners(rows)

	periodSet := map[time.Time]bool{}
	for k := range win {
		periodSet[k.end] = true
	}
	all := make([]time.Time, 0, len(periodSet))
	for p := range periodSet {
		all = append(all, p)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Before(all[j]) })
	out.PeriodsAvailable = len(all)
	limit := maxQuarters
	if in.PeriodType == "A" {
		limit = maxAnnuals
	}
	if len(all) > limit {
		all = all[len(all)-limit:]
	}
	idx := map[time.Time]int{}
	for i, p := range all {
		idx[p] = i
		out.Periods = append(out.Periods, p.Format(time.DateOnly))
		out.Labels = append(out.Labels, Label(p, in.PeriodType))
	}

	latest := map[string]int{}
	updatedSource := ""
	for k, r := range win {
		i, ok := idx[k.end]
		if !ok {
			continue
		}
		series := out.Metrics[k.key]
		if series == nil {
			series = make([]*float64, len(all))
			out.Metrics[k.key] = series
		}
		v := r.Value
		series[i] = &v
		if r.FetchedAt.After(out.updatedAt) {
			out.updatedAt, updatedSource = r.FetchedAt, r.Source
		}
		// the source and unit of a metric are those of its latest period in the window
		if prev, seen := latest[k.key]; !seen || i > prev {
			out.SourceByMetric[k.key] = r.Source
			out.UnitByMetric[k.key] = r.Unit
			latest[k.key] = i
		}
	}

	if len(all) == 0 {
		out.Status = "none"
		reason := ReasonNoData
		out.MetricsReason, out.DerivedReason, out.RatiosReason, out.ValuationReason = &reason, &reason, &reason, &reason
		hint := EntryHint
		out.EntryHint = &hint
		fillNulls(&out, 0)
		return out, nil
	}

	out.Status = "ok"
	switch in.MetaStatus {
	case "partial", "source_error":
		out.Status = "partial"
	case "parse_error":
		out.Status = "parse_error"
	}
	if in.PeriodType == "Q" && len(all) < 5 || in.PeriodType == "A" && len(all) < 2 {
		// too little history for growth (FND-12): the renderer shows tables; growth stays null
		if out.Status == "ok" {
			out.Status = "partial"
		}
	}
	if err := applySnapshot(&out, in, basis, all); err != nil {
		return out, err
	}
	if len(in.Bases) == 2 && in.Requested == "auto" {
		for _, b := range in.Bases {
			if b.Basis != basis && b.Periods > 0 {
				out.Warnings = append(out.Warnings, fmt.Sprintf(
					"%d %s period(s) are not shown: a series never mixes consolidated and standalone figures", b.Periods, b.Basis))
			}
		}
	}
	if u := out.updatedAt; !u.IsZero() {
		s := u.UTC().Format(time.RFC3339)
		out.LastUpdated = &s
		out.LastUpdatedSource = &updatedSource
	}
	return out, nil
}

type cell struct {
	end time.Time
	key string
}

// winners picks the stored value per (period_end, metric_key): best source, then newest entry.
func winners(rows []FundRow) map[cell]FundRow {
	win := map[cell]FundRow{}
	for _, r := range rows {
		c := cell{r.PeriodEnd, r.Key}
		cur, ok := win[c]
		if !ok || SourceRank(r.Source) < SourceRank(cur.Source) ||
			SourceRank(r.Source) == SourceRank(cur.Source) && r.FetchedAt.After(cur.FetchedAt) {
			win[c] = r
		}
	}
	return win
}

func fillNulls(out *Fundamentals, n int) {
	for _, k := range derivedKeys {
		out.Derived[k] = make([]*float64, n)
	}
	for _, k := range ratioKeys {
		out.Ratios[k] = nil
	}
	for _, k := range valuationKeys {
		out.Valuation[k] = nil
	}
	out.Valuation["pe_basis"] = "n/a"
}

// snapshotNode is the worker's contract (B05-4): indicators.fundamentals.<basis>.<Q|A>.
type snapshotNode struct {
	Periods   []string              `json:"periods"`
	Derived   map[string][]*float64 `json:"derived"`
	Ratios    map[string]*float64   `json:"ratios"`
	Valuation map[string]any        `json:"valuation"`
}

func applySnapshot(out *Fundamentals, in FundamentalsInput, basis string, periods []time.Time) error {
	fillNulls(out, len(periods))
	var tree map[string]map[string]snapshotNode
	if len(in.Snapshot) > 0 && string(in.Snapshot) != "null" {
		if err := json.Unmarshal(in.Snapshot, &tree); err != nil {
			return fmt.Errorf("analysis_snapshot fundamentals: %w", err)
		}
	}
	node, ok := tree[basis][in.PeriodType]
	if !ok {
		r := ReasonNotComputed
		out.DerivedReason, out.RatiosReason, out.ValuationReason = &r, &r, &r
		return nil
	}
	pos := map[string]int{}
	for i, p := range node.Periods {
		pos[p] = i
	}
	for _, k := range derivedKeys {
		src := node.Derived[k]
		for i, p := range periods {
			if j, ok := pos[p.Format(time.DateOnly)]; ok && j < len(src) {
				out.Derived[k][i] = src[j]
			}
		}
	}
	for _, k := range ratioKeys {
		out.Ratios[k] = node.Ratios[k]
	}
	for _, k := range valuationKeys {
		if v, ok := node.Valuation[k]; ok {
			out.Valuation[k] = v
		}
	}
	if v, ok := node.Valuation["pe_basis"].(string); ok {
		out.Valuation["pe_basis"] = v
	}
	return nil
}
