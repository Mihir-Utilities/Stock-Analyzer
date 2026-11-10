// Package screener serves the whitelisted screener, saved screens, compare and peers (B13,
// docs/03 sections 5, 8 and 9). It reads precomputed `screener_row.metrics`; it never calls a
// third-party site. Every metric key is mapped to a fixed SQL expression here; user input only ever
// travels as a bind parameter.
package screener

import (
	"fmt"
	"regexp"
)

// Kind is the value type of a metric.
type Kind int

// Metric kinds.
const (
	Numeric Kind = iota
	Text
)

// Direction says which side of a metric is better when comparing stocks.
type Direction int

// Directions; DirNone means "no winner is declared" (size, price, holder mix, momentum levels).
const (
	DirNone Direction = iota
	DirHigher
	DirLower
)

// Metric describes one whitelisted screener key.
type Metric struct {
	Key  string
	Kind Kind
	Unit string
	Dir  Direction
	// PositiveOnly marks lower-is-better ratios where a value <= 0 is not a meaningful winner
	// (a negative P/E is not "cheap").
	PositiveOnly bool
	expr         string // fixed SQL expression over screener_row alias sr; built at init from Key
}

// Units reported to clients (docs/03 section 1: every number carries a unit).
const (
	UnitINRCr   = "INR_CR"
	UnitINR     = "INR"
	UnitPercent = "PERCENT"
	UnitPP      = "PERCENT_POINTS"
	UnitRatio   = "RATIO"
	UnitIndex   = "INDEX_0_100"
	UnitScore   = "SCORE_0_100"
	UnitText    = "TEXT"
)

// whitelist is the complete docs/03 section 9 metric list, in documentation order. Nothing else is
// accepted; TestWhitelistMatchesWorker checks that the worker writes every key.
var whitelist = []Metric{
	{Key: "market_cap_cr", Unit: UnitINRCr},
	{Key: "price", Unit: UnitINR},
	{Key: "pe", Unit: UnitRatio, Dir: DirLower, PositiveOnly: true},
	{Key: "pb", Unit: UnitRatio, Dir: DirLower, PositiveOnly: true},
	{Key: "ev_ebitda", Unit: UnitRatio, Dir: DirLower, PositiveOnly: true},
	{Key: "div_yield", Unit: UnitPercent, Dir: DirHigher},
	{Key: "roe", Unit: UnitPercent, Dir: DirHigher},
	{Key: "roce", Unit: UnitPercent, Dir: DirHigher},
	{Key: "debt_equity", Unit: UnitRatio, Dir: DirLower},
	{Key: "interest_coverage", Unit: UnitRatio, Dir: DirHigher},
	{Key: "op_margin", Unit: UnitPercent, Dir: DirHigher},
	{Key: "net_margin", Unit: UnitPercent, Dir: DirHigher},
	{Key: "rev_growth_1y", Unit: UnitPercent, Dir: DirHigher},
	{Key: "rev_growth_3y", Unit: UnitPercent, Dir: DirHigher},
	{Key: "rev_growth_5y", Unit: UnitPercent, Dir: DirHigher},
	{Key: "profit_growth_1y", Unit: UnitPercent, Dir: DirHigher},
	{Key: "profit_growth_3y", Unit: UnitPercent, Dir: DirHigher},
	{Key: "profit_growth_5y", Unit: UnitPercent, Dir: DirHigher},
	{Key: "cfo_to_pat", Unit: UnitRatio, Dir: DirHigher},
	{Key: "promoter_pct", Unit: UnitPercent},
	{Key: "promoter_pledged_pct", Unit: UnitPercent, Dir: DirLower},
	{Key: "fii_pct", Unit: UnitPercent},
	{Key: "dii_pct", Unit: UnitPercent},
	{Key: "mf_pct", Unit: UnitPercent},
	{Key: "fii_change_qoq", Unit: UnitPP},
	{Key: "mf_change_qoq", Unit: UnitPP},
	{Key: "rsi14", Unit: UnitIndex},
	{Key: "dist_52w_high_pct", Unit: UnitPercent},
	{Key: "ret_1m", Unit: UnitPercent, Dir: DirHigher},
	{Key: "ret_6m", Unit: UnitPercent, Dir: DirHigher},
	{Key: "ret_1y", Unit: UnitPercent, Dir: DirHigher},
	{Key: "quality_score", Unit: UnitScore, Dir: DirHigher},
	{Key: "trend_score", Unit: UnitScore, Dir: DirHigher},
	{Key: "risk_score", Unit: UnitScore, Dir: DirLower},
	{Key: "sector", Kind: Text, Unit: UnitText},
	{Key: "industry", Kind: Text, Unit: UnitText},
}

var byKey = map[string]*Metric{}

var keyShape = regexp.MustCompile(`^[a-z][a-z0-9_]{0,40}$`)

func init() {
	for i := range whitelist {
		m := &whitelist[i]
		// The key becomes part of a SQL literal, so it must be a plain identifier. This is a
		// compile-time constant list, never user input; the check guards future edits.
		if !keyShape.MatchString(m.Key) {
			panic("screener: unsafe whitelist key " + m.Key)
		}
		if _, dup := byKey[m.Key]; dup {
			panic("screener: duplicate whitelist key " + m.Key)
		}
		if m.Kind == Numeric {
			// A non-number (or absent) value reads as NULL, so it is "missing" rather than an error.
			m.expr = fmt.Sprintf("(CASE WHEN jsonb_typeof(sr.metrics->'%[1]s') = 'number' THEN (sr.metrics->>'%[1]s')::float8 END)", m.Key)
		} else {
			m.expr = fmt.Sprintf("(CASE WHEN jsonb_typeof(sr.metrics->'%[1]s') = 'string' THEN sr.metrics->>'%[1]s' END)", m.Key)
		}
		byKey[m.Key] = m
	}
}

// Lookup returns the whitelisted metric for an exact key.
func Lookup(key string) (*Metric, bool) {
	m, ok := byKey[key]
	return m, ok
}

// Keys returns every whitelisted key in documentation order.
func Keys() []string {
	out := make([]string, len(whitelist))
	for i, m := range whitelist {
		out[i] = m.Key
	}
	return out
}

// Unit is the unit string of a whitelisted key.
func Unit(key string) string {
	if m, ok := byKey[key]; ok {
		return m.Unit
	}
	return ""
}
