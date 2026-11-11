package mfhold

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/pagination"
)

// DB is the pool surface the service needs (pgxpool.Pool satisfies it).
type DB interface {
	dbq.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Refresher queues the mf_refresh job for a scheme without NAV rows (docs/03 section 10). The API
// only records the job; the worker fetches the data. May be nil.
type Refresher interface {
	EnqueueMFRefresh(ctx context.Context, code int32) error
}

// Service is the MF ledger use-case layer.
type Service struct {
	db      DB
	Now     func() time.Time
	Refresh Refresher
}

// New builds the service over a pool.
func New(db DB) *Service { return &Service{db: db, Now: time.Now} }

// TxnItem is one transaction as served (money as strings with 4 decimals).
type TxnItem struct {
	ID            int64   `json:"id"`
	AssetClass    string  `json:"asset_class"`
	SchemeCode    int32   `json:"scheme_code"`
	SchemeName    string  `json:"scheme_name"`
	ISIN          *string `json:"isin"`
	Plan          string  `json:"plan"`
	Option        string  `json:"option"`
	Folio         string  `json:"folio"`
	TxnType       string  `json:"txn_type"`
	TxnDate       string  `json:"txn_date"`
	Units         string  `json:"units"`
	NAV           string  `json:"nav"`
	Amount        string  `json:"amount"`
	StampDuty     string  `json:"stamp_duty"`
	ExternalRef   *string `json:"external_ref"`
	Source        string  `json:"source"`
	ImportBatchID *int64  `json:"import_batch_id"`
	Note          string  `json:"note"`
}

// TxnResult is the body of create/update; it is also what an idempotent replay returns.
type TxnResult struct {
	Txn      TxnItem `json:"txn"`
	Warnings []Warn  `json:"warnings"`
	Replayed bool    `json:"-"`
}

const txnCols = `t.id, t.scheme_code, m.name, m.isin_growth, m.isin_div_reinvest, coalesce(m.plan, 'unknown'),
	coalesce(m.option_type, 'unknown'), t.folio, t.txn_type, t.txn_date, t.units, t.nav, t.amount, t.stamp_duty,
	t.external_ref, t.source, t.import_batch_id, coalesce(t.note, '')`

func scanItem(row pgx.Row) (TxnItem, error) {
	var it TxnItem
	var g, r *string
	var d time.Time
	var units, nav, amount, stamp decimal.Decimal
	err := row.Scan(&it.ID, &it.SchemeCode, &it.SchemeName, &g, &r, &it.Plan, &it.Option, &it.Folio, &it.TxnType, &d,
		&units, &nav, &amount, &stamp, &it.ExternalRef, &it.Source, &it.ImportBatchID, &it.Note)
	it.AssetClass = "mf"
	it.TxnDate = d.Format(time.DateOnly)
	it.Units, it.NAV, it.Amount, it.StampDuty = units.StringFixed(4), nav.StringFixed(4), amount.StringFixed(4), stamp.StringFixed(4)
	if it.Option == "idcw" && r != nil {
		it.ISIN = r
	} else if g != nil {
		it.ISIN = g
	} else {
		it.ISIN = r
	}
	return it, err
}

// LockSchemes serialises writers per scheme for the rest of the transaction (two concurrent
// redemptions must not each pass validation on their own).
func LockSchemes(ctx context.Context, tx pgx.Tx, codes ...int32) error {
	sorted := append([]int32(nil), codes...)
	for i := range sorted {
		for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	for i, c := range sorted {
		if i > 0 && c == sorted[i-1] {
			continue
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7012, $1::int)`, c); err != nil {
			return err
		}
	}
	return nil
}

// LoadSchemeTxns reads every stored row of the given schemes.
func LoadSchemeTxns(ctx context.Context, db dbq.DBTX, codes []int32) ([]Txn, error) {
	rows, err := db.Query(ctx, `SELECT id, scheme_code, folio, txn_type, txn_date, units, nav, amount, stamp_duty
		FROM mf_txn WHERE scheme_code = ANY($1::int[]) ORDER BY txn_date, id`, codes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Txn
	for rows.Next() {
		var t Txn
		if err := rows.Scan(&t.ID, &t.Scheme, &t.Folio, &t.Type, &t.Date, &t.Units, &t.NAV, &t.Amount, &t.Stamp); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ValidateSchemes replays every ledger of the given schemes as of today and returns the first oversell.
func ValidateSchemes(ctx context.Context, db dbq.DBTX, codes []int32, now time.Time) error {
	ts, err := LoadSchemeTxns(ctx, db, codes)
	if err != nil {
		return err
	}
	return Validate(ts, Today(now))
}

// RecomputeTracking re-derives is_tracked after a transaction change (B11-6 style): a watchlist
// entry, remaining holdings or an open keep a scheme tracked.
func RecomputeTracking(ctx context.Context, db dbq.DBTX, code int32) error {
	_, err := db.Exec(ctx, `UPDATE mf_scheme SET is_tracked = (
		EXISTS (SELECT 1 FROM mf_txn WHERE scheme_code = $1)
		OR EXISTS (SELECT 1 FROM watchlist_item WHERE mf_scheme_code = $1)
		OR last_opened_at IS NOT NULL) WHERE code = $1`, code)
	return err
}

// TrackScheme marks a scheme tracked (it keeps refreshing NAV, docs/04).
func TrackScheme(ctx context.Context, db dbq.DBTX, code int32) error {
	_, err := db.Exec(ctx, `UPDATE mf_scheme SET is_tracked = true WHERE code = $1`, code)
	return err
}

type schemeRef struct {
	Code   int32
	Name   string
	Status string
}

func resolveScheme(ctx context.Context, db dbq.DBTX, code int64) (schemeRef, error) {
	var s schemeRef
	if code < 1 || code > 1<<31-1 {
		return s, &NotFoundError{What: "scheme", Details: map[string]any{"scheme_code": code}}
	}
	err := db.QueryRow(ctx, `SELECT code, name, status FROM mf_scheme WHERE code = $1`, code).Scan(&s.Code, &s.Name, &s.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, &NotFoundError{What: "scheme", Details: map[string]any{"scheme_code": code}}
	}
	return s, err
}

func nonBusinessWarning(ctx context.Context, db dbq.DBTX, d time.Time) ([]Warn, error) {
	weekend := d.Weekday() == time.Saturday || d.Weekday() == time.Sunday
	var holiday bool
	if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM market_holiday WHERE holiday_date = $1 AND segment = 'trading')`, d).Scan(&holiday); err != nil {
		return nil, err
	}
	if weekend || holiday {
		return []Warn{{Code: "NON_BUSINESS_DAY", Message: fmt.Sprintf("%s was a weekend or listed market holiday", d.Format(time.DateOnly))}}, nil
	}
	return nil, nil
}

// rowWarnings are the never-an-error warnings of a stored row.
func (s *Service) rowWarnings(ctx context.Context, db dbq.DBTX, code int32, v Values, id int64, checkDup bool) ([]Warn, error) {
	var out []Warn
	if (v.Type == TypePurchase || v.Type == TypeSIP || v.Type == TypeIDCWReinvest) && AmountMismatch(v.Units, v.NAV, v.Amount) {
		out = append(out, Warn{"AMOUNT_MISMATCH", fmt.Sprintf("units x NAV (%s) differs from the amount (%s) by more than max(1.00, 1%%); stamp duty is separate",
			v.Units.Mul(v.NAV).StringFixed(4), v.Amount.StringFixed(4))})
	}
	w, err := nonBusinessWarning(ctx, db, v.Date)
	if err != nil {
		return nil, err
	}
	out = append(out, w...)
	var first *time.Time
	if err := db.QueryRow(ctx, `SELECT min(nav_date) FROM mf_nav WHERE scheme_code = $1`, code).Scan(&first); err != nil {
		return nil, err
	}
	if first != nil && first.After(v.Date) {
		out = append(out, Warn{"NAV_FEED_STARTS_AFTER_TXN", fmt.Sprintf("NAV data for this scheme starts on %s, after this transaction", first.Format(time.DateOnly))})
	}
	if checkDup {
		var dup bool
		if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mf_txn WHERE scheme_code = $1 AND folio = $2 AND txn_date = $3
			AND txn_type = $4 AND units = $5 AND amount = $6 AND id <> $7)`, code, v.Folio, v.Date, v.Type, v.Units, v.Amount, id).Scan(&dup); err != nil {
			return nil, err
		}
		if dup {
			out = append(out, Warn{"DUPLICATE_LOOKING_TXN", "A transaction with the same scheme, folio, date, type, units and amount already exists"})
		}
	}
	return out, nil
}

var reUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IdempotencyKeyValid reports whether the header value is a UUID.
func IdempotencyKeyValid(k string) bool { return reUUID.MatchString(k) }

const idemScope = "mf_txn"

func claimKey(ctx context.Context, tx pgx.Tx, key, hash string) (*TxnResult, error) {
	if _, err := tx.Exec(ctx, `DELETE FROM idempotency_key WHERE created_at < now() - interval '24 hours'`); err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO idempotency_key (key, scope, request_hash) VALUES ($1::uuid, $3, $2)
		ON CONFLICT (key) DO NOTHING`, key, hash, idemScope)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 1 {
		return nil, nil
	}
	var gotHash, scope string
	var resp []byte
	if err := tx.QueryRow(ctx, `SELECT request_hash, scope, response FROM idempotency_key WHERE key = $1::uuid`, key).Scan(&gotHash, &scope, &resp); err != nil {
		return nil, err
	}
	if gotHash != hash || scope != idemScope {
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

func requestHash(code int32, v Values) string {
	b, _ := json.Marshal([]string{fmt.Sprint(code), v.Folio, v.Type, v.Date.Format(time.DateOnly), v.Units.String(), v.NAV.String(),
		v.Amount.String(), v.Stamp.String(), v.Note})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func orEmpty(w []Warn) []Warn {
	if w == nil {
		return []Warn{}
	}
	return w
}

// noteArg is NULL for an empty note.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Service) refreshIfNoNAV(ctx context.Context, code int32) {
	if s.Refresh == nil {
		return
	}
	var has bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mf_nav WHERE scheme_code = $1)`, code).Scan(&has); err != nil || has {
		return
	}
	_ = s.Refresh.EnqueueMFRefresh(ctx, code) // best effort: the transaction is already stored
}

// insufficientFor wraps an oversell with the transaction id of the row being written.
func isInsufficient(err error) bool {
	var ie *InsufficientError
	return errors.As(err, &ie)
}

// CreateTxn validates and stores a transaction (docs/03 12a). key is the optional Idempotency-Key
// (already checked to be a UUID).
func (s *Service) CreateTxn(ctx context.Context, in TxnInput, key string) (TxnResult, error) {
	var fe []FieldError
	var sch schemeRef
	if in.SchemeCode == nil {
		fe = append(fe, FieldError{"scheme_code", "is required"})
	}
	if in.Source != nil {
		fe = append(fe, FieldError{"source", "cannot be set; rows entered through the API are manual"})
	}
	var v Values
	fe = append(fe, ValidateValues(in, &v, s.Now(), true)...)
	if len(fe) > 0 {
		return TxnResult{}, &ValidationError{Fields: fe}
	}
	if v.Type != "" && !SupportedType(v.Type) {
		return TxnResult{}, &TypeUnsupportedError{Type: v.Type}
	}
	sch, err := resolveScheme(ctx, s.db, *in.SchemeCode)
	if err != nil {
		return TxnResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return TxnResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if key != "" {
		prior, err := claimKey(ctx, tx, key, requestHash(sch.Code, v))
		if err != nil {
			return TxnResult{}, err
		}
		if prior != nil {
			return *prior, nil
		}
	}
	if err := LockSchemes(ctx, tx, sch.Code); err != nil {
		return TxnResult{}, err
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO mf_txn (scheme_code, folio, txn_type, txn_date, units, nav, amount, stamp_duty, source, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9) RETURNING id`,
		sch.Code, v.Folio, v.Type, v.Date, v.Units, v.NAV, v.Amount, v.Stamp, nullable(v.Note)).Scan(&id); err != nil {
		return TxnResult{}, err
	}
	warns, err := s.rowWarnings(ctx, tx, sch.Code, v, id, true)
	if err != nil {
		return TxnResult{}, err
	}
	if v.Type == TypeRedemption {
		w, err := s.roundedWarning(ctx, tx, sch.Code, v.Folio, id)
		if err != nil {
			return TxnResult{}, err
		}
		warns = append(warns, w...)
	}
	if err := TrackScheme(ctx, tx, sch.Code); err != nil {
		return TxnResult{}, err
	}
	item, err := scanItem(tx.QueryRow(ctx, `SELECT `+txnCols+` FROM mf_txn t JOIN mf_scheme m ON m.code = t.scheme_code WHERE t.id = $1`, id))
	if err != nil {
		return TxnResult{}, err
	}
	res := TxnResult{Txn: item, Warnings: orEmpty(warns)}
	if key != "" {
		b, _ := json.Marshal(res)
		if _, err := tx.Exec(ctx, `UPDATE idempotency_key SET response = $2::jsonb WHERE key = $1::uuid`, key, string(b)); err != nil {
			return TxnResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return TxnResult{}, err
	}
	s.refreshIfNoNAV(ctx, sch.Code)
	return res, nil
}

// roundedWarning is UNITS_ROUNDED when the stored redemption `id` was clamped to the held units.
func (s *Service) roundedWarning(ctx context.Context, db dbq.DBTX, code int32, folio string, id int64) ([]Warn, error) {
	ts, err := LoadSchemeTxns(ctx, db, []int32{code})
	if err != nil {
		return nil, err
	}
	pos, err := Replay(onlyFolio(ts, folio), Today(s.Now()))
	if err != nil {
		return nil, err
	}
	for _, r := range pos.Rounded {
		if r == id {
			return []Warn{{"UNITS_ROUNDED", "The redemption exceeded the held units by rounding dust; it was clamped to the held units"}}, nil
		}
	}
	return nil, nil
}

// validateFolios replays only the given folios of a scheme (an edit must not be blocked by an
// unrelated folio that was already inconsistent, B15 review N2).
func validateFolios(ctx context.Context, db dbq.DBTX, code int32, folios []string, now time.Time) error {
	ts, err := LoadSchemeTxns(ctx, db, []int32{code})
	if err != nil {
		return err
	}
	var scoped []Txn
	for _, t := range ts {
		for _, f := range folios {
			if t.Folio == f {
				scoped = append(scoped, t)
				break
			}
		}
	}
	return Validate(scoped, Today(now))
}

func onlyFolio(ts []Txn, folio string) []Txn {
	var out []Txn
	for _, t := range ts {
		if t.Folio == folio {
			out = append(out, t)
		}
	}
	return out
}

// UpdateTxn applies a partial edit and re-validates the whole (scheme, folio) sequence of the old
// and the new folio (docs/03 12a).
func (s *Service) UpdateTxn(ctx context.Context, id int64, in TxnInput) (TxnResult, error) {
	var fe []FieldError
	if in.SchemeCode != nil {
		fe = append(fe, FieldError{"scheme_code", "cannot be changed; delete the transaction and create it again"})
	}
	if in.Source != nil {
		fe = append(fe, FieldError{"source", "cannot be changed"})
	}
	var v Values
	fe = append(fe, ValidateValues(in, &v, s.Now(), false)...)
	if len(fe) > 0 {
		return TxnResult{}, &ValidationError{Fields: fe}
	}
	if v.Type != "" && !SupportedType(v.Type) {
		return TxnResult{}, &TypeUnsupportedError{Type: v.Type}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return TxnResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var code int32
	var oldFolio string
	err = tx.QueryRow(ctx, `SELECT scheme_code, folio FROM mf_txn WHERE id = $1`, id).Scan(&code, &oldFolio)
	if errors.Is(err, pgx.ErrNoRows) {
		return TxnResult{}, &NotFoundError{What: "transaction", Details: map[string]any{"id": id}}
	}
	if err != nil {
		return TxnResult{}, err
	}
	if err := LockSchemes(ctx, tx, code); err != nil {
		return TxnResult{}, err
	}
	var folio, typ, note *string
	var date *time.Time
	var units, nav, amount, stamp *decimal.Decimal
	if v.Folio != "" {
		folio = &v.Folio
	}
	if v.Type != "" {
		typ = &v.Type
	}
	if in.Note != nil {
		note = &v.Note
	}
	if in.TxnDate != nil {
		date = &v.Date
	}
	if in.Units.Set {
		units = &v.Units
	}
	if in.NAV.Set {
		nav = &v.NAV
	}
	if in.Amount.Set {
		amount = &v.Amount
	}
	if in.StampDuty.Set {
		stamp = &v.Stamp
	}
	if _, err := tx.Exec(ctx, `UPDATE mf_txn SET folio = coalesce($2, folio), txn_type = coalesce($3, txn_type),
		txn_date = coalesce($4, txn_date), units = coalesce($5, units), nav = coalesce($6, nav), amount = coalesce($7, amount),
		stamp_duty = coalesce($8, stamp_duty), note = CASE WHEN $9::text IS NULL THEN note ELSE NULLIF($9::text, '') END,
		updated_at = now() WHERE id = $1`, id, folio, typ, date, units, nav, amount, stamp, note); err != nil {
		return TxnResult{}, err
	}
	item, err := scanItem(tx.QueryRow(ctx, `SELECT `+txnCols+` FROM mf_txn t JOIN mf_scheme m ON m.code = t.scheme_code WHERE t.id = $1`, id))
	if err != nil {
		return TxnResult{}, err
	}
	if err := validateFolios(ctx, tx, code, []string{oldFolio, item.Folio}, s.Now()); err != nil {
		return TxnResult{}, err
	}
	full := Values{Folio: item.Folio, Type: item.TxnType}
	full.Date, _ = ParseDay(item.TxnDate)
	full.Units, _ = decimal.NewFromString(item.Units)
	full.NAV, _ = decimal.NewFromString(item.NAV)
	full.Amount, _ = decimal.NewFromString(item.Amount)
	warns, err := s.rowWarnings(ctx, tx, code, full, id, false)
	if err != nil {
		return TxnResult{}, err
	}
	if item.TxnType == TypeRedemption {
		w, err := s.roundedWarning(ctx, tx, code, item.Folio, id)
		if err != nil {
			return TxnResult{}, err
		}
		warns = append(warns, w...)
	}
	if err := tx.Commit(ctx); err != nil {
		return TxnResult{}, err
	}
	return TxnResult{Txn: item, Warnings: orEmpty(warns)}, nil
}

// DeleteTxn removes a transaction unless the remaining sequence would oversell.
func (s *Service) DeleteTxn(ctx context.Context, id int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var code int32
	err = tx.QueryRow(ctx, `SELECT scheme_code FROM mf_txn WHERE id = $1`, id).Scan(&code)
	if errors.Is(err, pgx.ErrNoRows) {
		return &NotFoundError{What: "transaction", Details: map[string]any{"id": id}}
	}
	if err != nil {
		return err
	}
	if err := LockSchemes(ctx, tx, code); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mf_txn WHERE id = $1`, id); err != nil {
		return err
	}
	if err := ValidateSchemes(ctx, tx, []int32{code}, s.Now()); err != nil {
		return err
	}
	if err := RecomputeTracking(ctx, tx, code); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListParams are the GET /portfolio/mf/txns filters.
type ListParams struct {
	SchemeCode, Folio, Type, From, To, Source string
	Page                                      pagination.Params
}

// ListTxns lists transactions newest first (txn_date desc, id desc) with keyset pagination.
func (s *Service) ListTxns(ctx context.Context, p ListParams) (pagination.Page[TxnItem], error) {
	var fe []FieldError
	var code *int64
	if p.SchemeCode != "" {
		// Full match, range of the int4 column: "1abc" and 99999999999 are 422, never a 500 (B15 review S7).
		n, err := strconv.ParseInt(p.SchemeCode, 10, 64)
		if err != nil || n < 1 || n > 1<<31-1 {
			fe = append(fe, FieldError{"scheme_code", "must be a positive integer up to 2147483647"})
		} else {
			code = &n
		}
	}
	if p.Type != "" && !KnownType(p.Type) {
		fe = append(fe, FieldError{"type", "is not a transaction type"})
	}
	if p.Source != "" && p.Source != "manual" && p.Source != "import" {
		fe = append(fe, FieldError{"source", "must be manual or import"})
	}
	var from, to *time.Time
	if p.From != "" {
		if d, ok := ParseDay(p.From); ok {
			from = &d
		} else {
			fe = append(fe, FieldError{"from", "must be YYYY-MM-DD"})
		}
	}
	if p.To != "" {
		if d, ok := ParseDay(p.To); ok {
			to = &d
		} else {
			fe = append(fe, FieldError{"to", "must be YYYY-MM-DD"})
		}
	}
	if len(fe) > 0 {
		return pagination.Page[TxnItem]{}, &ValidationError{Fields: fe}
	}
	curDate, curID := time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), int64(1)<<62
	if p.Page.Cursor != "" {
		var raw [2]json.RawMessage
		if err := pagination.Decode(p.Page.Cursor, &raw); err != nil {
			return pagination.Page[TxnItem]{}, err
		}
		var ds string
		var cid int64
		d, ok := time.Time{}, false
		if json.Unmarshal(raw[0], &ds) == nil && json.Unmarshal(raw[1], &cid) == nil {
			d, ok = ParseDay(ds)
		}
		if !ok || cid < 1 {
			return pagination.Page[TxnItem]{}, pagination.ErrInvalidCursor
		}
		curDate, curID = d, cid
	}
	rows, err := s.db.Query(ctx, `SELECT `+txnCols+` FROM mf_txn t JOIN mf_scheme m ON m.code = t.scheme_code
		WHERE ($1::int IS NULL OR t.scheme_code = $1) AND ($2::text = '' OR t.folio = $2) AND ($3::text = '' OR t.txn_type = $3)
		AND ($4::date IS NULL OR t.txn_date >= $4) AND ($5::date IS NULL OR t.txn_date <= $5) AND ($6::text = '' OR t.source = $6)
		AND (t.txn_date, t.id) < ($7::date, $8::bigint)
		ORDER BY t.txn_date DESC, t.id DESC LIMIT $9`, code, strings.TrimSpace(p.Folio), p.Type, from, to, p.Source, curDate, curID, p.Page.Limit+1)
	if err != nil {
		return pagination.Page[TxnItem]{}, err
	}
	defer rows.Close()
	items := []TxnItem{}
	for rows.Next() {
		it, err := scanItem(rows)
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
		c, err := pagination.Encode(last.TxnDate, last.ID)
		if err != nil {
			return page, err
		}
		page.NextCursor = &c
	}
	return page, nil
}
