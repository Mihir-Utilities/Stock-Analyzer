package prices

import (
	"encoding/json"
	"fmt"
)

// MaxSeriesPoints caps every indicator series at the last 750 trading days (docs/03 section 4).
const MaxSeriesPoints = 750

// alignedAnalysisKeys of snapshot.analysis are aligned to series.dates (D05a-A6); the other keys
// (histogram, month_year, calendar) carry their own labels and pass through.
var alignedAnalysisKeys = []string{"drawdown", "rolling_vol_21", "rolling_vol_63", "rolling_beta_252"}

// ExpandIndicators turns the stored indicators jsonb (columnar series, D05a-A6) into the API shape
// of docs/03 section 4: every series array becomes `[[date, value], ...]` pairs, nulls kept at
// warm-up positions. The result is the snapshot object plus `scores`.
func ExpandIndicators(indicators, scores []byte) (map[string]any, error) {
	var snap map[string]any
	if err := json.Unmarshal(indicators, &snap); err != nil {
		return nil, fmt.Errorf("prices: indicators jsonb: %w", err)
	}
	var sc any
	if err := json.Unmarshal(scores, &sc); err != nil {
		return nil, fmt.Errorf("prices: scores jsonb: %w", err)
	}
	snap["scores"] = sc

	series, _ := snap["series"].(map[string]any)
	dates, _ := series["dates"].([]any)
	if series != nil {
		out := map[string]any{}
		for k, v := range series {
			if k == "format" || k == "dates" {
				continue
			}
			out[k] = pairs(dates, v)
		}
		snap["series"] = out
	}
	if an, ok := snap["analysis"].(map[string]any); ok {
		delete(an, "format")
		for _, k := range alignedAnalysisKeys {
			if v, ok := an[k]; ok {
				an[k] = pairs(dates, v)
			}
		}
	}
	return snap, nil
}

// pairs zips an array (or a map of arrays) with the shared dates. A length mismatch is not
// papered over: values without a date are dropped from the end and the rest are kept aligned.
// Only the most recent MaxSeriesPoints pairs are returned.
func pairs(dates []any, v any) any {
	switch x := v.(type) {
	case []any:
		n := min(len(dates), len(x))
		start := max(0, n-MaxSeriesPoints) // keep the most recent points
		out := make([][2]any, 0, n-start)
		for i := start; i < n; i++ {
			out = append(out, [2]any{dates[i], x[i]})
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, sub := range x {
			out[k] = pairs(dates, sub)
		}
		return out
	}
	return v
}
