package portfolio

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/mfhold"
)

// Reasons and limits of the value history (docs/05 8.6.3).
const (
	ReasonNoTransactions = "no_transactions"
	ReasonNoPricedDates  = "no_priced_dates"
	ReasonTooFewPoints   = "too_few_points"
	ReasonNavGap         = "nav_gap"
	ReasonMissingNAV     = "missing_nav"

	maxGapRanges = 50
	navMaxAge    = mfhold.StaleDays
	indexBase    = 100
)

// Bar is one valid daily close of a stock. SrcAdj marks a close that is already in current units.
type Bar struct {
	Date   time.Time
	Close  decimal.Decimal
	SrcAdj bool
}

// HistStock is one traded stock with its ledger, effective adjustments and bars (ascending).
type HistStock struct {
	Symbol string
	Txns   []Txn
	Adjs   []Adj
	Bars   []Bar
}

// HistFund is one scheme with its transactions (any folio) and NAVs (ascending).
type HistFund struct {
	Code int32
	Name string
	Txns []mfhold.Txn
	NAVs []mfhold.NAV
}

// HistInput is everything the history of one view needs.
type HistInput struct {
	AsOf   time.Time
	Stocks []HistStock
	Funds  []HistFund
}

// HistPoint is one valid series date.
type HistPoint struct {
	Date        string  `json:"date"`
	Value       string  `json:"value"`
	Index       float64 `json:"index"`
	DrawdownPct float64 `json:"drawdown_pct"`
}

// HistGap is a range of series dates that could not be valued.
type HistGap struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Dates  int    `json:"dates"`
	Reason string `json:"reason"`
}

// MaxDrawdown is the deepest fall of the index.
type MaxDrawdown struct {
	DepthPct     float64 `json:"depth_pct"`
	PeakDate     *string `json:"peak_date"`
	TroughDate   *string `json:"trough_date"`
	RecoveryDate *string `json:"recovery_date"`
	Recovered    bool    `json:"recovered"`
}

// History is the value history block (docs/05 8.6.3).
type History struct {
	Basis          string       `json:"basis"`
	Base           int          `json:"base"`
	SeriesReason   *string      `json:"series_reason"`
	From           *string      `json:"from"`
	To             *string      `json:"to"`
	PointsCount    int          `json:"points_count"`
	Points         []HistPoint  `json:"points"`
	Gaps           []HistGap    `json:"gaps"`
	GapDatesTotal  int          `json:"gap_dates_total"`
	GapsTruncated  bool         `json:"gaps_truncated"`
	SkippedSteps   int          `json:"skipped_steps"`
	CurrentDD      *float64     `json:"current_drawdown_pct"`
	PeakDate       *string      `json:"peak_date"`
	PeakIndex      *float64     `json:"peak_index"`
	DaysUnderWater *int         `json:"days_under_water"`
	DrawdownReason *string      `json:"drawdown_reason"`
	MaxDrawdown    *MaxDrawdown `json:"max_drawdown"`
	TWRSinceStart  *float64     `json:"twr_since_start_pct"`
}

// HistExtras is what the handler turns into warnings.
type HistExtras struct {
	Excluded     []string // instruments whose stored sequence oversells
	SkippedDates []string // dates whose step was unknown
}

type qpoint struct {
	day int
	q   decimal.Decimal
}

type hInst struct {
	name   string
	isFund bool
	tl     []qpoint
	tp     int
	bars   []Bar
	navs   []mfhold.NAV
	pi     int // price pointer
}

func dayNum(t time.Time) int { return int(t.Unix() / 86400) }

func dayDate(n int) time.Time { return time.Unix(int64(n)*86400, 0).UTC() }

// multAfter is the product of the multipliers dated after d (and on or before asOf; adjs are pre-filtered).
func multAfter(adjs []Adj, d time.Time) decimal.Decimal {
	f := decimal.NewFromInt(1)
	for _, a := range adjs {
		if a.Date.After(d) {
			f = f.Mul(a.Multiplier)
		}
	}
	return f
}

// stockInst builds the quantity timeline (in current units) and the bars in current units. ok is false
// when the stored sequence oversells.
func stockInst(s HistStock, asOf time.Time) (hInst, bool) {
	in := hInst{name: s.Symbol}
	adjs := make([]Adj, 0, len(s.Adjs))
	for _, a := range s.Adjs {
		if !a.Date.After(asOf) {
			adjs = append(adjs, a)
		}
	}
	bps := map[int]time.Time{}
	var first time.Time
	for _, t := range s.Txns {
		if t.Date.After(asOf) {
			continue
		}
		bps[dayNum(t.Date)] = t.Date
		if first.IsZero() || t.Date.Before(first) {
			first = t.Date
		}
	}
	if first.IsZero() {
		return in, true
	}
	for _, a := range adjs {
		if !a.Date.Before(first) {
			bps[dayNum(a.Date)] = a.Date
		}
	}
	days := make([]int, 0, len(bps))
	for d := range bps {
		days = append(days, d)
	}
	sort.Ints(days)
	for _, d := range days {
		pos, err := Replay(s.Txns, adjs, bps[d])
		if err != nil {
			return in, false
		}
		in.tl = append(in.tl, qpoint{day: d, q: pos.Qty().Mul(multAfter(adjs, bps[d]))})
	}
	in.bars = make([]Bar, 0, len(s.Bars))
	for _, b := range s.Bars {
		if b.Date.After(asOf) {
			break
		}
		if !b.SrcAdj && len(adjs) > 0 {
			if f := multAfter(adjs, b.Date); !f.Equal(decimal.NewFromInt(1)) {
				b.Close = b.Close.DivRound(f, 12)
			}
		}
		in.bars = append(in.bars, b)
	}
	return in, true
}

func fundInst(f HistFund, asOf time.Time) (hInst, bool) {
	in := hInst{name: f.Name, isFund: true}
	txns := append([]mfhold.Txn(nil), f.Txns...)
	sort.SliceStable(txns, func(i, j int) bool {
		if !txns[i].Date.Equal(txns[j].Date) {
			return txns[i].Date.Before(txns[j].Date)
		}
		return txns[i].ID < txns[j].ID
	})
	units := decimal.Zero
	for _, t := range txns {
		if t.Date.After(asOf) {
			break
		}
		switch {
		case t.AddsUnits():
			units = units.Add(t.Units)
		case t.Type == mfhold.TypeRedemption:
			units = units.Sub(t.Units)
			if units.LessThan(mfhold.RoundingUnits.Neg()) {
				return in, false
			}
			if units.IsNegative() {
				units = decimal.Zero
			}
		}
		d := dayNum(t.Date)
		if n := len(in.tl); n > 0 && in.tl[n-1].day == d {
			in.tl[n-1].q = units
		} else {
			in.tl = append(in.tl, qpoint{day: d, q: units})
		}
	}
	for _, n := range f.NAVs {
		if n.Date.After(asOf) {
			break
		}
		in.navs = append(in.navs, n)
	}
	return in, true
}

// price returns the price at the series date: kind is "" when ok, else the gap kind.
func (in *hInst) price(day int, marketOpen map[int]struct{}) (decimal.Decimal, string) {
	if in.isFund {
		for in.pi < len(in.navs) && dayNum(in.navs[in.pi].Date) <= day {
			in.pi++
		}
		if in.pi == 0 {
			return decimal.Zero, ReasonMissingNAV
		}
		n := in.navs[in.pi-1]
		if day-dayNum(n.Date) > navMaxAge {
			return decimal.Zero, ReasonNavGap
		}
		return n.Value, ""
	}
	for in.pi < len(in.bars) && dayNum(in.bars[in.pi].Date) <= day {
		in.pi++
	}
	if in.pi == 0 {
		return decimal.Zero, ReasonMissingPrice
	}
	b := in.bars[in.pi-1]
	if dayNum(b.Date) == day {
		return b.Close, ""
	}
	if _, open := marketOpen[day]; !open {
		return b.Close, "" // a day on which no held stock traded: keep the last close
	}
	return decimal.Zero, ReasonMissingPrice
}

func sameQ(a, b []decimal.Decimal) bool {
	for i := range a {
		if !a[i].Equal(b[i]) {
			return false
		}
	}
	return true
}

func gapReason(missing map[string][]string) string {
	var parts []string
	for _, k := range []string{ReasonMissingPrice, ReasonMissingNAV, ReasonNavGap} {
		if names := missing[k]; len(names) > 0 {
			parts = append(parts, k+": "+strings.Join(names, ", "))
		}
	}
	return strings.Join(parts, "; ")
}

type gapAcc struct {
	gaps  []HistGap
	total int
}

// BuildHistory applies docs/05 8.6.3: the daily value, the time-weighted index and its drawdown.
func BuildHistory(in HistInput) (History, HistExtras) {
	h := History{Basis: "time_weighted_index", Base: indexBase, Points: []HistPoint{}, Gaps: []HistGap{}}
	var ex HistExtras
	var insts []hInst
	for _, s := range in.Stocks {
		inst, ok := stockInst(s, in.AsOf)
		switch {
		case !ok:
			ex.Excluded = append(ex.Excluded, s.Symbol)
		case len(inst.tl) > 0:
			insts = append(insts, inst)
		}
	}
	for _, f := range in.Funds {
		inst, ok := fundInst(f, in.AsOf)
		switch {
		case !ok:
			ex.Excluded = append(ex.Excluded, f.Name)
		case len(inst.tl) > 0:
			insts = append(insts, inst)
		}
	}
	if len(insts) == 0 {
		h.SeriesReason = strp(ReasonNoTransactions)
		return h, ex
	}

	marketOpen := map[int]struct{}{}
	dates := map[int]struct{}{}
	for _, i := range insts {
		for _, b := range i.bars {
			marketOpen[dayNum(b.Date)] = struct{}{}
			dates[dayNum(b.Date)] = struct{}{}
		}
		for _, n := range i.navs {
			dates[dayNum(n.Date)] = struct{}{}
		}
	}
	cal := make([]int, 0, len(dates))
	for d := range dates {
		cal = append(cal, d)
	}
	sort.Ints(cal)

	n := len(insts)
	cur := make([]decimal.Decimal, n)
	prevQ := make([]decimal.Decimal, n)
	prices := make([]decimal.Decimal, n)
	idx := make([]decimal.Decimal, 0, len(cal))
	var (
		haveValid                bool
		vp, ip                   decimal.Decimal
		lastValidDay, prevCalDay int
		gaps                     gapAcc
		sealed                   bool // a valid point was emitted since the last gap date
		hundred                  = decimal.NewFromInt(indexBase)
		anyIn, anyPrev           bool
	)
	for _, day := range cal {
		changedInGap := haveValid && lastValidDay != prevCalDay && !sameQ(cur, prevQ)
		for i := range insts {
			for insts[i].tp < len(insts[i].tl) && insts[i].tl[insts[i].tp].day <= day {
				cur[i] = insts[i].tl[insts[i].tp].q
				insts[i].tp++
			}
		}
		anyIn, anyPrev = false, false
		for i := range insts {
			if cur[i].IsPositive() {
				anyIn = true
			}
			if haveValid && prevQ[i].IsPositive() {
				anyPrev = true
			}
		}
		prevCalDay = day
		if !anyIn && !anyPrev {
			continue // empty portfolio on an empty portfolio: not a series date
		}
		needPrev := !changedInGap
		missing := map[string][]string{}
		for i := range insts {
			need := cur[i].IsPositive() || (needPrev && prevQ[i].IsPositive())
			if !need {
				continue
			}
			p, kind := insts[i].price(day, marketOpen)
			if kind != "" {
				missing[kind] = append(missing[kind], insts[i].name)
				continue
			}
			prices[i] = p
		}
		if len(missing) > 0 {
			reason := gapReason(missing)
			if sealed || len(gaps.gaps) == 0 || gaps.gaps[len(gaps.gaps)-1].Reason != reason {
				gaps.total++
				d := ymd(dayDate(day))
				gaps.gaps = append(gaps.gaps, HistGap{From: d, To: d, Dates: 1, Reason: reason})
			} else {
				last := &gaps.gaps[len(gaps.gaps)-1]
				gaps.total++
				last.To, last.Dates = ymd(dayDate(day)), last.Dates+1
			}
			sealed = false
			continue
		}
		v := decimal.Zero
		for i := range insts {
			if cur[i].IsPositive() {
				v = v.Add(cur[i].Mul(prices[i]))
			}
		}
		var cu decimal.Decimal
		switch {
		case !haveValid:
			cu = hundred
		case vp.IsZero():
			cu = ip
		case changedInGap:
			cu = ip
			h.SkippedSteps++
			ex.SkippedDates = append(ex.SkippedDates, ymd(dayDate(day)))
		default:
			w := v
			if !sameQ(cur, prevQ) {
				w = decimal.Zero
				for i := range insts {
					if prevQ[i].IsPositive() {
						w = w.Add(prevQ[i].Mul(prices[i]))
					}
				}
			}
			cu = ip.Mul(w).DivRound(vp, ratioPrecision)
		}
		idx = append(idx, cu)
		h.Points = append(h.Points, HistPoint{Date: ymd(dayDate(day)), Value: money(v)})
		copy(prevQ, cur)
		haveValid, vp, ip, lastValidDay, sealed = true, v, cu, day, true
	}
	h.GapDatesTotal = gaps.total
	if len(gaps.gaps) > maxGapRanges {
		gaps.gaps = gaps.gaps[len(gaps.gaps)-maxGapRanges:]
		h.GapsTruncated = true
	}
	h.Gaps = gaps.gaps
	h.PointsCount = len(h.Points)
	if h.PointsCount == 0 {
		h.SeriesReason = strp(ReasonNoPricedDates)
		h.DrawdownReason = strp(ReasonTooFewPoints)
		return h, ex
	}
	h.From, h.To = strp(h.Points[0].Date), strp(h.Points[len(h.Points)-1].Date)
	drawdown(&h, idx)
	return h, ex
}

// drawdown fills the index display, the drawdown per point and the summary figures (docs/05 8.6.3).
func drawdown(h *History, idx []decimal.Decimal) {
	hundred := decimal.NewFromInt(100)
	peak, peakAt := idx[0], 0
	worst, worstPeak, worstAt := decimal.Zero, 0, 0
	prevDD := decimal.Zero
	for i, cu := range idx {
		// a new high, or a return to the peak right after a fall (a flat carry over an empty day is not a new peak)
		if cu.GreaterThan(peak) || (cu.Equal(peak) && prevDD.IsNegative()) {
			peak, peakAt = cu, i
		}
		dd := cu.DivRound(peak, ratioPrecision).Sub(decimal.NewFromInt(1)).Mul(hundred)
		h.Points[i].Index = round4(cu.InexactFloat64())
		h.Points[i].DrawdownPct = *pct(dd)
		if dd.LessThan(worst) {
			worst, worstPeak, worstAt = dd, peakAt, i
		}
		prevDD = dd
	}
	if len(idx) < 2 {
		h.DrawdownReason = strp(ReasonTooFewPoints)
		return
	}
	last := len(idx) - 1
	h.CurrentDD = pct(idx[last].DivRound(peak, ratioPrecision).Sub(decimal.NewFromInt(1)).Mul(hundred))
	h.PeakDate = strp(h.Points[peakAt].Date)
	h.PeakIndex = round4p(peak)
	pd, _ := time.Parse(time.DateOnly, h.Points[peakAt].Date)
	ld, _ := time.Parse(time.DateOnly, h.Points[last].Date)
	uw := int(ld.Sub(pd).Hours() / 24)
	if prevDD.IsZero() {
		uw = 0 // at the peak
	}
	h.DaysUnderWater = &uw
	twr := idx[last].Sub(decimal.NewFromInt(indexBase)).DivRound(decimal.NewFromInt(indexBase), ratioPrecision).Mul(hundred)
	h.TWRSinceStart = pct(twr)
	md := &MaxDrawdown{DepthPct: *pct(worst)}
	if worst.IsNegative() { // a portfolio that never fell has depth 0 and no dates
		md.PeakDate, md.TroughDate = strp(h.Points[worstPeak].Date), strp(h.Points[worstAt].Date)
		for j := worstAt + 1; j < len(idx); j++ {
			if !idx[j].LessThan(idx[worstPeak]) {
				md.RecoveryDate, md.Recovered = strp(h.Points[j].Date), true
				break
			}
		}
	}
	h.MaxDrawdown = md
}

// HistoryWarnings turns the extras into envelope warnings (a code already present is not repeated).
func (ex HistExtras) Warnings(have map[string]bool) []Warn {
	var out []Warn
	if len(ex.Excluded) > 0 && !have["HOLDINGS_INCONSISTENT"] {
		out = append(out, Warn{"HOLDINGS_INCONSISTENT",
			"The history excludes " + strings.Join(ex.Excluded, ", ") + ": the stored transactions no longer pass the holdings check"})
	}
	if len(ex.SkippedDates) > 0 {
		out = append(out, Warn{"HISTORY_STEP_SKIPPED", fmt.Sprintf(
			"%d price moves could not be counted because a transaction fell inside a price gap (first on %s); the index carries its last value over them",
			len(ex.SkippedDates), ex.SkippedDates[0])})
	}
	return out
}
