// Package journal is the owner's decision journal (docs/03 section 13a, decision plan Item D, B20): short
// dated notes about one stock with the price at the time, an optional review date, a status and an
// optional link to one of the owner's own transactions.
//
// A note is untrusted plain text. It is validated here, stored as typed (trimmed), returned as typed
// and never logged, exported or sent anywhere. "Review due" is computed on read from the owner's IST
// date (Service.Now), never stored.
package journal

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/pagination"
)

const (
	// MaxNoteChars is the longest note (JRN-1).
	MaxNoteChars = 1000
	// MaxNotesPerStock bounds the table (JRN-3).
	MaxNotesPerStock = 500
	// maxReviewYears is how far ahead a review date may be set.
	maxReviewYears = 10
	// PriceSource labels the price at the time.
	PriceSource = "your imported prices"
	// ReasonNoPrice is the price_reason when no imported close exists.
	ReasonNoPrice = "no_price_imported"

	scope = "journal_note"
)

// IST is the market time zone (India has no DST).
var IST = time.FixedZone("IST", 5*3600+30*60)

// DB is the database surface the service needs.
type DB interface {
	dbq.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service reads and writes journal notes.
type Service struct {
	db  DB
	Now func() time.Time // injectable so tests never use the wall clock
}

// New returns a Service on the real clock.
func New(db DB) *Service { return &Service{db: db, Now: time.Now} }

// FieldError is one validation failure (422 details.fields[]).
type FieldError struct{ Field, Message string }

// ValidationError carries every field failure of one request.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "journal: validation failed" }

// NotFoundError names what was not found.
type NotFoundError struct {
	What    string
	Details map[string]any
}

func (e *NotFoundError) Error() string { return "journal: " + e.What + " not found" }

// ConflictError is a 409 with a message.
type ConflictError struct{ Message string }

func (e *ConflictError) Error() string { return e.Message }

// Txn is the linked transaction summary (decimal strings like docs/03 section 12).
type Txn struct {
	ID        int64  `json:"id"`
	Side      string `json:"side"`
	Qty       string `json:"qty"`
	Price     string `json:"price"`
	TradeDate string `json:"trade_date"`
}

// Item is one journal note as the API returns it.
type Item struct {
	ID             int64      `json:"id"`
	Symbol         string     `json:"symbol"`
	NotedOn        string     `json:"noted_on"`
	Note           string     `json:"note"`
	PriceAtNote    *string    `json:"price_at_note"`
	PriceAsOf      *string    `json:"price_as_of"`
	PriceSource    string     `json:"price_source"`
	PriceReason    *string    `json:"price_reason"`
	ReviewOn       *string    `json:"review_on"`
	Status         string     `json:"status"`
	ReviewedAt     *time.Time `json:"reviewed_at"`
	ReviewDue      bool       `json:"review_due"`
	PortfolioTxnID *int64     `json:"portfolio_txn_id"`
	Txn            *Txn       `json:"txn"`
}

// Page is the data of GET /stocks/{symbol}/journal.
type Page struct {
	Items          []Item  `json:"items"`
	NextCursor     *string `json:"next_cursor"`
	Today          string  `json:"today"`
	ReviewDueCount int     `json:"review_due_count"`
}

// CreateInput is the body of POST /stocks/{symbol}/journal.
type CreateInput struct {
	Note           *string `json:"note"`
	ReviewOn       *string `json:"review_on"`
	PortfolioTxnID *int64  `json:"portfolio_txn_id"`
}

// PatchInput is the body of PATCH /journal/{id}. A nil RawMessage means "key absent"; the JSON
// literal null means "clear".
type PatchInput struct {
	Note           *string         `json:"note"`
	ReviewOn       json.RawMessage `json:"review_on"`
	Status         *string         `json:"status"`
	PortfolioTxnID json.RawMessage `json:"portfolio_txn_id"`
}

// Result is a created or edited note plus the replay marker.
type Result struct {
	Item     Item
	Replayed bool
}

// Today is the IST market date of now (00:00 UTC carrying the IST date).
func Today(now time.Time) time.Time {
	i := now.In(IST)
	return time.Date(i.Year(), i.Month(), i.Day(), 0, 0, 0, 0, time.UTC)
}

// ReviewDue is true exactly when the note is open, has a review date and that date is today or
// earlier (the date itself counts as due). All dates are IST market dates.
func ReviewDue(status string, reviewOn *time.Time, today time.Time) bool {
	return status == "open" && reviewOn != nil && !reviewOn.After(today)
}

// NormalizeNote trims the note and turns CRLF and lone CR into LF.
func NormalizeNote(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.TrimSpace(s)
}

// ValidateNote checks length (in characters) and control characters. It returns the normalised
// text and the field errors.
func ValidateNote(raw *string) (string, []FieldError) {
	if raw == nil {
		return "", []FieldError{{"note", "is required"}}
	}
	n := NormalizeNote(*raw)
	if n == "" || strings.TrimSpace(strings.Map(dropInvisible, n)) == "" {
		return "", []FieldError{{"note", "must not be blank"}}
	}
	if !utf8.ValidString(n) {
		return "", []FieldError{{"note", "must be valid text"}}
	}
	if utf8.RuneCountInString(n) > MaxNoteChars {
		return "", []FieldError{{"note", "must be at most 1000 characters"}}
	}
	for _, r := range n {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return "", []FieldError{{"note", "must not contain control characters"}}
		}
		if isBidiControl(r) {
			return "", []FieldError{{"note", "must not contain text-direction control characters"}}
		}
	}
	return n, nil
}

// dropInvisible removes zero-width characters so a note made only of them counts as blank (JRN-7).
func dropInvisible(r rune) rune {
	switch {
	case r >= 0x200B && r <= 0x200D, r == 0x2060, r == 0xFEFF:
		return -1
	}
	return r
}

// isBidiControl is true for the bidirectional embedding, override and isolate controls, which can
// reorder surrounding text. Zero-width joiners stay allowed (emoji sequences). JRN-7.
func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// txnLinkError maps the foreign-key failure of a transaction deleted between the check and the write.
func txnLinkError(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23503" && strings.Contains(pe.ConstraintName, "portfolio_txn") {
		return &ValidationError{Fields: []FieldError{{"portfolio_txn_id", errTxn}}}
	}
	return err
}

// ParseReviewOn validates a review date against today. keep is the stored value on an edit: it may
// be a past date only when unchanged.
func ParseReviewOn(raw string, today time.Time, keep *time.Time) (time.Time, *FieldError) {
	d, err := time.Parse(time.DateOnly, raw)
	if err != nil {
		return time.Time{}, &FieldError{"review_on", "must be a date as YYYY-MM-DD"}
	}
	if keep != nil && d.Equal(*keep) {
		return d, nil
	}
	if d.Before(today) {
		return time.Time{}, &FieldError{"review_on", "must be today or later"}
	}
	if d.After(today.AddDate(maxReviewYears, 0, 0)) {
		return time.Time{}, &FieldError{"review_on", "must be within 10 years from today"}
	}
	return d, nil
}

var reUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IdempotencyKeyValid reports whether the header value is a UUID.
func IdempotencyKeyValid(k string) bool { return reUUID.MatchString(k) }

type instrumentRef struct {
	ID     int32
	Symbol string
}

// resolve finds an instrument by symbol (case-insensitive), then through symbol_alias.
func resolve(ctx context.Context, db dbq.DBTX, symbol string) (instrumentRef, error) {
	var r instrumentRef
	scan := func(row pgx.Row) error { return row.Scan(&r.ID, &r.Symbol) }
	err := scan(db.QueryRow(ctx, `SELECT i.id, i.symbol FROM instrument i WHERE upper(i.symbol) = upper($1::text)
		ORDER BY (i.symbol = $1::text) DESC, i.id LIMIT 1`, symbol))
	if errors.Is(err, pgx.ErrNoRows) {
		err = scan(db.QueryRow(ctx, `SELECT i.id, i.symbol FROM symbol_alias a JOIN instrument i ON i.id = a.instrument_id
			WHERE upper(a.old_symbol) = upper($1::text) ORDER BY a.changed_on DESC NULLS LAST, i.id LIMIT 1`, symbol))
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return r, &NotFoundError{What: "instrument", Details: map[string]any{"symbol": symbol}}
	}
	return r, err
}

const itemCols = `n.id, i.symbol, n.noted_on, n.note_text, n.price_at_note::text, n.price_as_of, n.review_on, n.status,
	n.reviewed_at, n.portfolio_txn_id, t.id, t.side, t.qty::text, t.price::text, t.trade_date`

const itemFrom = ` FROM journal_note n JOIN instrument i ON i.id = n.instrument_id
	LEFT JOIN portfolio_txn t ON t.id = n.portfolio_txn_id`

func ymd(t time.Time) string { return t.Format(time.DateOnly) }

func fixed4(s string) string {
	d, err := decimal.NewFromString(s)
	if err != nil {
		return s
	}
	return d.StringFixed(4)
}

func scanItem(row pgx.Row, today time.Time) (Item, error) {
	var it Item
	var notedOn time.Time
	var price *string
	var asOf, reviewOn, tradeDate *time.Time
	var tID *int64
	var side, qty, tprice *string
	if err := row.Scan(&it.ID, &it.Symbol, &notedOn, &it.Note, &price, &asOf, &reviewOn, &it.Status,
		&it.ReviewedAt, &it.PortfolioTxnID, &tID, &side, &qty, &tprice, &tradeDate); err != nil {
		return Item{}, err
	}
	it.NotedOn = ymd(notedOn)
	it.PriceSource = PriceSource
	if price != nil && asOf != nil {
		p := fixed4(*price)
		a := ymd(*asOf)
		it.PriceAtNote, it.PriceAsOf = &p, &a
	} else {
		r := ReasonNoPrice
		it.PriceReason = &r
	}
	if reviewOn != nil {
		r := ymd(*reviewOn)
		it.ReviewOn = &r
	}
	it.ReviewDue = ReviewDue(it.Status, reviewOn, today)
	if tID != nil && side != nil && qty != nil && tprice != nil && tradeDate != nil {
		it.Txn = &Txn{ID: *tID, Side: *side, Qty: fixed4(*qty), Price: fixed4(*tprice), TradeDate: ymd(*tradeDate)}
	}
	return it, nil
}

// List returns the notes of a stock, newest first, with the owner's IST date and the number of due
// notes. status is "" (all), "open" or "reviewed".
func (s *Service) List(ctx context.Context, symbol, status string, p pagination.Params) (Page, error) {
	var fe []FieldError
	if status != "" && status != "open" && status != "reviewed" {
		fe = append(fe, FieldError{"status", "must be open or reviewed"})
	}
	var curDate *time.Time
	var curID int64
	if p.Cursor != "" {
		var raw []json.RawMessage
		if err := pagination.Decode(p.Cursor, &raw); err != nil || len(raw) != 2 {
			return Page{}, pagination.ErrInvalidCursor
		}
		var ds string
		if json.Unmarshal(raw[0], &ds) != nil || json.Unmarshal(raw[1], &curID) != nil {
			return Page{}, pagination.ErrInvalidCursor
		}
		d, err := time.Parse(time.DateOnly, ds)
		if err != nil {
			return Page{}, pagination.ErrInvalidCursor
		}
		curDate = &d
	}
	if len(fe) > 0 {
		return Page{}, &ValidationError{Fields: fe}
	}
	inst, err := resolve(ctx, s.db, symbol)
	if err != nil {
		return Page{}, err
	}
	today := Today(s.Now())
	rows, err := s.db.Query(ctx, `SELECT `+itemCols+itemFrom+`
		WHERE n.instrument_id = $1 AND ($2::text = '' OR n.status = $2)
		  AND ($3::date IS NULL OR (n.noted_on, n.id) < ($3::date, $4::bigint))
		ORDER BY n.noted_on DESC, n.id DESC LIMIT $5`, inst.ID, status, curDate, curID, p.Limit+1)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	var items []Item
	for rows.Next() {
		it, err := scanItem(rows, today)
		if err != nil {
			return Page{}, err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	pg, err := pagination.NewPage(items, p.Limit, func(last Item) (string, error) {
		return pagination.Encode(last.NotedOn, last.ID)
	})
	if err != nil {
		return Page{}, err
	}
	out := Page{Items: pg.Items, NextCursor: pg.NextCursor, Today: ymd(today)}
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM journal_note WHERE instrument_id = $1 AND status = 'open'
		AND review_on IS NOT NULL AND review_on <= $2`, inst.ID, today).Scan(&out.ReviewDueCount); err != nil {
		return Page{}, err
	}
	return out, nil
}

// txnBelongs checks that the transaction exists and is a transaction of the instrument.
func txnBelongs(ctx context.Context, db dbq.DBTX, txnID int64, inst int32) (bool, error) {
	var n int
	err := db.QueryRow(ctx, `SELECT count(*) FROM portfolio_txn WHERE id = $1 AND instrument_id = $2`, txnID, inst).Scan(&n)
	return n == 1, err
}

const errTxn = "must be a transaction of this stock"

// Create validates and stores a note. key is the optional Idempotency-Key (already checked).
func (s *Service) Create(ctx context.Context, symbol string, in CreateInput, key string) (Result, error) {
	inst, err := resolve(ctx, s.db, symbol)
	if err != nil {
		return Result{}, err
	}
	today := Today(s.Now())
	note, fe := ValidateNote(in.Note)
	var reviewOn *time.Time
	if in.ReviewOn != nil {
		d, ferr := ParseReviewOn(*in.ReviewOn, today, nil)
		if ferr != nil {
			fe = append(fe, *ferr)
		} else {
			reviewOn = &d
		}
	}
	if in.PortfolioTxnID != nil {
		ok, err := txnBelongs(ctx, s.db, *in.PortfolioTxnID, inst.ID)
		if err != nil {
			return Result{}, err
		}
		if !ok {
			fe = append(fe, FieldError{"portfolio_txn_id", errTxn})
		}
	}
	if len(fe) > 0 {
		return Result{}, &ValidationError{Fields: fe}
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if key != "" {
		prior, err := claimKey(ctx, tx, key, requestHash(inst.Symbol, note, in.ReviewOn, in.PortfolioTxnID))
		if err != nil {
			return Result{}, err
		}
		if prior != nil {
			return Result{Item: *prior, Replayed: true}, nil
		}
	}
	// Serialise creates per stock so two concurrent requests cannot both pass the cap (N1).
	if _, err := tx.Exec(ctx, `SELECT 1 FROM instrument WHERE id = $1 FOR NO KEY UPDATE`, inst.ID); err != nil {
		return Result{}, err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM journal_note WHERE instrument_id = $1`, inst.ID).Scan(&n); err != nil {
		return Result{}, err
	}
	if n >= MaxNotesPerStock {
		return Result{}, &ConflictError{Message: "This stock already has 500 journal notes. Delete an old one first."}
	}
	var price *string
	var priceDate *time.Time
	err = tx.QueryRow(ctx, `SELECT close::text, trade_date FROM price_daily
		WHERE instrument_id = $1 AND NOT suspect AND trade_date <= $2 ORDER BY trade_date DESC LIMIT 1`,
		inst.ID, today).Scan(&price, &priceDate)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO journal_note (instrument_id, noted_on, note_text, price_at_note, price_as_of, review_on, portfolio_txn_id)
		VALUES ($1, $2, $3, $4::numeric, $5, $6, $7) RETURNING id`,
		inst.ID, today, note, price, priceDate, reviewOn, in.PortfolioTxnID).Scan(&id); err != nil {
		return Result{}, txnLinkError(err)
	}
	item, err := scanItem(tx.QueryRow(ctx, `SELECT `+itemCols+itemFrom+` WHERE n.id = $1`, id), today)
	if err != nil {
		return Result{}, err
	}
	if key != "" {
		b, _ := json.Marshal(item)
		if _, err := tx.Exec(ctx, `UPDATE idempotency_key SET response = $2::jsonb WHERE key = $1::uuid`, key, string(b)); err != nil {
			return Result{}, err
		}
	}
	return Result{Item: item}, tx.Commit(ctx)
}

// Update applies a partial edit.
func (s *Service) Update(ctx context.Context, id int64, in PatchInput) (Item, error) {
	if in.Note == nil && in.ReviewOn == nil && in.Status == nil && in.PortfolioTxnID == nil {
		return Item{}, &ValidationError{Fields: []FieldError{{"body", "at least one of note, review_on, status, portfolio_txn_id is required"}}}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Item{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var inst int32
	var curReview *time.Time
	var curStatus string
	var curTxn *int64
	if err := tx.QueryRow(ctx, `SELECT instrument_id, review_on, status, portfolio_txn_id FROM journal_note WHERE id = $1 FOR UPDATE`, id).
		Scan(&inst, &curReview, &curStatus, &curTxn); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Item{}, &NotFoundError{What: "journal note", Details: map[string]any{"id": id}}
		}
		return Item{}, err
	}
	today := Today(s.Now())
	var fe []FieldError
	note := ""
	if in.Note != nil {
		var f []FieldError
		note, f = ValidateNote(in.Note)
		fe = append(fe, f...)
	}
	newReview := curReview
	if in.ReviewOn != nil {
		if isNull(in.ReviewOn) {
			newReview = nil
		} else {
			var ds string
			if json.Unmarshal(in.ReviewOn, &ds) != nil {
				fe = append(fe, FieldError{"review_on", "must be a date as YYYY-MM-DD or null"})
			} else if d, ferr := ParseReviewOn(ds, today, curReview); ferr != nil {
				fe = append(fe, *ferr)
			} else {
				newReview = &d
			}
		}
	}
	newStatus := curStatus
	if in.Status != nil {
		if *in.Status != "open" && *in.Status != "reviewed" {
			fe = append(fe, FieldError{"status", "must be open or reviewed"})
		} else {
			newStatus = *in.Status
		}
	}
	newTxn := curTxn
	if in.PortfolioTxnID != nil {
		if isNull(in.PortfolioTxnID) {
			newTxn = nil
		} else {
			var tid int64
			if json.Unmarshal(in.PortfolioTxnID, &tid) != nil || tid < 1 {
				fe = append(fe, FieldError{"portfolio_txn_id", "must be an id or null"})
			} else {
				ok, err := txnBelongs(ctx, tx, tid, inst)
				if err != nil {
					return Item{}, err
				}
				if !ok {
					fe = append(fe, FieldError{"portfolio_txn_id", errTxn})
				}
				newTxn = &tid
			}
		}
	}
	if len(fe) > 0 {
		return Item{}, &ValidationError{Fields: fe}
	}
	if _, err := tx.Exec(ctx, `UPDATE journal_note SET
		note_text = CASE WHEN $2::boolean THEN $3 ELSE note_text END,
		review_on = $4, portfolio_txn_id = $5, status = $6,
		reviewed_at = CASE WHEN $6::text = 'reviewed' THEN coalesce(reviewed_at, now()) ELSE NULL END,
		updated_at = now() WHERE id = $1`,
		id, in.Note != nil, note, newReview, newTxn, newStatus); err != nil {
		return Item{}, txnLinkError(err)
	}
	item, err := scanItem(tx.QueryRow(ctx, `SELECT `+itemCols+itemFrom+` WHERE n.id = $1`, id), today)
	if err != nil {
		return Item{}, err
	}
	return item, tx.Commit(ctx)
}

func isNull(b json.RawMessage) bool { return strings.TrimSpace(string(b)) == "null" }

// Delete removes a note (final).
func (s *Service) Delete(ctx context.Context, id int64) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM journal_note WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &NotFoundError{What: "journal note", Details: map[string]any{"id": id}}
	}
	return nil
}
