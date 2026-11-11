package portfolio

import (
	"context"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/mfhold"
)

// Views of GET /portfolio/summary (docs/03 12a, docs/05 8.5.1): filters over one logical ledger.
const (
	ViewAll    = "all"
	ViewEquity = "equity"
	ViewMF     = "mf"
)

// eqAgg holds the decimal aggregates of the equity ledger that the view combiner needs.
type eqAgg struct {
	Invested, Realized, MarketValue, DayChange decimal.Decimal
	Outflow, Inflow                            decimal.Decimal
	Open                                       int
	Unpriced, NoDay                            []string
	Flows                                      []mfhold.Flow
}

// ViewTotals are the totals of a view: the legacy fields plus the D-MF additions.
type ViewTotals struct {
	Invested          string   `json:"invested"`
	MarketValue       *string  `json:"market_value"`
	MarketValueReason *string  `json:"market_value_reason"`
	Unrealized        *string  `json:"unrealized_pnl"`
	UnrealizedPct     *float64 `json:"unrealized_pct"`
	Realized          string   `json:"realized_pnl"`
	DayChange         *string  `json:"day_change"`
	DayChangeReason   *string  `json:"day_change_reason"`
	IDCWIncome        *string  `json:"idcw_income"`
	TotalPnL          *string  `json:"total_pnl"`
	TotalPnLReason    *string  `json:"total_pnl_reason"`
	PurchaseCash      string   `json:"purchase_cash"`
}

// ViewReturns are the returns of a view (docs/05 8.5.6).
type ViewReturns struct {
	XIRRPct       *float64 `json:"xirr_pct"`
	XIRRReason    *string  `json:"xirr_reason"`
	AbsolutePct   *float64 `json:"absolute_return_pct"`
	AbsoluteBasis string   `json:"absolute_return_basis"`
	SpanDays      *int     `json:"span_days"`
	FirstFlowDate *string  `json:"first_flow_date"`
}

// Breakdown is one asset-class row of the All view; it uses only that class's flows.
type Breakdown struct {
	AssetClass        string   `json:"asset_class"`
	Invested          string   `json:"invested"`
	MarketValue       *string  `json:"market_value"`
	MarketValueReason *string  `json:"market_value_reason"`
	Unrealized        *string  `json:"unrealized_pnl"`
	Realized          string   `json:"realized_pnl"`
	IDCWIncome        *string  `json:"idcw_income"`
	TotalPnL          *string  `json:"total_pnl"`
	XIRRPct           *float64 `json:"xirr_pct"`
	XIRRReason        *string  `json:"xirr_reason"`
	AbsolutePct       *float64 `json:"absolute_return_pct"`
	AsOf              string   `json:"as_of"`
	Stale             bool     `json:"stale"`
}

// NoBenchmark is the benchmark of the All and Mutual funds views (MFH-9).
type NoBenchmark struct {
	Code    *string  `json:"code"`
	XIRRPct *float64 `json:"xirr_pct"`
	Reason  string   `json:"reason"`
}

// ViewSummary is the data of GET /portfolio/summary?view=. It embeds the legacy Summary (same field
// names and meanings); the fields declared here shadow the ones that grew in D-MF.
type ViewSummary struct {
	Summary
	View                string           `json:"view"`
	AssetClassesPresent []string         `json:"asset_classes_present"`
	Totals              ViewTotals       `json:"totals"`
	Returns             ViewReturns      `json:"returns"`
	Benchmark           any              `json:"benchmark"`
	Breakdown           []Breakdown      `json:"breakdown"`
	MFHoldings          []mfhold.Holding `json:"mf_holdings"`
	AllocScheme         []mfhold.Share   `json:"allocation_by_scheme"`
	AllocCategory       []mfhold.Share   `json:"allocation_by_category"`
	AllocAssetClass     []Share          `json:"allocation_by_asset_class"`
	Stale               bool             `json:"-"`
	StaleAgeHours       float64          `json:"-"`
	Warnings            []Warn           `json:"-"`
}

// ViewResult is a ViewSummary with the freshness the envelope meta needs.
type ViewResult struct {
	Summary ViewSummary
	AsOf    time.Time
}

// ParseView validates ?view= (missing = equity, MFH-14).
func ParseView(raw string) (string, error) {
	switch raw {
	case "", ViewEquity:
		return ViewEquity, nil
	case ViewAll, ViewMF:
		return raw, nil
	}
	return "", &ValidationError{[]FieldError{{"view", "must be all, equity or mf"}}}
}

func joinReasons(parts ...string) *string {
	var keep []string
	for _, p := range parts {
		if p != "" {
			keep = append(keep, p)
		}
	}
	if len(keep) == 0 {
		return nil
	}
	return strp(strings.Join(keep, "; "))
}

// SummaryView computes the summary of one view. The default (equity) keeps every legacy field.
func (s *Service) SummaryView(ctx context.Context, rawView, rawAsOf string, includeExited bool) (ViewResult, error) {
	view, err := ParseView(rawView)
	if err != nil {
		return ViewResult{}, err
	}
	asOf, err := ParseAsOf(rawAsOf, s.Now())
	if err != nil {
		return ViewResult{}, err
	}
	var eq SummaryResult
	var eqSum Summary
	if view != ViewMF {
		if eq, err = s.Summary(ctx, rawAsOf, includeExited); err != nil {
			return ViewResult{}, err
		}
		eqSum = eq.Summary
	} else {
		eqSum = emptyEquity(asOf)
	}
	var mf mfhold.Result
	if view != ViewEquity && s.MF != nil {
		if mf, err = s.MF.Sleeve(ctx, asOf, includeExited, false); err != nil {
			return ViewResult{}, err
		}
	}
	present := []string{}
	var hasEq bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM portfolio_txn WHERE trade_date <= $1)`, asOf).Scan(&hasEq); err != nil {
		return ViewResult{}, err
	}
	hasMF := mf.Present
	if s.MF != nil && view == ViewEquity {
		if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mf_txn WHERE txn_date <= $1)`, asOf).Scan(&hasMF); err != nil {
			return ViewResult{}, err
		}
	}
	if hasEq {
		present = append(present, "equity")
	}
	if hasMF {
		present = append(present, "mf")
	}
	vs := ViewSummary{Summary: eqSum, View: view, AssetClassesPresent: present, Breakdown: []Breakdown{},
		MFHoldings: []mfhold.Holding{}, AllocScheme: []mfhold.Share{}, AllocCategory: []mfhold.Share{}, AllocAssetClass: []Share{}}
	asOfS := ymd(asOf)
	switch view {
	case ViewEquity:
		vs.Totals = equityTotals(eqSum)
		vs.Returns = returnsFor(asOf, eqSum.agg.Flows, eqSum.agg.Open > 0, eqSum.Returns)
		vs.Benchmark = eqSum.Benchmark
		vs.Stale, vs.StaleAgeHours, vs.Warnings = eqSum.Stale, eqSum.StaleAgeHours, eqSum.Warnings
	case ViewMF:
		vs.Holdings, vs.AllocStock, vs.AllocSector = []Holding{}, []Share{}, []Share{}
		vs.Dividends = Dividends{Amount: money(decimal.Zero), Label: "not applicable to mutual funds; IDCW income is taken from your transactions", Items: []DividendItem{}}
		vs.MFHoldings, vs.AllocScheme, vs.AllocCategory, vs.AllocPartial = mf.Items, mf.AllocScheme, mf.AllocCategory, mf.AllocPartial
		vs.Totals = mfTotals(mf.Totals)
		vs.Returns = mfReturns(mf.Returns)
		vs.Benchmark = NoBenchmark{Reason: "not_defined_for_view"}
		vs.Stale, vs.StaleAgeHours = mf.Stale, float64(mf.StaleAgeDays)*24
		vs.Warnings = convWarns(mf.Warnings)
	default: // all
		vs.MFHoldings, vs.AllocScheme, vs.AllocCategory = mf.Items, mf.AllocScheme, mf.AllocCategory
		vs.Benchmark = NoBenchmark{Reason: "not_defined_for_view"}
		vs.combine(asOf, asOfS, eqSum, mf)
		vs.Stale = eqSum.Stale || mf.Stale
		vs.StaleAgeHours = max(eqSum.StaleAgeHours, float64(mf.StaleAgeDays)*24)
		vs.Warnings = append(append([]Warn{}, eqSum.Warnings...), convWarns(mf.Warnings)...)
	}
	return ViewResult{Summary: vs, AsOf: asOf}, nil
}

func convWarns(ws []mfhold.Warn) []Warn {
	out := make([]Warn, 0, len(ws))
	for _, w := range ws {
		out = append(out, Warn{Code: w.Code, Message: w.Message})
	}
	return out
}

func emptyEquity(asOf time.Time) Summary {
	return BuildSummary(SummaryInput{AsOf: asOf, Stale: func(time.Time) (bool, float64) { return false, 0 }})
}

// spanOf returns the span and first-flow date of a flow list: to as_of while something is open, else
// to the last flow (the same convention as the returns themselves).
func spanOf(asOf time.Time, flows []mfhold.Flow, open bool) (*int, *string) {
	if len(flows) == 0 {
		return nil, nil
	}
	first, last := flows[0].Date, flows[0].Date
	for _, f := range flows {
		if f.Date.Before(first) {
			first = f.Date
		}
		if f.Date.After(last) {
			last = f.Date
		}
	}
	end := last
	if open {
		end = asOf
	}
	d := int(end.Sub(first).Hours() / 24)
	return &d, strp(ymd(first))
}

func returnsFor(asOf time.Time, flows []mfhold.Flow, open bool, r Returns) ViewReturns {
	span, first := spanOf(asOf, flows, open)
	return ViewReturns{XIRRPct: r.XIRRPct, XIRRReason: r.XIRRReason, AbsolutePct: r.AbsolutePct, AbsoluteBasis: r.AbsoluteBasis, SpanDays: span, FirstFlowDate: first}
}

func mfReturns(r mfhold.Returns) ViewReturns {
	return ViewReturns{XIRRPct: r.XIRRPct, XIRRReason: r.XIRRReason, AbsolutePct: r.AbsPct, AbsoluteBasis: r.Basis, SpanDays: r.SpanDays, FirstFlowDate: r.FirstFlow}
}

func mfTotals(t mfhold.Totals) ViewTotals {
	return ViewTotals{Invested: t.Invested, MarketValue: t.MarketValue, MarketValueReason: t.MarketValueReason, Unrealized: t.Unrealized,
		UnrealizedPct: t.UnrealizedPct, Realized: t.Realized, DayChange: t.DayChange, DayChangeReason: t.DayChangeReason,
		IDCWIncome: strp(t.IDCWIncome), TotalPnL: t.TotalPnL, TotalPnLReason: t.TotalPnLReason, PurchaseCash: t.PurchaseCash}
}

// equityTotals adds the D-MF fields to the legacy totals (idcw_income stays null for equity).
func equityTotals(s Summary) ViewTotals {
	t := s.Totals
	vt := ViewTotals{Invested: t.Invested, MarketValue: t.MarketValue, MarketValueReason: t.MarketValueReason, Unrealized: t.Unrealized,
		UnrealizedPct: t.UnrealizedPct, Realized: t.Realized, DayChange: t.DayChange, DayChangeReason: t.DayChangeReason,
		PurchaseCash: money(s.agg.Outflow)}
	switch {
	case s.agg.Open == 0:
		vt.TotalPnL = moneyP(s.agg.Realized)
	case t.Unrealized != nil:
		vt.TotalPnL = moneyP(s.agg.MarketValue.Sub(s.agg.Invested).Add(s.agg.Realized))
	default:
		vt.TotalPnLReason = t.MarketValueReason
	}
	return vt
}

// combine fills the All view: pooled totals and returns, breakdown, weights and allocation by class.
func (vs *ViewSummary) combine(asOf time.Time, asOfS string, eq Summary, mf mfhold.Result) {
	ea, ma := eq.agg, mf.Agg
	hundred := decimal.NewFromInt(100)
	invested := ea.Invested.Add(ma.Invested)
	realized := ea.Realized.Add(ma.Realized)
	idcw := ma.IDCWIncome
	t := ViewTotals{Invested: money(invested), Realized: money(realized), IDCWIncome: moneyP(idcw), PurchaseCash: money(ea.Outflow.Add(ma.PurchaseCash))}
	open := ea.Open + ma.Open
	var eqMiss, mfMiss string
	if len(ea.Unpriced) > 0 {
		eqMiss = ReasonMissingPrice + ": " + strings.Join(ea.Unpriced, ", ")
	}
	if len(ma.Unpriced) > 0 {
		mfMiss = mfhold.ReasonMissingNAV + ": " + strings.Join(ma.Unpriced, ", ")
	}
	mv := ea.MarketValue.Add(ma.MarketValue)
	switch {
	case open == 0:
		t.MarketValueReason = strp("no_open_holdings")
		t.TotalPnL = moneyP(realized.Add(idcw))
	case eqMiss == "" && mfMiss == "":
		t.MarketValue = moneyP(mv)
		t.Unrealized = moneyP(mv.Sub(invested))
		if invested.IsPositive() {
			t.UnrealizedPct = pct(mv.Sub(invested).Div(invested).Mul(hundred))
		}
		t.TotalPnL = moneyP(mv.Sub(invested).Add(realized).Add(idcw))
	default:
		t.MarketValueReason = joinReasons(eqMiss, mfMiss)
		t.TotalPnLReason = t.MarketValueReason
	}
	if open > 0 {
		if len(ea.NoDay) == 0 && (ma.Open == 0 || mf.Totals.DayChange != nil) {
			dc := ea.DayChange.Add(ma.DayChange)
			t.DayChange = moneyP(dc)
		} else {
			var names []string
			names = append(names, ea.NoDay...)
			if mf.Totals.DayChangeReason != nil {
				names = append(names, strings.TrimPrefix(*mf.Totals.DayChangeReason, "unavailable for "))
			}
			t.DayChangeReason = strp("unavailable for " + strings.Join(names, ", "))
		}
	}
	vs.Totals = t

	// Pooled returns: one equation over both classes' flows (never an average, docs/05 8.5.4).
	flows := append(append([]mfhold.Flow{}, ea.Flows...), mf.Flows...)
	mfhold.SortFlows(flows)
	rin := mfhold.ReturnsIn{AsOf: asOf, Flows: flows, HasOpen: open > 0, PurchaseCash: ea.Outflow.Add(ma.PurchaseCash),
		Proceeds: ea.Inflow.Add(ma.Proceeds), IDCWCash: ma.IDCWCash,
		Basis: "(market value + money received + IDCW cash - money invested) / money invested; simple, not annualised"}
	switch {
	case eqMiss != "":
		rin.MissingReason = ReasonMissingPrice
	case mfMiss != "":
		rin.MissingReason = mfhold.ReasonMissingNAV
	default:
		rin.Terminal = &mv
	}
	vs.Returns = mfReturns(mfhold.ComputeReturns(rin))

	// Breakdown: each class uses only its own flows.
	eqRet := returnsFor(asOf, ea.Flows, ea.Open > 0, eq.Returns)
	eqRow := Breakdown{AssetClass: "equity", Invested: money(ea.Invested), MarketValue: eq.Totals.MarketValue, MarketValueReason: eq.Totals.MarketValueReason,
		Unrealized: eq.Totals.Unrealized, Realized: money(ea.Realized), XIRRPct: eqRet.XIRRPct, XIRRReason: eqRet.XIRRReason,
		AbsolutePct: eqRet.AbsolutePct, AsOf: asOfS, Stale: eq.Stale}
	et := equityTotals(eq)
	eqRow.TotalPnL = et.TotalPnL
	mfRow := Breakdown{AssetClass: "mf", Invested: mf.Totals.Invested, MarketValue: mf.Totals.MarketValue, MarketValueReason: mf.Totals.MarketValueReason,
		Unrealized: mf.Totals.Unrealized, Realized: mf.Totals.Realized, IDCWIncome: strp(mf.Totals.IDCWIncome), TotalPnL: mf.Totals.TotalPnL,
		XIRRPct: mf.Returns.XIRRPct, XIRRReason: mf.Returns.XIRRReason, AbsolutePct: mf.Returns.AbsPct, AsOf: asOfS, Stale: mf.Stale}
	if eq.agg.Open > 0 || len(ea.Flows) > 0 {
		vs.Breakdown = append(vs.Breakdown, eqRow)
	}
	if mf.Present {
		vs.Breakdown = append(vs.Breakdown, mfRow)
	}

	// Weights and allocation by class, over priced holdings only.
	pricedTotal := ea.MarketValue.Add(ma.MarketValue)
	if pricedTotal.IsPositive() {
		for i := range vs.Holdings {
			h := &vs.Holdings[i]
			if h.MarketValue == nil {
				continue
			}
			v, _ := decimal.NewFromString(*h.MarketValue)
			h.WeightPct = pct(v.Div(pricedTotal).Mul(hundred))
		}
		for i := range vs.MFHoldings {
			h := &vs.MFHoldings[i]
			if h.MV == nil {
				continue
			}
			h.WeightPct = pct(h.MV.Div(pricedTotal).Mul(hundred))
		}
		if ea.MarketValue.IsPositive() {
			vs.AllocAssetClass = append(vs.AllocAssetClass, Share{Key: "equity", WeightPct: *pct(ea.MarketValue.Div(pricedTotal).Mul(hundred))})
		}
		if ma.MarketValue.IsPositive() {
			vs.AllocAssetClass = append(vs.AllocAssetClass, Share{Key: "mf", WeightPct: *pct(ma.MarketValue.Div(pricedTotal).Mul(hundred))})
		}
		vs.AllocPartial = eqMiss != "" || mfMiss != ""
	}
	if mf.AllocPartial {
		vs.AllocPartial = true
	}
}
