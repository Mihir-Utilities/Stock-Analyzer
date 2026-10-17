// Package alerts holds the alert use cases of docs/03-api-spec.md section 13: per-kind parameter
// validation, CRUD with the 200-active limit and the creation-time THRESHOLD_ALREADY_MET check,
// Telegram link codes and event history. It never evaluates alerts or sends alert messages (D06).
package alerts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
)

// FieldError is one `details.fields[]` entry.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// Kinds in docs/03 section 13 and the DDL CHECK, with the target type each applies to.
var kindTarget = map[string]string{
	"price_above": "stock", "price_below": "stock", "day_change_pct": "stock",
	"wk52_high": "stock", "wk52_low": "stock", "ma_cross": "stock",
	"rsi_above": "stock", "rsi_below": "stock", "results_upcoming": "stock",
	"results_declared": "stock", "holding_change": "stock",
	"nav_above": "mf", "nav_below": "mf",
}

// TargetFor returns the target type a kind applies to ("stock" or "mf"), or "" for an unknown kind.
func TargetFor(kind string) string { return kindTarget[kind] }

// ValidateParams checks raw against the schema of kind (unknown keys rejected, every field typed and
// range-checked) and returns the canonical JSON to store. A nil, empty or `null` params value counts
// as `{}`.
func ValidateParams(kind string, raw json.RawMessage) ([]byte, []FieldError) {
	if _, ok := kindTarget[kind]; !ok {
		return nil, []FieldError{{Field: "kind", Message: "unknown alert kind"}}
	}
	m := map[string]json.RawMessage{}
	if t := bytes.TrimSpace(raw); len(t) > 0 && !bytes.Equal(t, []byte("null")) {
		if err := json.Unmarshal(t, &m); err != nil || m == nil {
			return nil, []FieldError{{Field: "params", Message: "must be an object"}}
		}
	}
	v := &paramReader{m: m, out: map[string]any{}, seen: map[string]struct{}{}}
	switch kind {
	case "price_above", "price_below":
		v.num("price", 0, math.MaxFloat64, true)
	case "day_change_pct":
		v.num("pct", 0.1, 50, false)
		v.enum("direction", "up", "down", "either")
	case "wk52_high", "wk52_low", "results_declared":
		// no parameters
	case "ma_cross":
		fast, okF := v.integer("fast", 5, 100)
		slow, okS := v.integer("slow", 20, 300)
		if okF && okS && slow <= fast {
			v.fail("slow", "must be greater than fast")
		}
		v.enum("direction", "golden", "death")
	case "rsi_above", "rsi_below":
		v.num("level", 1, 99, false)
	case "results_upcoming":
		v.integer("days_before", 1, 14)
	case "holding_change":
		v.enum("holder", "promoter", "fii", "dii", "mf")
		v.num("delta_pct", 0.1, 20, false)
	case "nav_above", "nav_below":
		v.num("nav", 0, math.MaxFloat64, true)
	}
	for k := range m {
		if _, ok := v.seen[k]; !ok {
			v.fail(k, "unknown parameter")
		}
	}
	if len(v.errs) > 0 {
		sort.Slice(v.errs, func(i, j int) bool { return v.errs[i].Field < v.errs[j].Field })
		return nil, v.errs
	}
	b, err := json.Marshal(v.out) // map keys are sorted: canonical
	if err != nil {
		return nil, []FieldError{{Field: "params", Message: "could not be encoded"}}
	}
	return b, nil
}

type paramReader struct {
	m    map[string]json.RawMessage
	out  map[string]any
	seen map[string]struct{}
	errs []FieldError
}

func (p *paramReader) fail(key, msg string) {
	p.errs = append(p.errs, FieldError{Field: "params." + key, Message: msg})
}

func (p *paramReader) take(key string) (json.RawMessage, bool) {
	p.seen[key] = struct{}{}
	raw, ok := p.m[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		p.fail(key, "is required")
		return nil, false
	}
	return raw, true
}

func parseNumber(raw json.RawMessage) (float64, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] == '"' {
		return 0, false // numbers only, never numeric strings
	}
	f, err := strconv.ParseFloat(string(t), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// num reads a number; exclusiveLow means the lower bound itself is invalid ("> 0").
func (p *paramReader) num(key string, lo, hi float64, exclusiveLow bool) {
	raw, ok := p.take(key)
	if !ok {
		return
	}
	f, ok := parseNumber(raw)
	switch {
	case !ok:
		p.fail(key, "must be a number")
	case exclusiveLow && f <= lo:
		p.fail(key, "must be > "+trim(lo))
	case !exclusiveLow && (f < lo || f > hi):
		p.fail(key, fmt.Sprintf("must be between %s and %s", trim(lo), trim(hi)))
	default:
		p.out[key] = f
	}
}

func (p *paramReader) integer(key string, lo, hi int) (int, bool) {
	raw, ok := p.take(key)
	if !ok {
		return 0, false
	}
	f, ok := parseNumber(raw)
	if !ok || f != math.Trunc(f) {
		p.fail(key, "must be an integer")
		return 0, false
	}
	if f < float64(lo) || f > float64(hi) {
		p.fail(key, fmt.Sprintf("must be between %d and %d", lo, hi))
		return 0, false
	}
	p.out[key] = int(f)
	return int(f), true
}

func (p *paramReader) enum(key string, allowed ...string) {
	raw, ok := p.take(key)
	if !ok {
		return
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		p.fail(key, "must be a string")
		return
	}
	for _, a := range allowed {
		if s == a {
			p.out[key] = s
			return
		}
	}
	p.fail(key, fmt.Sprintf("must be one of %v", allowed))
}

func trim(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
