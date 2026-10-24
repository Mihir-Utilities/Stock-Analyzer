package portfolio

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/finmath"
)

// Reasons for a null value (docs/03 section 1: never 0 for unknown).
const (
	ReasonNoPrice       = "no_price"
	ReasonMissingPrice  = "missing_price"
	ReasonNoPrevClose   = "no_previous_close"
	ReasonActionInRange = "corporate_action_in_window"
	ReasonNoTxns        = "no_transactions"
	ReasonShortPeriod   = "period_too_short"
	ReasonNoSignChange  = "no_sign_change"
	ReasonNoFlows       = "insufficient_flows"
	ReasonNoBenchmark   = "benchmark_unavailable"
	ReasonBenchLate     = "benchmark_series_starts_after_first_transaction"
	ReasonBenchOversold = "benchmark_units_negative"
	ReasonNoOutflow     = "no_outflow"
)

// minXIRRDays: below this span only the absolute return is shown (docs/05 section 8.3).
const minXIRRDays = 30

// Price is the latest valid bar on or before the as-of date and the bar before it.
type Price struct {
	Date        time.Time
	Close       decimal.Decimal
	PrevDate    *time.Time
	PrevClose   *decimal.Decimal
	SrcAdjusted bool
}

// SeriesPoint is one benchmark level.
type SeriesPoint struct {
	Date  time.Time
	Value float64
}

// InstrumentInput is everything the summary needs about one instrument the owner has traded.
type InstrumentInput struct {
	Symbol    string
	Name      string
	Sector    *string
	Status    string
	Txns      []Txn
	Actions   []CorporateAction
	Overrides []Override
	Price     *Price
}

// SummaryInput is the whole portfolio at one as-of date.
type SummaryInput struct {
	AsOf          time.Time
	Items         []InstrumentInput
	Bench         []SeriesPoint // ascending
	IncludeExited bool
	// Stale reports whether a bar date is stale at AsOf and its age in hours.
	Stale func(barDate time.Time) (bool, float64)
}

// Warn is a response-level warning.
type Warn struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Applied is one adjustment shown on a holding.
type Applied struct {
	Date       string `json:"date"`
	Type       string `json:"type"`
	Multiplier string `json:"multiplier"`
	Source     string `json:"source"`
}

// ReviewItem is a confirmed action that is never auto-applied.
type ReviewItem struct {
	Date string `json:"date"`
	Type string `json:"type"`
	Note string `json:"note"`
}

// Holding is one row of the summary.
type Holding struct {
	Symbol             string       `json:"symbol"`
	Name               string       `json:"name"`
	Sector             *string      `json:"sector"`
	Status             string       `json:"status"`
	Flags              []string     `json:"flags"`
	Qty                string       `json:"qty"`
	AvgCost            *string      `json:"avg_cost"`
	Invested           string       `json:"invested"`
	LTP                *string      `json:"ltp"`
	LTPReason          *string      `json:"ltp_reason"`
	LTPAsOf            *string      `json:"ltp_as_of"`
	PriceStale         bool         `json:"price_stale"`
	MarketValue        *string      `json:"market_value"`
	Unrealized         *string      `json:"unrealized_pnl"`
	UnrealizedPct      *float64     `json:"unrealized_pct"`
	DayChange          *string      `json:"day_change"`
	DayChangeReason    *string      `json:"day_change_reason"`
	WeightPct          *float64     `json:"weight_pct"`
	Realized           string       `json:"realized_pnl"`
	Exited             bool         `json:"exited"`
	AdjustmentsApplied []Applied    `json:"adjustments_applied"`
	ReviewNeeded       []ReviewItem `json:"review_needed"`
}

// Totals are portfolio-wide money fields (all strings with 4 decimals, INR).
type Totals struct {
	Invested          string   `json:"invested"`
	MarketValue       *string  `json:"market_value"`
	MarketValueReason *string  `json:"market_value_reason"`
	Unrealized        *string  `json:"unrealized_pnl"`
	UnrealizedPct     *float64 `json:"unrealized_pct"`
	Realized          string   `json:"realized_pnl"`
	DayChange         *string  `json:"day_change"`
	DayChangeReason   *string  `json:"day_change_reason"`
}

// Returns holds XIRR and the absolute return, both percent numbers.
type Returns struct {
	XIRRPct       *float64 `json:"xirr_pct"`
	XIRRReason    *string  `json:"xirr_reason"`
	AbsolutePct   *float64 `json:"absolute_return_pct"`
	AbsoluteBasis string   `json:"absolute_return_basis"`
}

// Benchmark is the same cash flows invested in NIFTY50 (price index, dividends excluded).
type Benchmark struct {
	Code       string   `json:"code"`
	XIRRPct    *float64 `json:"xirr_pct"`
	Reason     *string  `json:"reason"`
	LevelAsOf  *string  `json:"level_as_of"`
	Disclaimer string   `json:"note"`
}

// Share is an allocation slice (percent of priced market value).
type Share struct {
	Key       string  `json:"key"`
	WeightPct float64 `json:"weight_pct"`
}

// DividendItem is one estimated dividend.
type DividendItem struct {
	Symbol    string `json:"symbol"`
	ExDate    string `json:"ex_date"`
	Qty       string `json:"qty"`
	PerShare  string `json:"amount_per_share"`
	Amount    string `json:"amount"`
	RecordDay string `json:"qty_as_of"`
}

// Dividends is shown separately and is not part of XIRR or P&L.
type Dividends struct {
	Amount string         `json:"amount"`
	Label  string         `json:"label"`
	Items  []DividendItem `json:"items"`
}

// Summary is the data of GET /portfolio/summary.
type Summary struct {
	AsOf          string             `json:"as_of"`
	Currency      string             `json:"currency"`
	PnLBasis      map[string]any     `json:"pnl_basis"`
	Holdings      []Holding          `json:"holdings"`
	Totals        Totals             `json:"totals"`
	Returns       Returns            `json:"returns"`
	Benchmark     Benchmark          `json:"benchmark"`
	AllocStock    []Share            `json:"allocation_by_stock"`
	AllocSector   []Share            `json:"allocation_by_sector"`
	AllocPartial  bool               `json:"allocation_excludes_unpriced"`
	Dividends     Dividends          `json:"estimated_dividends"`
	Stale         bool               `json:"-"`
	StaleAgeHours float64            `json:"-"`
	Warnings      []Warn             `json:"-"`
	Flows         []finmath.CashFlow `json:"-"`
}

func money(d decimal.Decimal) string { return d.StringFixed(4) }

func moneyP(d decimal.Decimal) *string { s := money(d); return &s }

func strp(s string) *string { return &s }

func pct(d decimal.Decimal) *float64 { f, _ := d.Round(2).Float64(); return &f }

func ymd(t time.Time) string { return t.Format(time.DateOnly) }

// BuildSummary applies docs/05 section 8 to the portfolio at in.AsOf.
func BuildSummary(in SummaryInput) Summary {
	s := Summary{
		AsOf: ymd(in.AsOf), Currency: "INR",
		PnLBasis: map[string]any{
			"realized":   "FIFO lots, fees capitalised on buys and deducted from sell proceeds",
			"unrealized": "average cost of the open lots (quantity x LTP - remaining cost)",
		},
		Holdings: []Holding{}, AllocStock: []Share{}, AllocSector: []Share{},
		Dividends: Dividends{Label: "estimated, not included in XIRR/P&L", Items: []DividendItem{}},
	}
	items := append([]InstrumentInput(nil), in.Items...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Symbol < items[j].Symbol })

	invested, realized, mvSum, dayChange := decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero
	var unpriced, noDay []string
	var flows []finmath.CashFlow
	inflow, outflow := decimal.Zero, decimal.Zero
	var firstFlow time.Time
	divTotal := decimal.Zero
	openCount := 0

	for _, it := range items {
		if len(it.Txns) == 0 {
			continue
		}
		adjs := EffectiveAdjustments(it.Actions, it.Overrides)
		pos, err := Replay(it.Txns, adjs, in.AsOf)
		if err != nil {
			s.Warnings = append(s.Warnings, Warn{"HOLDINGS_INCONSISTENT",
				fmt.Sprintf("%s: stored transactions no longer pass the holdings check (%s); excluded from totals", it.Symbol, err.Error())})
			continue
		}
		if len(pos.Sales) == 0 && len(pos.Lots) == 0 {
			continue // only transactions after as_of
		}
		for _, t := range it.Txns {
			if t.Date.After(in.AsOf) {
				continue
			}
			amt := t.Qty.Mul(t.Price)
			if t.Side == "buy" {
				amt = amt.Add(t.Fees).Neg()
				outflow = outflow.Add(amt.Neg())
			} else {
				amt = amt.Sub(t.Fees)
				inflow = inflow.Add(amt)
			}
			f, _ := amt.Float64()
			flows = append(flows, finmath.CashFlow{Date: t.Date, Amount: f})
			if firstFlow.IsZero() || t.Date.Before(firstFlow) {
				firstFlow = t.Date
			}
		}
		h := Holding{Symbol: it.Symbol, Name: it.Name, Sector: it.Sector, Status: it.Status, Flags: []string{},
			Realized: money(pos.Realized()), AdjustmentsApplied: []Applied{}, ReviewNeeded: []ReviewItem{}}
		realized = realized.Add(pos.Realized())
		qty, cost := pos.Qty(), pos.Cost()
		h.Qty, h.Invested = qty.StringFixed(4), money(cost)
		h.Exited = !qty.IsPositive()
		if it.Status == "delisted" || it.Status == "suspended" {
			h.Flags = append(h.Flags, it.Status)
			s.Warnings = append(s.Warnings, Warn{"DELISTED_HOLDING", fmt.Sprintf("%s is %s; the holding is kept and valued at the last imported close", it.Symbol, it.Status)})
		}
		for _, a := range pos.Applied {
			h.AdjustmentsApplied = append(h.AdjustmentsApplied, Applied{Date: ymd(a.Date), Type: a.Type, Multiplier: a.Multiplier.String(), Source: a.Source})
		}
		first := it.Txns[0].Date
		for _, t := range it.Txns {
			if t.Date.Before(first) {
				first = t.Date
			}
		}
		h.ReviewNeeded, s.Warnings = reviewAndUnconfirmed(it, first, in.AsOf, s.Warnings)
		d, items2 := dividends(it, adjs, first, in.AsOf)
		divTotal = divTotal.Add(d)
		s.Dividends.Items = append(s.Dividends.Items, items2...)

		if h.Exited {
			if in.IncludeExited {
				s.Holdings = append(s.Holdings, h)
			}
			continue
		}
		openCount++
		invested = invested.Add(cost)
		avg := cost.DivRound(qty, 8)
		h.AvgCost = moneyP(avg)
		fillPrice(&h, it, adjs, qty, cost, in)
		if h.MarketValue == nil {
			unpriced = append(unpriced, it.Symbol)
		} else {
			mv, _ := decimal.NewFromString(*h.MarketValue)
			mvSum = mvSum.Add(mv)
			if h.PriceStale {
				s.Stale = true
				if _, age := in.Stale(it.Price.Date); age > s.StaleAgeHours {
					s.StaleAgeHours = age
				}
			}
		}
		if h.DayChange == nil {
			noDay = append(noDay, it.Symbol)
		} else {
			dc, _ := decimal.NewFromString(*h.DayChange)
			dayChange = dayChange.Add(dc)
		}
		s.Holdings = append(s.Holdings, h)
	}
	s.Dividends.Amount = money(divTotal)

	s.Totals = Totals{Invested: money(invested), Realized: money(realized)}
	allPriced := len(unpriced) == 0
	if openCount > 0 {
		if allPriced {
			s.Totals.MarketValue = moneyP(mvSum)
			s.Totals.Unrealized = moneyP(mvSum.Sub(invested))
			if invested.IsPositive() {
				s.Totals.UnrealizedPct = pct(mvSum.Sub(invested).Div(invested).Mul(decimal.NewFromInt(100)))
			}
		} else {
			s.Totals.MarketValueReason = strp(ReasonMissingPrice + ": " + strings.Join(unpriced, ", "))
			s.Warnings = append(s.Warnings, Warn{"MISSING_PRICE", "No imported price for " + strings.Join(unpriced, ", ") + "; totals that need it are unavailable"})
		}
		if len(noDay) == 0 {
			s.Totals.DayChange = moneyP(dayChange)
		} else {
			s.Totals.DayChangeReason = strp("unavailable for " + strings.Join(noDay, ", "))
		}
	} else {
		s.Totals.MarketValueReason = strp("no_open_holdings")
	}

	// Weights and allocation use priced holdings only.
	if mvSum.IsPositive() {
		sector := map[string]decimal.Decimal{}
		for i := range s.Holdings {
			h := &s.Holdings[i]
			if h.MarketValue == nil {
				continue
			}
			mv, _ := decimal.NewFromString(*h.MarketValue)
			w := mv.Div(mvSum).Mul(decimal.NewFromInt(100))
			h.WeightPct = pct(w)
			s.AllocStock = append(s.AllocStock, Share{Key: h.Symbol, WeightPct: *pct(w)})
			k := "Unclassified"
			if h.Sector != nil && *h.Sector != "" {
				k = *h.Sector
			}
			sector[k] = sector[k].Add(w)
		}
		keys := make([]string, 0, len(sector))
		for k := range sector {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			s.AllocSector = append(s.AllocSector, Share{Key: k, WeightPct: *pct(sector[k])})
		}
		sort.SliceStable(s.AllocStock, func(i, j int) bool { return s.AllocStock[i].WeightPct > s.AllocStock[j].WeightPct })
		s.AllocPartial = !allPriced
	}

	s.returns(in, flows, firstFlow, mvSum, allPriced, openCount, inflow, outflow)
	s.Flows = flows
	return s
}

// fillPrice sets LTP, value, unrealized and day change on an open holding.
func fillPrice(h *Holding, it InstrumentInput, adjs []Adj, qty, cost decimal.Decimal, in SummaryInput) {
	p := it.Price
	if p == nil {
		h.LTPReason = strp(ReasonNoPrice)
		return
	}
	ltp := p.Close
	if !p.SrcAdjusted { // the bar predates a later confirmed action: convert to current units
		for _, a := range adjs {
			if a.Date.After(p.Date) && !a.Date.After(in.AsOf) {
				ltp = ltp.DivRound(a.Multiplier, 8)
				h.Flags = append(h.Flags, "price_before_action")
			}
		}
	}
	h.LTP, h.LTPAsOf = moneyP(ltp), strp(ymd(p.Date))
	h.PriceStale, _ = in.Stale(p.Date)
	mv := qty.Mul(ltp)
	h.MarketValue = moneyP(mv)
	h.Unrealized = moneyP(mv.Sub(cost))
	if cost.IsPositive() {
		h.UnrealizedPct = pct(mv.Sub(cost).Div(cost).Mul(decimal.NewFromInt(100)))
	}
	switch {
	case p.PrevClose == nil || p.PrevDate == nil:
		h.DayChangeReason = strp(ReasonNoPrevClose)
	case !p.SrcAdjusted && actionBetween(adjs, *p.PrevDate, p.Date):
		h.DayChangeReason = strp(ReasonActionInRange)
	default:
		h.DayChange = moneyP(qty.Mul(ltp.Sub(*p.PrevClose)))
	}
}

func actionBetween(adjs []Adj, after, upTo time.Time) bool {
	for _, a := range adjs {
		if a.Date.After(after) && !a.Date.After(upTo) {
			return true
		}
	}
	return false
}

var autoTypes = map[string]bool{"split": true, "bonus": true}

// reviewAndUnconfirmed lists confirmed actions that are not auto-applied and warns on detected
// split-like candidates inside the holding period (docs/05 section 8.2).
func reviewAndUnconfirmed(it InstrumentInput, first, asOf time.Time, w []Warn) ([]ReviewItem, []Warn) {
	over := map[string]bool{}
	for _, o := range it.Overrides {
		over[ymd(o.Date)] = true
	}
	out := []ReviewItem{}
	for _, a := range it.Actions {
		if a.ExDate.Before(first) || a.ExDate.After(asOf) {
			continue
		}
		switch a.Status {
		case "confirmed":
			if a.Type == "dividend" || a.Type == "other" || over[ymd(a.ExDate)] {
				continue
			}
			if _, ok := a.Multiplier(); ok {
				continue
			}
			note := "not applied to quantities automatically; review needed"
			if autoTypes[a.Type] {
				note = "ratio missing or invalid; not applied; enter an adjustment override"
			}
			out = append(out, ReviewItem{Date: ymd(a.ExDate), Type: a.Type, Note: note})
			w = append(w, Warn{"REVIEW_NEEDED", fmt.Sprintf("%s %s on %s needs review; it is not applied automatically", it.Symbol, a.Type, ymd(a.ExDate))})
		case "detected":
			if a.Type == "split" || a.Type == "bonus" || a.Type == "split_or_bonus" {
				w = append(w, Warn{"UNCONFIRMED_ACTION", fmt.Sprintf("Possible split on %s for %s not yet confirmed", ymd(a.ExDate), it.Symbol)})
			}
		}
	}
	return out, w
}

// dividends is the estimated dividend income (docs/05 section 8.4): quantity held at the record date
// (the ex-date when no record date is stored) times the per-share amount, within the holding period.
func dividends(it InstrumentInput, adjs []Adj, first, asOf time.Time) (decimal.Decimal, []DividendItem) {
	total := decimal.Zero
	var out []DividendItem
	for _, a := range it.Actions {
		if a.Status != "confirmed" || a.Type != "dividend" || a.AmountPS == nil || !a.AmountPS.IsPositive() {
			continue
		}
		if a.ExDate.Before(first) || a.ExDate.After(asOf) {
			continue
		}
		at := a.ExDate
		if a.RecordDay != nil {
			at = *a.RecordDay
		}
		q := QtyAt(it.Txns, adjs, at)
		if !q.IsPositive() {
			continue
		}
		amt := q.Mul(*a.AmountPS)
		total = total.Add(amt)
		out = append(out, DividendItem{Symbol: it.Symbol, ExDate: ymd(a.ExDate), Qty: q.StringFixed(4),
			PerShare: money(*a.AmountPS), Amount: money(amt), RecordDay: ymd(at)})
	}
	return total, out
}

// returns fills XIRR, the absolute return and the benchmark (docs/05 sections 8.3, 8.4).
func (s *Summary) returns(in SummaryInput, flows []finmath.CashFlow, first time.Time, mv decimal.Decimal,
	allPriced bool, open int, inflow, outflow decimal.Decimal) {
	s.Returns.AbsoluteBasis = "(money received + current value) / money invested - 1"
	s.Benchmark = Benchmark{Code: "NIFTY50", Disclaimer: "Nifty 50 price index (dividends excluded) with the same dated cash flows"}
	reason := func(r string) { s.Returns.XIRRReason = strp(r) }
	if len(flows) == 0 {
		reason(ReasonNoTxns)
		s.Benchmark.Reason = strp(ReasonNoTxns)
		return
	}
	if open > 0 && !allPriced {
		reason(ReasonMissingPrice)
		s.Benchmark.Reason = strp(ReasonMissingPrice)
		return
	}
	if outflow.IsPositive() {
		total := inflow
		if open > 0 {
			total = total.Add(mv)
		}
		s.Returns.AbsolutePct = pct(total.Div(outflow).Sub(decimal.NewFromInt(1)).Mul(decimal.NewFromInt(100)))
	}
	all := append([]finmath.CashFlow(nil), flows...)
	if open > 0 {
		f, _ := mv.Float64()
		all = append(all, finmath.CashFlow{Date: in.AsOf, Amount: f})
	}
	if in.AsOf.Sub(first).Hours()/24 < minXIRRDays {
		reason(ReasonShortPeriod)
		s.Benchmark.Reason = strp(ReasonShortPeriod)
		return
	}
	r, err := finmath.XIRR(all)
	s.Returns.XIRRPct, s.Returns.XIRRReason = rate(r, err)
	s.benchmark(in, flows, open > 0)
}

func rate(r float64, err error) (*float64, *string) {
	switch {
	case err == nil:
		v := round4(r * 100)
		return &v, nil
	case errors.Is(err, finmath.ErrNoSignChange):
		return nil, strp(ReasonNoSignChange)
	default:
		return nil, strp(ReasonNoFlows)
	}
}

func round4(f float64) float64 { return decimal.NewFromFloat(f).Round(4).InexactFloat64() }

// level is the latest series value on or before d.
func level(series []SeriesPoint, d time.Time) (SeriesPoint, bool) {
	i := sort.Search(len(series), func(i int) bool { return series[i].Date.After(d) })
	if i == 0 {
		return SeriesPoint{}, false
	}
	return series[i-1], true
}

func (s *Summary) benchmark(in SummaryInput, flows []finmath.CashFlow, open bool) {
	if len(in.Bench) == 0 {
		s.Benchmark.Reason = strp(ReasonNoBenchmark)
		return
	}
	fs := append([]finmath.CashFlow(nil), flows...)
	sort.SliceStable(fs, func(i, j int) bool { return fs[i].Date.Before(fs[j].Date) })
	units := 0.0
	var bf []finmath.CashFlow
	for _, f := range fs {
		p, ok := level(in.Bench, f.Date)
		if !ok {
			s.Benchmark.Reason = strp(ReasonBenchLate)
			return
		}
		units -= f.Amount / p.Value // a buy (negative amount) buys units
		if units < -1e-9 {
			s.Benchmark.Reason = strp(ReasonBenchOversold)
			return
		}
		bf = append(bf, finmath.CashFlow{Date: f.Date, Amount: f.Amount})
	}
	if open {
		p, _ := level(in.Bench, in.AsOf)
		bf = append(bf, finmath.CashFlow{Date: in.AsOf, Amount: units * p.Value})
		s.Benchmark.LevelAsOf = strp(ymd(p.Date))
	}
	s.Benchmark.XIRRPct, s.Benchmark.Reason = rate(finmath.XIRR(bf))
}
