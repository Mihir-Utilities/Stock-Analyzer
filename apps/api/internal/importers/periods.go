package importers

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

// This file holds the validators shared by the CSV importers and the manual-entry forms
// (docs/01 7.2-7.4, 7.6; IMP-17): one code path, so a value is accepted or rejected identically on
// both paths. They work on raw text cells and return normalised values plus field-level issues.

// Import kinds of B06b (the contract list is AllKinds in service.go).
const (
	KindHolidays          = "holidays"
	KindResultsQuarterly  = "results_quarterly"
	KindResultsAnnual     = "results_annual"
	KindBalanceCashflow   = "balance_cashflow"
	KindFundamentalsLong  = "fundamentals_long"
	KindShareholding      = "shareholding"
	KindCorporateActions  = "corporate_actions"
	KindInstrumentMeta    = "instrument_meta"
	kindManualForm        = "manual_form"
	maxRevenueCrore       = 1e7 // docs/01 7.2: revenue >= 1e7 crore is an error
	maxAbsEPS             = 1e5 // docs/01 7.2: EPS within +/-1e5
	netProfitUnitFactor   = 2.0 // docs/01 7.2: |net_profit| > 2 x revenue is a "check units" warning
	pbtTaxMismatchPercent = 0.15
)

const (
	basisConsolidated = "consolidated"
	basisStandalone   = "standalone"
	periodQuarter     = "Q"
	periodAnnual      = "A"
)

// metricDef maps a wide-template column to its canonical key and unit (docs/05 section 2).
type metricDef struct{ Col, Key, Unit string }

var resultMetrics = []metricDef{
	{"revenue", "pnl.revenue", "INR_CR"}, {"ebitda", "pnl.ebitda", "INR_CR"},
	{"operating_income", "pnl.operating_income", "INR_CR"}, {"other_income", "pnl.other_income", "INR_CR"},
	{"interest", "pnl.interest", "INR_CR"}, {"depreciation", "pnl.depreciation", "INR_CR"},
	{"pbt", "pnl.pbt", "INR_CR"}, {"tax", "pnl.tax", "INR_CR"}, {"net_profit", "pnl.net_profit", "INR_CR"},
	{"eps", "pnl.eps", "INR"},
}

var balanceMetrics = []metricDef{
	{"total_assets", "bs.total_assets", "INR_CR"}, {"total_liabilities", "bs.total_liabilities", "INR_CR"},
	{"equity", "bs.equity", "INR_CR"}, {"borrowings", "bs.borrowings", "INR_CR"},
	{"current_liabilities", "bs.current_liabilities", "INR_CR"}, {"cash", "bs.cash", "INR_CR"},
	{"shares_outstanding", "bs.shares_outstanding", "SHARES"},
	{"cfo", "cf.cfo", "INR_CR"}, {"cfi", "cf.cfi", "INR_CR"}, {"cff", "cf.cff", "INR_CR"}, {"capex", "cf.capex", "INR_CR"},
}

// canonicalUnits is the full key list of docs/05 section 2 (used by fundamentals_long).
var canonicalUnits = func() map[string]string {
	m := map[string]string{}
	for _, d := range resultMetrics {
		m[d.Key] = d.Unit
	}
	for _, d := range balanceMetrics {
		m[d.Key] = d.Unit
	}
	for _, k := range []string{"pnl.nii", "pnl.provisions", "bs.equity_capital", "bs.reserves", "bs.fixed_assets",
		"bs.investments", "bs.inventory", "bs.receivables", "bs.deposits", "bs.advances"} {
		m[k] = "INR_CR"
	}
	return m
}()

// metricShortName returns the template column of a canonical key ("pnl.revenue" -> "revenue").
func metricShortName(key string) string {
	for _, d := range resultMetrics {
		if d.Key == key {
			return d.Col
		}
	}
	for _, d := range balanceMetrics {
		if d.Key == key {
			return d.Col
		}
	}
	return key
}

func issue(field, code, msg string) FieldIssue {
	return FieldIssue{Field: field, Code: code, Message: msg}
}

// isQuarterEnd: 31 Mar, 30 Jun, 30 Sep, 31 Dec.
func isQuarterEnd(d time.Time) bool {
	switch d.Month() {
	case time.March, time.December:
		return d.Day() == 31
	case time.June, time.September:
		return d.Day() == 30
	}
	return false
}

// NormalizedPeriod is a validated basis / period type / period end.
type NormalizedPeriod struct {
	Basis, PeriodType string
	End               time.Time
}

// ValidatePeriod checks the fields common to every fundamentals path (docs/01 7.2): basis in
// consolidated/standalone, period type Q or A (D-Q), a real date that is not in the future, a quarterly
// period_end on a calendar quarter end (error) and an annual one on 31 March (warning otherwise).
func ValidatePeriod(basis, periodType, periodEnd string, today time.Time) (n NormalizedPeriod, errs, warns []FieldIssue) {
	switch b := strings.ToLower(strings.TrimSpace(basis)); b {
	case basisConsolidated, basisStandalone:
		n.Basis = b
	case "":
		errs = append(errs, issue("basis", "REQUIRED", "basis is required (consolidated or standalone)"))
	default:
		errs = append(errs, issue("basis", "BASIS_INVALID", fmt.Sprintf("basis %q must be consolidated or standalone", basis)))
	}
	switch p := strings.ToUpper(strings.TrimSpace(periodType)); p {
	case periodQuarter, periodAnnual:
		n.PeriodType = p
	case "":
		errs = append(errs, issue("period_type", "REQUIRED", "period_type is required (Q or A)"))
	default:
		errs = append(errs, issue("period_type", "PERIOD_TYPE_INVALID", fmt.Sprintf("period_type %q must be Q or A", periodType)))
	}
	raw := strings.TrimSpace(periodEnd)
	if raw == "" {
		return n, append(errs, issue("period_end", "REQUIRED", "period_end is required")), warns
	}
	d, err := ParseDate(raw)
	if err != nil {
		return n, append(errs, issue("period_end", "DATE_INVALID", err.Error())), warns
	}
	n.End = d
	switch {
	case d.After(today):
		errs = append(errs, issue("period_end", "DATE_FUTURE", fmt.Sprintf("%s is in the future", d.Format(time.DateOnly))))
	case n.PeriodType == periodQuarter && !isQuarterEnd(d):
		errs = append(errs, issue("period_end", "NOT_QUARTER_END", fmt.Sprintf("%s is not a calendar quarter end (31 Mar, 30 Jun, 30 Sep or 31 Dec)", d.Format(time.DateOnly))))
	case n.PeriodType == periodAnnual && (d.Month() != time.March || d.Day() != 31):
		warns = append(warns, issue("period_end", "NOT_FISCAL_YEAR_END", fmt.Sprintf("%s is not 31 March; annual periods normally end on the fiscal year end", d.Format(time.DateOnly))))
	}
	return n, errs, warns
}

// checkMetric applies the single-value rules of docs/01 7.2 to one canonical metric.
func checkMetric(key string, v float64) (errs []FieldIssue) {
	switch key {
	case "pnl.revenue":
		if v >= maxRevenueCrore {
			errs = append(errs, issue(key, "REVENUE_TOO_LARGE", fmt.Sprintf("revenue %v is not below 1e7 crore; check the units (INR crore, not INR)", v)))
		}
	case "pnl.eps":
		if math.Abs(v) > maxAbsEPS {
			errs = append(errs, issue(key, "EPS_OUT_OF_RANGE", fmt.Sprintf("eps %v is outside +/-100000; EPS is in INR per share", v)))
		}
	case "bs.shares_outstanding":
		if v <= 0 {
			errs = append(errs, issue(key, "SHARES_NOT_POSITIVE", "shares_outstanding must be greater than 0 (an absolute share count)"))
		}
	}
	return errs
}

// checkCross applies the multi-value warnings of docs/01 7.2 (unit mix-up, tax/PBT mismatch).
func checkCross(values map[string]float64) (warns []FieldIssue) {
	np, hasNP := values["pnl.net_profit"]
	if rev, ok := values["pnl.revenue"]; ok && hasNP && math.Abs(np) > netProfitUnitFactor*math.Abs(rev) {
		warns = append(warns, issue("pnl.net_profit", "NET_PROFIT_UNITS", fmt.Sprintf("net_profit %v is more than twice revenue %v; check units", np, rev)))
	}
	pbt, hasPBT := values["pnl.pbt"]
	tax, hasTax := values["pnl.tax"]
	if hasNP && hasPBT && hasTax {
		implied := pbt - tax
		base := math.Max(math.Abs(implied), math.Abs(np))
		if base > 0 && math.Abs(implied-np) > pbtTaxMismatchPercent*base {
			warns = append(warns, issue("pnl.net_profit", "PBT_TAX_MISMATCH", fmt.Sprintf("pbt - tax (%v) differs from net_profit (%v) by more than 15%% (minority interest or exceptional items?)", round6(implied), np)))
		}
	}
	return warns
}

func round6(v float64) float64 { return math.Round(v*1e6) / 1e6 }

// FundamentalInput is one period of one stock as raw text: Cells is keyed by canonical metric key.
type FundamentalInput struct {
	Basis, PeriodType, PeriodEnd string
	Cells                        map[string]string
}

// NormalizedFundamentals is the validated period; Values holds only the non-empty metrics (an empty
// cell is not a value and never becomes 0, IMP-04).
type NormalizedFundamentals struct {
	NormalizedPeriod
	Values map[string]float64
}

// ValidateFundamentals is the single validator behind results_quarterly, results_annual,
// balance_cashflow and the manual results form. Issue fields are canonical keys for metric cells.
func ValidateFundamentals(in FundamentalInput, today time.Time) (n NormalizedFundamentals, errs, warns []FieldIssue) {
	n.NormalizedPeriod, errs, warns = ValidatePeriod(in.Basis, in.PeriodType, in.PeriodEnd, today)
	n.Values = map[string]float64{}
	keys := make([]string, 0, len(in.Cells))
	for key := range in.Cells {
		keys = append(keys, key)
	}
	sort.Strings(keys) // deterministic issue order
	for _, key := range keys {
		raw := in.Cells[key]
		if strings.TrimSpace(raw) == "" {
			continue
		}
		if _, known := canonicalUnits[key]; !known {
			errs = append(errs, issue(key, "METRIC_UNKNOWN", fmt.Sprintf("unknown metric %q", key)))
			continue
		}
		v, err := ParseFloat(raw)
		if err != nil {
			errs = append(errs, issue(key, "NUMBER_INVALID", err.Error()))
			continue
		}
		if e := checkMetric(key, v); len(e) > 0 {
			errs = append(errs, e...)
			continue
		}
		n.Values[key] = v
	}
	if len(errs) == 0 {
		warns = append(warns, checkCross(n.Values)...)
	}
	return n, errs, warns
}

// ---- shareholding (docs/01 7.3) ----

// ShareholdingInput is one quarter as raw text.
type ShareholdingInput struct {
	QuarterEnd, Promoter, FII, DII, MF, Insurance, Govt, Public, Pledged, Count, FiledOn string
}

// NormalizedShareholding is the validated quarter; nil means unknown (blank), never 0.
type NormalizedShareholding struct {
	QuarterEnd                                      time.Time
	Promoter, FII, DII, MF, Insurance, Govt, Public *float64
	Pledged                                         *float64
	Count                                           *int32
	FiledOn                                         *time.Time
}

const (
	holdingSumTolerance = 1.0 // promoter+fii+dii+govt+public within 100 +/- 1.0
	holdingMFTolerance  = 0.5 // mf+insurance <= dii + 0.5
)

// ValidateShareholding is the single validator behind shareholding.csv and the manual form.
func ValidateShareholding(in ShareholdingInput, today time.Time) (n NormalizedShareholding, errs, warns []FieldIssue) {
	if raw := strings.TrimSpace(in.QuarterEnd); raw == "" {
		errs = append(errs, issue("quarter_end", "REQUIRED", "quarter_end is required"))
	} else if d, err := ParseDate(raw); err != nil {
		errs = append(errs, issue("quarter_end", "DATE_INVALID", err.Error()))
	} else {
		n.QuarterEnd = d
		switch {
		case !isQuarterEnd(d):
			errs = append(errs, issue("quarter_end", "NOT_QUARTER_END", fmt.Sprintf("%s is not a calendar quarter end (31 Mar, 30 Jun, 30 Sep or 31 Dec)", d.Format(time.DateOnly))))
		case d.After(today):
			errs = append(errs, issue("quarter_end", "DATE_FUTURE", fmt.Sprintf("%s is in the future", d.Format(time.DateOnly))))
		}
	}
	pct := func(field, raw string) *float64 {
		if strings.TrimSpace(raw) == "" {
			return nil
		}
		v, err := ParseFloat(raw)
		switch {
		case err != nil:
			errs = append(errs, issue(field, "NUMBER_INVALID", err.Error()))
		case v < 0 || v > 100:
			errs = append(errs, issue(field, "PERCENT_RANGE", fmt.Sprintf("%s must be between 0 and 100 (a percent number)", field)))
		default:
			return &v
		}
		return nil
	}
	n.Promoter, n.FII, n.DII = pct("promoter", in.Promoter), pct("fii", in.FII), pct("dii", in.DII)
	n.MF, n.Insurance = pct("mf", in.MF), pct("insurance", in.Insurance)
	n.Govt, n.Public = pct("govt", in.Govt), pct("public", in.Public)
	n.Pledged = pct("pledged_of_promoter", in.Pledged)
	if raw := strings.TrimSpace(in.Count); raw != "" {
		v, err := ParseWhole(raw)
		switch {
		case err != nil:
			errs = append(errs, issue("shareholders_count", "NUMBER_INVALID", err.Error()))
		case v < 0 || v > math.MaxInt32:
			errs = append(errs, issue("shareholders_count", "COUNT_RANGE", "shareholders_count must be a whole number of 0 or more"))
		default:
			c := int32(v) //nolint:gosec // bounded above
			n.Count = &c
		}
	}
	if raw := strings.TrimSpace(in.FiledOn); raw != "" {
		if d, err := ParseDate(raw); err != nil {
			errs = append(errs, issue("filed_on", "DATE_INVALID", err.Error()))
		} else {
			n.FiledOn = &d
		}
	}
	if len(errs) > 0 {
		return n, errs, warns
	}
	if n.Promoter != nil && n.FII != nil && n.DII != nil && n.Govt != nil && n.Public != nil {
		sum := *n.Promoter + *n.FII + *n.DII + *n.Govt + *n.Public
		if math.Abs(sum-100) > holdingSumTolerance {
			errs = append(errs, issue("promoter", "HOLDING_SUM", fmt.Sprintf("promoter + fii + dii + govt + public = %.2f; it must be 100 +/- 1.0", sum)))
		}
	}
	if n.MF != nil && n.Insurance != nil && n.DII != nil && *n.MF+*n.Insurance > *n.DII+holdingMFTolerance {
		errs = append(errs, issue("mf", "MF_INSURANCE_EXCEEDS_DII", fmt.Sprintf("mf + insurance = %.2f exceeds dii %.2f (they are components of dii)", *n.MF+*n.Insurance, *n.DII)))
	}
	return n, errs, warns
}

// ---- corporate actions (docs/01 7.4) ----

var actionTypes = map[string]bool{"split": true, "bonus": true, "dividend": true, "rights": true,
	"buyback": true, "merger": true, "demerger": true, "other": true}

const maxPurposeText = 500

// ActionInput is one corporate action as raw text.
type ActionInput struct {
	ExDate, Type, RatioNum, RatioDen, Amount, Purpose string
}

// NormalizedAction holds the validated action; ratios and amount are numeric text ("" = NULL).
type NormalizedAction struct {
	ExDate             time.Time
	Type               string
	RatioNum, RatioDen *string // numeric(12,4)
	Amount             *string // numeric(14,4)
	Purpose            string
}

// decimalCell parses a numeric cell with at most dp decimals and below limit.
func decimalCell(field, raw string, dp int32, limit int64) (*string, *FieldIssue) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	c, err := CleanNumber(raw)
	if err != nil {
		i := issue(field, "NUMBER_INVALID", err.Error())
		return nil, &i
	}
	d, err := decimal.NewFromString(c)
	switch {
	case err != nil:
		i := issue(field, "NUMBER_INVALID", fmt.Sprintf("%q is not a number", raw))
		return nil, &i
	case d.Sign() <= 0:
		i := issue(field, "NOT_POSITIVE", field+" must be greater than 0")
		return nil, &i
	case !d.Equal(d.Round(dp)):
		i := issue(field, "TOO_MANY_DECIMALS", fmt.Sprintf("%s may have at most %d decimal places", field, dp))
		return nil, &i
	case d.GreaterThanOrEqual(decimal.NewFromInt(limit)):
		i := issue(field, "TOO_LARGE", field+" is too large")
		return nil, &i
	}
	s := d.StringFixed(dp)
	return &s, nil
}

// ValidateAction is the single validator behind corporate_actions.csv and the manual action form.
// A future ex-date is accepted (ACT-10: stored now, applied once ex_date <= as_of).
func ValidateAction(in ActionInput) (n NormalizedAction, errs, warns []FieldIssue) {
	if raw := strings.TrimSpace(in.ExDate); raw == "" {
		errs = append(errs, issue("ex_date", "REQUIRED", "ex_date is required"))
	} else if d, err := ParseDate(raw); err != nil {
		errs = append(errs, issue("ex_date", "DATE_INVALID", err.Error()))
	} else {
		n.ExDate = d
	}
	t := strings.ToLower(strings.TrimSpace(in.Type))
	switch {
	case t == "":
		errs = append(errs, issue("type", "REQUIRED", "type is required"))
	case !actionTypes[t]:
		errs = append(errs, issue("type", "TYPE_INVALID", fmt.Sprintf("type %q must be one of split, bonus, dividend, rights, buyback, merger, demerger, other", in.Type)))
	default:
		n.Type = t
	}
	var e *FieldIssue
	if n.RatioNum, e = decimalCell("ratio_num", in.RatioNum, 4, 100_000_000); e != nil {
		errs = append(errs, *e)
	}
	if n.RatioDen, e = decimalCell("ratio_den", in.RatioDen, 4, 100_000_000); e != nil {
		errs = append(errs, *e)
	}
	if n.Amount, e = decimalCell("amount_per_share", in.Amount, 4, 10_000_000_000); e != nil {
		errs = append(errs, *e)
	}
	purpose := strings.TrimSpace(in.Purpose)
	if len([]rune(purpose)) > maxPurposeText {
		errs = append(errs, issue("purpose_text", "TOO_LONG", fmt.Sprintf("purpose_text must be at most %d characters", maxPurposeText)))
	} else {
		n.Purpose = purpose
	}
	if len(errs) > 0 {
		return n, errs, warns
	}
	hasNum, hasDen := strings.TrimSpace(in.RatioNum) != "", strings.TrimSpace(in.RatioDen) != ""
	switch n.Type {
	case "split", "bonus":
		if !hasNum || !hasDen {
			what := "ratio_num = old face value and ratio_den = new face value (10 and 2 for 10 to 2)"
			if n.Type == "bonus" {
				what = "ratio_num = new shares and ratio_den = shares held (1 and 1 for 1:1)"
			}
			errs = append(errs, issue("ratio_num", "RATIO_REQUIRED", n.Type+" needs both ratios: "+what))
		} else if n.RatioNum != nil && n.RatioDen != nil && *n.RatioNum == *n.RatioDen && n.Type == "split" {
			errs = append(errs, issue("ratio_num", "RATIO_NO_CHANGE", "a split with equal ratios changes nothing"))
		}
	case "dividend":
		if n.Amount == nil {
			errs = append(errs, issue("amount_per_share", "AMOUNT_REQUIRED", "a dividend needs amount_per_share"))
		}
	default:
		if hasNum != hasDen {
			errs = append(errs, issue("ratio_num", "RATIO_PAIR", "give ratio_num and ratio_den together or neither"))
		}
	}
	return n, errs, warns
}

// ---- instrument_meta (docs/01 7.5) ----

const maxMetaText = 100

func validIndexTag(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == ' ', r == '-', r == '&', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// NormalizedMeta is a validated instrument_meta row; empty text keeps the stored value on update.
type NormalizedMeta struct {
	Sector, Industry, CompanyType *string
	Tags                          []string
}

// ValidateMeta validates the non-symbol cells of instrument_meta.csv.
func ValidateMeta(sector, industry, companyType, tags string) (n NormalizedMeta, errs, warns []FieldIssue) {
	text := func(field, raw string) *string {
		v := strings.TrimSpace(raw)
		switch {
		case v == "":
			return nil
		case len([]rune(v)) > maxMetaText:
			errs = append(errs, issue(field, "TOO_LONG", fmt.Sprintf("%s must be at most %d characters", field, maxMetaText)))
			return nil
		}
		return &v
	}
	n.Sector, n.Industry = text("sector", sector), text("industry", industry)
	if v := strings.ToLower(strings.TrimSpace(companyType)); v != "" {
		if v != "general" && v != "financial" {
			errs = append(errs, issue("company_type", "COMPANY_TYPE_INVALID", fmt.Sprintf("company_type %q must be general or financial", companyType)))
		} else {
			n.CompanyType = &v
		}
	}
	seen := map[string]bool{}
	for _, tag := range strings.Split(tags, "|") {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if !validIndexTag(tag) {
			errs = append(errs, issue("index_tags", "TAG_INVALID", fmt.Sprintf("index tag %q must be 1-40 letters, digits, spaces or - & _ . (separate tags with |)", tag)))
			continue
		}
		if !seen[tag] {
			seen[tag] = true
			n.Tags = append(n.Tags, tag)
		}
	}
	return n, errs, warns
}

// ---- holidays (docs/01 7.8) ----

const maxHolidayText = 200

// NormalizedHoliday is a validated holidays.csv row.
type NormalizedHoliday struct {
	Date        time.Time
	Segment     string
	Description *string
}

// ValidateHoliday validates one holidays.csv row: a real date in 2000..current year + 1, a segment
// of trading or clearing (default trading); a weekend date is a warning (kept).
func ValidateHoliday(date, description, segment string, today time.Time) (n NormalizedHoliday, errs, warns []FieldIssue) {
	if raw := strings.TrimSpace(date); raw == "" {
		errs = append(errs, issue("date", "REQUIRED", "date is required"))
	} else if d, err := ParseDate(raw); err != nil {
		errs = append(errs, issue("date", "DATE_INVALID", err.Error()))
	} else {
		n.Date = d
		if d.Year() < 2000 || d.Year() > today.Year()+1 {
			errs = append(errs, issue("date", "YEAR_RANGE", fmt.Sprintf("year %d is outside 2000 to %d", d.Year(), today.Year()+1)))
		} else if wd := d.Weekday(); wd == time.Saturday || wd == time.Sunday {
			warns = append(warns, issue("date", "HOLIDAY_WEEKEND", fmt.Sprintf("%s is a %s; the row was kept", d.Format(time.DateOnly), wd)))
		}
	}
	switch s := strings.ToLower(strings.TrimSpace(segment)); s {
	case "":
		n.Segment = "trading"
	case "trading", "clearing":
		n.Segment = s
	default:
		errs = append(errs, issue("segment", "SEGMENT_INVALID", fmt.Sprintf("segment %q must be trading or clearing", segment)))
	}
	if v := strings.TrimSpace(description); v != "" {
		if len([]rune(v)) > maxHolidayText {
			errs = append(errs, issue("description", "TOO_LONG", fmt.Sprintf("description must be at most %d characters", maxHolidayText)))
		} else {
			n.Description = &v
		}
	}
	return n, errs, warns
}
