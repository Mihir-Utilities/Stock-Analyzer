package screener

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Compare limits (docs/03 section 8: 2-5 symbols).
const (
	MinCompare       = 2
	MaxCompare       = 5
	shortHistoryFrac = 0.6
)

// DefaultCompareMetrics are shown when `metrics` is omitted.
var DefaultCompareMetrics = []string{"market_cap_cr", "pe", "pb", "roe", "roce", "debt_equity", "op_margin",
	"rev_growth_3y", "profit_growth_3y", "ret_1y", "quality_score", "trend_score", "risk_score"}

var rangeMonths = map[string]int{"1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "MAX": 0}

// CompareParams are the validated query parameters of GET /compare.
type CompareParams struct {
	Symbols []string
	Range   string
	Metrics []string
}

// ParseCompare validates symbols (2-5 after removing duplicates), range and metrics.
func ParseCompare(q url.Values) (CompareParams, error) {
	var fe fieldErrs
	p := CompareParams{Range: "1Y"}
	seen := map[string]bool{}
	raw := splitList(q.Get("symbols"))
	if len(raw) > 4*MaxCompare {
		fe.add("symbols", fmt.Sprintf("at most %d symbols are allowed", MaxCompare))
		raw = raw[:4*MaxCompare]
	}
	for _, x := range raw {
		if !ValidSymbol(x) {
			fe.add("symbols", "contains an invalid symbol")
			break
		}
		u := strings.ToUpper(x)
		if !seen[u] {
			seen[u] = true
			p.Symbols = append(p.Symbols, u)
		}
	}
	if len(fe.list) == 0 && (len(p.Symbols) < MinCompare || len(p.Symbols) > MaxCompare) {
		fe.add("symbols", fmt.Sprintf("must list %d to %d different symbols", MinCompare, MaxCompare))
	}
	if r := strings.TrimSpace(q.Get("range")); r != "" {
		if _, ok := rangeMonths[r]; !ok {
			fe.add("range", "must be one of 1M, 3M, 6M, 1Y, 3Y, 5Y, MAX")
		} else {
			p.Range = r
		}
	}
	if raw := q.Get("metrics"); strings.TrimSpace(raw) == "" {
		p.Metrics = append([]string(nil), DefaultCompareMetrics...)
	} else {
		ms := splitList(raw)
		if len(ms) > len(whitelist) {
			fe.add("metrics", "too many metrics")
			ms = ms[:len(whitelist)]
		}
		have := map[string]bool{}
		for _, m := range ms {
			if _, ok := Lookup(m); !ok {
				fe.add("metrics", "contains a metric that is not supported")
				break
			}
			if !have[m] {
				have[m] = true
				p.Metrics = append(p.Metrics, m)
			}
		}
	}
	return p, fe.err()
}

// CompareSymbol describes one compared stock.
type CompareSymbol struct {
	Symbol       string  `json:"symbol"`
	Name         string  `json:"name"`
	Bars         int     `json:"bars"`
	FirstDate    *string `json:"first_date"`
	LastDate     *string `json:"last_date"`
	ShortHistory bool    `json:"short_history"`
	PricesReason *string `json:"prices_reason"`
	MetricsAsOf  *string `json:"metrics_as_of"`
	Stamp
}

// Rebased is the common-date series (first common trading date = 100, adj_close).
type Rebased struct {
	BaseDate *string              `json:"base_date"`
	Dates    []string             `json:"dates"`
	Series   map[string][]float64 `json:"series"`
	Unit     string               `json:"unit"`
	Reason   *string              `json:"reason"`
}

// CompareResult is the data of GET /compare.
type CompareResult struct {
	Range         string                       `json:"range"`
	Symbols       []CompareSymbol              `json:"symbols"`
	Rebased       Rebased                      `json:"rebased"`
	Metrics       map[string]map[string]any    `json:"metrics"`
	MetricReasons map[string]map[string]string `json:"metric_reasons"`
	Units         map[string]string            `json:"units"`
	Best          map[string]*string           `json:"best"`

	AsOf time.Time `json:"-"`
}

type bar struct {
	d time.Time
	v float64
}

// Compare rebases the price history of 2-5 stocks and tabulates their screener metrics.
func (s *Service) Compare(ctx context.Context, p CompareParams) (CompareResult, error) {
	refs := make([]instRef, 0, len(p.Symbols))
	seen := map[int32]bool{}
	for _, sym := range p.Symbols {
		r, err := s.resolve(ctx, sym)
		if err != nil {
			return CompareResult{}, err
		}
		if !seen[r.ID] { // an alias and its new symbol resolve to the same stock
			seen[r.ID] = true
			refs = append(refs, r)
		}
	}
	ids := make([]int32, len(refs))
	for i, r := range refs {
		ids[i] = r.ID
	}
	var anchor pgtype.Date
	if err := s.db.QueryRow(ctx, `SELECT max(trade_date) FROM price_daily WHERE instrument_id = ANY($1::int[]) AND NOT suspect`, ids).Scan(&anchor); err != nil {
		return CompareResult{}, err
	}
	bars := map[int32][]bar{}
	from := time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)
	if anchor.Valid {
		if m := rangeMonths[p.Range]; m > 0 {
			from = anchor.Time.AddDate(0, -m, 0)
		}
		rows, err := s.db.Query(ctx, `SELECT instrument_id, trade_date, adj_close FROM price_daily
			WHERE instrument_id = ANY($1::int[]) AND NOT suspect AND trade_date >= $2 AND trade_date <= $3
			ORDER BY instrument_id, trade_date`, ids, from, anchor.Time)
		if err != nil {
			return CompareResult{}, err
		}
		for rows.Next() {
			var id int32
			var d pgtype.Date
			var v float64
			if err := rows.Scan(&id, &d, &v); err != nil {
				rows.Close()
				return CompareResult{}, err
			}
			bars[id] = append(bars[id], bar{d.Time, v})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return CompareResult{}, err
		}
	}
	mrows, err := s.metricsFor(ctx, ids)
	if err != nil {
		return CompareResult{}, err
	}
	st, err := s.stamps(ctx, ids)
	if err != nil {
		return CompareResult{}, err
	}

	// Trading dates of the window: union over the compared stocks. A stock with under 60% of them is short.
	union := map[time.Time]bool{}
	for _, bs := range bars {
		for _, b := range bs {
			union[b.d] = true
		}
	}
	res := CompareResult{Range: p.Range, Symbols: make([]CompareSymbol, 0, len(refs)),
		Metrics: map[string]map[string]any{}, MetricReasons: map[string]map[string]string{},
		Units: map[string]string{}, Best: map[string]*string{}, AsOf: s.Now()}
	if anchor.Valid {
		res.AsOf = anchor.Time
	}
	var withBars []instRef
	for _, r := range refs {
		bs := bars[r.ID]
		cs := CompareSymbol{Symbol: r.Symbol, Name: r.Name, Bars: len(bs), Stamp: st[r.ID]}
		if len(bs) == 0 {
			reason := "no_prices_in_range"
			cs.PricesReason, cs.ShortHistory = &reason, true
		} else {
			f, l := bs[0].d.Format(time.DateOnly), bs[len(bs)-1].d.Format(time.DateOnly)
			cs.FirstDate, cs.LastDate = &f, &l
			cs.ShortHistory = float64(len(bs)) < shortHistoryFrac*float64(len(union))
			withBars = append(withBars, r)
		}
		if d, ok := mrows[r.ID]; ok {
			a := d.asOf.Format(time.DateOnly)
			cs.MetricsAsOf = &a
		}
		res.Symbols = append(res.Symbols, cs)
	}
	res.Rebased = rebase(refs, withBars, bars)

	for _, k := range p.Metrics {
		res.Units[k] = Unit(k)
	}
	byValue := map[string]map[string]float64{} // metric -> symbol -> value
	for _, r := range refs {
		vals, reasons := map[string]any{}, map[string]string{}
		d, hasRow := mrows[r.ID]
		for _, k := range p.Metrics {
			if v, ok := metricValue(k, d.metrics); ok && hasRow {
				vals[k] = v
				if f, isNum := v.(float64); isNum {
					if byValue[k] == nil {
						byValue[k] = map[string]float64{}
					}
					byValue[k][r.Symbol] = f
				}
			} else {
				vals[k] = nil
				if hasRow {
					reasons[k] = reasonNotAvailable
				} else {
					reasons[k] = "no_screener_row"
				}
			}
		}
		res.Metrics[r.Symbol], res.MetricReasons[r.Symbol] = vals, reasons
	}
	for _, k := range p.Metrics {
		m := byKey[k]
		if m.Kind == Numeric && m.Dir != DirNone {
			res.Best[k] = best(m, byValue[k])
		}
	}
	return res, nil
}

// best names the single winner of a metric by the explicit direction table; nil when fewer than two
// stocks have a usable value or the top value is tied.
func best(m *Metric, vals map[string]float64) *string {
	type sv struct {
		sym string
		v   float64
	}
	var xs []sv
	for sym, v := range vals {
		if m.PositiveOnly && v <= 0 {
			continue // a non-positive P/E or P/B is not a meaningful "cheapest"
		}
		xs = append(xs, sv{sym, v})
	}
	if len(xs) < 2 {
		return nil
	}
	sort.Slice(xs, func(i, j int) bool {
		if xs[i].v != xs[j].v {
			if m.Dir == DirHigher {
				return xs[i].v > xs[j].v
			}
			return xs[i].v < xs[j].v
		}
		return xs[i].sym < xs[j].sym
	})
	if xs[0].v == xs[1].v {
		return nil
	}
	w := xs[0].sym
	return &w
}

func rebase(all, withBars []instRef, bars map[int32][]bar) Rebased {
	out := Rebased{Dates: []string{}, Series: map[string][]float64{}, Unit: "INDEX_BASE_100"}
	for _, r := range all {
		out.Series[r.Symbol] = nil
	}
	reason := func(s string) Rebased { out.Reason = &s; return out }
	if len(withBars) < MinCompare {
		return reason("fewer_than_two_stocks_with_prices")
	}
	count := map[time.Time]int{}
	for _, r := range withBars {
		for _, b := range bars[r.ID] {
			count[b.d]++
		}
	}
	var common []time.Time
	for d, n := range count {
		if n == len(withBars) {
			common = append(common, d)
		}
	}
	if len(common) == 0 {
		return reason("no_common_dates")
	}
	sort.Slice(common, func(i, j int) bool { return common[i].Before(common[j]) })
	for _, d := range common {
		out.Dates = append(out.Dates, d.Format(time.DateOnly))
	}
	base := common[0].Format(time.DateOnly)
	out.BaseDate = &base
	keep := map[time.Time]bool{}
	for _, d := range common {
		keep[d] = true
	}
	for _, r := range withBars {
		series := make([]float64, 0, len(common))
		var b0 float64
		for _, b := range bars[r.ID] {
			if !keep[b.d] {
				continue
			}
			if b0 == 0 {
				b0 = b.v
			}
			series = append(series, math.Round(b.v/b0*1e6)/1e4)
		}
		out.Series[r.Symbol] = series
	}
	return out
}
