package mfhold

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

// Staleness limits (docs/05 8.5.3, 8.5.7).
const (
	StaleDays  = 4  // a NAV more than this many calendar days before as_of is stale
	MergedDays = 10 // inactive scheme or a NAV older than this: SCHEME_MAY_BE_MERGED
)

// Warn is a response-level warning.
type Warn struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Scheme is the mf_scheme data a holding needs.
type Scheme struct {
	Code       int32
	Name       string
	FundHouse  *string
	Category   *string
	ISINGrowth *string
	ISINReinv  *string
	Plan       string // direct | regular | unknown
	Option     string // growth | idcw | unknown
	Status     string
	FirstNAV   *time.Time
}

// NAV is one stored net asset value (INR per unit).
type NAV struct {
	Date  time.Time
	Value decimal.Decimal
}

// SchemeNAV is the latest NAV on or before as_of and the one before it.
type SchemeNAV struct {
	Latest *NAV
	Prev   *NAV
}

// Input is everything the holdings of one as-of date need.
type Input struct {
	AsOf          time.Time
	Schemes       map[int32]Scheme
	NAVs          map[int32]SchemeNAV
	Txns          []Txn
	IncludeExited bool
	GroupFolio    bool
}

// Holding is one row of GET /portfolio/mf/holdings (one scheme, folios summed, or one folio).
type Holding struct {
	AssetClass    string   `json:"asset_class"`
	SchemeCode    int32    `json:"scheme_code"`
	SchemeName    string   `json:"scheme_name"`
	FundHouse     *string  `json:"fund_house"`
	Category      *string  `json:"category"`
	Plan          string   `json:"plan"`
	Option        string   `json:"option"`
	ISIN          *string  `json:"isin"`
	Folio         *string  `json:"folio,omitempty"`
	Folios        []string `json:"folios,omitempty"`
	Units         string   `json:"units"`
	AvgCost       *string  `json:"avg_cost"`
	Invested      string   `json:"invested"`
	NAV           *string  `json:"nav"`
	NAVDate       *string  `json:"nav_date"`
	NAVStale      bool     `json:"nav_stale"`
	NAVReason     *string  `json:"nav_reason"`
	MarketValue   *string  `json:"market_value"`
	Unrealized    *string  `json:"unrealized_pnl"`
	UnrealizedPct *float64 `json:"unrealized_pct"`
	// UnrealizedPctReason is "n/m" when the percentage is not meaningful (nothing invested), B15 review N3.
	UnrealizedPctReason *string  `json:"unrealized_pct_reason"`
	Realized            string   `json:"realized_pnl"`
	IDCWIncome          string   `json:"idcw_income"`
	DayChange           *string  `json:"day_change"`
	DayChangeReason     *string  `json:"day_change_reason"`
	WeightPct           *float64 `json:"weight_pct"`
	XIRRPct             *float64 `json:"xirr_pct"`
	XIRRReason          *string  `json:"xirr_reason"`
	AbsolutePct         *float64 `json:"absolute_return_pct"`
	FirstTxnDate        *string  `json:"first_txn_date"`
	SpanDays            *int     `json:"span_days"`
	Exited              bool     `json:"exited"`
	Flags               []string `json:"flags"`
	Source              string   `json:"source"`

	MV *decimal.Decimal `json:"-"`
}

// Totals are the MF sleeve totals (money strings with 4 decimals, INR).
type Totals struct {
	Invested          string   `json:"invested"`
	MarketValue       *string  `json:"market_value"`
	MarketValueReason *string  `json:"market_value_reason"`
	Unrealized        *string  `json:"unrealized_pnl"`
	UnrealizedPct     *float64 `json:"unrealized_pct"`
	// UnrealizedPctReason is "n/m" when the percentage is not meaningful (nothing invested), B15 review N3.
	UnrealizedPctReason *string `json:"unrealized_pct_reason"`
	Realized            string  `json:"realized_pnl"`
	IDCWIncome          string  `json:"idcw_income"`
	TotalPnL            *string `json:"total_pnl"`
	TotalPnLReason      *string `json:"total_pnl_reason"`
	PurchaseCash        string  `json:"purchase_cash"`
	DayChange           *string `json:"day_change"`
	DayChangeReason     *string `json:"day_change_reason"`
}

// Share is an allocation slice.
type Share struct {
	Key       string  `json:"key"`
	WeightPct float64 `json:"weight_pct"`
}

// Agg holds the decimal aggregates the view combiner needs.
type Agg struct {
	Invested     decimal.Decimal // cost of units still held
	Realized     decimal.Decimal
	IDCWIncome   decimal.Decimal
	IDCWCash     decimal.Decimal
	PurchaseCash decimal.Decimal
	Proceeds     decimal.Decimal
	MarketValue  decimal.Decimal // sum over priced open holdings
	DayChange    decimal.Decimal
	Open         int
	Unpriced     []string
}

// Result is the MF sleeve at one as-of date.
type Result struct {
	Items         []Holding
	Totals        Totals
	Returns       Returns
	AllocScheme   []Share
	AllocCategory []Share
	AllocPartial  bool
	Warnings      []Warn
	Stale         bool
	StaleAgeDays  int
	Present       bool // any transaction on or before as_of (a holding or an exited one)
	Flows         []Flow
	Terminal      *decimal.Decimal
	MissingReason string
	Agg           Agg
}

const sourceLabel = "your statement; NAV: AMFI via mfapi.in"
const returnsBasis = "(market value + redemption proceeds + IDCW cash - purchase cash) / purchase cash; simple, not annualised"

func money(d decimal.Decimal) string { return d.StringFixed(4) }

func moneyP(d decimal.Decimal) *string { s := money(d); return &s }

func strp(s string) *string { return &s }

func pct(d decimal.Decimal) *float64 { f, _ := d.Round(2).Float64(); return &f }

func ymd(t time.Time) string { return t.Format(time.DateOnly) }

func ageDays(asOf, d time.Time) int { return int(asOf.Sub(d).Hours() / 24) }

type unit struct {
	key   Key // Folio "" for scheme-level units
	txns  []Txn
	folio []string
}

// Build computes the holdings of the sleeve (docs/05 8.5.2, 8.5.3).
func Build(in Input) Result {
	res := Result{Items: []Holding{}, AllocScheme: []Share{}, AllocCategory: []Share{}}
	var visible []Txn
	for _, t := range in.Txns {
		if !t.Date.After(in.AsOf) {
			visible = append(visible, t)
		}
	}
	res.Present = len(visible) > 0
	// Units of work: per scheme (folios summed) or per (scheme, folio).
	byUnit := map[Key]*unit{}
	for k, ts := range Group(visible) {
		uk := Key{Scheme: k.Scheme}
		if in.GroupFolio {
			uk = k
		}
		u := byUnit[uk]
		if u == nil {
			u = &unit{key: uk}
			byUnit[uk] = u
		}
		u.txns = append(u.txns, ts...)
		u.folio = append(u.folio, k.Folio)
	}
	keys := make([]Key, 0, len(byUnit))
	for k := range byUnit {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := in.Schemes[keys[i].Scheme].Name, in.Schemes[keys[j].Scheme].Name
		if a != b {
			return a < b
		}
		if keys[i].Scheme != keys[j].Scheme {
			return keys[i].Scheme < keys[j].Scheme
		}
		return keys[i].Folio < keys[j].Folio
	})

	var dayMissing []string
	warned := map[string]bool{}
	warn := func(code, msg string) {
		if !warned[code+msg] {
			warned[code+msg] = true
			res.Warnings = append(res.Warnings, Warn{code, msg})
		}
	}
	var staleAge int
	for _, uk := range keys {
		u := byUnit[uk]
		sch := in.Schemes[uk.Scheme]
		name := sch.Name
		if name == "" {
			name = fmt.Sprintf("scheme %d", uk.Scheme)
		}
		// Replay each (scheme, folio) ledger; folios of one unit are merged afterwards.
		var pos Position
		bad := false
		perFolio := Group(u.txns)
		fkeys := make([]Key, 0, len(perFolio))
		for k := range perFolio {
			fkeys = append(fkeys, k)
		}
		sort.Slice(fkeys, func(i, j int) bool { return fkeys[i].Folio < fkeys[j].Folio })
		for _, k := range fkeys {
			p, err := Replay(perFolio[k], in.AsOf)
			if err != nil {
				warn("HOLDINGS_INCONSISTENT", fmt.Sprintf("%s: stored transactions no longer pass the holdings check (%s); excluded from totals", name, err.Error()))
				bad = true
				break
			}
			pos.merge(p)
		}
		if bad {
			continue
		}
		// Per-unit cash aggregates.
		purchaseCash, idcwCash := decimal.Zero, decimal.Zero
		hasIDCW := false
		first := u.txns[0].Date
		for _, t := range u.txns {
			if t.Date.Before(first) {
				first = t.Date
			}
			if t.IsPurchase() {
				purchaseCash = purchaseCash.Add(t.Cost())
			}
			if t.Type == TypeIDCWPayout {
				idcwCash = idcwCash.Add(t.Amount)
			}
			if t.Type == TypeIDCWPayout || t.Type == TypeIDCWReinvest {
				hasIDCW = true
			}
		}
		proceeds := decimal.Zero
		for _, s := range pos.Sales {
			proceeds = proceeds.Add(s.Proceeds)
		}
		units, cost := pos.Units(), pos.Cost()
		h := Holding{AssetClass: "mf", SchemeCode: uk.Scheme, SchemeName: name, FundHouse: sch.FundHouse, Category: sch.Category,
			Plan: orUnknown(sch.Plan), Option: orUnknown(sch.Option), ISIN: pickISIN(sch),
			Units: units.StringFixed(4), Invested: money(cost), Realized: money(pos.Realized()), IDCWIncome: money(pos.IDCWIncome()),
			Flags: []string{}, Source: sourceLabel, Exited: !units.IsPositive()}
		if in.GroupFolio {
			f := uk.Folio
			h.Folio = &f
		} else {
			fs := append([]string(nil), u.folio...)
			sort.Strings(fs)
			h.Folios = fs
		}
		fd := ymd(first)
		h.FirstTxnDate = &fd
		if sch.Status == "inactive" {
			h.Flags = append(h.Flags, "inactive")
		}
		if sch.Option == "idcw" {
			h.Flags = append(h.Flags, "idcw")
			if !hasIDCW {
				warn("IDCW_PAYOUTS_NOT_RECORDED", fmt.Sprintf("%s: returns exclude payouts you have not entered", name))
			}
		}
		if sch.FirstNAV != nil && sch.FirstNAV.After(first) {
			warn("NAV_FEED_STARTS_AFTER_TXN", fmt.Sprintf("%s: NAV data starts on %s, after your first transaction on %s", name, ymd(*sch.FirstNAV), fd))
		}
		// Aggregates over the sleeve.
		res.Agg.Realized = res.Agg.Realized.Add(pos.Realized())
		res.Agg.IDCWIncome = res.Agg.IDCWIncome.Add(pos.IDCWIncome())
		res.Agg.IDCWCash = res.Agg.IDCWCash.Add(idcwCash)
		res.Agg.PurchaseCash = res.Agg.PurchaseCash.Add(purchaseCash)
		res.Agg.Proceeds = res.Agg.Proceeds.Add(proceeds)
		holdFlows := Flows(u.txns, in.AsOf)
		res.Flows = append(res.Flows, holdFlows...)

		rin := ReturnsIn{AsOf: in.AsOf, Flows: holdFlows, HasOpen: !h.Exited, PurchaseCash: purchaseCash, Proceeds: proceeds,
			IDCWCash: idcwCash, Basis: returnsBasis}
		if !h.Exited {
			res.Agg.Open++
			res.Agg.Invested = res.Agg.Invested.Add(cost)
			h.AvgCost = moneyP(cost.DivRound(units, 8))
			fillNAV(&h, sch, in.NAVs[uk.Scheme], units, cost, in.AsOf)
			if h.MarketValue == nil {
				res.Agg.Unpriced = append(res.Agg.Unpriced, name)
				rin.MissingReason = ReasonNoNAV
			} else {
				mv := *h.MV
				res.Agg.MarketValue = res.Agg.MarketValue.Add(mv)
				rin.Terminal = &mv
				if h.NAVStale {
					res.Stale = true
					if n := in.NAVs[uk.Scheme].Latest; n != nil && ageDays(in.AsOf, n.Date) > staleAge {
						staleAge = ageDays(in.AsOf, n.Date)
					}
				}
				if n := in.NAVs[uk.Scheme].Latest; n != nil && (sch.Status == "inactive" || ageDays(in.AsOf, n.Date) > MergedDays) {
					h.Flags = append(h.Flags, "merged_suspected")
					warn("SCHEME_MAY_BE_MERGED", fmt.Sprintf("%s: the NAV is from %s or the scheme is inactive; it may have merged or closed; valued at the last NAV", name, ymd(n.Date)))
				}
				if h.NAVStale {
					warn("NAV_STALE", fmt.Sprintf("%s: NAV is from %s, more than %d days before %s", name, *h.NAVDate, StaleDays, ymd(in.AsOf)))
				}
			}
			if h.DayChange != nil {
				dc, _ := decimal.NewFromString(*h.DayChange)
				res.Agg.DayChange = res.Agg.DayChange.Add(dc)
			} else {
				dayMissing = append(dayMissing, name)
			}
		}
		ret := ComputeReturns(rin)
		h.XIRRPct, h.XIRRReason, h.AbsolutePct, h.SpanDays = ret.XIRRPct, ret.XIRRReason, ret.AbsPct, ret.SpanDays
		if h.Exited && !in.IncludeExited {
			continue
		}
		res.Items = append(res.Items, h)
	}
	res.StaleAgeDays = staleAge
	res.totals(dayMissing, in)
	return res
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

func pickISIN(s Scheme) *string {
	if s.Option == "idcw" && s.ISINReinv != nil {
		return s.ISINReinv
	}
	if s.ISINGrowth != nil {
		return s.ISINGrowth
	}
	return s.ISINReinv
}

// fillNAV sets NAV, value, unrealised and day change on an open holding.
func fillNAV(h *Holding, sch Scheme, n SchemeNAV, units, cost decimal.Decimal, asOf time.Time) {
	if n.Latest == nil {
		h.NAVReason = strp(ReasonNoNAV)
		h.DayChangeReason = strp(ReasonNoNAV)
		return
	}
	h.NAV, h.NAVDate = moneyP(n.Latest.Value), strp(ymd(n.Latest.Date))
	h.NAVStale = ageDays(asOf, n.Latest.Date) > StaleDays
	mv := units.Mul(n.Latest.Value)
	h.MV = &mv
	h.MarketValue = moneyP(mv)
	h.Unrealized = moneyP(mv.Sub(cost))
	if cost.IsPositive() {
		h.UnrealizedPct = pct(mv.Sub(cost).Div(cost).Mul(decimal.NewFromInt(100)))
	} else {
		h.UnrealizedPctReason = strp(ReasonNotMeaningful)
	}
	switch {
	case h.NAVStale:
		h.DayChangeReason = strp("nav_stale")
	case n.Prev == nil:
		h.DayChangeReason = strp("no_previous_nav")
	default:
		h.DayChange = moneyP(units.Mul(n.Latest.Value.Sub(n.Prev.Value)))
	}
}

func (r *Result) totals(dayMissing []string, in Input) {
	a := r.Agg
	t := Totals{Invested: money(a.Invested), Realized: money(a.Realized), IDCWIncome: money(a.IDCWIncome), PurchaseCash: money(a.PurchaseCash)}
	allPriced := len(a.Unpriced) == 0
	switch {
	case a.Open == 0:
		t.MarketValueReason = strp("no_open_holdings")
		t.TotalPnL = moneyP(a.Realized.Add(a.IDCWIncome))
	case allPriced:
		t.MarketValue = moneyP(a.MarketValue)
		t.Unrealized = moneyP(a.MarketValue.Sub(a.Invested))
		if a.Invested.IsPositive() {
			t.UnrealizedPct = pct(a.MarketValue.Sub(a.Invested).Div(a.Invested).Mul(decimal.NewFromInt(100)))
		} else {
			t.UnrealizedPctReason = strp(ReasonNotMeaningful)
		}
		t.TotalPnL = moneyP(a.MarketValue.Sub(a.Invested).Add(a.Realized).Add(a.IDCWIncome))
	default:
		reason := ReasonMissingNAV + ": " + strings.Join(a.Unpriced, ", ")
		t.MarketValueReason, t.TotalPnLReason = strp(reason), strp(reason)
	}
	if a.Open > 0 {
		if len(dayMissing) == 0 {
			t.DayChange = moneyP(a.DayChange)
		} else {
			t.DayChangeReason = strp("unavailable for " + strings.Join(dayMissing, ", "))
		}
	}
	r.Totals = t
	// Returns of the sleeve.
	rin := ReturnsIn{AsOf: in.AsOf, Flows: r.Flows, HasOpen: a.Open > 0, PurchaseCash: a.PurchaseCash, Proceeds: a.Proceeds,
		IDCWCash: a.IDCWCash, Basis: returnsBasis}
	if a.Open > 0 {
		if allPriced {
			mv := a.MarketValue
			rin.Terminal = &mv
			r.Terminal = &mv
		} else {
			rin.MissingReason = ReasonMissingNAV
			r.MissingReason = ReasonMissingNAV
		}
	}
	r.Returns = ComputeReturns(rin)
	if len(a.Unpriced) > 0 {
		r.Warnings = append(r.Warnings, Warn{"MISSING_NAV", "No NAV on or before the valuation date for " + strings.Join(a.Unpriced, ", ") + "; totals that need it are unavailable"})
	}
	// Weights and allocation over priced holdings.
	if a.MarketValue.IsPositive() {
		byCat := map[string]decimal.Decimal{}
		for i := range r.Items {
			h := &r.Items[i]
			if h.MV == nil {
				continue
			}
			w := h.MV.Div(a.MarketValue).Mul(decimal.NewFromInt(100))
			h.WeightPct = pct(w)
		}
		bySch := map[string]decimal.Decimal{}
		for i := range r.Items {
			h := &r.Items[i]
			if h.MV == nil {
				continue
			}
			w := h.MV.Div(a.MarketValue).Mul(decimal.NewFromInt(100))
			bySch[h.SchemeName] = bySch[h.SchemeName].Add(w)
			c := "Unclassified"
			if h.Category != nil && *h.Category != "" {
				c = *h.Category
			}
			byCat[c] = byCat[c].Add(w)
		}
		r.AllocScheme, r.AllocCategory = shares(bySch), shares(byCat)
		r.AllocPartial = !allPriced
	}
}

func shares(m map[string]decimal.Decimal) []Share {
	out := make([]Share, 0, len(m))
	for k, v := range m {
		out = append(out, Share{Key: k, WeightPct: *pct(v)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].WeightPct != out[j].WeightPct {
			return out[i].WeightPct > out[j].WeightPct
		}
		return out[i].Key < out[j].Key
	})
	return out
}
