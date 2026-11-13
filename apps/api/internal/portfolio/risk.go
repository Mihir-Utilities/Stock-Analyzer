package portfolio

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/mfhold"
)

// RiskData is the data of GET /portfolio/risk (docs/03 12b, docs/05 8.6).
type RiskData struct {
	View          string        `json:"view"`
	AsOf          string        `json:"as_of"`
	Currency      string        `json:"currency"`
	Concentration Concentration `json:"concentration"`
	Stress        Stress        `json:"stress"`
	History       History       `json:"history"`
}

// RiskResult is the data plus what the envelope meta and warnings need.
type RiskResult struct {
	Data          RiskData
	Stale         bool
	StaleAgeHours float64
	Warnings      []Warn
}

// Risk serves GET /portfolio/risk: the concentration and stress of the view's open holdings (read from the
// same summary the Portfolio page shows) and the reconstructed value history (docs/05 8.6).
func (s *Service) Risk(ctx context.Context, rawView, rawAsOf string) (RiskResult, error) {
	view := rawView
	if view == "" {
		view = ViewAll // the new endpoint defaults to All (PRK-5)
	}
	view, err := ParseView(view)
	if err != nil {
		return RiskResult{}, err
	}
	asOf, err := ParseAsOf(rawAsOf, s.Now())
	if err != nil {
		return RiskResult{}, err
	}
	vr, err := s.SummaryView(ctx, view, rawAsOf, false)
	if err != nil {
		return RiskResult{}, err
	}
	sum := vr.Summary
	conc, stress := BuildConcentration(riskHoldings(sum, view))

	in := HistInput{AsOf: asOf}
	if view != ViewMF {
		if in.Stocks, err = s.loadHistStocks(ctx, asOf); err != nil {
			return RiskResult{}, err
		}
	}
	if view != ViewEquity {
		if in.Funds, err = s.loadHistFunds(ctx, asOf); err != nil {
			return RiskResult{}, err
		}
	}
	hist, extras := BuildHistory(in)

	have := map[string]bool{}
	for _, w := range sum.Warnings {
		have[w.Code] = true
	}
	warns := append(append([]Warn{}, sum.Warnings...), extras.Warnings(have)...)
	return RiskResult{
		Data:  RiskData{View: view, AsOf: ymd(asOf), Currency: "INR", Concentration: conc, Stress: stress, History: hist},
		Stale: sum.Stale, StaleAgeHours: sum.StaleAgeHours, Warnings: warns,
	}, nil
}

// riskHoldings maps the open holdings of a view summary to the concentration input.
func riskHoldings(sum ViewSummary, view string) []RiskHolding {
	var out []RiskHolding
	for _, h := range sum.Holdings {
		if h.Exited {
			continue
		}
		g, kind := GroupUnclassified, kindUnclassified
		if h.Sector != nil && trimmed(*h.Sector) != "" {
			g, kind = trimmed(*h.Sector), kindSector
		}
		rh := RiskHolding{Key: h.Symbol, Name: h.Name, AssetClass: "equity", Group: g, GroupKind: kind}
		if h.MarketValue != nil {
			if v, err := decimal.NewFromString(*h.MarketValue); err == nil {
				rh.Value = &v
			}
		}
		out = append(out, rh)
	}
	for _, h := range sum.MFHoldings {
		if h.Exited {
			continue
		}
		g, kind := GroupFunds, kindFunds
		if view == ViewMF {
			g, kind = GroupUnclassified, kindUnclassified
			if h.Category != nil && trimmed(*h.Category) != "" {
				g, kind = trimmed(*h.Category), kindCategory
			}
		}
		out = append(out, RiskHolding{Key: itoa(h.SchemeCode), Name: h.SchemeName, AssetClass: "mf", Group: g, GroupKind: kind, Value: h.MV})
	}
	return out
}

// loadHistStocks reads every traded stock's ledger, adjustments and bars once (docs/05 8.6.3 cost note).
func (s *Service) loadHistStocks(ctx context.Context, asOf time.Time) ([]HistStock, error) {
	rows, err := s.db.Query(ctx, `SELECT i.id, i.symbol FROM instrument i
		WHERE EXISTS (SELECT 1 FROM portfolio_txn t WHERE t.instrument_id = i.id AND t.trade_date <= $1) ORDER BY i.symbol`, asOf)
	if err != nil {
		return nil, err
	}
	var ids []int32
	syms := map[int32]string{}
	for rows.Next() {
		var id int32
		var sym string
		if err := rows.Scan(&id, &sym); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		syms[id] = sym
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	txns, err := loadTxns(ctx, s.db, ids)
	if err != nil {
		return nil, err
	}
	acts, err := loadActions(ctx, s.db, ids)
	if err != nil {
		return nil, err
	}
	ovs, err := loadOverrides(ctx, s.db, ids)
	if err != nil {
		return nil, err
	}
	// One row per instrument with the bars as arrays: decoding 100k rows one by one costs several times more.
	brows, err := s.db.Query(ctx, `SELECT x.id, array_agg((b.trade_date - DATE '1970-01-01')::int ORDER BY b.trade_date),
		array_agg(b.close ORDER BY b.trade_date), array_agg(b.src_adjusted ORDER BY b.trade_date)
		FROM unnest($1::int[]) AS x(id)
		JOIN LATERAL (SELECT min(trade_date) AS first_d FROM portfolio_txn WHERE instrument_id = x.id AND trade_date <= $2) f ON true
		JOIN LATERAL (SELECT trade_date, close, src_adjusted FROM price_daily
		  WHERE instrument_id = x.id AND NOT suspect AND trade_date >= f.first_d AND trade_date <= $2 ORDER BY trade_date) b ON true
		GROUP BY x.id`, ids, asOf)
	if err != nil {
		return nil, err
	}
	defer brows.Close()
	bars := map[int32][]Bar{}
	for brows.Next() {
		var id int32
		var days []int32
		var closes []float64
		var adj []bool
		if err := brows.Scan(&id, &days, &closes, &adj); err != nil {
			return nil, err
		}
		bs := make([]Bar, len(days))
		for i := range days {
			bs[i] = Bar{Date: dayDate(int(days[i])), Close: fastDecimal(closes[i]), SrcAdj: adj[i]}
		}
		bars[id] = bs
	}
	if err := brows.Err(); err != nil {
		return nil, err
	}
	out := make([]HistStock, 0, len(ids))
	for _, id := range ids {
		out = append(out, HistStock{Symbol: syms[id], Txns: txns[id], Adjs: EffectiveAdjustments(acts[id], ovs[id]), Bars: bars[id]})
	}
	return out, nil
}

// loadHistFunds reads every scheme's ledger and NAVs once.
func (s *Service) loadHistFunds(ctx context.Context, asOf time.Time) ([]HistFund, error) {
	rows, err := s.db.Query(ctx, `SELECT t.id, t.scheme_code, t.folio, t.txn_type, t.txn_date, t.units, t.nav, t.amount, t.stamp_duty, m.name
		FROM mf_txn t JOIN mf_scheme m ON m.code = t.scheme_code WHERE t.txn_date <= $1 ORDER BY t.scheme_code, t.txn_date, t.id`, asOf)
	if err != nil {
		return nil, err
	}
	var funds []*HistFund
	byCode := map[int32]*HistFund{}
	var codes []int32
	first := time.Time{}
	for rows.Next() {
		var t mfhold.Txn
		var name string
		if err := rows.Scan(&t.ID, &t.Scheme, &t.Folio, &t.Type, &t.Date, &t.Units, &t.NAV, &t.Amount, &t.Stamp, &name); err != nil {
			rows.Close()
			return nil, err
		}
		f := byCode[t.Scheme]
		if f == nil {
			f = &HistFund{Code: t.Scheme, Name: name}
			byCode[t.Scheme] = f
			funds = append(funds, f)
			codes = append(codes, t.Scheme)
		}
		f.Txns = append(f.Txns, t)
		if first.IsZero() || t.Date.Before(first) {
			first = t.Date
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(funds) == 0 {
		return nil, nil
	}
	nrows, err := s.db.Query(ctx, `SELECT scheme_code, nav_date, nav FROM mf_nav
		WHERE scheme_code = ANY($1::int[]) AND nav_date >= $2 AND nav_date <= $3 ORDER BY scheme_code, nav_date`, codes, first, asOf)
	if err != nil {
		return nil, err
	}
	defer nrows.Close()
	for nrows.Next() {
		var code int32
		var n mfhold.NAV
		var v float64
		if err := nrows.Scan(&code, &n.Date, &v); err != nil {
			return nil, err
		}
		n.Value = decimal.NewFromFloat(v) // mf_nav.nav is a double: shortest round-trip decimal, as the sleeve does
		byCode[code].NAVs = append(byCode[code].NAVs, n)
	}
	if err := nrows.Err(); err != nil {
		return nil, err
	}
	out := make([]HistFund, 0, len(funds))
	for _, f := range funds {
		out = append(out, *f)
	}
	return out, nil
}

func trimmed(s string) string { return strings.TrimSpace(s) }

func itoa(n int32) string { return strconv.Itoa(int(n)) }

// fastDecimal converts a stored double close to a decimal. Closes carry at most 4 decimals, for which an
// integer scaled by 10^4 is exact (and about ten times faster than NewFromFloat); anything else takes the
// shortest round-trip decimal like the summary does.
func fastDecimal(c float64) decimal.Decimal {
	scaled := math.Round(c * 1e4)
	if math.Abs(c*1e4-scaled) < 1e-6 && math.Abs(scaled) < 1e15 {
		return decimal.New(int64(scaled), -4)
	}
	return decimal.NewFromFloat(c)
}
