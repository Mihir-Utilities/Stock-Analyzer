package portfolio

import (
	"sort"
	"strings"

	"github.com/shopspring/decimal"
)

// Reasons and labels of the portfolio risk blocks (docs/05 8.6).
const (
	ReasonNoOpenHoldings = "no_open_holdings"
	ReasonZeroValue      = "zero_value"
	ReasonNoNAV          = "no_nav"
	// GroupUnclassified is the visible slice of holdings without a sector or category (PRK-2).
	GroupUnclassified = "Unclassified"
	// GroupFunds is the single slice of all mutual funds in the All view (PRK-6).
	GroupFunds = "Mutual funds"

	kindSector       = "sector"
	kindCategory     = "category"
	kindFunds        = "mutual_funds"
	kindUnclassified = "unclassified"

	stressLabel = "What if this one holding fell and nothing else moved. Arithmetic on today's values, not a forecast."
)

// RiskHolding is one open holding reduced to what concentration and stress need. Value is nil when
// the holding has no price or NAV.
type RiskHolding struct {
	Key        string
	Name       string
	AssetClass string // equity | mf
	Group      string
	GroupKind  string
	Value      *decimal.Decimal
}

// HoldingWeight is one row of concentration.by_holding.
type HoldingWeight struct {
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	AssetClass   string   `json:"asset_class"`
	Group        string   `json:"group"`
	Value        *string  `json:"value"`
	WeightPct    *float64 `json:"weight_pct"`
	WeightReason *string  `json:"weight_reason"`
}

// GroupWeight is one row of concentration.by_group.
type GroupWeight struct {
	Key       string   `json:"key"`
	Kind      string   `json:"kind"`
	Value     *string  `json:"value"`
	WeightPct *float64 `json:"weight_pct"`
	Holdings  int      `json:"holdings"`
}

// Concentration is the concentration block (docs/05 8.6.1).
type Concentration struct {
	TotalValue       *string         `json:"total_value"`
	TotalValueReason *string         `json:"total_value_reason"`
	HoldingsCount    int             `json:"holdings_count"`
	Top1Pct          *float64        `json:"top1_pct"`
	Top3Pct          *float64        `json:"top3_pct"`
	Top5Pct          *float64        `json:"top5_pct"`
	SharesReason     *string         `json:"shares_reason"`
	HHI              *float64        `json:"hhi"`
	EffectiveCount   *float64        `json:"effective_holdings"`
	HHIReason        *string         `json:"hhi_reason"`
	GroupHHI         *float64        `json:"group_hhi"`
	GroupTop1Pct     *float64        `json:"group_top1_pct"`
	GroupReason      *string         `json:"group_reason"`
	ByHolding        []HoldingWeight `json:"by_holding"`
	ByGroup          []GroupWeight   `json:"by_group"`
}

// StressItem is one row of stress.items.
type StressItem struct {
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	AssetClass   string   `json:"asset_class"`
	Value        *string  `json:"value"`
	Impact10     *string  `json:"impact_10"`
	Impact10Pct  *float64 `json:"impact_10_pct"`
	Impact20     *string  `json:"impact_20"`
	Impact20Pct  *float64 `json:"impact_20_pct"`
	ImpactReason *string  `json:"impact_reason"`
}

// Stress is the position stress block (docs/05 8.6.2): arithmetic, not a forecast.
type Stress struct {
	Label    string       `json:"label"`
	FallsPct []int        `json:"falls_pct"`
	Items    []StressItem `json:"items"`
}

const ratioPrecision = 16

func sortHoldings(hs []RiskHolding) []RiskHolding {
	out := append([]RiskHolding(nil), hs...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Value == nil) != (b.Value == nil) {
			return a.Value != nil // unpriced last
		}
		if a.Value != nil && !a.Value.Equal(*b.Value) {
			return a.Value.GreaterThan(*b.Value)
		}
		return a.Key < b.Key
	})
	return out
}

// unpricedReason names the holdings without a value the way the summary does.
func unpricedReason(hs []RiskHolding) string {
	var stocks, funds []string
	for _, h := range hs {
		if h.Value != nil {
			continue
		}
		if h.AssetClass == "mf" {
			funds = append(funds, h.Name)
		} else {
			stocks = append(stocks, h.Key)
		}
	}
	var parts []string
	if len(stocks) > 0 {
		parts = append(parts, ReasonMissingPrice+": "+strings.Join(stocks, ", "))
	}
	if len(funds) > 0 {
		parts = append(parts, "missing_nav: "+strings.Join(funds, ", "))
	}
	return strings.Join(parts, "; ")
}

// topShare is the sum of the n largest weights (all of them when there are fewer), in percent.
func topShare(ws []decimal.Decimal, n int) *float64 {
	sum := decimal.Zero
	for i := 0; i < n && i < len(ws); i++ {
		sum = sum.Add(ws[i])
	}
	return pct(sum.Mul(decimal.NewFromInt(100)))
}

func hhiOf(ws []decimal.Decimal) decimal.Decimal {
	h := decimal.Zero
	for _, w := range ws {
		h = h.Add(w.Mul(w))
	}
	return h
}

func round4p(d decimal.Decimal) *float64 { f, _ := d.Round(4).Float64(); return &f }

// BuildConcentration applies docs/05 8.6.1 and 8.6.2 to the open holdings of one view.
func BuildConcentration(in []RiskHolding) (Concentration, Stress) {
	hs := sortHoldings(in)
	c := Concentration{HoldingsCount: len(hs), ByHolding: []HoldingWeight{}, ByGroup: []GroupWeight{}}
	st := Stress{Label: stressLabel, FallsPct: []int{10, 20}, Items: []StressItem{}}
	reason := ""
	total := decimal.Zero
	switch {
	case len(hs) == 0:
		reason = ReasonNoOpenHoldings
	default:
		if r := unpricedReason(hs); r != "" {
			reason = r
		}
		for _, h := range hs {
			if h.Value != nil {
				total = total.Add(*h.Value)
			}
		}
		if reason == "" && !total.IsPositive() {
			reason = ReasonZeroValue
		}
	}
	var rp *string
	if reason != "" {
		rp = strp(reason)
		c.TotalValueReason, c.SharesReason, c.HHIReason, c.GroupReason = rp, rp, rp, rp
	} else {
		c.TotalValue = moneyP(total)
	}

	hundred := decimal.NewFromInt(100)
	ws := make([]decimal.Decimal, 0, len(hs))
	for _, h := range hs {
		row := HoldingWeight{Key: h.Key, Name: h.Name, AssetClass: h.AssetClass, Group: h.Group}
		if h.Value != nil {
			row.Value = moneyP(*h.Value)
		}
		if reason == "" {
			w := h.Value.DivRound(total, ratioPrecision)
			ws = append(ws, w)
			row.WeightPct = pct(w.Mul(hundred))
		} else {
			row.WeightReason = rp
		}
		c.ByHolding = append(c.ByHolding, row)
		st.Items = append(st.Items, stressRow(h, total, reason))
	}
	if reason == "" {
		c.Top1Pct, c.Top3Pct, c.Top5Pct = topShare(ws, 1), topShare(ws, 3), topShare(ws, 5)
		hhi := hhiOf(ws)
		c.HHI = round4p(hhi)
		c.EffectiveCount = pct(decimal.NewFromInt(1).DivRound(hhi, ratioPrecision))
	}
	c.ByGroup, c.GroupHHI, c.GroupTop1Pct = buildGroups(hs, total, reason == "")
	return c, st
}

func stressRow(h RiskHolding, total decimal.Decimal, totalReason string) StressItem {
	it := StressItem{Key: h.Key, Name: h.Name, AssetClass: h.AssetClass}
	if h.Value == nil {
		r := ReasonNoPrice
		if h.AssetClass == "mf" {
			r = ReasonNoNAV
		}
		it.ImpactReason = strp(r)
		return it
	}
	it.Value = moneyP(*h.Value)
	i10 := h.Value.Mul(decimal.NewFromInt(10)).Div(decimal.NewFromInt(100)).Neg()
	i20 := h.Value.Mul(decimal.NewFromInt(20)).Div(decimal.NewFromInt(100)).Neg()
	it.Impact10, it.Impact20 = moneyP(i10), moneyP(i20)
	if totalReason != "" {
		it.ImpactReason = strp(totalReason)
		return it
	}
	hundred := decimal.NewFromInt(100)
	it.Impact10Pct = pct(i10.DivRound(total, ratioPrecision).Mul(hundred))
	it.Impact20Pct = pct(i20.DivRound(total, ratioPrecision).Mul(hundred))
	return it
}

func buildGroups(hs []RiskHolding, total decimal.Decimal, priced bool) ([]GroupWeight, *float64, *float64) {
	type agg struct {
		kind     string
		sum      decimal.Decimal
		holdings int
		unpriced bool
	}
	by := map[string]*agg{}
	var keys []string
	for _, h := range hs {
		a := by[h.Group]
		if a == nil {
			a = &agg{kind: h.GroupKind}
			by[h.Group] = a
			keys = append(keys, h.Group)
		}
		a.holdings++
		if h.Value == nil {
			a.unpriced = true
		} else {
			a.sum = a.sum.Add(*h.Value)
		}
	}
	sort.SliceStable(keys, func(i, j int) bool {
		a, b := by[keys[i]], by[keys[j]]
		if a.unpriced != b.unpriced {
			return !a.unpriced
		}
		if !a.sum.Equal(b.sum) {
			return a.sum.GreaterThan(b.sum)
		}
		return keys[i] < keys[j]
	})
	out := make([]GroupWeight, 0, len(keys))
	var ws []decimal.Decimal
	hundred := decimal.NewFromInt(100)
	for _, k := range keys {
		a := by[k]
		g := GroupWeight{Key: k, Kind: a.kind, Holdings: a.holdings}
		if !a.unpriced { // a group that holds an unpriced holding has no value: never a partial sum
			g.Value = moneyP(a.sum)
		}
		if priced {
			w := a.sum.DivRound(total, ratioPrecision)
			ws = append(ws, w)
			g.WeightPct = pct(w.Mul(hundred))
		}
		out = append(out, g)
	}
	if !priced || len(ws) == 0 {
		return out, nil, nil
	}
	return out, round4p(hhiOf(ws)), topShare(ws, 1)
}
