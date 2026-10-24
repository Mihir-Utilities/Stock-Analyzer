// Package importers validates and commits owner-supplied CSV files (docs/01 section 7). B06a covers
// the `instruments` and `prices` kinds and the price management actions (delete, trim).
package importers

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// IST is the market time zone (fixed offset: no tzdata dependency).
var IST = time.FixedZone("IST", 5*3600+1800)

// RowIssue is one error or warning of a validated file (docs/03 section 14). Row is the 1-based
// line of the record in the file, so the header is row 1 and the first data row is row 2. Row is 0
// for file-level issues.
type RowIssue struct {
	Row     int    `json:"row"`
	Column  string `json:"column"`
	Message string `json:"message"`
}

var (
	reISODate   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	reDMYDate   = regexp.MustCompile(`^(\d{1,2})-(\d{1,2})-(\d{4})$`)
	reDMonYDate = regexp.MustCompile(`^(\d{1,2})-([A-Za-z]{3})-(\d{4})$`)
	reSymbol    = regexp.MustCompile(`^[A-Z0-9][A-Z0-9&-]{0,29}$`)
	reISIN      = regexp.MustCompile(`^IN[A-Z0-9]{10}$`)
	reSeries    = regexp.MustCompile(`^[A-Z0-9]{1,10}$`)

	reIntl     = regexp.MustCompile(`^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$`)
	reIndian   = regexp.MustCompile(`^[1-9]\d?(,\d{2})+,\d{3}(\.\d+)?$`)
	reLeadZero = regexp.MustCompile(`^0+,\d+$`)
	reEuropean = regexp.MustCompile(`^\d{1,3}(\.\d{3})+,\d+$`)
)

var monthNames = map[string]time.Month{
	"jan": time.January, "feb": time.February, "mar": time.March, "apr": time.April,
	"may": time.May, "jun": time.June, "jul": time.July, "aug": time.August,
	"sep": time.September, "oct": time.October, "nov": time.November, "dec": time.December,
}

// DateFloor is the earliest accepted calendar date for any imported date (assumption B06a-18).
var DateFloor = time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC)

const dateHelp = "use YYYY-MM-DD, DD-MM-YYYY or DD-Mon-YYYY"

// ParseDate accepts YYYY-MM-DD, DD-MM-YYYY and DD-Mon-YYYY (docs/01 section 7). MM-DD-YYYY is
// rejected. The result is midnight UTC of the calendar date.
func ParseDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	mk := func(y, m, d int) (time.Time, error) {
		t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
		if t.Year() != y || int(t.Month()) != m || t.Day() != d {
			return time.Time{}, fmt.Errorf("%q is not a real calendar date", s)
		}
		if t.Before(DateFloor) {
			return time.Time{}, fmt.Errorf("%q is before %s, the earliest accepted date", s, DateFloor.Format(time.DateOnly))
		}
		return t, nil
	}
	switch {
	case reISODate.MatchString(s):
		y, _ := strconv.Atoi(s[0:4])
		m, _ := strconv.Atoi(s[5:7])
		d, _ := strconv.Atoi(s[8:10])
		return mk(y, m, d)
	case reDMYDate.MatchString(s):
		g := reDMYDate.FindStringSubmatch(s)
		d, _ := strconv.Atoi(g[1])
		m, _ := strconv.Atoi(g[2])
		y, _ := strconv.Atoi(g[3])
		if m > 12 && d <= 12 {
			return time.Time{}, fmt.Errorf("%q looks like MM-DD-YYYY, which is not accepted; %s", s, dateHelp)
		}
		return mk(y, m, d)
	case reDMonYDate.MatchString(s):
		g := reDMonYDate.FindStringSubmatch(s)
		d, _ := strconv.Atoi(g[1])
		mon, ok := monthNames[strings.ToLower(g[2])]
		if !ok {
			return time.Time{}, fmt.Errorf("%q has an unknown month name; %s", s, dateHelp)
		}
		y, _ := strconv.Atoi(g[3])
		return mk(y, int(mon), d)
	}
	return time.Time{}, fmt.Errorf("%q is not a recognised date; %s", s, dateHelp)
}

// CleanNumber normalises a numeric cell to a plain decimal string (decision D-P, IMP-03, IMP-28).
// A comma is accepted only as a thousands separator in a valid grouping: 1,234.56 or Indian lakh
// grouping 1,23,456.78. Everything else with a comma (1234,56; 12,34; 1.234,56) is rejected as
// ambiguous, never read silently as 123456 or 1234.56.
func CleanNumber(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	neg := false
	if strings.HasPrefix(s, "-") {
		neg, s = true, strings.TrimSpace(s[1:])
	}
	var out string
	switch {
	case isPlainNumber(s):
		out = s
	case reIntl.MatchString(s) || reIndian.MatchString(s):
		out = strings.ReplaceAll(s, ",", "")
	case strings.Contains(s, ","):
		hint := ""
		if reEuropean.MatchString(s) || reLeadZero.MatchString(s) {
			hint = " (looks like a decimal comma)"
		}
		return "", fmt.Errorf("%q is ambiguous%s: a comma is only accepted as a thousands separator (1,234.56 or 1,23,456.78); write the decimal point as '.'", raw, hint)
	default:
		return "", fmt.Errorf("%q is not a number", raw)
	}
	if neg {
		out = "-" + out
	}
	return out, nil
}

// isPlainNumber is the fast path of rePlain (digits with one inner decimal point); large files
// run it millions of times.
func isPlainNumber(s string) bool {
	if s == "" {
		return false
	}
	dot := -1
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c >= '0' && c <= '9':
		case c == '.' && dot < 0:
			dot = i
		default:
			return false
		}
	}
	return dot != 0 && dot != len(s)-1
}

// ParseFloat parses a cleaned numeric cell into a finite float64.
func ParseFloat(raw string) (float64, error) {
	c, err := CleanNumber(raw)
	if err != nil {
		return 0, err
	}
	f, err := strconv.ParseFloat(c, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, fmt.Errorf("%q is out of range", raw)
	}
	return f, nil
}

// ParseWhole parses a whole number (1250000, 1,250,000, 1250000.0).
func ParseWhole(raw string) (int64, error) {
	c, err := CleanNumber(raw)
	if err != nil {
		return 0, err
	}
	if i := strings.IndexByte(c, '.'); i >= 0 {
		if strings.Trim(c[i+1:], "0") != "" {
			return 0, fmt.Errorf("%q must be a whole number", raw)
		}
		c = c[:i]
	}
	n, err := strconv.ParseInt(c, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%q is out of range", raw)
	}
	return n, nil
}

// Reserved market-series symbols (docs/01 7.1): written to market_series, never to instrument.
const (
	ReservedNifty50   = "NIFTY50"
	ReservedIndiaVIX  = "INDIAVIX"
	maxInstrumentName = 200
)

// IsReserved reports whether sym (upper case) is a reserved market-series code.
func IsReserved(sym string) bool { return sym == ReservedNifty50 || sym == ReservedIndiaVIX }

// InstrumentFields are the raw inputs shared by instruments.csv and POST /instruments.
type InstrumentFields struct {
	Symbol, Name, ISIN string
}

// FieldIssue is an error or warning for one input field; Code is the stable machine code.
type FieldIssue struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// NormalizedInstrument is the validated, normalised form (ISIN "" means NULL).
type NormalizedInstrument struct{ Symbol, Name, ISIN string }

// ValidateInstrumentFields is the single validator behind both the CSV path and the manual Add stock
// form (IMP-17). Errors reject the input; warnings keep it (a malformed ISIN is stored as NULL).
func ValidateInstrumentFields(in InstrumentFields) (n NormalizedInstrument, errs, warns []FieldIssue) {
	sym := strings.TrimSpace(in.Symbol)
	if sym == "" {
		errs = append(errs, FieldIssue{"symbol", "REQUIRED", "symbol is required"})
	} else {
		up := upperTrim(sym)
		switch {
		case !reSymbol.MatchString(up):
			errs = append(errs, FieldIssue{"symbol", "SYMBOL_CHARSET", fmt.Sprintf("symbol %q must use only A-Z, 0-9, & and - (at most 30 characters)", sym)})
		case IsReserved(up):
			errs = append(errs, FieldIssue{"symbol", "SYMBOL_RESERVED", up + " is reserved for the market series in prices.csv and cannot be a stock"})
		default:
			n.Symbol = up
			if up != sym {
				warns = append(warns, FieldIssue{"symbol", "SYMBOL_UPPERCASED", fmt.Sprintf("symbol %q was converted to upper case", sym)})
			}
		}
	}
	name := strings.TrimSpace(in.Name)
	switch {
	case name == "":
		errs = append(errs, FieldIssue{"name", "REQUIRED", "name is required"})
	case len([]rune(name)) > maxInstrumentName:
		errs = append(errs, FieldIssue{"name", "NAME_TOO_LONG", fmt.Sprintf("name must be at most %d characters", maxInstrumentName)})
	default:
		n.Name = name
	}
	if isin := upperTrim(in.ISIN); isin != "" {
		if reISIN.MatchString(isin) {
			n.ISIN = isin
		} else {
			warns = append(warns, FieldIssue{"isin", "ISIN_MALFORMED", fmt.Sprintf("isin %q is not a valid ISIN (IN + 10 letters or digits); stored as empty", in.ISIN)})
		}
	}
	return n, errs, warns
}

// SafeCSVCell makes a text cell safe for spreadsheet export: a leading = + - @ tab or CR gets a
// leading apostrophe (IMP-15, CSV injection). Imports always store the original text.
func SafeCSVCell(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}
