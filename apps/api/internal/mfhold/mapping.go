package mfhold

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/india-analyzer/api/internal/dbq"
)

// NormalizeFundName is the mapping key of a statement fund name (MFH-23): lower case, "&" as "and",
// every character that is not a letter or digit becomes a space, whitespace collapsed.
func NormalizeFundName(s string) string {
	s = strings.ReplaceAll(strings.ToLower(s), "&", " and ")
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		} else {
			b.WriteByte(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// Mapping is one stored fund-name -> scheme choice.
type Mapping struct {
	FundName    string    `json:"fund_name"`
	FundNameKey string    `json:"fund_name_key"`
	SchemeCode  int32     `json:"scheme_code"`
	SchemeName  string    `json:"scheme_name"`
	Plan        string    `json:"plan"`
	Option      string    `json:"option"`
	ISIN        *string   `json:"isin"`
	Rows        int       `json:"rows"`
	AuditNote   *string   `json:"audit_note"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

const mappingCols = `f.fund_name, f.fund_name_key, f.scheme_code, m.name, coalesce(m.plan, 'unknown'), coalesce(m.option_type, 'unknown'),
	CASE WHEN m.option_type = 'idcw' AND m.isin_div_reinvest IS NOT NULL THEN m.isin_div_reinvest ELSE coalesce(m.isin_growth, m.isin_div_reinvest) END,
	(SELECT count(*) FROM mf_txn t WHERE t.fund_name_key = f.fund_name_key), f.audit_note, f.created_at, f.updated_at`

func scanMapping(row pgx.Row) (Mapping, error) {
	var m Mapping
	err := row.Scan(&m.FundName, &m.FundNameKey, &m.SchemeCode, &m.SchemeName, &m.Plan, &m.Option, &m.ISIN, &m.Rows, &m.AuditNote, &m.CreatedAt, &m.UpdatedAt)
	return m, err
}

// LoadMappings returns every stored mapping keyed by fund_name_key.
func LoadMappings(ctx context.Context, db dbq.DBTX) (map[string]Mapping, error) {
	rows, err := db.Query(ctx, `SELECT `+mappingCols+` FROM mf_fund_name_map f JOIN mf_scheme m ON m.code = f.scheme_code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Mapping{}
	for rows.Next() {
		m, err := scanMapping(rows)
		if err != nil {
			return nil, err
		}
		out[m.FundNameKey] = m
	}
	return out, rows.Err()
}

// ListMappings serves GET /portfolio/mf/fund-mappings.
func (s *Service) ListMappings(ctx context.Context) ([]Mapping, error) {
	all, err := LoadMappings(ctx, s.db)
	if err != nil {
		return nil, err
	}
	out := make([]Mapping, 0, len(all))
	for _, m := range all {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FundNameKey < out[j].FundNameKey })
	return out, nil
}

// MappingInput is the body of PUT /portfolio/mf/fund-mappings.
type MappingInput struct {
	FundName   *string `json:"fund_name"`
	SchemeCode *int64  `json:"scheme_code"`
	Remap      bool    `json:"remap"`
}

// PutMapping saves the scheme chosen for a statement fund name (MFH-23). A change of scheme is
// allowed while no transaction depends on the name; later only with Remap, which rewrites those
// rows in one transaction, re-validates the sequences and appends an audit note.
func (s *Service) PutMapping(ctx context.Context, in MappingInput) (Mapping, error) {
	var fe []FieldError
	name := ""
	if in.FundName == nil {
		fe = append(fe, FieldError{"fund_name", "is required"})
	} else if name = CleanText(*in.FundName); name == "" || utf8.RuneCountInString(name) > MaxFund || NormalizeFundName(name) == "" {
		fe = append(fe, FieldError{"fund_name", "must be 1-200 characters"})
	}
	if in.SchemeCode == nil {
		fe = append(fe, FieldError{"scheme_code", "is required"})
	}
	if len(fe) > 0 {
		return Mapping{}, &ValidationError{Fields: fe}
	}
	key := NormalizeFundName(name)
	sch, err := resolveScheme(ctx, s.db, *in.SchemeCode)
	if err != nil {
		return Mapping{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Mapping{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7013, hashtext($1))`, key); err != nil {
		return Mapping{}, err
	}
	var old int32
	err = tx.QueryRow(ctx, `SELECT scheme_code FROM mf_fund_name_map WHERE fund_name_key = $1 FOR UPDATE`, key).Scan(&old)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if _, err := tx.Exec(ctx, `INSERT INTO mf_fund_name_map (fund_name_key, fund_name, scheme_code) VALUES ($1, $2, $3)`, key, name, sch.Code); err != nil {
			return Mapping{}, err
		}
	case err != nil:
		return Mapping{}, err
	case old == sch.Code:
		// no-op
	default:
		var rows int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM mf_txn WHERE fund_name_key = $1`, key).Scan(&rows); err != nil {
			return Mapping{}, err
		}
		if rows > 0 && !in.Remap {
			return Mapping{}, &ConflictError{Code: "FUND_MAPPING_IN_USE",
				Message: fmt.Sprintf("%d stored transaction(s) depend on this mapping; confirm the re-map to rewrite them", rows),
				Details: map[string]any{"rows": rows}}
		}
		if err := LockSchemes(ctx, tx, old, sch.Code); err != nil {
			return Mapping{}, err
		}
		if rows > 0 {
			if _, err := tx.Exec(ctx, `UPDATE mf_txn SET scheme_code = $2, updated_at = now() WHERE fund_name_key = $1`, key, sch.Code); err != nil {
				return Mapping{}, err
			}
			if err := ValidateSchemes(ctx, tx, []int32{old, sch.Code}, s.Now()); err != nil {
				return Mapping{}, err
			}
			if err := TrackScheme(ctx, tx, sch.Code); err != nil {
				return Mapping{}, err
			}
			if err := RecomputeTracking(ctx, tx, old); err != nil {
				return Mapping{}, err
			}
		}
		note := fmt.Sprintf("remapped %s: %d -> %d (%d rows)", Today(s.Now()).Format(time.DateOnly), old, sch.Code, rows)
		if _, err := tx.Exec(ctx, `UPDATE mf_fund_name_map SET scheme_code = $2, updated_at = now(),
			audit_note = CASE WHEN audit_note IS NULL THEN $3 ELSE audit_note || E'\n' || $3 END WHERE fund_name_key = $1`, key, sch.Code, note); err != nil {
			return Mapping{}, err
		}
	}
	m, err := scanMapping(tx.QueryRow(ctx, `SELECT `+mappingCols+` FROM mf_fund_name_map f JOIN mf_scheme m ON m.code = f.scheme_code WHERE f.fund_name_key = $1`, key))
	if err != nil {
		return Mapping{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Mapping{}, err
	}
	s.refreshIfNoNAV(ctx, sch.Code)
	return m, nil
}

// Candidate is a scheme the owner may pick for an unmapped fund name.
type Candidate struct {
	SchemeCode  int32   `json:"scheme_code"`
	Name        string  `json:"name"`
	FundHouse   *string `json:"fund_house"`
	Plan        string  `json:"plan"`
	Option      string  `json:"option"`
	ISIN        *string `json:"isin"`
	OnWatchlist bool    `json:"on_watchlist"`
	HasNAV      bool    `json:"has_nav"`
}

// maxCandidates caps the candidate list of one fund name.
const maxCandidates = 10

var stopTokens = map[string]bool{"fund": true, "plan": true, "option": true, "scheme": true, "the": true, "and": true, "of": true, "a": true}

const candCols = `m.code, m.name, m.fund_house, coalesce(m.plan, 'unknown'), coalesce(m.option_type, 'unknown'),
	CASE WHEN m.option_type = 'idcw' AND m.isin_div_reinvest IS NOT NULL THEN m.isin_div_reinvest ELSE coalesce(m.isin_growth, m.isin_div_reinvest) END,
	EXISTS (SELECT 1 FROM watchlist_item w WHERE w.mf_scheme_code = m.code), EXISTS (SELECT 1 FROM mf_nav n WHERE n.scheme_code = m.code)`

// Candidates searches mf_scheme by the normalised fund name: every name token must occur in the
// scheme name; watchlist and tracked schemes first, then schemes with NAV data, then the closest name.
// When nothing contains all tokens the trigram-closest names are offered. The list is a suggestion
// only: nothing is ever matched automatically (MFH-23).
func Candidates(ctx context.Context, db dbq.DBTX, fundName string) ([]Candidate, error) {
	key := NormalizeFundName(fundName)
	var toks []string
	for _, t := range strings.Fields(key) {
		if !stopTokens[t] {
			toks = append(toks, t)
		}
	}
	if len(toks) == 0 {
		return []Candidate{}, nil
	}
	q := `SELECT ` + candCols + ` FROM mf_scheme m WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[]) t
		WHERE regexp_replace(lower(replace(m.name, '&', ' and ')), '[^a-z0-9]+', ' ', 'g') NOT LIKE '%' || t || '%')
		ORDER BY EXISTS (SELECT 1 FROM watchlist_item w WHERE w.mf_scheme_code = m.code) DESC, m.is_tracked DESC,
		  (m.status = 'active') DESC, EXISTS (SELECT 1 FROM mf_nav n WHERE n.scheme_code = m.code) DESC, similarity(lower(m.name), $2::text) DESC, m.name, m.code
		LIMIT $3`
	out, err := queryCandidates(ctx, db, q, toks, key, maxCandidates)
	if err != nil || len(out) > 0 {
		return out, err
	}
	q = `SELECT ` + candCols + ` FROM mf_scheme m WHERE similarity(lower(m.name), $2::text) > 0.3 AND $1::text[] IS NOT NULL
		ORDER BY EXISTS (SELECT 1 FROM watchlist_item w WHERE w.mf_scheme_code = m.code) DESC, similarity(lower(m.name), $2::text) DESC, m.name, m.code
		LIMIT $3`
	return queryCandidates(ctx, db, q, toks, key, maxCandidates)
}

func queryCandidates(ctx context.Context, db dbq.DBTX, q string, toks []string, key string, limit int) ([]Candidate, error) {
	rows, err := db.Query(ctx, q, toks, key, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Candidate{}
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.SchemeCode, &c.Name, &c.FundHouse, &c.Plan, &c.Option, &c.ISIN, &c.OnWatchlist, &c.HasNAV); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
