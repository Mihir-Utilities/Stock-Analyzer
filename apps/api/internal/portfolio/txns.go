package portfolio

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/pagination"
)

// Service is the watchlist and portfolio use-case layer.
type Service struct {
	db  DB
	Now func() time.Time
}

// New builds the service over a pool.
func New(db DB) *Service { return &Service{db: db, Now: time.Now} }

// TxnItem is one transaction as served (money as strings with 4 decimals).
type TxnItem struct {
	ID        int64     `json:"id"`
	Symbol    string    `json:"symbol"`
	Name      string    `json:"name"`
	Side      string    `json:"side"`
	Qty       string    `json:"qty"`
	Price     string    `json:"price"`
	Fees      string    `json:"fees"`
	TradeDate string    `json:"trade_date"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// TxnResult is the body of create/update responses; it is also what an idempotent replay returns.
type TxnResult struct {
	Txn      TxnItem `json:"txn"`
	Warnings []Warn  `json:"warnings"`
	Replayed bool    `json:"-"`
}

const txnCols = `t.id, i.symbol, i.name, t.side, t.qty, t.price, t.fees, t.trade_date, coalesce(t.note, ''), t.created_at, t.updated_at`

func scanTxn(row pgx.Row) (TxnItem, int32, error) {
	var it TxnItem
	var qty, price, fees decimal.Decimal
	var d time.Time
	var inst int32
	err := row.Scan(&it.ID, &it.Symbol, &it.Name, &it.Side, &qty, &price, &fees, &d, &it.Note, &it.CreatedAt, &it.UpdatedAt, &inst)
	it.Qty, it.Price, it.Fees, it.TradeDate = qty.StringFixed(4), price.StringFixed(4), fees.StringFixed(4), ymd(d)
	return it, inst, err
}

// validateValues checks the trade fields against docs/03 section 12. listing may be nil.
func (s *Service) validateValues(in TxnInput, v *txnValues, listing *time.Time, needAll bool) []FieldError {
	var fe []FieldError
	if in.Side != nil {
		if *in.Side != "buy" && *in.Side != "sell" {
			fe = append(fe, FieldError{"side", "must be buy or sell"})
		} else {
			v.Side = *in.Side
		}
	} else if needAll {
		fe = append(fe, FieldError{"side", "is required"})
	}
	if in.Qty.Set || needAll {
		q, msg := parseDecimal(in.Qty, 4)
		switch {
		case msg != "":
			fe = append(fe, FieldError{"qty", msg})
		case !q.IsPositive() || q.GreaterThan(qtyMax):
			fe = append(fe, FieldError{"qty", "must be > 0 and <= 1e9"})
		default:
			v.Qty = q
		}
	}
	if in.Price.Set || needAll {
		p, msg := parseDecimal(in.Price, 4)
		switch {
		case msg != "":
			fe = append(fe, FieldError{"price", msg})
		case !p.IsPositive() || p.GreaterThan(moneyMax):
			fe = append(fe, FieldError{"price", "must be > 0"})
		default:
			v.Price = p
		}
	}
	if in.Fees.Set {
		f, msg := parseDecimal(in.Fees, 4)
		switch {
		case msg != "":
			fe = append(fe, FieldError{"fees", msg})
		case f.GreaterThan(moneyMax):
			fe = append(fe, FieldError{"fees", "must be >= 0"})
		default:
			v.Fees = f
		}
	}
	if in.TradeDate != nil || needAll {
		raw := ""
		if in.TradeDate != nil {
			raw = *in.TradeDate
		}
		d, ok := parseDate(raw)
		switch {
		case !ok:
			fe = append(fe, FieldError{"trade_date", "must be YYYY-MM-DD"})
		case d.After(today(s.Now())):
			fe = append(fe, FieldError{"trade_date", "must not be in the future (IST)"})
		case listing != nil && d.Before(*listing):
			fe = append(fe, FieldError{"trade_date", "must not be before the listing date " + ymd(*listing)})
		default:
			v.Date = d
		}
	}
	v.Note = validateNote(in.Note, &fe)
	return fe
}

// nonTradingWarning is the PF-06 warning (never an error).
func nonTradingWarning(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, d time.Time) ([]Warn, error) {
	weekend := d.Weekday() == time.Saturday || d.Weekday() == time.Sunday
	var holiday bool
	if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM market_holiday WHERE holiday_date = $1 AND segment = 'trading')`, d).Scan(&holiday); err != nil {
		return nil, err
	}
	if weekend || holiday {
		return []Warn{{Code: "NON_TRADING_DAY", Message: fmt.Sprintf("%s was a weekend or listed market holiday", ymd(d))}}, nil
	}
	return nil, nil
}

var reUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IdempotencyKeyValid reports whether the header value is a UUID.
func IdempotencyKeyValid(k string) bool { return reUUID.MatchString(k) }

// claimKey claims an Idempotency-Key inside the transaction. It returns a stored result when the
// key was already used with the same request (replay), or a conflict when the request differs. A
// concurrent first use blocks on the unique index until the other transaction commits.
func claimKey(ctx context.Context, tx pgx.Tx, key, hash string) (*TxnResult, error) {
	if _, err := tx.Exec(ctx, `DELETE FROM idempotency_key WHERE created_at < now() - interval '24 hours'`); err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO idempotency_key (key, scope, request_hash) VALUES ($1::uuid, 'portfolio_txn', $2)
		ON CONFLICT (key) DO NOTHING`, key, hash)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 1 {
		return nil, nil
	}
	var gotHash string
	var resp []byte
	if err := tx.QueryRow(ctx, `SELECT request_hash, response FROM idempotency_key WHERE key = $1::uuid`, key).Scan(&gotHash, &resp); err != nil {
		return nil, err
	}
	if gotHash != hash {
		return nil, &ConflictError{Message: "Idempotency-Key was already used with a different request"}
	}
	if resp == nil {
		return nil, &ConflictError{Message: "A request with this Idempotency-Key is still being processed"}
	}
	var res TxnResult
	if err := json.Unmarshal(resp, &res); err != nil {
		return nil, err
	}
	res.Replayed = true
	return &res, nil
}

func requestHash(sym string, v txnValues) string {
	b, _ := json.Marshal([]string{strings.ToUpper(sym), v.Side, v.Qty.String(), v.Price.String(), v.Fees.String(), ymd(v.Date), v.Note})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// CreateTxn validates and stores a transaction (docs/03 section 12). key is the optional
// Idempotency-Key (already checked to be a UUID).
func (s *Service) CreateTxn(ctx context.Context, in TxnInput, key string) (TxnResult, error) {
	var fe []FieldError
	if in.Symbol == nil || strings.TrimSpace(*in.Symbol) == "" {
		fe = append(fe, FieldError{"symbol", "is required"})
	}
	var inst instrumentRef
	if len(fe) == 0 {
		var err error
		inst, err = resolve(ctx, s.db, strings.TrimSpace(*in.Symbol))
		var nf *NotFoundError
		if errors.As(err, &nf) {
			fe = append(fe, FieldError{"symbol", "does not resolve to an instrument"})
		} else if err != nil {
			return TxnResult{}, err
		}
	}
	var v txnValues
	fe = append(fe, s.validateValues(in, &v, inst.Listing, true)...)
	if len(fe) > 0 {
		return TxnResult{}, &ValidationError{Fields: fe}
	}
	warns, err := nonTradingWarning(ctx, s.db, v.Date)
	if err != nil {
		return TxnResult{}, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return TxnResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hash := requestHash(inst.Symbol, v)
	if key != "" {
		prior, err := claimKey(ctx, tx, key, hash)
		if err != nil {
			return TxnResult{}, err
		}
		if prior != nil {
			return *prior, nil
		}
	}
	if err := lockInstruments(ctx, tx, inst.ID); err != nil {
		return TxnResult{}, err
	}
	row := tx.QueryRow(ctx, `WITH t AS (
		INSERT INTO portfolio_txn (instrument_id, side, qty, price, fees, trade_date, note)
		VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')) RETURNING *)
		SELECT `+txnCols+`, t.instrument_id FROM t JOIN instrument i ON i.id = t.instrument_id`,
		inst.ID, v.Side, v.Qty, v.Price, v.Fees, v.Date, v.Note)
	item, _, err := scanTxn(row)
	if err != nil {
		return TxnResult{}, err
	}
	if err := validateSequence(ctx, tx, inst.ID, s.Now()); err != nil {
		return TxnResult{}, err
	}
	if err := trackFor(ctx, tx, inst.ID, "portfolio"); err != nil {
		return TxnResult{}, err
	}
	res := TxnResult{Txn: item, Warnings: orEmpty(warns)}
	if key != "" {
		b, _ := json.Marshal(res)
		if _, err := tx.Exec(ctx, `UPDATE idempotency_key SET response = $2::jsonb WHERE key = $1::uuid`, key, string(b)); err != nil {
			return TxnResult{}, err
		}
	}
	return res, tx.Commit(ctx)
}

func orEmpty(w []Warn) []Warn {
	if w == nil {
		return []Warn{}
	}
	return w
}

// UpdateTxn applies a partial edit and re-validates the whole sequence of every affected symbol.
func (s *Service) UpdateTxn(ctx context.Context, id int64, in TxnInput) (TxnResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return TxnResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var oldInst int32
	var oldSym string
	if err := tx.QueryRow(ctx, `SELECT t.instrument_id, i.symbol FROM portfolio_txn t JOIN instrument i ON i.id = t.instrument_id WHERE t.id = $1`, id).
		Scan(&oldInst, &oldSym); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TxnResult{}, &NotFoundError{What: "transaction", Details: map[string]any{"id": id}}
		}
		return TxnResult{}, err
	}
	newInst := instrumentRef{ID: oldInst, Symbol: oldSym}
	var fe []FieldError
	if in.Symbol != nil {
		r, err := resolve(ctx, tx, strings.TrimSpace(*in.Symbol))
		var nf *NotFoundError
		switch {
		case errors.As(err, &nf):
			fe = append(fe, FieldError{"symbol", "does not resolve to an instrument"})
		case err != nil:
			return TxnResult{}, err
		default:
			newInst = r
		}
	}
	if newInst.Listing == nil && newInst.ID == oldInst { // load the listing date of the unchanged symbol
		var l *time.Time
		if err := tx.QueryRow(ctx, `SELECT listing_date FROM instrument WHERE id = $1`, oldInst).Scan(&l); err != nil {
			return TxnResult{}, err
		}
		newInst.Listing = l
	}
	var v txnValues
	fe = append(fe, s.validateValues(in, &v, newInst.Listing, false)...)
	if len(fe) > 0 {
		return TxnResult{}, &ValidationError{Fields: fe}
	}
	if err := lockInstruments(ctx, tx, oldInst, newInst.ID); err != nil {
		return TxnResult{}, err
	}
	// COALESCE keeps the stored value for every field the request left out.
	var side, note *string
	var qty, price, fees *decimal.Decimal
	var date *time.Time
	if v.Side != "" {
		side = &v.Side
	}
	if in.Note != nil {
		note = &v.Note
	}
	if in.Qty.Set {
		qty = &v.Qty
	}
	if in.Price.Set {
		price = &v.Price
	}
	if in.Fees.Set {
		fees = &v.Fees
	}
	if in.TradeDate != nil {
		date = &v.Date
	}
	row := tx.QueryRow(ctx, `WITH t AS (
		UPDATE portfolio_txn SET instrument_id = $2, side = coalesce($3, side), qty = coalesce($4, qty),
		  price = coalesce($5, price), fees = coalesce($6, fees), trade_date = coalesce($7, trade_date),
		  note = CASE WHEN $8::text IS NULL THEN note ELSE NULLIF($8::text, '') END, updated_at = now()
		WHERE id = $1 RETURNING *)
		SELECT `+txnCols+`, t.instrument_id FROM t JOIN instrument i ON i.id = t.instrument_id`,
		id, newInst.ID, side, qty, price, fees, date, note)
	item, _, err := scanTxn(row)
	if err != nil {
		return TxnResult{}, err
	}
	for _, inst := range uniq(oldInst, newInst.ID) {
		if err := validateSequence(ctx, tx, inst, s.Now()); err != nil {
			return TxnResult{}, err
		}
		if err := recomputeTracking(ctx, tx, inst); err != nil {
			return TxnResult{}, err
		}
	}
	if err := trackFor(ctx, tx, newInst.ID, "portfolio"); err != nil {
		return TxnResult{}, err
	}
	d, _ := parseDate(item.TradeDate)
	warns, err := nonTradingWarning(ctx, tx, d)
	if err != nil {
		return TxnResult{}, err
	}
	return TxnResult{Txn: item, Warnings: orEmpty(warns)}, tx.Commit(ctx)
}

func uniq(a, b int32) []int32 {
	if a == b {
		return []int32{a}
	}
	return []int32{a, b}
}

// DeleteTxn removes a transaction unless the remaining sequence would oversell.
func (s *Service) DeleteTxn(ctx context.Context, id int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var inst int32
	if err := tx.QueryRow(ctx, `SELECT instrument_id FROM portfolio_txn WHERE id = $1`, id).Scan(&inst); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &NotFoundError{What: "transaction", Details: map[string]any{"id": id}}
		}
		return err
	}
	if err := lockInstruments(ctx, tx, inst); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM portfolio_txn WHERE id = $1`, id); err != nil {
		return err
	}
	if err := validateSequence(ctx, tx, inst, s.Now()); err != nil {
		return err
	}
	if err := recomputeTracking(ctx, tx, inst); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TxnListParams are the GET /portfolio/txns filters.
type TxnListParams struct {
	Symbol string
	Page   pagination.Params
}

// ListTxns lists transactions newest first (trade_date desc, id desc) with keyset pagination.
func (s *Service) ListTxns(ctx context.Context, p TxnListParams) (pagination.Page[TxnItem], error) {
	var instFilter *int32
	if p.Symbol != "" {
		r, err := resolve(ctx, s.db, p.Symbol)
		if err != nil {
			return pagination.Page[TxnItem]{}, err
		}
		instFilter = &r.ID
	}
	curDate, curID := time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), int64(1)<<62
	if p.Page.Cursor != "" {
		var raw [2]json.RawMessage // keys written by pagination.Encode(trade_date, id)
		if err := pagination.Decode(p.Page.Cursor, &raw); err != nil {
			return pagination.Page[TxnItem]{}, err
		}
		var ds string
		var id int64
		d, ok := time.Time{}, false
		if json.Unmarshal(raw[0], &ds) == nil && json.Unmarshal(raw[1], &id) == nil {
			d, ok = parseDate(ds)
		}
		if !ok || id < 1 {
			return pagination.Page[TxnItem]{}, pagination.ErrInvalidCursor
		}
		curDate, curID = d, id
	}
	rows, err := s.db.Query(ctx, `SELECT `+txnCols+`, t.instrument_id FROM portfolio_txn t JOIN instrument i ON i.id = t.instrument_id
		WHERE ($1::int IS NULL OR t.instrument_id = $1) AND (t.trade_date, t.id) < ($2::date, $3::bigint)
		ORDER BY t.trade_date DESC, t.id DESC LIMIT $4`, instFilter, curDate, curID, p.Page.Limit+1)
	if err != nil {
		return pagination.Page[TxnItem]{}, err
	}
	defer rows.Close()
	items := []TxnItem{}
	for rows.Next() {
		it, _, err := scanTxn(rows)
		if err != nil {
			return pagination.Page[TxnItem]{}, err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return pagination.Page[TxnItem]{}, err
	}
	page := pagination.Page[TxnItem]{Items: items}
	if len(items) > p.Page.Limit {
		page.Items = items[:p.Page.Limit]
		last := page.Items[len(page.Items)-1]
		c, err := pagination.Encode(last.TradeDate, last.ID)
		if err != nil {
			return page, err
		}
		page.NextCursor = &c
	}
	return page, nil
}
