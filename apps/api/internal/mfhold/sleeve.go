package mfhold

import (
	"context"
	"time"

	"github.com/shopspring/decimal"
)

// Sleeve loads the MF ledger and NAVs and builds the sleeve as of asOf (docs/05 8.5).
func (s *Service) Sleeve(ctx context.Context, asOf time.Time, includeExited, groupFolio bool) (Result, error) {
	rows, err := s.db.Query(ctx, `SELECT id, scheme_code, folio, txn_type, txn_date, units, nav, amount, stamp_duty
		FROM mf_txn WHERE txn_date <= $1 ORDER BY txn_date, id`, asOf)
	if err != nil {
		return Result{}, err
	}
	var txns []Txn
	seen := map[int32]bool{}
	var codes []int32
	for rows.Next() {
		var t Txn
		if err := rows.Scan(&t.ID, &t.Scheme, &t.Folio, &t.Type, &t.Date, &t.Units, &t.NAV, &t.Amount, &t.Stamp); err != nil {
			rows.Close()
			return Result{}, err
		}
		txns = append(txns, t)
		if !seen[t.Scheme] {
			seen[t.Scheme] = true
			codes = append(codes, t.Scheme)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Result{}, err
	}
	in := Input{AsOf: asOf, Txns: txns, IncludeExited: includeExited, GroupFolio: groupFolio,
		Schemes: map[int32]Scheme{}, NAVs: map[int32]SchemeNAV{}}
	if len(codes) == 0 {
		return Build(in), nil
	}
	srows, err := s.db.Query(ctx, `SELECT m.code, m.name, m.fund_house, m.category, m.isin_growth, m.isin_div_reinvest,
		coalesce(m.plan, 'unknown'), coalesce(m.option_type, 'unknown'), m.status,
		(SELECT min(nav_date) FROM mf_nav WHERE scheme_code = m.code)
		FROM mf_scheme m WHERE m.code = ANY($1::int[])`, codes)
	if err != nil {
		return Result{}, err
	}
	for srows.Next() {
		var sc Scheme
		if err := srows.Scan(&sc.Code, &sc.Name, &sc.FundHouse, &sc.Category, &sc.ISINGrowth, &sc.ISINReinv, &sc.Plan, &sc.Option, &sc.Status, &sc.FirstNAV); err != nil {
			srows.Close()
			return Result{}, err
		}
		in.Schemes[sc.Code] = sc
	}
	srows.Close()
	if err := srows.Err(); err != nil {
		return Result{}, err
	}
	// The latest two NAV rows on or before as_of (a NAV after as_of is ignored).
	nrows, err := s.db.Query(ctx, `SELECT x.code, n.nav_date, n.nav FROM unnest($1::int[]) AS x(code)
		CROSS JOIN LATERAL (SELECT nav_date, nav FROM mf_nav WHERE scheme_code = x.code AND nav_date <= $2
		  ORDER BY nav_date DESC LIMIT 2) n ORDER BY x.code, n.nav_date DESC`, codes, asOf)
	if err != nil {
		return Result{}, err
	}
	for nrows.Next() {
		var code int32
		var d time.Time
		var v float64
		if err := nrows.Scan(&code, &d, &v); err != nil {
			nrows.Close()
			return Result{}, err
		}
		n := NAV{Date: d, Value: decimal.NewFromFloat(v)}
		cur := in.NAVs[code]
		if cur.Latest == nil {
			cur.Latest = &n
		} else {
			cur.Prev = &n
		}
		in.NAVs[code] = cur
	}
	nrows.Close()
	if err := nrows.Err(); err != nil {
		return Result{}, err
	}
	return Build(in), nil
}

// HoldingsResult is the data of GET /portfolio/mf/holdings.
type HoldingsResult struct {
	Items  []Holding `json:"items"`
	Totals Totals    `json:"totals"`

	Result Result    `json:"-"`
	AsOf   time.Time `json:"-"`
}

// Holdings serves GET /portfolio/mf/holdings. group is "scheme" (default) or "folio".
func (s *Service) Holdings(ctx context.Context, rawAsOf string, includeExited bool, group string) (HoldingsResult, error) {
	var fe []FieldError
	asOf := Today(s.Now())
	if rawAsOf != "" {
		d, ok := ParseDay(rawAsOf)
		switch {
		case !ok:
			fe = append(fe, FieldError{"as_of", "must be YYYY-MM-DD"})
		case d.After(asOf):
			fe = append(fe, FieldError{"as_of", "must not be in the future"})
		default:
			asOf = d
		}
	}
	if group != "" && group != "scheme" && group != "folio" {
		fe = append(fe, FieldError{"group", "must be scheme or folio"})
	}
	if len(fe) > 0 {
		return HoldingsResult{}, &ValidationError{Fields: fe}
	}
	res, err := s.Sleeve(ctx, asOf, includeExited, group == "folio")
	if err != nil {
		return HoldingsResult{}, err
	}
	return HoldingsResult{Items: res.Items, Totals: res.Totals, Result: res, AsOf: asOf}, nil
}
