package portfolio

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/dbq"
)

// DB is the pool surface the service needs (pgxpool.Pool satisfies it).
type DB interface {
	dbq.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Domain errors the HTTP layer maps to the envelope.
var (
	ErrNotFound = errors.New("portfolio: not found")
	ErrConflict = errors.New("portfolio: conflict")
)

// NotFoundError names what was not found (details for the envelope).
type NotFoundError struct {
	What    string
	Details map[string]any
}

func (e *NotFoundError) Error() string { return "portfolio: " + e.What + " not found" }

// ConflictError is a 409 with a message.
type ConflictError struct{ Message string }

func (e *ConflictError) Error() string { return e.Message }

// instrumentRef is the resolved instrument.
type instrumentRef struct {
	ID      int32
	Symbol  string
	Name    string
	Status  string
	Listing *time.Time
	Sector  *string
}

// resolve finds an instrument by exact symbol (case-insensitive), then by old symbol (docs/03
// section 1: alias follows the instrument, PF-15).
func resolve(ctx context.Context, db dbq.DBTX, symbol string) (instrumentRef, error) {
	const cols = `i.id, i.symbol, i.name, i.status, i.listing_date, i.sector`
	var r instrumentRef
	scan := func(row pgx.Row) error {
		return row.Scan(&r.ID, &r.Symbol, &r.Name, &r.Status, &r.Listing, &r.Sector)
	}
	err := scan(db.QueryRow(ctx, `SELECT `+cols+` FROM instrument i WHERE upper(i.symbol) = upper($1::text)
		ORDER BY (i.symbol = $1::text) DESC, i.id LIMIT 1`, symbol))
	if errors.Is(err, pgx.ErrNoRows) {
		err = scan(db.QueryRow(ctx, `SELECT `+cols+` FROM symbol_alias a JOIN instrument i ON i.id = a.instrument_id
			WHERE upper(a.old_symbol) = upper($1::text) ORDER BY a.changed_on DESC NULLS LAST, i.id LIMIT 1`, symbol))
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return r, &NotFoundError{What: "instrument", Details: map[string]any{"symbol": symbol}}
	}
	return r, err
}

func loadTxns(ctx context.Context, db dbq.DBTX, ids []int32) (map[int32][]Txn, error) {
	rows, err := db.Query(ctx, `SELECT instrument_id, id, side, qty, price, fees, trade_date
		FROM portfolio_txn WHERE instrument_id = ANY($1::int[]) ORDER BY trade_date, id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int32][]Txn{}
	for rows.Next() {
		var inst int32
		var t Txn
		if err := rows.Scan(&inst, &t.ID, &t.Side, &t.Qty, &t.Price, &t.Fees, &t.Date); err != nil {
			return nil, err
		}
		out[inst] = append(out[inst], t)
	}
	return out, rows.Err()
}

func loadActions(ctx context.Context, db dbq.DBTX, ids []int32) (map[int32][]CorporateAction, error) {
	rows, err := db.Query(ctx, `SELECT instrument_id, id, ex_date, record_date, action_type, status,
		ratio_num, ratio_den, amount_per_share, purpose_text
		FROM corporate_action WHERE instrument_id = ANY($1::int[]) AND status IN ('confirmed','detected')
		ORDER BY ex_date, id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int32][]CorporateAction{}
	for rows.Next() {
		var inst int32
		var a CorporateAction
		var num, den, amt decimal.NullDecimal
		if err := rows.Scan(&inst, &a.ID, &a.ExDate, &a.RecordDay, &a.Type, &a.Status, &num, &den, &amt, &a.Purpose); err != nil {
			return nil, err
		}
		a.RatioNum, a.RatioDen, a.AmountPS = nd(num), nd(den), nd(amt)
		out[inst] = append(out[inst], a)
	}
	return out, rows.Err()
}

func nd(n decimal.NullDecimal) *decimal.Decimal {
	if !n.Valid {
		return nil
	}
	d := n.Decimal
	return &d
}

func loadOverrides(ctx context.Context, db dbq.DBTX, ids []int32) (map[int32][]Override, error) {
	rows, err := db.Query(ctx, `SELECT instrument_id, id, corporate_action_id, effective_date, qty_multiplier, coalesce(note, '')
		FROM portfolio_adjustment WHERE instrument_id = ANY($1::int[]) ORDER BY effective_date, id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int32][]Override{}
	for rows.Next() {
		var inst int32
		var o Override
		if err := rows.Scan(&inst, &o.ID, &o.ActionID, &o.Date, &o.Multiplier, &o.Note); err != nil {
			return nil, err
		}
		out[inst] = append(out[inst], o)
	}
	return out, rows.Err()
}

// lockInstruments serialises writers per instrument for the rest of the transaction, so two
// concurrent sells cannot each pass validation on their own.
func lockInstruments(ctx context.Context, tx pgx.Tx, ids ...int32) error {
	sorted := append([]int32(nil), ids...)
	for i := range sorted { // tiny insertion sort: lock in ascending order to avoid deadlocks
		for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	for i, id := range sorted {
		if i > 0 && id == sorted[i-1] {
			continue
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7011, $1::int)`, id); err != nil {
			return err
		}
	}
	return nil
}

// validateSequence replays one instrument's full stored sequence with the confirmed actions and
// overrides as of today and reports the first sell that exceeds holdings.
func validateSequence(ctx context.Context, db dbq.DBTX, id int32, now time.Time) error {
	ids := []int32{id}
	txns, err := loadTxns(ctx, db, ids)
	if err != nil {
		return err
	}
	acts, err := loadActions(ctx, db, ids)
	if err != nil {
		return err
	}
	ovs, err := loadOverrides(ctx, db, ids)
	if err != nil {
		return err
	}
	_, err = Replay(txns[id], EffectiveAdjustments(acts[id], ovs[id]), today(now))
	return err
}

// recomputeTracking applies docs/03 sections 11-12 after a watchlist or portfolio change. A stock
// whose reason is watchlist or portfolio is re-derived: portfolio transactions keep it (portfolio),
// else a watchlist entry (watchlist), else imported prices keep it (imported), else a recent open
// leaves it to the LRU job (opened), else it is untracked. Imported prices are never deleted (D-C).
func recomputeTracking(ctx context.Context, db dbq.DBTX, id int32) error {
	_, err := db.Exec(ctx, `UPDATE instrument SET
		tracked_reason = CASE
		  WHEN EXISTS (SELECT 1 FROM portfolio_txn WHERE instrument_id = $1) THEN 'portfolio'
		  WHEN EXISTS (SELECT 1 FROM watchlist_item WHERE instrument_id = $1) THEN 'watchlist'
		  WHEN EXISTS (SELECT 1 FROM price_daily WHERE instrument_id = $1) THEN 'imported'
		  WHEN last_opened_at IS NOT NULL THEN 'opened'
		  ELSE NULL END,
		is_tracked = (
		  EXISTS (SELECT 1 FROM portfolio_txn WHERE instrument_id = $1)
		  OR EXISTS (SELECT 1 FROM watchlist_item WHERE instrument_id = $1)
		  OR EXISTS (SELECT 1 FROM price_daily WHERE instrument_id = $1)
		  OR last_opened_at IS NOT NULL)
		WHERE id = $1 AND is_tracked AND tracked_reason IN ('watchlist','portfolio')`, id)
	return err
}

// trackFor marks a stock tracked for a new watchlist entry or portfolio transaction. A watchlist
// add never overrides another reason except the LRU 'opened'; a portfolio add always wins.
func trackFor(ctx context.Context, db dbq.DBTX, id int32, reason string) error {
	_, err := db.Exec(ctx, `UPDATE instrument SET is_tracked = true,
		tracked_reason = CASE
		  WHEN $2 = 'portfolio' THEN 'portfolio'
		  WHEN NOT is_tracked OR tracked_reason IS NULL OR tracked_reason = 'opened' THEN $2
		  ELSE tracked_reason END
		WHERE id = $1`, id, reason)
	return err
}
