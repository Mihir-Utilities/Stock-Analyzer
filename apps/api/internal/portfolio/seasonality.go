package portfolio

import (
	"encoding/json"
	"time"
)

// WatchSeasonality is stocks[].seasonality of GET /watchlist (docs/03 section 11, INV): how the
// current IST calendar month behaved over past years, read from the newest analysis snapshot. A
// description of past prices (price return, dividends excluded), never a signal. Percent fields
// are percent numbers (66.67 = 66.67%).
type WatchSeasonality struct {
	Month          int      `json:"month"`
	MonthName      string   `json:"month_name"`
	AsOf           string   `json:"as_of"`
	DataSince      string   `json:"data_since"`
	YearsOfHistory *float64 `json:"years_of_history"`
	NYears         int      `json:"n_years"`
	NGreen         int      `json:"n_green"`
	GreenPct       *float64 `json:"green_pct"`
	GreenPctReason *string  `json:"green_pct_reason"`
	SmallSample    bool     `json:"small_sample"`
	MinYears       int      `json:"min_years"`
	AvgPct         *float64 `json:"avg_pct"`
	MedianPct      *float64 `json:"median_pct"`
	MtdReturnPct   *float64 `json:"mtd_return_pct"`
	MtdReason      *string  `json:"mtd_reason"`
	MtdAsOf        *string  `json:"mtd_as_of"`
}

// Reasons of a null seasonality (docs/03 section 11).
const (
	ReasonNoPricesImported = "no_prices_imported"
	ReasonNoHistory        = "no_history"
	reasonNoBarThisMonth   = "no_bar_this_month"
)

// storedSeasonality is the part of analysis_snapshot.indicators.analysis.seasonality the watchlist
// reads (written by the worker, docs/05 12.2).
type storedSeasonality struct {
	AsOf           string   `json:"as_of"`
	FirstBar       string   `json:"first_bar"`
	YearsOfHistory *float64 `json:"years_of_history"`
	MinYears       int      `json:"min_years"`
	Running        struct {
		Year         int      `json:"year"`
		Month        int      `json:"month"`
		MtdReturnPct *float64 `json:"mtd_return_pct"`
		MtdReason    *string  `json:"mtd_reason"`
		AsOf         string   `json:"as_of"`
	} `json:"running"`
	Months []struct {
		Month          int      `json:"month"`
		NYears         int      `json:"n_years"`
		NGreen         int      `json:"n_green"`
		GreenPct       *float64 `json:"green_pct"`
		GreenPctReason *string  `json:"green_pct_reason"`
		AvgPct         *float64 `json:"avg_pct"`
		MedianPct      *float64 `json:"median_pct"`
		SmallSample    bool     `json:"small_sample"`
	} `json:"months"`
}

// seasonalityFor picks the entry of today's IST month from the stored block. The month is chosen
// at request time (no recompute when the month changes); the running month never counts in
// n_years (the worker excludes it). The second result is the reason when the value is null.
func seasonalityFor(raw []byte, hasSnapshot, hasPrice bool, today time.Time) (*WatchSeasonality, *string) {
	if !hasSnapshot {
		if !hasPrice {
			return nil, strp(ReasonNoPricesImported)
		}
		return nil, strp(ReasonNoHistory)
	}
	var st storedSeasonality
	if len(raw) == 0 || json.Unmarshal(raw, &st) != nil || len(st.Months) == 0 {
		return nil, strp(ReasonNoHistory) // an older snapshot without the block: not computed yet
	}
	month := int(today.Month())
	for _, m := range st.Months {
		if m.Month != month {
			continue
		}
		out := &WatchSeasonality{
			Month:          month,
			MonthName:      today.Month().String(),
			AsOf:           st.AsOf,
			DataSince:      st.FirstBar,
			YearsOfHistory: st.YearsOfHistory,
			NYears:         m.NYears,
			NGreen:         m.NGreen,
			GreenPct:       m.GreenPct,
			GreenPctReason: m.GreenPctReason,
			SmallSample:    m.SmallSample,
			MinYears:       st.MinYears,
			AvgPct:         m.AvgPct,
			MedianPct:      m.MedianPct,
		}
		asOf, err := time.Parse("2006-01-02", st.AsOf)
		switch {
		case err != nil || asOf.Year() != today.Year() || asOf.Month() != today.Month():
			// The newest snapshot has no bar of this month: the share is still valid, MTD is not.
			out.MtdReason = strp(reasonNoBarThisMonth)
		case st.Running.Year != today.Year() || st.Running.Month != month:
			out.MtdReason = strp(reasonNoBarThisMonth)
		default:
			out.MtdReturnPct, out.MtdReason = st.Running.MtdReturnPct, st.Running.MtdReason
			if st.Running.MtdReturnPct != nil {
				out.MtdAsOf = strp(st.Running.AsOf)
			}
		}
		return out, nil
	}
	return nil, strp(ReasonNoHistory)
}
