package portfolio

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/india-analyzer/api/internal/instruments"
)

// WatchStock is one watched stock (docs/03 section 11). Prices are the latest valid imported bar:
// LTP is the close, ChangePct a percent number (12.34 = 12.34%).
type WatchStock struct {
	ID           int64     `json:"id"`
	Symbol       string    `json:"symbol"`
	Name         string    `json:"name"`
	LTP          *float64  `json:"ltp"`
	LTPAsOf      *string   `json:"ltp_as_of"`
	PriceStale   bool      `json:"price_stale"`
	ChangePct    *float64  `json:"change_pct"`
	ChangeReason *string   `json:"change_reason"`
	AddedAt      time.Time `json:"added_at"`
	Note         string    `json:"note"`
}

// WatchFund is one watched mutual fund.
type WatchFund struct {
	ID           int64     `json:"id"`
	Code         int32     `json:"code"`
	Name         string    `json:"name"`
	NAV          *float64  `json:"nav"`
	NAVDate      *string   `json:"nav_date"`
	ChangePct    *float64  `json:"change_pct"`
	ChangeReason *string   `json:"change_reason"`
	AddedAt      time.Time `json:"added_at"`
	Note         string    `json:"note"`
}

// Watchlist is the data of GET /watchlist.
type Watchlist struct {
	Stocks []WatchStock `json:"stocks"`
	Funds  []WatchFund  `json:"funds"`
}

// WatchAdd is the body of POST /watchlist.
type WatchAdd struct {
	Type   string  `json:"type"`
	Symbol *string `json:"symbol"`
	Code   *int32  `json:"code"`
	Note   *string `json:"note"`
}

// WatchEntry is the created or patched entry.
type WatchEntry struct {
	ID      int64     `json:"id"`
	Type    string    `json:"type"`
	Symbol  *string   `json:"symbol"`
	Code    *int32    `json:"code"`
	Name    string    `json:"name"`
	Note    string    `json:"note"`
	AddedAt time.Time `json:"added_at"`
}

func pctChange(last, prev float64) *float64 {
	if prev <= 0 {
		return nil
	}
	v := round4((last/prev - 1) * 100)
	return &v
}

// calendar loads the trading calendar for staleness (same rule as the stock profile, SYS-13).
func (s *Service) calendar(ctx context.Context, now time.Time) (instruments.Calendar, error) {
	from := today(now).AddDate(0, 0, -400)
	rows, err := s.db.Query(ctx, `SELECT DISTINCT holiday_date FROM market_holiday WHERE segment = 'trading' AND holiday_date BETWEEN $1 AND $2`,
		from, from.AddDate(0, 0, 440))
	if err != nil {
		return instruments.Calendar{}, err
	}
	defer rows.Close()
	var hs []time.Time
	for rows.Next() {
		var d time.Time
		if err := rows.Scan(&d); err != nil {
			return instruments.Calendar{}, err
		}
		hs = append(hs, d)
	}
	return instruments.NewCalendar(hs), rows.Err()
}

// List returns the watchlist with latest prices and NAVs.
func (s *Service) List(ctx context.Context) (Watchlist, bool, error) {
	now := s.Now()
	cal, err := s.calendar(ctx, now)
	if err != nil {
		return Watchlist{}, false, err
	}
	out := Watchlist{Stocks: []WatchStock{}, Funds: []WatchFund{}}
	rows, err := s.db.Query(ctx, `SELECT w.id, i.symbol, i.name, coalesce(w.note, ''), w.added_at,
		b.trade_date, b.close, b.src_adjusted, p.trade_date, p.close,
		EXISTS (SELECT 1 FROM corporate_action ca WHERE ca.instrument_id = i.id AND ca.status = 'confirmed'
		  AND ca.action_type IN ('split','bonus') AND ca.ex_date > p.trade_date AND ca.ex_date <= b.trade_date)
		FROM watchlist_item w JOIN instrument i ON i.id = w.instrument_id
		LEFT JOIN LATERAL (SELECT trade_date, close, src_adjusted FROM price_daily
		  WHERE instrument_id = i.id AND NOT suspect ORDER BY trade_date DESC LIMIT 1) b ON true
		LEFT JOIN LATERAL (SELECT trade_date, close FROM price_daily
		  WHERE instrument_id = i.id AND NOT suspect AND trade_date < b.trade_date ORDER BY trade_date DESC LIMIT 1) p ON true
		WHERE w.instrument_id IS NOT NULL ORDER BY w.added_at DESC, w.id DESC`)
	if err != nil {
		return out, false, err
	}
	defer rows.Close()
	stale := false
	for rows.Next() {
		var ws WatchStock
		var bd, pd *time.Time
		var bc, pc *float64
		var srcAdj *bool
		var inWindow bool
		if err := rows.Scan(&ws.ID, &ws.Symbol, &ws.Name, &ws.Note, &ws.AddedAt, &bd, &bc, &srcAdj, &pd, &pc, &inWindow); err != nil {
			return out, false, err
		}
		if bd != nil {
			ws.LTP, ws.LTPAsOf = bc, strp(ymd(*bd))
			st := cal.PricesStaleness(now, bd, true)
			ws.PriceStale = st.Stale
			stale = stale || st.Stale
			switch {
			case pc == nil:
				ws.ChangeReason = strp(ReasonNoPrevClose)
			case inWindow && srcAdj != nil && !*srcAdj:
				ws.ChangeReason = strp(ReasonActionInRange)
			default:
				ws.ChangePct = pctChange(*bc, *pc)
			}
		} else {
			ws.ChangeReason = strp(ReasonNoPrice)
		}
		out.Stocks = append(out.Stocks, ws)
	}
	if err := rows.Err(); err != nil {
		return out, false, err
	}
	rows.Close()
	frows, err := s.db.Query(ctx, `SELECT w.id, m.code, m.name, coalesce(w.note, ''), w.added_at, n.nav_date, n.nav, p.nav
		FROM watchlist_item w JOIN mf_scheme m ON m.code = w.mf_scheme_code
		LEFT JOIN LATERAL (SELECT nav_date, nav FROM mf_nav WHERE scheme_code = m.code ORDER BY nav_date DESC LIMIT 1) n ON true
		LEFT JOIN LATERAL (SELECT nav FROM mf_nav WHERE scheme_code = m.code AND nav_date < n.nav_date ORDER BY nav_date DESC LIMIT 1) p ON true
		WHERE w.mf_scheme_code IS NOT NULL ORDER BY w.added_at DESC, w.id DESC`)
	if err != nil {
		return out, false, err
	}
	defer frows.Close()
	for frows.Next() {
		var f WatchFund
		var nd *time.Time
		var nav, prev *float64
		if err := frows.Scan(&f.ID, &f.Code, &f.Name, &f.Note, &f.AddedAt, &nd, &nav, &prev); err != nil {
			return out, false, err
		}
		if nd != nil {
			f.NAV, f.NAVDate = nav, strp(ymd(*nd))
			if prev != nil {
				f.ChangePct = pctChange(*nav, *prev)
			} else {
				f.ChangeReason = strp(ReasonNoPrevClose)
			}
		} else {
			f.ChangeReason = strp("no_nav")
		}
		out.Funds = append(out.Funds, f)
	}
	return out, stale, frows.Err()
}

// Add creates a watchlist entry (duplicate -> ConflictError). A stock becomes tracked per docs/03
// section 11; no backfill is enqueued in manual price mode.
func (s *Service) Add(ctx context.Context, in WatchAdd) (WatchEntry, error) {
	var fe []FieldError
	note := validateNote(in.Note, &fe)
	switch in.Type {
	case "stock":
		if in.Symbol == nil || strings.TrimSpace(*in.Symbol) == "" {
			fe = append(fe, FieldError{"symbol", "is required"})
		}
	case "mf":
		if in.Code == nil || *in.Code < 1 {
			fe = append(fe, FieldError{"code", "is required"})
		}
	default:
		fe = append(fe, FieldError{"type", "must be stock or mf"})
	}
	if len(fe) > 0 {
		return WatchEntry{}, &ValidationError{Fields: fe}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return WatchEntry{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	e := WatchEntry{Type: in.Type, Note: note}
	if in.Type == "stock" {
		inst, err := resolve(ctx, tx, strings.TrimSpace(*in.Symbol))
		if err != nil {
			return e, err
		}
		e.Symbol, e.Name = &inst.Symbol, inst.Name
		err = tx.QueryRow(ctx, `INSERT INTO watchlist_item (instrument_id, note) VALUES ($1, NULLIF($2, ''))
			ON CONFLICT DO NOTHING RETURNING id, added_at`, inst.ID, note).Scan(&e.ID, &e.AddedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return e, &ConflictError{Message: inst.Symbol + " is already on the watchlist"}
		}
		if err != nil {
			return e, err
		}
		if err := trackFor(ctx, tx, inst.ID, "watchlist"); err != nil {
			return e, err
		}
	} else {
		e.Code = in.Code
		if err := tx.QueryRow(ctx, `SELECT name FROM mf_scheme WHERE code = $1`, *in.Code).Scan(&e.Name); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return e, &NotFoundError{What: "scheme", Details: map[string]any{"code": *in.Code}}
			}
			return e, err
		}
		err := tx.QueryRow(ctx, `INSERT INTO watchlist_item (mf_scheme_code, note) VALUES ($1, NULLIF($2, ''))
			ON CONFLICT DO NOTHING RETURNING id, added_at`, *in.Code, note).Scan(&e.ID, &e.AddedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return e, &ConflictError{Message: "Scheme is already on the watchlist"}
		}
		if err != nil {
			return e, err
		}
		if _, err := tx.Exec(ctx, `UPDATE mf_scheme SET is_tracked = true WHERE code = $1`, *in.Code); err != nil {
			return e, err
		}
	}
	return e, tx.Commit(ctx)
}

// PatchNote updates the note (max 500 characters).
func (s *Service) PatchNote(ctx context.Context, id int64, note string) (WatchEntry, error) {
	if utf8.RuneCountInString(note) > maxNote {
		return WatchEntry{}, &ValidationError{[]FieldError{{"note", "must be at most 500 characters"}}}
	}
	var e WatchEntry
	var sym *string
	var name *string
	err := s.db.QueryRow(ctx, `WITH u AS (UPDATE watchlist_item SET note = NULLIF($2, '') WHERE id = $1 RETURNING *)
		SELECT u.id, u.added_at, i.symbol, m.code, coalesce(i.name, m.name)
		FROM u LEFT JOIN instrument i ON i.id = u.instrument_id LEFT JOIN mf_scheme m ON m.code = u.mf_scheme_code`, id, note).
		Scan(&e.ID, &e.AddedAt, &sym, &e.Code, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return e, &NotFoundError{What: "watchlist entry", Details: map[string]any{"id": id}}
	}
	if err != nil {
		return e, err
	}
	e.Symbol, e.Note, e.Type = sym, note, "mf"
	if sym != nil {
		e.Type = "stock"
	}
	if name != nil {
		e.Name = *name
	}
	return e, nil
}

// Remove deletes an entry. A stock stays tracked while portfolio transactions, imported prices or
// a recent open still justify it (recomputeTracking); imported prices are never deleted.
func (s *Service) Remove(ctx context.Context, id int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var inst *int32
	var code *int32
	err = tx.QueryRow(ctx, `DELETE FROM watchlist_item WHERE id = $1 RETURNING instrument_id, mf_scheme_code`, id).Scan(&inst, &code)
	if errors.Is(err, pgx.ErrNoRows) {
		return &NotFoundError{What: "watchlist entry", Details: map[string]any{"id": id}}
	}
	if err != nil {
		return err
	}
	if inst != nil {
		err = recomputeTracking(ctx, tx, *inst)
	} else if code != nil {
		_, err = tx.Exec(ctx, `UPDATE mf_scheme SET is_tracked = false WHERE code = $1`, *code)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
