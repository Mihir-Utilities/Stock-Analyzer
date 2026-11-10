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
	Requested    string // consolidated | standalone | auto
	PeriodType   string // Q | A
	CompanyType  string
	Bases        []BasisCount
	Rows         func(basis string) []FundRow // rows of the chosen basis (called at most once)
	MetaStatus   string                       // fundamental_meta.status, "" when absent
	Snapshot     json.RawMessage              // analysis_snapshot.indicators.fundamentals, may be empty
	SnapshotAsOf *time.Time                   // analysis_snapshot.as_of (a date), nil without a snapshot
	SnapshotMeta json.RawMessage              // analysis_snapshot.indicators.fundamentals_meta (D05b-10), may be empty
}

// NullReasons are the worker's per-metric reasons for a null (node.null_reasons), passed through
// unchanged: derived is metric -> period_end -> reason, ratios and valuation are metric -> reason.
type NullReasons struct {
	Derived   map[string]map[string]string `json:"derived"`
	Ratios    map[string]string            `json:"ratios"`
	Valuation map[string]string            `json:"valuation"`
}

// RatioMeta says which period and definition a ratio used (node.ratio_meta).
type RatioMeta struct {
	RoeBasis    *string           `json:"roe_basis"` // average | ending
	RatioPeriod map[string]string `json:"ratio_period"`
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
	DerivedAsOf       *string               `json:"derived_as_of"` // computed_at (UTC RFC 3339) of the D05b run behind derived, ratios and valuation; the snapshot as_of date for older snapshots
	Ratios            map[string]*float64   `json:"ratios"`
	RatiosReason      *string               `json:"ratios_reason"`
	Valuation         map[string]any        `json:"valuation"`
	ValuationReason   *string               `json:"valuation_reason"`
	NullReasons       NullReasons           `json:"null_reasons"`
	RatioMeta         RatioMeta             `json:"ratio_meta"`
	CompanyType       string                `json:"company_type"`
	Status            string                `json:"status"`
	EntryHint         *string               `json:"entry_hint"`
	LastUpdated       *string               `json:"last_updated"`
	LastUpdatedSource *string               `json:"last_updated_source"`
	Warnings          []string              `json:"-"`
	DerivedStale      bool                  `json:"-"` // the snapshot is older than the newest stored value
	MixedSources      []string              `json:"-"` // metrics whose periods come from more than one source
	updatedAt         time.Time
}

// UpdatedAt is the newest fetched_at among the returned values (zero when none).
func (f *Fundamentals) UpdatedAt() time.Time { return f.updatedAt }

// Derived growth/margin keys (docs/03 section 5) and ratio/valuation keys; always present.
var (
	derivedKeys = []string{"revenue_yoy", "net_profit_yoy", "op_margin", "net_margin"}
	// optional derived keys: returned only when the worker wrote them (QoQ for quarters, NII for banks)
	derivedOptionalKeys = []string{"revenue_qoq", "net_profit_qoq", "nii_yoy"}
	ratioKeys           = []string{"roe", "roce", "debt_equity", "interest_coverage", "cfo_to_pat", "fcf",
		"revenue_cagr_3y", "revenue_cagr_5y", "net_profit_cagr_3y", "net_profit_cagr_5y", "cfo_to_pat_avg", "eps_cagr_3y"}
	valuationKeys = []string{"pe_ttm", "pb", "div_yield", "peg", "pe_percentile_5y", "ev_ebitda", "market_cap_cr"}
	// valuation context written by the worker, returned only when present
	valuationOptionalKeys = []string{"eps_ttm", "bvps", "pb_source", "eps_period_end", "close"}
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
		NullReasons: NullReasons{Derived: map[string]map[string]string{}, Ratios: map[string]string{}, Valuation: map[string]string{}},
		RatioMeta:   RatioMeta{RatioPeriod: map[string]string{}},
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
	var newestFetched time.Time // newest fundamental_value.fetched_at of this basis and period type (D05b-10)
	for _, r := range rows {
		if r.FetchedAt.After(newestFetched) {
			newestFetched = r.FetchedAt
		}
	}

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
	sources := map[string]map[string]bool{}
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
		if sources[k.key] == nil {
			sources[k.key] = map[string]bool{}
		}
		sources[k.key][r.Source] = true
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

	for k, set := range sources {
		if len(set) > 1 {
			out.MixedSources = append(out.MixedSources, k)
		}
	}
	sort.Strings(out.MixedSources)

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
	if err := applySnapshot(&out, in, basis, all, newestFetched); err != nil {
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
// Derived is kept raw: the worker also writes text arrays there (op_margin_source), which must not
// break the numeric ones.
type snapshotNode struct {
	Periods     []string                   `json:"periods"`
	Derived     map[string]json.RawMessage `json:"derived"`
	Ratios      map[string]*float64        `json:"ratios"`
	Valuation   map[string]any             `json:"valuation"`
	NullReasons NullReasons                `json:"null_reasons"`
	RatioMeta   RatioMeta                  `json:"ratio_meta"`
}

// snapshotMeta is indicators.fundamentals_meta (worker D05b): when the run happened.
type snapshotMeta struct {
	ComputedAt *string `json:"computed_at"`
}

// computedAt is the worker's computed_at, nil when absent or unreadable (older snapshots).
func computedAt(raw json.RawMessage) *time.Time {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var m snapshotMeta
	if json.Unmarshal(raw, &m) != nil || m.ComputedAt == nil {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, *m.ComputedAt)
	if err != nil {
		return nil
	}
	return &t
}

func floatSeries(raw json.RawMessage) ([]*float64, bool) {
	var s []*float64
	if len(raw) == 0 || json.Unmarshal(raw, &s) != nil {
		return nil, false
	}
	return s, true
}

func applySnapshot(out *Fundamentals, in FundamentalsInput, basis string, periods []time.Time, newestFetched time.Time) error {
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
	if c := computedAt(in.SnapshotMeta); c != nil {
		// D05b-10: stale when an entry is newer than the run that computed the snapshot.
		d := c.UTC().Format(time.RFC3339)
		out.DerivedAsOf = &d
		out.DerivedStale = newestFetched.After(*c)
	} else if in.SnapshotAsOf != nil {
		// Older snapshots carry no computed_at: the as_of date (the last bar) is all there is, so an
		// entry fetched on a later IST day reads stale.
		d := in.SnapshotAsOf.Format(time.DateOnly)
		out.DerivedAsOf = &d
		if !out.updatedAt.IsZero() && istDate(out.updatedAt).After(*in.SnapshotAsOf) {
			out.DerivedStale = true
		}
	}
	if node.NullReasons.Derived != nil {
		out.NullReasons.Derived = node.NullReasons.Derived
	}
	if node.NullReasons.Ratios != nil {
		out.NullReasons.Ratios = node.NullReasons.Ratios
	}
	if node.NullReasons.Valuation != nil {
		out.NullReasons.Valuation = node.NullReasons.Valuation
	}
	out.RatioMeta.RoeBasis = node.RatioMeta.RoeBasis
	if node.RatioMeta.RatioPeriod != nil {
		out.RatioMeta.RatioPeriod = node.RatioMeta.RatioPeriod
	}
	pos := map[string]int{}
	for i, p := range node.Periods {
		pos[p] = i
	}
	for _, k := range append(append([]string{}, derivedKeys...), derivedOptionalKeys...) {
		src, ok := floatSeries(node.Derived[k])
		if !ok {
			continue // absent, or not a numeric array: the key stays all-null (or absent when optional)
		}
		if out.Derived[k] == nil {
			out.Derived[k] = make([]*float64, len(periods))
		}
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
	for _, k := range valuationOptionalKeys {
		if v, ok := node.Valuation[k]; ok {
			out.Valuation[k] = v
		}
	}
	if v, ok := node.Valuation["pe_basis"].(string); ok {
		out.Valuation["pe_basis"] = v
	}
	return nil
}

// istDate is the IST calendar date of t as a UTC-midnight time (comparable with DATE columns).
func istDate(t time.Time) time.Time {
	ist := t.In(time.FixedZone("IST", 5*3600+30*60))
	return time.Date(ist.Year(), ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC)
}
