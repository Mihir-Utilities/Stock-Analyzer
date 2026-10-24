package importers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/jobs"
)

// Import kinds built in B06a. The other kinds of docs/03 section 14 arrive with B06b.
const (
	KindPrices      = "prices"
	KindInstruments = "instruments"
)

// AllKinds lists every kind of the contract; only Implemented ones are served by this package.
var AllKinds = []string{"prices", "instruments", "holidays", "results_quarterly", "results_annual",
	"balance_cashflow", "fundamentals_long", "shareholding", "corporate_actions", "instrument_meta"}

// Implemented reports whether the kind is built (B06a: prices and instruments).
func Implemented(kind string) bool { return kind == KindPrices || kind == KindInstruments }

// KnownKind reports whether kind is one of the contract's import kinds.
func KnownKind(kind string) bool {
	for _, k := range AllKinds {
		if k == kind {
			return true
		}
	}
	return false
}

const (
	// SettingPricesAdjusted is the app_setting key (docs/01 3.7, decision D-K).
	SettingPricesAdjusted = "PRICES_ALREADY_ADJUSTED"
	// uploadTTL is how long a validated upload waits for its commit (docs/01 section 7).
	uploadTTL = time.Hour
	// bytesPerRow is the projected growth of one price row (docs/01 7.1).
	bytesPerRow = 130
	// TrackedWarnLimit: warn (never block) above this many tracked stocks.
	TrackedWarnLimit = 400
	// WarnTrackedOver400 is the commit warning code.
	WarnTrackedOver400 = "TRACKED_OVER_400"
)

// Sentinel and typed errors; the HTTP layer maps them to the envelope of docs/03 section 1.
var reUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var (
	ErrUploadNotFound  = errors.New("importers: upload not found or expired")
	ErrKindNotBuilt    = errors.New("importers: kind not built yet")
	ErrAdjustmentUnset = errors.New("importers: PRICES_ALREADY_ADJUSTED is unset")
	ErrConflict        = errors.New("importers: conflict")
	ErrBatchNotFound   = errors.New("importers: batch not found")
	ErrNotUndoable     = errors.New("importers: batch kind cannot be undone")
	ErrSymbolNotFound  = errors.New("importers: symbol not found")
	ErrConfirmChange   = errors.New("importers: changing the setting needs confirm")
)

// HasErrorsError: the upload still has row errors; commit is refused (IMP-11).
type HasErrorsError struct{ Count int }

func (e *HasErrorsError) Error() string {
	return fmt.Sprintf("importers: upload has %d errors", e.Count)
}

// SizeLimitError: current database size plus the estimated growth exceeds DB_SOFT_LIMIT_MB (IMP-23).
type SizeLimitError struct {
	LimitMB, CurrentMB, GrowthMB float64
}

func (e *SizeLimitError) Error() string {
	return fmt.Sprintf("This file would make the database exceed %.0f MB; trim history or import fewer rows", e.LimitMB)
}

// ValidationError carries field-level problems (422 details.fields).
type ValidationError struct{ Fields []FieldIssue }

func (e *ValidationError) Error() string { return "importers: validation failed" }

func validation(field, msg string) *ValidationError {
	return &ValidationError{Fields: []FieldIssue{{Field: field, Message: msg}}}
}

// PostImportEnqueuer queues the post_import job after a commit (B09: EnqueuePostImport).
type PostImportEnqueuer interface {
	EnqueuePostImport(ctx context.Context, batchID int64, symbols []string) (jobs.Job, bool, error)
}

// Service validates and commits imports and runs the price management actions.
type Service struct {
	pool *pgxpool.Pool
	enq  PostImportEnqueuer
	log  zerolog.Logger

	// Now is the clock (tests replace it).
	Now func() time.Time
	// LargePrices enables the 25 MB / 300,000-row prices limits (only after spike S9 passed).
	LargePrices bool
	// DBSoftLimitMB is DB_SOFT_LIMIT_MB.
	DBSoftLimitMB int
	// DBSize returns the current database size in bytes (tests replace it).
	DBSize func(ctx context.Context) (int64, error)

	chunkSize  int
	afterChunk func(chunk int) error // test hook: a returned error aborts and rolls back the commit
}

// New builds a Service. enq may be nil (no post_import job is queued).
func New(pool *pgxpool.Pool, enq PostImportEnqueuer, softLimitMB int, log zerolog.Logger) *Service {
	s := &Service{pool: pool, enq: enq, log: log, Now: time.Now, DBSoftLimitMB: softLimitMB, chunkSize: ChunkSize}
	s.DBSize = func(ctx context.Context) (int64, error) {
		var n int64
		err := s.pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&n)
		return n, err
	}
	return s
}

// Limits returns the upload limits for a kind (the handler enforces the byte limit while reading).
func (s *Service) Limits(kind string) Limits { return LimitsFor(kind, s.LargePrices) }

// today is the current market date (IST) as midnight UTC.
func (s *Service) today() time.Time {
	n := s.Now().In(IST)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}

func templateHint(kind string) string {
	return "Download the template from /api/v1/imports/templates/" + kind + "."
}

// ---- upload store (table import_upload, UNLOGGED, 1 h TTL; decision D-B) ----

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("importers: crypto/rand failed")
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// IsUUID reports whether s is a canonical lower-case UUID.
func IsUUID(s string) bool { return reUUID.MatchString(strings.ToLower(s)) }

func (s *Service) putUpload(ctx context.Context, kind string, content []byte) (string, error) {
	now := s.Now()
	// Lazy cleanup next to the housekeeping job (docs/04 3.10): expired rows never pile up.
	if _, err := s.pool.Exec(ctx, `DELETE FROM import_upload WHERE expires_at <= $1`, now); err != nil {
		return "", err
	}
	id := newUUID()
	_, err := s.pool.Exec(ctx,
		`INSERT INTO import_upload (id, kind, content, created_at, expires_at) VALUES ($1::uuid, $2, $3, $4, $5)`,
		id, kind, content, now, now.Add(uploadTTL))
	return id, err
}

func (s *Service) getUpload(ctx context.Context, db dbq.DBTX, id, kind string) ([]byte, error) {
	if !IsUUID(id) {
		return nil, ErrUploadNotFound
	}
	var content []byte
	var k string
	err := db.QueryRow(ctx, `SELECT kind, content FROM import_upload WHERE id = $1::uuid AND expires_at > $2`,
		strings.ToLower(id), s.Now()).Scan(&k, &content)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUploadNotFound
	}
	if err != nil {
		return nil, err
	}
	if k != kind {
		return nil, validation("upload_id", fmt.Sprintf("the upload was validated as %q, not %q", k, kind))
	}
	return content, nil
}

// ---- instrument lookup shared by both importers ----

type instrumentIndex struct {
	bySymbol map[string]int32 // current symbol -> id (-1: added earlier in the same file)
	byID     map[int32]string
	alias    map[string]int32 // old symbol -> id
	tracked  map[int32]bool
}

func loadIndex(ctx context.Context, db dbq.DBTX) (*instrumentIndex, error) {
	idx := &instrumentIndex{bySymbol: map[string]int32{}, byID: map[int32]string{}, alias: map[string]int32{}, tracked: map[int32]bool{}}
	rows, err := db.Query(ctx, `SELECT id, symbol, is_tracked FROM instrument`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int32
		var sym string
		var tr bool
		if err := rows.Scan(&id, &sym, &tr); err != nil {
			rows.Close()
			return nil, err
		}
		idx.bySymbol[sym], idx.byID[id], idx.tracked[id] = id, sym, tr
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	arows, err := db.Query(ctx, `SELECT instrument_id, old_symbol FROM symbol_alias`)
	if err != nil {
		return nil, err
	}
	defer arows.Close()
	for arows.Next() {
		var id int32
		var old string
		if err := arows.Scan(&id, &old); err != nil {
			return nil, err
		}
		idx.alias[old] = id
	}
	return idx, arows.Err()
}

// suggest returns the nearest known symbol (current or old) within a small edit distance, or "".
func (x *instrumentIndex) suggest(sym string) string {
	best, bestD := "", 3
	consider := func(c string) {
		if d := levenshtein(sym, c, bestD); d < bestD {
			best, bestD = c, d
		}
	}
	names := make([]string, 0, len(x.bySymbol))
	for c := range x.bySymbol {
		names = append(names, c)
	}
	sort.Strings(names)
	for _, c := range names {
		consider(c)
	}
	return best
}

// levenshtein returns the edit distance, or limit when it is at least limit.
func levenshtein(a, b string, limit int) int {
	ra, rb := []rune(a), []rune(b)
	if d := len(ra) - len(rb); d >= limit || -d >= limit {
		return limit
	}
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		minRow := cur[0]
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
			minRow = min(minRow, cur[j])
		}
		if minRow >= limit {
			return limit
		}
		prev, cur = cur, prev
	}
	if prev[len(rb)] >= limit {
		return limit
	}
	return prev[len(rb)]
}

// ---- settings ----

// AdjustmentSetting is GET /settings/prices-adjustment. Value is nil until the owner chooses.
type AdjustmentSetting struct {
	Value *bool      `json:"value"`
	SetAt *time.Time `json:"set_at"`
}

func readAdjustment(ctx context.Context, db dbq.DBTX) (AdjustmentSetting, error) {
	var raw string
	var at time.Time
	err := db.QueryRow(ctx, `SELECT value::text, updated_at FROM app_setting WHERE key = $1`, SettingPricesAdjusted).Scan(&raw, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdjustmentSetting{}, nil
	}
	if err != nil {
		return AdjustmentSetting{}, err
	}
	var v bool
	switch strings.TrimSpace(raw) {
	case "true":
		v = true
	case "false":
		v = false
	default:
		return AdjustmentSetting{}, nil // not a boolean: treated as unset
	}
	return AdjustmentSetting{Value: &v, SetAt: &at}, nil
}

// PricesAdjustment returns the current choice (null = not chosen).
func (s *Service) PricesAdjustment(ctx context.Context) (AdjustmentSetting, error) {
	return readAdjustment(ctx, s.pool)
}

// SetPricesAdjustment stores the owner's choice. Changing an already-set value needs confirm
// (docs/03 section 14); existing bars keep their own src_adjusted.
func (s *Service) SetPricesAdjustment(ctx context.Context, value, confirm bool) (AdjustmentSetting, error) {
	cur, err := readAdjustment(ctx, s.pool)
	if err != nil {
		return AdjustmentSetting{}, err
	}
	if cur.Value != nil && *cur.Value != value && !confirm {
		return AdjustmentSetting{}, ErrConfirmChange
	}
	if cur.Value == nil || *cur.Value != value {
		lit := "false"
		if value {
			lit = "true"
		}
		if _, err := s.pool.Exec(ctx, `INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb)
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, SettingPricesAdjusted, lit); err != nil {
			return AdjustmentSetting{}, err
		}
	}
	return readAdjustment(ctx, s.pool)
}
