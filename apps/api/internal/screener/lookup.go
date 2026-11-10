package screener

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// NotFoundError is an unknown symbol (404 NOT_FOUND on a path symbol).
type NotFoundError struct{ Symbol string }

func (e *NotFoundError) Error() string { return "screener: instrument not found" }

// NoDataError is a valid target without the data needed (404 DATA_UNAVAILABLE with a reason).
type NoDataError struct{ Reason string }

func (e *NoDataError) Error() string { return "screener: data unavailable: " + e.Reason }

var symbolPattern = regexp.MustCompile(`^[A-Za-z0-9&._-]{1,20}$`)

// ValidSymbol reports whether s has the shape of an exchange symbol (letters, digits, & . _ -).
func ValidSymbol(s string) bool { return symbolPattern.MatchString(s) }

type instRef struct {
	ID       int32
	Symbol   string
	Name     string
	Sector   string
	Industry string
	ViaAlias bool // matched an old symbol, not the current one
}

// resolve finds an instrument by symbol (case-insensitive), then through symbol_alias.
func (s *Service) resolve(ctx context.Context, symbol string) (instRef, error) {
	if !ValidSymbol(symbol) {
		return instRef{}, &NotFoundError{Symbol: symbol}
	}
	const q = `SELECT id, symbol, name, coalesce(sector,''), coalesce(industry,'') FROM instrument `
	var r instRef
	scan := func(row pgx.Row) error { return row.Scan(&r.ID, &r.Symbol, &r.Name, &r.Sector, &r.Industry) }
	err := scan(s.db.QueryRow(ctx, q+`WHERE upper(symbol) = upper($1::text) ORDER BY (symbol = $1::text) DESC, id LIMIT 1`, symbol))
	if errors.Is(err, pgx.ErrNoRows) {
		r.ViaAlias = true
		err = scan(s.db.QueryRow(ctx, q+`WHERE id = (SELECT a.instrument_id FROM symbol_alias a
			WHERE upper(a.old_symbol) = upper($1::text) ORDER BY a.changed_on DESC NULLS LAST, a.instrument_id LIMIT 1)`, symbol))
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return instRef{}, &NotFoundError{Symbol: symbol}
	}
	return r, err
}

type rowData struct {
	asOf    time.Time
	metrics map[string]any
}

// metricsFor loads screener rows for the instruments; a missing id means "no screener row".
func (s *Service) metricsFor(ctx context.Context, ids []int32) (map[int32]rowData, error) {
	out := map[int32]rowData{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT instrument_id, as_of, metrics FROM screener_row WHERE instrument_id = ANY($1::int[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int32
		var d pgtype.Date
		var raw []byte
		if err := rows.Scan(&id, &d, &raw); err != nil {
			return nil, err
		}
		m := map[string]any{}
		if err := json.Unmarshal(raw, &m); err != nil || m == nil {
			m = map[string]any{}
		}
		out[id] = rowData{asOf: d.Time, metrics: m}
	}
	return out, rows.Err()
}

func splitList(raw string) []string {
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
