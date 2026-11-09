package importers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// F13b-3 parity guard: fixtures/validation-cases.json is read by this test (the server is
// authoritative) and by apps/web/tests/unit/validation-parity.test.ts (the browser mirror in
// lib/imports/entry-validate.ts). A rule change must change the table, and both sides must pass.

type parityCase struct {
	ID            string          `json:"id"`
	Input         json.RawMessage `json:"input"`
	Today         string          `json:"today"`
	OK            bool            `json:"ok"`
	Value         string          `json:"value"`
	Field         string          `json:"field"`
	ErrorContains string          `json:"error_contains"`
}

type parityTable struct {
	Numbers      []parityCase `json:"numbers"`
	Dates        []parityCase `json:"dates"`
	Results      []parityCase `json:"results"`
	Shareholding []parityCase `json:"shareholding"`
	Actions      []parityCase `json:"actions"`
}

func loadParityTable(t *testing.T) parityTable {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "fixtures", "validation-cases.json")) //nolint:gosec // test fixture path
	if err != nil {
		t.Fatal(err)
	}
	var tab parityTable
	if err := json.Unmarshal(b, &tab); err != nil {
		t.Fatal(err)
	}
	return tab
}

// rawString is the "input" of the numbers and dates tables (a JSON string).
func rawString(t *testing.T, c parityCase) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(c.Input, &s); err != nil {
		t.Fatalf("%s: input is not a string: %v", c.ID, err)
	}
	return s
}

func parityToday(t *testing.T, c parityCase) time.Time {
	t.Helper()
	d, err := time.Parse(time.DateOnly, c.Today)
	if err != nil {
		t.Fatalf("%s: bad today %q", c.ID, c.Today)
	}
	return d
}

// expectIssue checks the case outcome against the validator's errors (warnings never count).
func expectIssue(t *testing.T, c parityCase, errs []FieldIssue, field func(string) string) {
	t.Helper()
	if c.OK {
		if len(errs) > 0 {
			t.Errorf("%s: want no error, got %+v", c.ID, errs)
		}
		return
	}
	for _, e := range errs {
		if field(e.Field) == c.Field && strings.Contains(e.Message, c.ErrorContains) {
			return
		}
	}
	t.Errorf("%s: want an error on %q containing %q, got %+v", c.ID, c.Field, c.ErrorContains, errs)
}

func TestValidationParityNumbers(t *testing.T) {
	for _, c := range loadParityTable(t).Numbers {
		t.Run(c.ID, func(t *testing.T) {
			got, err := CleanNumber(rawString(t, c))
			if c.OK {
				if err != nil || got != c.Value {
					t.Errorf("CleanNumber = %q, %v; want %q", got, err, c.Value)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.ErrorContains) {
				t.Errorf("CleanNumber error = %v; want one containing %q", err, c.ErrorContains)
			}
		})
	}
}

func TestValidationParityDates(t *testing.T) {
	for _, c := range loadParityTable(t).Dates {
		t.Run(c.ID, func(t *testing.T) {
			got, err := ParseDate(rawString(t, c))
			if c.OK {
				if err != nil || got.Format(time.DateOnly) != c.Value {
					t.Errorf("ParseDate = %v, %v; want %s", got, err, c.Value)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.ErrorContains) {
				t.Errorf("ParseDate error = %v; want one containing %q", err, c.ErrorContains)
			}
		})
	}
}

func TestValidationParityResults(t *testing.T) {
	for _, c := range loadParityTable(t).Results {
		t.Run(c.ID, func(t *testing.T) {
			var in struct {
				Basis      string            `json:"basis"`
				PeriodType string            `json:"period_type"`
				PeriodEnd  string            `json:"period_end"`
				Values     map[string]string `json:"values"`
			}
			if err := json.Unmarshal(c.Input, &in); err != nil {
				t.Fatal(err)
			}
			cells := map[string]string{}
			for k, v := range in.Values {
				cells["pnl."+k] = v
			}
			_, errs, _ := ValidateFundamentals(FundamentalInput{Basis: in.Basis, PeriodType: in.PeriodType, PeriodEnd: in.PeriodEnd, Cells: cells}, parityToday(t, c))
			expectIssue(t, c, errs, func(f string) string { return strings.TrimPrefix(f, "pnl.") })
		})
	}
}

func TestValidationParityShareholding(t *testing.T) {
	for _, c := range loadParityTable(t).Shareholding {
		t.Run(c.ID, func(t *testing.T) {
			var in struct {
				QuarterEnd string            `json:"quarter_end"`
				FiledOn    string            `json:"filed_on"`
				Count      string            `json:"count"`
				Pct        map[string]string `json:"pct"`
			}
			if err := json.Unmarshal(c.Input, &in); err != nil {
				t.Fatal(err)
			}
			p := in.Pct
			_, errs, _ := ValidateShareholding(ShareholdingInput{
				QuarterEnd: in.QuarterEnd, FiledOn: in.FiledOn, Count: in.Count,
				Promoter: p["promoter"], FII: p["fii"], DII: p["dii"], MF: p["mf"], Insurance: p["insurance"],
				Govt: p["govt"], Public: p["public"], Pledged: p["pledged_of_promoter"],
			}, parityToday(t, c))
			expectIssue(t, c, errs, func(f string) string { return f })
		})
	}
}

func TestValidationParityActions(t *testing.T) {
	for _, c := range loadParityTable(t).Actions {
		t.Run(c.ID, func(t *testing.T) {
			var in struct {
				ExDate   string `json:"ex_date"`
				Type     string `json:"type"`
				RatioNum string `json:"ratio_num"`
				RatioDen string `json:"ratio_den"`
				Amount   string `json:"amount"`
				Purpose  string `json:"purpose"`
			}
			if err := json.Unmarshal(c.Input, &in); err != nil {
				t.Fatal(err)
			}
			_, errs, _ := ValidateAction(ActionInput{ExDate: in.ExDate, Type: in.Type, RatioNum: in.RatioNum, RatioDen: in.RatioDen, Amount: in.Amount, Purpose: in.Purpose})
			expectIssue(t, c, errs, func(f string) string { return f })
		})
	}
}
