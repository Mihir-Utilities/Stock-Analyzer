package importers

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// IMP-02: ISO, DD-MM-YYYY and DD-Mon-YYYY are accepted; MM-DD-YYYY is rejected.
func TestParseDate(t *testing.T) {
	ok := map[string]string{
		"2026-01-05": "2026-01-05", "05-01-2026": "2026-01-05", "5-1-2026": "2026-01-05",
		"05-Jan-2026": "2026-01-05", "5-jan-2026": "2026-01-05", "29-02-2024": "2024-02-29", "31-DEC-2025": "2025-12-31",
	}
	for in, want := range ok {
		got, err := ParseDate(in)
		if err != nil || got.Format(time.DateOnly) != want {
			t.Errorf("ParseDate(%q) = %v, %v; want %s", in, got, err, want)
		}
	}
	bad := []string{"01-25-2026", "2026/01/05", "2026-13-01", "30-02-2026", "29-02-2025", "05-Foo-2026", "", "5 Jan 2026", "20260105"}
	for _, in := range bad {
		if _, err := ParseDate(in); err == nil {
			t.Errorf("ParseDate(%q) accepted", in)
		}
	}
	if _, err := ParseDate("01-25-2026"); err == nil || !strings.Contains(err.Error(), "MM-DD-YYYY") {
		t.Errorf("MM-DD-YYYY message: %v", err)
	}
}

// IMP-03 and IMP-28 (decision D-P): a comma is only a thousands separator.
func TestCleanNumber(t *testing.T) {
	ok := map[string]string{
		"1234.56": "1234.56", "1,234.56": "1234.56", "1,234": "1234", "12,34,567.80": "1234567.80",
		"1,23,456.78": "123456.78", "1,00,00,000": "10000000", "-5": "-5", "0": "0", "100": "100", "12,345": "12345",
	}
	for in, want := range ok {
		got, err := CleanNumber(in)
		if err != nil || got != want {
			t.Errorf("CleanNumber(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{"1.234,56", "1234,56", "12,34", "12,3456", "1,2,3", ",5", "5,", "1,234,56", "1e5", "NaN", "Inf", "abc", "", "--1", "1 234", "+5", "1,234,5"}
	for _, in := range bad {
		if got, err := CleanNumber(in); err == nil {
			t.Errorf("CleanNumber(%q) accepted as %q", in, got)
		}
	}
	if _, err := CleanNumber("1.234,56"); err == nil || !strings.Contains(err.Error(), "decimal comma") {
		t.Errorf("ambiguity message: %v", err)
	}
	if _, err := CleanNumber("1234,56"); err == nil || !strings.Contains(err.Error(), "1234,56") {
		t.Errorf("the offending value must be quoted: %v", err)
	}
}

func TestParseWhole(t *testing.T) {
	for in, want := range map[string]int64{"0": 0, "1250000": 1250000, "1,250,000": 1250000, "12.0": 12, "3.00": 3} {
		if got, err := ParseWhole(in); err != nil || got != want {
			t.Errorf("ParseWhole(%q) = %d, %v", in, got, err)
		}
	}
	for _, in := range []string{"12.5", "1234,5", "x", "99999999999999999999"} {
		if _, err := ParseWhole(in); err == nil {
			t.Errorf("ParseWhole(%q) accepted", in)
		}
	}
}

// IMP-15: imports store text as is; exports prefix a quote.
func TestSafeCSVCell(t *testing.T) {
	for in, want := range map[string]string{"=cmd|' /C calc'!A0": "'=cmd|' /C calc'!A0", "+1": "'+1", "-1": "'-1", "@SUM(A1)": "'@SUM(A1)",
		"\tx": "'\tx", "Acme Ltd": "Acme Ltd", "": ""} {
		if got := SafeCSVCell(in); got != want {
			t.Errorf("SafeCSVCell(%q) = %q, want %q", in, got, want)
		}
	}
}

// IMP-20 field rules shared with the manual Add stock form (IMP-17).
func TestValidateInstrumentFields(t *testing.T) {
	cases := []struct {
		name         string
		in           InstrumentFields
		wantSym      string
		errs, warns  []string // field:code
		wantISINNull bool
	}{
		{"plain", InstrumentFields{"TCS", "Tata Consultancy Services Ltd", "INE467B01029"}, "TCS", nil, nil, false},
		{"charset ampersand and dash", InstrumentFields{"M&M", "Mahindra", ""}, "M&M", nil, nil, true},
		{"dash", InstrumentFields{"BAJAJ-AUTO", "Bajaj Auto", ""}, "BAJAJ-AUTO", nil, nil, true},
		{"lower case is upper-cased with a warning", InstrumentFields{"tcs", "Tata", ""}, "TCS", nil, []string{"symbol:SYMBOL_UPPERCASED"}, true},
		{"bad characters", InstrumentFields{"TC S", "x", ""}, "", []string{"symbol:SYMBOL_CHARSET"}, nil, true},
		{"dot rejected", InstrumentFields{"TCS.NS", "x", ""}, "", []string{"symbol:SYMBOL_CHARSET"}, nil, true},
		{"reserved NIFTY50", InstrumentFields{"NIFTY50", "x", ""}, "", []string{"symbol:SYMBOL_RESERVED"}, nil, true},
		{"reserved INDIAVIX lower", InstrumentFields{"indiavix", "x", ""}, "", []string{"symbol:SYMBOL_RESERVED"}, nil, true},
		{"missing symbol and name", InstrumentFields{"", " ", ""}, "", []string{"symbol:REQUIRED", "name:REQUIRED"}, nil, true},
		{"malformed isin is a warning and stored NULL", InstrumentFields{"TCS", "Tata", "XX123"}, "TCS", nil, []string{"isin:ISIN_MALFORMED"}, true},
		{"isin too long", InstrumentFields{"TCS", "Tata", "INE467B010299"}, "TCS", nil, []string{"isin:ISIN_MALFORMED"}, true},
		{"lower case isin is normalised", InstrumentFields{"TCS", "Tata", "ine467b01029"}, "TCS", nil, nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n, errs, warns := ValidateInstrumentFields(c.in)
			if n.Symbol != c.wantSym {
				t.Errorf("symbol %q, want %q", n.Symbol, c.wantSym)
			}
			if got := codes(errs); strings.Join(got, ",") != strings.Join(c.errs, ",") {
				t.Errorf("errors %v, want %v", got, c.errs)
			}
			if got := codes(warns); strings.Join(got, ",") != strings.Join(c.warns, ",") {
				t.Errorf("warnings %v, want %v", got, c.warns)
			}
			if (n.ISIN == "") != c.wantISINNull {
				t.Errorf("isin %q", n.ISIN)
			}
		})
	}
}

func codes(in []FieldIssue) []string {
	var out []string
	for _, f := range in {
		out = append(out, f.Field+":"+f.Code)
	}
	return out
}

func TestLevenshteinSuggest(t *testing.T) {
	idx := &instrumentIndex{bySymbol: map[string]int32{"TCS": 1, "INFY": 2, "RELIANCE": 3, "HDFCBANK": 4}}
	for in, want := range map[string]string{"TCSS": "TCS", "INFYY": "INFY", "RELIANC": "RELIANCE", "ZZZZ": "", "HDFBANK": "HDFCBANK"} {
		if got := idx.suggest(in); got != want {
			t.Errorf("suggest(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLimitsFor(t *testing.T) {
	if l := LimitsFor(KindPrices, false); l.MaxBytes != 5<<20 || l.MaxRows != 50_000 {
		t.Errorf("prices before S9: %+v", l)
	}
	if l := LimitsFor(KindPrices, true); l.MaxBytes != 25<<20 || l.MaxRows != 300_000 {
		t.Errorf("prices after S9: %+v", l)
	}
	if l := LimitsFor(KindInstruments, true); l.MaxBytes != 5<<20 || l.MaxRows != 50_000 {
		t.Errorf("instruments: %+v", l)
	}
}

// The embedded templates are the owner-format templates under fixtures/templates.
func TestTemplatesMatchFixtures(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "fixtures", "templates")
	for _, kind := range []string{KindPrices, KindInstruments} {
		want, err := os.ReadFile(filepath.Join(dir, kind+".csv")) //nolint:gosec // test fixture path
		if err != nil {
			t.Fatal(err)
		}
		got, name, err := Template(kind)
		if err != nil || name != kind+"_template.csv" {
			t.Fatalf("%s: %v %q", kind, err, name)
		}
		if strings.ReplaceAll(string(want), "\r\n", "\n") != string(got) {
			t.Errorf("%s template differs from fixtures/templates/%s.csv", kind, kind)
		}
	}
	if _, _, err := Template("results_quarterly"); err == nil {
		t.Error("results_quarterly template is B06b")
	}
}
