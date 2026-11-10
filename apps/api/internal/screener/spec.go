package screener

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/india-analyzer/api/internal/pagination"
	"github.com/india-analyzer/api/internal/validate"
)

// Limits of a screener spec (docs/03 section 9: <= 12 filters, `in` <= 50 strings).
const (
	MaxFilters       = 12
	MaxInValues      = 50
	MaxColumns       = 40
	MaxTextLen       = 100
	MaxNumber        = 1e15
	MaxOffset        = 100000
	DefaultLimit     = 50
	DefaultKind      = "equity"
	maxCursorOffsets = MaxOffset
)

// FieldError is one 422 problem; Field names the offending input (for example `filters[1].op`).
type FieldError struct{ Field, Message string }

// ValidationError carries 422 field problems.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "screener: validation failed" }

// ErrInvalidCursor is a cursor that is malformed or belongs to a different screen.
var ErrInvalidCursor = pagination.ErrInvalidCursor

// Filter is one condition over a whitelisted metric.
type Filter struct {
	Metric string          `json:"metric"`
	Op     string          `json:"op"`
	Value  json.RawMessage `json:"value"`

	num []float64 // parsed numeric operand(s)
	txt []string  // parsed text operand(s)
}

// Sort orders the result by one whitelisted metric.
type Sort struct {
	Metric string `json:"metric"`
	Dir    string `json:"dir"`
}

// Universe narrows the stocks considered.
type Universe struct {
	Index       string `json:"index,omitempty"`
	Kind        string `json:"kind,omitempty"`
	CompanyType string `json:"company_type,omitempty"`
}

// Spec is a screener definition (also the `spec` of a saved screen).
type Spec struct {
	Filters  []Filter `json:"filters"`
	Sort     *Sort    `json:"sort,omitempty"`
	Columns  []string `json:"columns,omitempty"`
	Universe Universe `json:"universe"`
}

// QueryBody is the body of POST /screener/query.
type QueryBody struct {
	Spec
	Limit  json.RawMessage `json:"limit"`
	Cursor *string         `json:"cursor"`
}

var kinds = map[string]bool{"equity": true, "etf": true, "reit": true, "invit": true, "sme": true, "other": true}

// Operators allowed per metric kind; the map value is the fixed SQL operator.
var numericOps = map[string]string{">": ">", ">=": ">=", "<": "<", "<=": "<=", "=": "=", "between": ""}

type fieldErrs struct{ list []FieldError }

func (f *fieldErrs) add(field, msg string) { f.list = append(f.list, FieldError{field, msg}) }

func (f *fieldErrs) err() error {
	if len(f.list) == 0 {
		return nil
	}
	return &ValidationError{Fields: f.list}
}

func parseNumber(raw json.RawMessage) (float64, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || (raw[0] != '-' && (raw[0] < '0' || raw[0] > '9')) {
		return 0, false // a string, bool, null, array or object is not a number
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > MaxNumber {
		return 0, false
	}
	return f, true
}

func parseText(s string) (string, string) {
	s = strings.TrimSpace(s)
	switch {
	case !validate.Text(s):
		return "", "must be valid text without NUL bytes"
	case s == "":
		return "", "must not be empty"
	case utf8.RuneCountInString(s) > MaxTextLen:
		return "", fmt.Sprintf("must be at most %d characters", MaxTextLen)
	}
	return s, ""
}

// Validate checks the spec against the whitelist and limits, normalising it in place (defaults,
// trimmed text, canonical filter values). Problems are reported per field as a *ValidationError.
func (s *Spec) Validate() error {
	var fe fieldErrs
	if s.Filters == nil {
		s.Filters = []Filter{}
	}
	if len(s.Filters) > MaxFilters {
		fe.add("filters", fmt.Sprintf("at most %d filters are allowed", MaxFilters))
	}
	for i := range s.Filters {
		if i >= MaxFilters {
			break
		}
		s.Filters[i].validate(fmt.Sprintf("filters[%d]", i), &fe)
	}
	if s.Sort != nil {
		if _, ok := Lookup(s.Sort.Metric); !ok {
			fe.add("sort.metric", "is not a supported metric")
		}
		s.Sort.Dir = strings.ToLower(strings.TrimSpace(s.Sort.Dir))
		if s.Sort.Dir == "" {
			s.Sort.Dir = "asc"
		}
		if s.Sort.Dir != "asc" && s.Sort.Dir != "desc" {
			fe.add("sort.dir", "must be asc or desc")
		}
	}
	if len(s.Columns) > MaxColumns {
		fe.add("columns", fmt.Sprintf("at most %d columns are allowed", MaxColumns))
	}
	seen := map[string]bool{}
	cols := make([]string, 0, len(s.Columns))
	for i, c := range s.Columns {
		if i >= MaxColumns {
			break
		}
		if _, ok := Lookup(c); !ok {
			fe.add(fmt.Sprintf("columns[%d]", i), "is not a supported metric")
			continue
		}
		if !seen[c] {
			seen[c] = true
			cols = append(cols, c)
		}
	}
	s.Columns = cols
	if len(s.Columns) == 0 {
		s.Columns = nil
	}
	u := &s.Universe
	u.Kind = strings.ToLower(strings.TrimSpace(u.Kind))
	if u.Kind == "" {
		u.Kind = DefaultKind
	}
	if !kinds[u.Kind] {
		fe.add("universe.kind", "must be one of equity, etf, reit, invit, sme, other")
	}
	u.CompanyType = strings.ToLower(strings.TrimSpace(u.CompanyType))
	if u.CompanyType != "" && u.CompanyType != "general" && u.CompanyType != "financial" {
		fe.add("universe.company_type", "must be general or financial")
	}
	if u.Index != "" {
		if t, msg := parseText(u.Index); msg != "" {
			fe.add("universe.index", msg)
		} else {
			u.Index = t
		}
	}
	return fe.err()
}

func (f *Filter) validate(path string, fe *fieldErrs) {
	m, ok := Lookup(f.Metric)
	if !ok {
		fe.add(path+".metric", "is not a supported metric")
		return
	}
	op := strings.TrimSpace(f.Op)
	f.Op = op
	f.num, f.txt = nil, nil
	if m.Kind == Numeric {
		if _, ok := numericOps[op]; !ok {
			fe.add(path+".op", "must be one of >, >=, <, <=, =, between for a numeric metric")
			return
		}
		if op == "between" {
			var arr []json.RawMessage
			if err := json.Unmarshal(f.Value, &arr); err != nil || len(arr) != 2 {
				fe.add(path+".value", "must be an array of two numbers")
				return
			}
			lo, ok1 := parseNumber(arr[0])
			hi, ok2 := parseNumber(arr[1])
			if !ok1 || !ok2 {
				fe.add(path+".value", "must be finite numbers within +/-1e15")
				return
			}
			if lo > hi {
				fe.add(path+".value", "the lower bound must not exceed the upper bound")
				return
			}
			f.num = []float64{lo, hi}
			f.Value, _ = json.Marshal([]float64{lo, hi})
			return
		}
		v, ok := parseNumber(f.Value)
		if !ok {
			fe.add(path+".value", "must be a finite number within +/-1e15")
			return
		}
		f.num = []float64{v}
		f.Value, _ = json.Marshal(v)
		return
	}
	// text metric
	switch op {
	case "=":
		var s string
		if err := json.Unmarshal(f.Value, &s); err != nil {
			fe.add(path+".value", "must be a string")
			return
		}
		t, msg := parseText(s)
		if msg != "" {
			fe.add(path+".value", msg)
			return
		}
		f.txt = []string{t}
		f.Value, _ = json.Marshal(t)
	case "in":
		var arr []string
		if err := json.Unmarshal(f.Value, &arr); err != nil {
			fe.add(path+".value", "must be an array of strings")
			return
		}
		if len(arr) == 0 || len(arr) > MaxInValues {
			fe.add(path+".value", fmt.Sprintf("must hold 1 to %d strings", MaxInValues))
			return
		}
		out := make([]string, 0, len(arr))
		for _, x := range arr {
			t, msg := parseText(x)
			if msg != "" {
				fe.add(path+".value", msg)
				return
			}
			out = append(out, t)
		}
		f.txt = out
		f.Value, _ = json.Marshal(out)
	default:
		fe.add(path+".op", "must be = or in for a text metric")
	}
}

// Fingerprint identifies a normalised spec; cursors carry it so a cursor from another screen is rejected.
func (s *Spec) Fingerprint() string {
	b, _ := json.Marshal(s)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:6])
}

// Page is the validated paging of a query.
type Page struct {
	Limit  int
	Offset int
}

// ParsePage validates `limit` (default 50, clamp 200, non-integer or < 1 is a 422) and the opaque cursor.
func ParsePage(rawLimit json.RawMessage, cursor *string, fingerprint string) (Page, error) {
	var fe fieldErrs
	p := Page{Limit: DefaultLimit}
	if t := bytes.TrimSpace(rawLimit); len(t) > 0 && string(t) != "null" {
		f, ok := parseNumber(t)
		if !ok || f != math.Trunc(f) || f < 1 {
			fe.add("limit", "must be a positive integer")
		} else {
			p.Limit = int(math.Min(f, pagination.MaxLimit))
		}
	}
	if err := fe.err(); err != nil {
		return p, err
	}
	if cursor != nil && *cursor != "" {
		if !validate.Text(*cursor) {
			return p, &ValidationError{Fields: []FieldError{{"cursor", "must be valid text without NUL bytes"}}}
		}
		var arr [2]json.RawMessage
		if err := pagination.Decode(*cursor, &arr); err != nil {
			return p, ErrInvalidCursor
		}
		var fp string
		var off int
		if json.Unmarshal(arr[0], &fp) != nil || json.Unmarshal(arr[1], &off) != nil {
			return p, ErrInvalidCursor
		}
		if fp != fingerprint || off < 0 || off > maxCursorOffsets {
			return p, ErrInvalidCursor
		}
		p.Offset = off
	}
	return p, nil
}

func encodeCursor(fingerprint string, offset int) (string, error) {
	return pagination.Encode(fingerprint, offset)
}

// AsValidation extracts a *ValidationError.
func AsValidation(err error) (*ValidationError, bool) {
	var ve *ValidationError
	if errors.As(err, &ve) {
		return ve, true
	}
	return nil, false
}
