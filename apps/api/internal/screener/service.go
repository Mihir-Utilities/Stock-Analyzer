package screener

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
)

// DB is what the service needs: queries plus transactions (saved screens). *pgxpool.Pool satisfies it.
type DB interface {
	dbq.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service reads the precomputed screener rows.
type Service struct {
	db  DB
	Now func() time.Time
}

// New builds a Service.
func New(db DB) *Service { return &Service{db: db, Now: time.Now} }

// Item is one screener result row. `values` holds the requested metrics (null when the stock has no
// value; never 0), each unit is in the response `units` map, `as_of` is the date of the screener row.
type Item struct {
	Symbol       string            `json:"symbol"`
	Name         string            `json:"name"`
	AsOf         string            `json:"as_of"`
	Values       map[string]any    `json:"values"`
	ValueReasons map[string]string `json:"value_reasons"`
	Coverage     float64           `json:"coverage"`
	Stamp
}

// QueryResult is the data of POST /screener/query.
type QueryResult struct {
	Items      []Item            `json:"items"`
	NextCursor *string           `json:"next_cursor"`
	Total      *int              `json:"total"`
	Units      map[string]string `json:"units"`

	ExcludedForMissing map[string]int64 `json:"-"` // meta.excluded_for_missing
	AsOf               time.Time        `json:"-"`
}

const reasonNotAvailable = "not_available"

// Query runs a validated spec.
func (s *Service) Query(ctx context.Context, spec *Spec, rawLimit json.RawMessage, cursor *string) (QueryResult, error) {
	if err := spec.Validate(); err != nil {
		return QueryResult{}, err
	}
	fp := spec.Fingerprint()
	page, err := ParsePage(rawLimit, cursor, fp)
	if err != nil {
		return QueryResult{}, err
	}
	sqlText, args := buildQuery(spec, page)
	rows, err := s.db.Query(ctx, sqlText, args...)
	if err != nil {
		return QueryResult{}, err
	}
	type rec struct {
		id      int32
		symbol  string
		name    string
		asOf    time.Time
		metrics map[string]any
	}
	var recs []rec
	total := 0
	for rows.Next() {
		var r rec
		var d pgtype.Date
		var raw []byte
		if err := rows.Scan(&r.id, &r.symbol, &r.name, &d, &raw, &total); err != nil {
			rows.Close()
			return QueryResult{}, err
		}
		r.asOf = d.Time
		if err := json.Unmarshal(raw, &r.metrics); err != nil || r.metrics == nil {
			r.metrics = map[string]any{}
		}
		recs = append(recs, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return QueryResult{}, err
	}
	ids := make([]int32, len(recs))
	for i, r := range recs {
		ids[i] = r.id
	}
	st, err := s.stamps(ctx, ids)
	if err != nil {
		return QueryResult{}, err
	}
	keys := spec.RequestedKeys()
	out := QueryResult{Items: make([]Item, 0, len(recs)), Units: map[string]string{}, ExcludedForMissing: map[string]int64{}}
	for _, k := range keys {
		out.Units[k] = Unit(k)
	}
	for _, r := range recs {
		it := Item{Symbol: r.symbol, Name: r.name, AsOf: r.asOf.Format(time.DateOnly),
			Values: map[string]any{}, ValueReasons: map[string]string{}, Coverage: coverage(r.metrics), Stamp: st[r.id]}
		for _, k := range keys {
			if v, ok := metricValue(k, r.metrics); ok {
				it.Values[k] = v
			} else {
				it.Values[k] = nil
				it.ValueReasons[k] = reasonNotAvailable
			}
		}
		out.Items = append(out.Items, it)
		if r.asOf.After(out.AsOf) {
			out.AsOf = r.asOf
		}
	}
	if out.AsOf.IsZero() {
		out.AsOf = s.Now()
	}
	if len(recs) > 0 {
		t := total
		out.Total = &t
		if page.Offset+len(recs) < total {
			c, err := encodeCursor(fp, page.Offset+len(recs))
			if err != nil {
				return QueryResult{}, err
			}
			out.NextCursor = &c
		}
	} else if page.Offset == 0 {
		z := 0
		out.Total = &z
	}
	if q, a, ks := buildExcluded(spec); q != "" {
		counts := make([]int64, len(ks))
		dest := make([]any, len(ks))
		for i := range counts {
			dest[i] = &counts[i]
		}
		if err := s.db.QueryRow(ctx, q, a...).Scan(dest...); err != nil {
			return QueryResult{}, err
		}
		for i, k := range ks {
			out.ExcludedForMissing[k] = counts[i]
		}
	}
	return out, nil
}

// metricValue returns the typed value of a whitelisted key from a decoded metrics object; ok is false
// when the key is absent or has the wrong type.
func metricValue(key string, m map[string]any) (any, bool) {
	def, ok := byKey[key]
	if !ok {
		return nil, false
	}
	v, present := m[key]
	if !present || v == nil {
		return nil, false
	}
	switch def.Kind {
	case Numeric:
		if f, ok := v.(float64); ok {
			return f, true
		}
	case Text:
		if s, ok := v.(string); ok && s != "" {
			return s, true
		}
	}
	return nil, false
}

// coverage is the fraction of whitelisted metrics the row holds (0..1, 4 decimals).
func coverage(m map[string]any) float64 {
	n := 0
	for _, w := range whitelist {
		if _, ok := metricValue(w.Key, m); ok {
			n++
		}
	}
	return float64(n*10000/len(whitelist)) / 10000
}

// ---- saved screens ----

const (
	savedKey      = "saved_screens"
	MaxSaved      = 30
	MaxSpecBytes  = 8 << 10
	savedLockName = "saved_screens"
)

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,59}$`)

// Errors for saved screens.
var (
	ErrSavedLimit    = errors.New("screener: saved screens limit reached")
	ErrSavedNotFound = errors.New("screener: saved screen not found")
)

// SavedScreen is one stored screen.
type SavedScreen struct {
	Name    string `json:"name"`
	Spec    Spec   `json:"spec"`
	SavedAt string `json:"saved_at"`
}

// ValidName reports whether name is an acceptable saved-screen name.
func ValidName(name string) bool { return namePattern.MatchString(name) }

func (s *Service) loadSaved(ctx context.Context, q dbq.DBTX) ([]SavedScreen, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT value FROM app_setting WHERE key = $1`, savedKey).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var list []SavedScreen
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Service) storeSaved(ctx context.Context, q dbq.DBTX, list []SavedScreen) error {
	b, err := json.Marshal(list)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `INSERT INTO app_setting (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
		savedKey, string(b), s.Now().UTC())
	return err
}

// ListSaved returns the saved screens ordered by name.
func (s *Service) ListSaved(ctx context.Context) ([]SavedScreen, error) {
	list, err := s.loadSaved(ctx, s.db)
	if err != nil {
		return nil, err
	}
	sortSaved(list)
	if list == nil {
		list = []SavedScreen{}
	}
	return list, nil
}

func sortSaved(l []SavedScreen) {
	sort.Slice(l, func(i, j int) bool {
		a, b := strings.ToLower(l[i].Name), strings.ToLower(l[j].Name)
		if a != b {
			return a < b
		}
		return l[i].Name < l[j].Name
	})
}

func (s *Service) locked(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// One writer at a time: app_setting.value is a single jsonb document (read-modify-write).
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, savedLockName); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SaveScreen upserts a screen by name (case-insensitive); created is true for a new name.
func (s *Service) SaveScreen(ctx context.Context, name string, spec *Spec) (SavedScreen, bool, error) {
	var fe fieldErrs
	if !ValidName(name) {
		fe.add("name", "must be 1-60 characters: letters, digits, space, _ . ( ) -, starting with a letter or digit")
	}
	if err := spec.Validate(); err != nil {
		if ve, ok := AsValidation(err); ok {
			for _, f := range ve.Fields {
				fe.add("spec."+f.Field, f.Message)
			}
		}
	} else if b, _ := json.Marshal(spec); len(b) > MaxSpecBytes {
		fe.add("spec", "must be at most 8 KiB")
	}
	if err := fe.err(); err != nil {
		return SavedScreen{}, false, err
	}
	out := SavedScreen{Name: name, Spec: *spec, SavedAt: s.Now().UTC().Format(time.RFC3339)}
	created := false
	err := s.locked(ctx, func(tx pgx.Tx) error {
		list, err := s.loadSaved(ctx, tx)
		if err != nil {
			return err
		}
		idx := -1
		for i, x := range list {
			if strings.EqualFold(x.Name, name) {
				idx = i
				break
			}
		}
		if idx < 0 {
			if len(list) >= MaxSaved {
				return ErrSavedLimit
			}
			created = true
			list = append(list, out)
		} else {
			list[idx] = out
		}
		return s.storeSaved(ctx, tx, list)
	})
	if err != nil {
		return SavedScreen{}, false, err
	}
	return out, created, nil
}

// DeleteSaved removes a screen by name (case-insensitive).
func (s *Service) DeleteSaved(ctx context.Context, name string) error {
	if !ValidName(name) {
		return ErrSavedNotFound // no valid name can match
	}
	return s.locked(ctx, func(tx pgx.Tx) error {
		list, err := s.loadSaved(ctx, tx)
		if err != nil {
			return err
		}
		for i, x := range list {
			if strings.EqualFold(x.Name, name) {
				list = append(list[:i], list[i+1:]...)
				return s.storeSaved(ctx, tx, list)
			}
		}
		return ErrSavedNotFound
	})
}
