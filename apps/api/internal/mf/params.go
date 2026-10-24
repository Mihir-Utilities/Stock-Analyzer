package mf

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/pagination"
	"github.com/india-analyzer/api/internal/validate"
)

// Errors the handlers map onto the envelope.
var (
	ErrInvalidCursor = pagination.ErrInvalidCursor
)

// FieldError is a validation problem on one query parameter.
type FieldError struct{ Field, Message string }

// ValidationError carries 422 field problems.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "mf: validation failed" }

// NotFoundError is the 404 for an unknown scheme code (MF-13); Suggestions are active schemes
// whose code starts with the same leading digits.
type NotFoundError struct {
	Code        int32
	Suggestions []Suggestion
}

func (e *NotFoundError) Error() string { return "mf: scheme not found" }

// Suggestion is one "did you mean" scheme.
type Suggestion struct {
	Code int32  `json:"code"`
	Name string `json:"name"`
}

// NoDataError is a known scheme with no NAV rows yet (404 DATA_UNAVAILABLE).
type NoDataError struct{ Code int32 }

func (e *NoDataError) Error() string { return "mf: no NAV rows" }

// NoCommonDatesError is a compare whose schemes share no NAV date in the window (422).
type NoCommonDatesError struct{}

func (e *NoCommonDatesError) Error() string { return "mf: no common NAV dates" }

const (
	maxFilterLen = 100
	maxTokens    = 12
	minSIPStart  = "1990-01-01"
	maxSIPAmount = 1e9
)

// SearchParams are the validated parameters of GET /mf/schemes.
type SearchParams struct {
	Tokens     []string // lower-cased search words, ANDed (trigram ILIKE)
	Category   string
	FundHouse  string
	Plan       string // "" = no plan filter
	Option     string // "" = no option filter
	IncludeAll bool   // also inactive schemes
	Group      bool
	Page       pagination.Params
}

func get(v url.Values, k string) (string, bool) {
	if xs, ok := v[k]; ok && len(xs) > 0 {
		return strings.TrimSpace(xs[0]), true
	}
	return "", false
}

func parseBool(v url.Values, k string, fe *[]FieldError) bool {
	raw, ok := get(v, k)
	if !ok || raw == "" {
		return false
	}
	b, err := strconv.ParseBool(raw)
	if err != nil {
		*fe = append(*fe, FieldError{k, "must be true or false"})
	}
	return b
}

// ParseSearch validates GET /mf/schemes. Defaults (docs/03 section 10): plan=direct and
// option=growth unless include_all=true; an explicit plan/option always applies.
func ParseSearch(v url.Values) (SearchParams, error) {
	var fe []FieldError
	p := SearchParams{}
	if q, ok := get(v, "q"); ok {
		if !validate.Text(q) {
			fe = append(fe, FieldError{"q", "must be valid text without NUL bytes"})
		} else if utf8.RuneCountInString(q) > maxFilterLen {
			fe = append(fe, FieldError{"q", "must be at most 100 characters"})
		}
		p.Tokens = strings.Fields(strings.ToLower(q))
		if len(p.Tokens) > maxTokens {
			fe = append(fe, FieldError{"q", "must have at most 12 words"})
		}
	}
	for _, f := range []struct {
		key string
		dst *string
	}{{"category", &p.Category}, {"fund_house", &p.FundHouse}} {
		if x, ok := get(v, f.key); ok {
			if !validate.Text(x) {
				fe = append(fe, FieldError{f.key, "must be valid text without NUL bytes"})
			} else if utf8.RuneCountInString(x) > maxFilterLen {
				fe = append(fe, FieldError{f.key, "must be at most 100 characters"})
			}
			*f.dst = x
		}
	}
	p.IncludeAll = parseBool(v, "include_all", &fe)
	p.Group = parseBool(v, "group", &fe)
	if x, ok := get(v, "plan"); ok && x != "" {
		if x != "direct" && x != "regular" {
			fe = append(fe, FieldError{"plan", "must be direct or regular"})
		}
		p.Plan = x
	} else if !p.IncludeAll {
		p.Plan = "direct"
	}
	if x, ok := get(v, "option"); ok && x != "" {
		if x != "growth" && x != "idcw" {
			fe = append(fe, FieldError{"option", "must be growth or idcw"})
		}
		p.Option = x
	} else if !p.IncludeAll {
		p.Option = "growth"
	}
	pg, err := pagination.Parse(v)
	switch {
	case errors.Is(err, pagination.ErrInvalidCursor):
		return p, ErrInvalidCursor
	case err != nil:
		fe = append(fe, FieldError{"limit", "must be a positive integer"})
	}
	p.Page = pg
	if len(fe) > 0 {
		return p, &ValidationError{Fields: fe}
	}
	return p, nil
}

// DefaultRange is used when `range` is absent.
const DefaultRange = "1Y"

// ParseNav validates range and log of GET /mf/schemes/{code}/nav.
func ParseNav(v url.Values) (rng string, logScale bool, err error) {
	var fe []FieldError
	rng = DefaultRange
	if x, ok := get(v, "range"); ok && x != "" {
		rng = x
	}
	if _, ok := RangeStart(rng, time.Now()); !ok {
		fe = append(fe, FieldError{"range", "must be one of 1M, 6M, 1Y, 3Y, 5Y, MAX"})
	}
	logScale = parseBool(v, "log", &fe)
	if len(fe) > 0 {
		return "", false, &ValidationError{Fields: fe}
	}
	return rng, logScale, nil
}

// SIPParams are the validated parameters of GET /mf/schemes/{code}/sip. End is nil when absent
// (the latest NAV date is used).
type SIPParams struct {
	Amount decimal.Decimal
	Start  time.Time
	End    *time.Time
	Day    int
}

// ParseSIP validates the SIP query: amount > 0, start required, day 1-28 (MF-11), start <= end.
func ParseSIP(v url.Values) (SIPParams, error) {
	var fe []FieldError
	p := SIPParams{Day: 1}
	if raw, ok := get(v, "amount"); !ok || raw == "" {
		fe = append(fe, FieldError{"amount", "is required"})
	} else if a, err := decimal.NewFromString(raw); err != nil || !a.IsPositive() ||
		a.GreaterThan(decimal.NewFromFloat(maxSIPAmount)) || a.Exponent() < -2 {
		fe = append(fe, FieldError{"amount", "must be a positive amount up to 1,000,000,000 with at most 2 decimals"})
	} else {
		p.Amount = a
	}
	floor, _ := time.Parse(time.DateOnly, minSIPStart)
	if raw, ok := get(v, "start"); !ok || raw == "" {
		fe = append(fe, FieldError{"start", "is required"})
	} else if t, err := time.Parse(time.DateOnly, raw); err != nil {
		fe = append(fe, FieldError{"start", "must be a date, YYYY-MM-DD"})
	} else if t.Before(floor) {
		fe = append(fe, FieldError{"start", "must be on or after " + minSIPStart})
	} else {
		p.Start = t
	}
	if raw, ok := get(v, "end"); ok && raw != "" {
		if t, err := time.Parse(time.DateOnly, raw); err != nil {
			fe = append(fe, FieldError{"end", "must be a date, YYYY-MM-DD"})
		} else {
			p.End = &t
		}
	}
	if p.End != nil && !p.Start.IsZero() && p.End.Before(p.Start) {
		fe = append(fe, FieldError{"end", "must not be before start"})
	}
	if raw, ok := get(v, "day"); ok && raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 28 {
			fe = append(fe, FieldError{"day", "must be an integer from 1 to 28"})
		} else {
			p.Day = n
		}
	}
	if len(fe) > 0 {
		return p, &ValidationError{Fields: fe}
	}
	return p, nil
}

// ParseCompare validates codes (2-5 distinct scheme codes) and range (default 3Y).
func ParseCompare(v url.Values) (codes []int32, rng string, err error) {
	var fe []FieldError
	rng = "3Y"
	if x, ok := get(v, "range"); ok && x != "" {
		rng = x
	}
	if _, ok := RangeStart(rng, time.Now()); !ok {
		fe = append(fe, FieldError{"range", "must be one of 1M, 6M, 1Y, 3Y, 5Y, MAX"})
	}
	raw, _ := get(v, "codes")
	seen := map[int32]bool{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		n, perr := strconv.ParseInt(part, 10, 32)
		if perr != nil || n < 1 {
			fe = append(fe, FieldError{"codes", "must be comma separated scheme codes"})
			codes = nil
			break
		}
		if seen[int32(n)] {
			fe = append(fe, FieldError{"codes", "must not repeat a scheme"})
			break
		}
		seen[int32(n)] = true
		codes = append(codes, int32(n))
	}
	if len(fe) == 0 && (len(codes) < 2 || len(codes) > 5) {
		fe = append(fe, FieldError{"codes", "needs 2 to 5 scheme codes"})
	}
	if len(fe) > 0 {
		return nil, "", &ValidationError{Fields: fe}
	}
	return codes, rng, nil
}
