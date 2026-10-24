package portfolio

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// SummaryResult is the summary plus its freshness for the envelope meta.
type SummaryResult struct {
	Summary Summary
	AsOf    time.Time
}

// Summary computes GET /portfolio/summary at asOf from the stored transactions, confirmed
// actions, overrides and the latest valid bars on or before asOf (docs/05 section 8).
func (s *Service) Summary(ctx context.Context, rawAsOf string, includeExited bool) (SummaryResult, error) {
	now := s.Now()
	asOf, err := ParseAsOf(rawAsOf, now)
	if err != nil {
		return SummaryResult{}, err
	}
	rows, err := s.db.Query(ctx, `SELECT i.id, i.symbol, i.name, i.sector, i.status
		FROM instrument i WHERE EXISTS (SELECT 1 FROM portfolio_txn t WHERE t.instrument_id = i.id AND t.trade_date <= $1)
		ORDER BY i.symbol`, asOf)
	if err != nil {
		return SummaryResult{}, err
	}
	var ids []int32
	byID := map[int32]*InstrumentInput{}
	for rows.Next() {
		var id int32
		var it InstrumentInput
		if err := rows.Scan(&id, &it.Symbol, &it.Name, &it.Sector, &it.Status); err != nil {
			rows.Close()
			return SummaryResult{}, err
		}
		ids = append(ids, id)
		byID[id] = &it
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return SummaryResult{}, err
	}
	txns, err := loadTxns(ctx, s.db, ids)
	if err != nil {
		return SummaryResult{}, err
	}
	acts, err := loadActions(ctx, s.db, ids)
	if err != nil {
		return SummaryResult{}, err
	}
	ovs, err := loadOverrides(ctx, s.db, ids)
	if err != nil {
		return SummaryResult{}, err
	}
	prices, err := s.latestPrices(ctx, ids, asOf)
	if err != nil {
		return SummaryResult{}, err
	}
	in := SummaryInput{AsOf: asOf, IncludeExited: includeExited}
	for _, id := range ids {
		it := byID[id]
		it.Txns, it.Actions, it.Overrides, it.Price = txns[id], acts[id], ovs[id], prices[id]
		in.Items = append(in.Items, *it)
	}
	if in.Bench, err = s.benchmarkSeries(ctx, asOf); err != nil {
		return SummaryResult{}, err
	}
	cal, err := s.calendar(ctx, now)
	if err != nil {
		return SummaryResult{}, err
	}
	ref := now // a past as_of is judged against the end of that day, not against today
	if asOf.Before(today(now)) {
		ref = time.Date(asOf.Year(), asOf.Month(), asOf.Day(), 20, 0, 0, 0, IST)
	}
	in.Stale = func(bar time.Time) (bool, float64) {
		st := cal.PricesStaleness(ref, &bar, true)
		return st.Stale, st.AgeHours
	}
	return SummaryResult{Summary: BuildSummary(in), AsOf: asOf}, nil
}

func (s *Service) latestPrices(ctx context.Context, ids []int32, asOf time.Time) (map[int32]*Price, error) {
	rows, err := s.db.Query(ctx, `SELECT x.id, b.trade_date, b.close, b.src_adjusted, p.trade_date, p.close
		FROM unnest($1::int[]) AS x(id)
		JOIN LATERAL (SELECT trade_date, close, src_adjusted FROM price_daily
		  WHERE instrument_id = x.id AND NOT suspect AND trade_date <= $2 ORDER BY trade_date DESC LIMIT 1) b ON true
		LEFT JOIN LATERAL (SELECT trade_date, close FROM price_daily
		  WHERE instrument_id = x.id AND NOT suspect AND trade_date < b.trade_date ORDER BY trade_date DESC LIMIT 1) p ON true`, ids, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int32]*Price{}
	for rows.Next() {
		var id int32
		var p Price
		var bc float64
		var pd *time.Time
		var pc *float64
		if err := rows.Scan(&id, &p.Date, &bc, &p.SrcAdjusted, &pd, &pc); err != nil {
			return nil, err
		}
		p.Close = decimal.NewFromFloat(bc)
		if pd != nil && pc != nil {
			c := decimal.NewFromFloat(*pc)
			p.PrevDate, p.PrevClose = pd, &c
		}
		out[id] = &p
	}
	return out, rows.Err()
}

func (s *Service) benchmarkSeries(ctx context.Context, asOf time.Time) ([]SeriesPoint, error) {
	rows, err := s.db.Query(ctx, `SELECT trade_date, value FROM market_series WHERE code = 'NIFTY50' AND trade_date <= $1 ORDER BY trade_date`, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesPoint
	for rows.Next() {
		var p SeriesPoint
		if err := rows.Scan(&p.Date, &p.Value); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AdjustmentItem is one row of GET /portfolio/adjustments.
type AdjustmentItem struct {
	ID                *int64  `json:"id"`
	Symbol            string  `json:"symbol"`
	Date              string  `json:"date"`
	Type              string  `json:"type"`
	Multiplier        *string `json:"multiplier"`
	Source            string  `json:"source"`
	Applied           bool    `json:"applied"`
	CorporateActionID *int64  `json:"corporate_action_id"`
	Note              string  `json:"note"`
}

// AdjustmentList is the data of GET /portfolio/adjustments.
type AdjustmentList struct {
	Items []AdjustmentItem `json:"items"`
}

// Adjustments lists, for every instrument the owner has traded, the confirmed split/bonus actions
// and the owner overrides after its first transaction, plus confirmed actions that need review and
// unconfirmed candidates (multiplier null, applied false).
func (s *Service) Adjustments(ctx context.Context) (AdjustmentList, error) {
	out := AdjustmentList{Items: []AdjustmentItem{}}
	rows, err := s.db.Query(ctx, `SELECT i.id, i.symbol, min(t.trade_date) FROM instrument i
		JOIN portfolio_txn t ON t.instrument_id = i.id GROUP BY i.id, i.symbol ORDER BY i.symbol`)
	if err != nil {
		return out, err
	}
	type inst struct {
		id    int32
		sym   string
		first time.Time
	}
	var is []inst
	var ids []int32
	for rows.Next() {
		var x inst
		if err := rows.Scan(&x.id, &x.sym, &x.first); err != nil {
			rows.Close()
			return out, err
		}
		is = append(is, x)
		ids = append(ids, x.id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	acts, err := loadActions(ctx, s.db, ids)
	if err != nil {
		return out, err
	}
	ovs, err := loadOverrides(ctx, s.db, ids)
	if err != nil {
		return out, err
	}
	for _, x := range is {
		over := map[string]bool{}
		for _, o := range ovs[x.id] {
			over[ymd(o.Date)] = true
			id, m := o.ID, o.Multiplier.String()
			out.Items = append(out.Items, AdjustmentItem{ID: &id, Symbol: x.sym, Date: ymd(o.Date), Type: "override", Multiplier: &m,
				Source: "override", Applied: true, CorporateActionID: o.ActionID, Note: o.Note})
		}
		for _, a := range acts[x.id] {
			if a.ExDate.Before(x.first) || a.Type == "dividend" {
				continue
			}
			aid := a.ID
			it := AdjustmentItem{Symbol: x.sym, Date: ymd(a.ExDate), Type: a.Type, Source: "confirmed_action", CorporateActionID: &aid, Note: a.Purpose}
			if m, ok := a.Multiplier(); ok {
				ms := m.String()
				it.Multiplier, it.Applied = &ms, !over[ymd(a.ExDate)]
			} else if a.Status == "detected" {
				it.Source = "detected_unconfirmed"
			} else {
				it.Source = "review_needed"
			}
			out.Items = append(out.Items, it)
		}
	}
	return out, nil
}

// AdjustmentInput is the body of POST /portfolio/adjustments.
type AdjustmentInput struct {
	Symbol            *string `json:"symbol"`
	EffectiveDate     *string `json:"effective_date"`
	QtyMultiplier     Dec     `json:"qty_multiplier"`
	CorporateActionID *int64  `json:"corporate_action_id"`
	Note              *string `json:"note"`
}

var maxMultiplier = decimal.NewFromInt(1_000_000)

// CreateAdjustment stores an owner override (docs/05 section 8.2: it replaces the confirmed action
// of the same ex-date) after re-validating the instrument's whole transaction sequence with it.
func (s *Service) CreateAdjustment(ctx context.Context, in AdjustmentInput) (AdjustmentItem, error) {
	var fe []FieldError
	note := validateNote(in.Note, &fe)
	var inst instrumentRef
	if in.Symbol == nil || strings.TrimSpace(*in.Symbol) == "" {
		fe = append(fe, FieldError{"symbol", "is required"})
	} else {
		var err error
		inst, err = resolve(ctx, s.db, strings.TrimSpace(*in.Symbol))
		var nf *NotFoundError
		if errors.As(err, &nf) {
			fe = append(fe, FieldError{"symbol", "does not resolve to an instrument"})
		} else if err != nil {
			return AdjustmentItem{}, err
		}
	}
	var date time.Time
	if in.EffectiveDate == nil {
		fe = append(fe, FieldError{"effective_date", "is required"})
	} else if d, ok := parseDate(*in.EffectiveDate); !ok {
		fe = append(fe, FieldError{"effective_date", "must be YYYY-MM-DD"})
	} else if d.After(today(s.Now())) {
		fe = append(fe, FieldError{"effective_date", "must not be in the future (IST)"})
	} else {
		date = d
	}
	mult, msg := parseDecimal(in.QtyMultiplier, 8)
	if msg != "" || !mult.IsPositive() || mult.GreaterThan(maxMultiplier) {
		if msg == "" {
			msg = "must be > 0 and <= 1000000"
		}
		fe = append(fe, FieldError{"qty_multiplier", msg})
	}
	if len(fe) > 0 {
		return AdjustmentItem{}, &ValidationError{Fields: fe}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return AdjustmentItem{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockInstruments(ctx, tx, inst.ID); err != nil {
		return AdjustmentItem{}, err
	}
	if in.CorporateActionID != nil {
		var ex time.Time
		err := tx.QueryRow(ctx, `SELECT ex_date FROM corporate_action WHERE id = $1 AND instrument_id = $2`, *in.CorporateActionID, inst.ID).Scan(&ex)
		if errors.Is(err, pgx.ErrNoRows) {
			return AdjustmentItem{}, &ValidationError{[]FieldError{{"corporate_action_id", "does not belong to this instrument"}}}
		}
		if err != nil {
			return AdjustmentItem{}, err
		}
		if !ex.Equal(date) {
			return AdjustmentItem{}, &ValidationError{[]FieldError{{"effective_date", "must equal the action's ex-date " + ymd(ex)}}}
		}
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO portfolio_adjustment (instrument_id, corporate_action_id, effective_date, qty_multiplier, note)
		SELECT $1, $2, $3, $4, NULLIF($5, '')
		WHERE NOT EXISTS (SELECT 1 FROM portfolio_adjustment WHERE instrument_id = $1 AND effective_date = $3)
		RETURNING id`, inst.ID, in.CorporateActionID, date, mult, note).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdjustmentItem{}, &ConflictError{Message: "An override already exists for " + inst.Symbol + " on " + ymd(date)}
	}
	if err != nil {
		return AdjustmentItem{}, err
	}
	if err := validateSequence(ctx, tx, inst.ID, s.Now()); err != nil {
		return AdjustmentItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AdjustmentItem{}, err
	}
	m := mult.String()
	return AdjustmentItem{ID: &id, Symbol: inst.Symbol, Date: ymd(date), Type: "override", Multiplier: &m, Source: "override",
		Applied: true, CorporateActionID: in.CorporateActionID, Note: note}, nil
}
