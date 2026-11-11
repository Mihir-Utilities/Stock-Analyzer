package importers

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/india-analyzer/api/internal/mfhold"
)

// All fixtures here are SYNTHETIC (made-up fund names, folios and amounts): never a real statement row.

const stmtHdr = "Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty\n"

var mfLimits = Limits{MaxBytes: mfMaxBytes, MaxRows: mfMaxRows}

func testEnv(maps ...string) mfEnv {
	e := mfEnv{today: time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC), holidays: map[time.Time]bool{
		time.Date(2026, 1, 26, 0, 0, 0, 0, time.UTC): true}, mappings: map[string]mfhold.Mapping{}}
	for i, name := range maps {
		k := mfhold.NormalizeFundName(name)
		e.mappings[k] = mfhold.Mapping{FundName: name, FundNameKey: k, SchemeCode: int32(100 + i), SchemeName: "Scheme " + name, Plan: "direct", Option: "growth"}
	}
	return e
}

func scan(t *testing.T, content string, env mfEnv) *mfScan {
	t.Helper()
	sc, err := scanMF([]byte(content), env, mfLimits)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	return sc
}

func errCodes(sc *mfScan) []string {
	var out []string
	for _, e := range sc.Report.Errors.items {
		out = append(out, e.Code)
	}
	return out
}

// MFH-I33 / I22: the statement shape (blank row after the header, DD-Mon-YYYY dates, a folio with a
// slash, 3-decimal units, 2-decimal amounts); header names in any case, spacing or order.
func TestStatementShape(t *testing.T) {
	csv := stmtHdr + ",,,,,,,\n" +
		"05-Nov-2026,Alpha Flexi Cap Fund - Direct Plan - Growth,Purchase,12345678/90,12.345,81.000,999.95,0.05\n" +
		"\n" +
		"05-Oct-2026,Alpha Flexi Cap Fund - Direct Plan - Growth,Purchase,00123,12.100,82.640,999.94,0.05\n"
	sc := scan(t, csv, testEnv("Alpha Flexi Cap Fund - Direct Plan - Growth"))
	if sc.Report.Errors.total != 0 || len(sc.Rows) != 2 {
		t.Fatalf("errors %v rows %d", sc.Report.Errors.items, len(sc.Rows))
	}
	r := sc.Rows[0]
	if r.Line != 3 || r.Folio != "12345678/90" || r.Type != mfhold.TypePurchase || r.Date.Format(time.DateOnly) != "2026-11-05" {
		t.Errorf("row %+v", r)
	}
	if sc.Rows[1].Folio != "00123" || sc.Rows[1].Line != 5 {
		t.Errorf("leading zeros / line numbers: %+v", sc.Rows[1])
	}
	if got := r.Cost().StringFixed(2); got != "1000.00" {
		t.Errorf("cost of a purchase is amount + stamp duty, got %s", got)
	}
	if sc.Report.Warnings.total != 0 {
		t.Errorf("warnings: %v", sc.Report.Warnings.items)
	}
	// Reordered, odd-case headers with a personal-data column that must never surface.
	odd := "client name,TRANSACTION TYPE, folio no ,Fund  Name,AMOUNT,Nav,units traded,Stamp-Duty,date,PAN\n" +
		"Jane Q Sample,Purchase,F-1,Beta Fund,999.95,81.000,12.345,0.05,05-Nov-2026,ABCDE1234F\n"
	sc = scan(t, odd, testEnv("Beta Fund"))
	if len(sc.Rows) != 1 || sc.Report.Errors.total != 0 {
		t.Fatalf("odd header: %v %+v", sc.Report.Errors.items, sc.Rows)
	}
	blob := fmt.Sprintf("%+v %+v %+v", sc.Report.Preview, sc.Report.Errors.items, sc.Report.Warnings.items)
	for _, secret := range []string{"Jane", "ABCDE1234F"} {
		if strings.Contains(blob, secret) {
			t.Errorf("MFH-I30: %q leaked into the preview or issue lists", secret)
		}
	}
	// A missing required header rejects the file and names the header, not the file's own cells.
	sc = scan(t, "Date,Fund Name,Folio No,Units Traded,NAV,Amount\n05-Nov-2026,X,1,1,1,1\n", testEnv())
	if len(sc.Header) != 1 || !strings.Contains(sc.Header[0].Message, "Transaction Type") {
		t.Errorf("header error: %+v", sc.Header)
	}
}

// MFH-I26: numbers and dates.
func TestStatementNumbersAndDates(t *testing.T) {
	ok := func(units, nav, amount, date string) string {
		return fmt.Sprintf("%s,Gamma Fund,Purchase,F1,%s,%s,%s,0\n", date, units, nav, amount)
	}
	cases := []struct {
		name, row string
		wantErr   string // error column or ""
	}{
		{"thousands", ok("1.000", "1,234.56", "1,234.56", "05-Nov-2026"), ""},
		{"lakh", ok("1.000", "1,23,456.78", "1,23,456.78", "05-Nov-2026"), ""},
		{"decimal comma", ok("1.000", `"1234,56"`, "1234.56", "05-Nov-2026"), "NAV"},
		{"short comma", ok("1.000", `"12,34"`, "12.34", "05-Nov-2026"), "NAV"},
		{"5-decimal units", ok("1.23456", "10", "12.35", "05-Nov-2026"), "Units Traded"},
		{"lowercase month", ok("1", "10", "10", "5-nov-2026"), ""},
		{"Sept", ok("1", "10", "10", "05-Sept-2026"), ""},
		{"bad month", ok("1", "10", "10", "05-Xyz-2026"), "Date"},
		{"DD-MM-YYYY", ok("1", "10", "10", "05-11-2026"), ""},
		{"DD/MM/YYYY day first", ok("1", "10", "10", "05/11/2026"), ""},
		{"ISO", ok("1", "10", "10", "2026-11-05"), ""},
		{"future", ok("1", "10", "10", "12-Nov-2026"), "Date"},
		{"exponent", ok("1", "1e3", "1000", "05-Nov-2026"), "NAV"},
	}
	for _, c := range cases {
		sc := scan(t, stmtHdr+c.row, testEnv("Gamma Fund"))
		got := ""
		if len(sc.Report.Errors.items) > 0 {
			got = sc.Report.Errors.items[0].Column
		}
		if got != c.wantErr {
			t.Errorf("%s: error column %q, want %q (%v)", c.name, got, c.wantErr, sc.Report.Errors.items)
		}
	}
	d, err := parseMFDate("03/04/2026")
	if err != nil || d.Month() != time.April || d.Day() != 3 {
		t.Errorf("ambiguous 03/04/2026 must be read day-first: %v %v", d, err)
	}
}

// MFH-I31 / I29 / V02: negative, zero and reversal rows; switch and merger wording; unknown wording.
func TestStatementRowErrors(t *testing.T) {
	row := func(typ, units, nav, amt string) string {
		return fmt.Sprintf("05-Nov-2026,Gamma Fund,%s,F1,%s,%s,%s,0\n", typ, units, nav, amt)
	}
	env := testEnv("Gamma Fund")
	for _, c := range []struct{ row, code string }{
		{row("Purchase", "-1", "10", "10"), "NEGATIVE_OR_REVERSAL_ROW"},
		{row("Purchase", "0", "10", "10"), "NEGATIVE_OR_REVERSAL_ROW"},
		{row("Purchase", "1", "10", "-10"), "NEGATIVE_OR_REVERSAL_ROW"},
		{row("Switch In", "1", "10", "10"), "MF_TXN_TYPE_NOT_SUPPORTED"},
		{row("Switch Out", "1", "10", "10"), "MF_TXN_TYPE_NOT_SUPPORTED"},
		{row("Merger", "1", "10", "10"), "MF_TXN_TYPE_NOT_SUPPORTED"},
		{row("Gift", "1", "10", "10"), "TYPE_UNKNOWN"},
	} {
		sc := scan(t, stmtHdr+c.row, env)
		if got := errCodes(sc); len(got) != 1 || got[0] != c.code {
			t.Errorf("%q: codes %v, want %s", strings.TrimSpace(c.row), got, c.code)
		}
	}
	sc := scan(t, stmtHdr+row("Switch In", "1", "10", "10"), env)
	if m := sc.Report.Errors.items[0].Message; !strings.Contains(m, "redemption plus a purchase") {
		t.Errorf("message must tell the owner to enter a switch as redemption + purchase: %s", m)
	}
}

// MFH-I23 / MFH-23: the fund name is only resolved through a stored mapping, never auto-matched.
func TestUnmappedFund(t *testing.T) {
	csv := stmtHdr +
		"05-Nov-2026,Alpha Fund,Purchase,F1,1,10,10,0\n" +
		"05-Nov-2026,  ALPHA   fund ,Purchase,F1,2,10,20,0\n" +
		"05-Nov-2026,Beta Fund & Co,Purchase,F1,1,10,10,0\n"
	sc := scan(t, csv, testEnv("Alpha Fund")) // the mapping key ignores case and spacing
	codes := errCodes(sc)
	if len(codes) != 1 || codes[0] != "UNMAPPED_FUND" || sc.Report.Errors.items[0].Row != 4 {
		t.Fatalf("errors %+v", sc.Report.Errors.items)
	}
	if sc.Rows[0].SchemeCode != 100 || sc.Rows[1].SchemeCode != 100 || sc.Rows[2].SchemeCode != 0 {
		t.Errorf("scheme codes %d %d %d", sc.Rows[0].SchemeCode, sc.Rows[1].SchemeCode, sc.Rows[2].SchemeCode)
	}
	if len(sc.Preview.Funds) != 2 || sc.Preview.Funds[0].Rows != 2 {
		t.Errorf("funds %+v", sc.Preview.Funds)
	}
	if k := mfhold.NormalizeFundName("Beta Fund & Co."); k != "beta fund and co" {
		t.Errorf("normalised key %q", k)
	}
}

// MFH-I35 / MFH-24: identical rows are separate rows with a stable occurrence index; DUPLICATE_IN_FILE
// is informational and never an error.
func TestIdenticalRows(t *testing.T) {
	same := "05-Nov-2026,Alpha Fund,Purchase,F1,12.345,81.000,999.95,0.05\n"
	other := "05-Nov-2026,Alpha Fund,Purchase,F2,12.345,81.000,999.95,0.05\n"
	two := scan(t, stmtHdr+same+other+same, testEnv("Alpha Fund"))
	if two.Report.Errors.total != 0 || len(two.Rows) != 3 {
		t.Fatalf("errors %v rows %d", two.Report.Errors.items, len(two.Rows))
	}
	if two.Rows[0].Occurrence != 1 || two.Rows[2].Occurrence != 2 || two.Rows[1].Occurrence != 1 {
		t.Errorf("occurrence indexes %d %d %d", two.Rows[0].Occurrence, two.Rows[1].Occurrence, two.Rows[2].Occurrence)
	}
	if two.Rows[0].DedupeKey == two.Rows[2].DedupeKey || two.Rows[0].DedupeKey == two.Rows[1].DedupeKey {
		t.Error("identical rows need distinct keys (occurrence index) and another folio is another key")
	}
	if two.Report.Warnings.total != 2 || two.Report.Warnings.items[0].Code != "DUPLICATE_IN_FILE" {
		t.Errorf("warnings %+v", two.Report.Warnings.items)
	}
	if len(two.Preview.DuplicateGroup) != 1 || two.Preview.DuplicateGroup[0].Count != 2 || two.Preview.DuplicateGroup[0].Rows[0] != 2 {
		t.Errorf("groups %+v", two.Preview.DuplicateGroup)
	}
	// The same file again gives the same keys (idempotent); one more identical row adds one new key.
	again := scan(t, stmtHdr+same+other+same, testEnv("Alpha Fund"))
	three := scan(t, stmtHdr+same+other+same+same, testEnv("Alpha Fund"))
	keys := map[string]bool{}
	for _, r := range two.Rows {
		keys[r.DedupeKey] = true
	}
	for _, r := range again.Rows {
		if !keys[r.DedupeKey] {
			t.Error("re-scan of the same file changed a dedupe key")
		}
	}
	fresh := 0
	for _, r := range three.Rows {
		if !keys[r.DedupeKey] {
			fresh++
		}
	}
	if fresh != 1 {
		t.Errorf("a file with one more identical row adds exactly one new key, got %d", fresh)
	}
	// The key follows the normalised fund name, not the scheme: a re-map does not change keys.
	remapped := testEnv("Alpha Fund")
	m := remapped.mappings["alpha fund"]
	m.SchemeCode = 999
	remapped.mappings["alpha fund"] = m
	if r := scan(t, stmtHdr+same, remapped); r.Rows[0].DedupeKey != two.Rows[0].DedupeKey {
		t.Error("dedupe key must not depend on the mapped scheme")
	}
}

// MFH-I36 / MFH-V09 (importer side): AMOUNT_MISMATCH tolerance, weekend and holiday dates, several
// purchases of one fund in one month.
func TestWarningsAndFacts(t *testing.T) {
	csv := stmtHdr +
		"07-Nov-2026,Alpha Fund,Purchase,F1,10.000,100.000,1000.00,0.05\n" + // Saturday
		"26-Jan-2026,Alpha Fund,Purchase,F1,10.000,100.000,1000.00,0\n" + // listed holiday
		"02-Nov-2026,Alpha Fund,Purchase,F1,10.000,100.000,1000.90,0\n" + // diff 0.90 is within the tolerance: no warning
		"03-Nov-2026,Alpha Fund,Purchase,F1,10.000,100.000,1015.00,0\n" + // diff 15 > 1% of the amount (10.15)
		"04-Nov-2026,Alpha Fund,Purchase,F1,10.000,100.000,1000.00,0\n" +
		"09-Nov-2026,Alpha Fund,Purchase,F1,100.000,100.000,10200.00,0\n" // 1% of 10200 = 102 -> diff 200 > 102
	sc := scan(t, csv, testEnv("Alpha Fund"))
	if sc.Report.Errors.total != 0 {
		t.Fatalf("errors %v", sc.Report.Errors.items)
	}
	codes := map[string]int{}
	for _, w := range sc.Report.Warnings.items {
		codes[w.Code]++
	}
	if codes["NON_BUSINESS_DAY"] != 2 || codes["AMOUNT_MISMATCH"] != 2 {
		t.Errorf("warnings %v", codes)
	}
}

// ---- xlsx ----

type xl struct {
	rows     [][]string // text cells; "=..." marks a formula cell without cached value; "@date:N" an Excel date serial
	sheets   int
	extra    map[string]string
	macro    bool
	padBytes int
}

func buildXLSX(x xl) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(body))
	}
	if x.sheets == 0 {
		x.sheets = 1
	}
	ct := `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`
	if x.macro {
		ct = strings.Replace(ct, "sheet.main+xml", "sheet.macroEnabled.main+xml", 1)
	}
	add("[Content_Types].xml", ct)
	var wb, rels strings.Builder
	wb.WriteString(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	rels.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for i := 1; i <= x.sheets; i++ {
		fmt.Fprintf(&wb, `<sheet name="S%d" sheetId="%d" r:id="rId%d"/>`, i, i, i)
		fmt.Fprintf(&rels, `<Relationship Id="rId%d" Type="worksheet" Target="worksheets/sheet%d.xml"/>`, i, i)
	}
	wb.WriteString(`</sheets></workbook>`)
	rels.WriteString(`</Relationships>`)
	add("xl/workbook.xml", wb.String())
	add("xl/_rels/workbook.xml.rels", rels.String())
	add("xl/styles.xml", `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`)
	var sheet strings.Builder
	sheet.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for ri, row := range x.rows {
		fmt.Fprintf(&sheet, `<row r="%d">`, ri+1)
		for ci, c := range row {
			ref := fmt.Sprintf("%c%d", 'A'+ci, ri+1)
			switch {
			case c == "":
			case strings.HasPrefix(c, "@date:"):
				fmt.Fprintf(&sheet, `<c r="%s" s="1"><v>%s</v></c>`, ref, strings.TrimPrefix(c, "@date:"))
			case strings.HasPrefix(c, "="):
				fmt.Fprintf(&sheet, `<c r="%s"><f>%s</f></c>`, ref, strings.TrimPrefix(c, "="))
			case strings.HasPrefix(c, "#"):
				fmt.Fprintf(&sheet, `<c r="%s"><v>%s</v></c>`, ref, strings.TrimPrefix(c, "#"))
			default:
				fmt.Fprintf(&sheet, `<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, ref, strings.ReplaceAll(c, "&", "&amp;"))
			}
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	for i := 1; i <= x.sheets; i++ {
		body := sheet.String()
		if i > 1 {
			body = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`
		}
		add(fmt.Sprintf("xl/worksheets/sheet%d.xml", i), body)
	}
	for name, body := range x.extra {
		add(name, body)
	}
	if x.macro {
		add("xl/vbaProject.bin", "x")
	}
	if x.padBytes > 0 {
		add("xl/media/pad.bin", strings.Repeat("\x00", x.padBytes))
	}
	_ = zw.Close()
	return buf.Bytes()
}

var xlHdr = []string{"Date", "Fund Name", "Transaction Type", "Folio No", "Units Traded", "NAV", "Amount", "Stamp Duty"}

// MFH-I33: the same statement as xlsx gives the same rows as CSV (date cell, numbers, inline text).
func TestXLSXMatchesCSV(t *testing.T) {
	x := buildXLSX(xl{rows: [][]string{
		{"Statement for Jane Sample", "", "", "PAN ABCDE1234F"}, // title rows above the header are ignored
		xlHdr,
		{},
		{"@date:46331", "Alpha Fund", "Purchase", "12345678/90", "#12.345", "#81", "#999.9500000000001", "#0.05"}, // 2026-11-05
		{"05-Nov-2026", "Alpha Fund", "Purchase", "12345678/90", "12.345", "81.000", "999.95", "0.05"},
	}})
	env := testEnv("Alpha Fund")
	sc, err := scanMF(x, env, mfLimits)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Report.Errors.total != 0 || len(sc.Rows) != 2 {
		t.Fatalf("errors %v rows %d", sc.Report.Errors.items, len(sc.Rows))
	}
	a, b := sc.Rows[0], sc.Rows[1]
	if a.Date != b.Date || a.Date.Format(time.DateOnly) != "2026-11-05" || !a.Amount.Equal(b.Amount) || a.Folio != "12345678/90" || !a.Units.Equal(b.Units) {
		t.Errorf("rows differ: %+v vs %+v", a, b)
	}
	if a.Line != 4 || b.Line != 5 {
		t.Errorf("lines %d %d", a.Line, b.Line)
	}
	blob := fmt.Sprintf("%+v", sc.Report.Preview)
	if strings.Contains(blob, "Jane") || strings.Contains(blob, "ABCDE") {
		t.Error("title-row personal data leaked into the preview")
	}
}

// MFH-I21: workbook hardening.
func TestXLSXHardening(t *testing.T) {
	good := [][]string{xlHdr, {"05-Nov-2026", "Alpha Fund", "Purchase", "F1", "1", "10", "10", "0"}}
	cases := []struct {
		name string
		x    xl
		want string
	}{
		{"macro", xl{rows: good, macro: true}, "macro"},
		{"external link", xl{rows: good, extra: map[string]string{"xl/externalLinks/externalLink1.xml": "<x/>"}}, "external"},
		{"embedded object", xl{rows: good, extra: map[string]string{"xl/embeddings/oleObject1.bin": "x"}}, "embedded"},
		{"zip bomb ratio", xl{rows: good, padBytes: 5 << 20}, "compresses"},
		{"too many entries", xl{rows: good, extra: func() map[string]string {
			m := map[string]string{}
			for i := 0; i < 60; i++ {
				m[fmt.Sprintf("xl/extra/p%d.xml", i)] = "<a/>"
			}
			return m
		}()}, "more than 50"},
	}
	for _, c := range cases {
		_, err := scanMF(buildXLSX(c.x), testEnv("Alpha Fund"), mfLimits)
		if !errors.Is(err, ErrXLSX) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	// A formula cell is never evaluated: without a cached value it is a row error, not a guess.
	sc, err := scanMF(buildXLSX(xl{rows: [][]string{xlHdr, {"05-Nov-2026", "Alpha Fund", "Purchase", "F1", "1", "10", "=A1+1", "0"}}}), testEnv("Alpha Fund"), mfLimits)
	if err != nil || len(errCodes(sc)) != 1 || errCodes(sc)[0] != "UNREADABLE_CELL" {
		t.Errorf("formula without value: %v %v", err, sc.Report.Errors.items)
	}
	// A workbook of six sheets: only the first five are read; a header on the sixth is not found.
	if _, err := readXLSX(buildXLSX(xl{rows: good, sheets: 6}), 10); err != nil {
		t.Errorf("6 sheets: %v", err)
	} else if g, _ := readXLSX(buildXLSX(xl{rows: good, sheets: 6}), 10); len(g) != 5 {
		t.Errorf("only 5 sheets must be read, got %d", len(g))
	}
	// Not a workbook at all.
	if _, err := scanMF([]byte("PK\x03\x04garbage"), testEnv(), mfLimits); !errors.Is(err, ErrXLSX) {
		t.Errorf("garbage zip: %v", err)
	}
	// Too many rows.
	var rows [][]string
	rows = append(rows, xlHdr)
	for i := 0; i < 60; i++ {
		rows = append(rows, []string{"05-Nov-2026", "Alpha Fund", "Purchase", "F1", "1", "10", "10", "0"})
	}
	if _, err := scanMF(buildXLSX(xl{rows: rows}), testEnv("Alpha Fund"), Limits{MaxBytes: mfMaxBytes, MaxRows: 5}); !errors.Is(err, ErrTooManyRows) {
		t.Errorf("row limit: %v", err)
	}
}

// MFH-I20 (service level): content decides the type.
func TestSniff(t *testing.T) {
	if _, err := scanMF(nil, testEnv(), mfLimits); err == nil {
		t.Error("empty file must be rejected")
	}
	if _, err := scanMF([]byte("MZ\x90\x00\x03\x00\x00\x00\x04"), testEnv(), mfLimits); !errors.Is(err, ErrNotText) {
		t.Errorf("exe: %v", err)
	}
	if _, err := scanMF([]byte{0xD0, 0xCF, 0x11, 0xE0, 0, 0}, testEnv(), mfLimits); !errors.Is(err, ErrNotText) {
		t.Errorf("legacy xls: %v", err)
	}
	var b strings.Builder
	b.WriteString(stmtHdr)
	for i := 0; i < 5001; i++ {
		b.WriteString("05-Nov-2026,Alpha Fund,Purchase,F1,1,10,10,0\n")
	}
	if _, err := scanMF([]byte(b.String()), testEnv("Alpha Fund"), mfLimits); !errors.Is(err, ErrTooManyRows) {
		t.Errorf("5,001 rows: %v", err)
	}
	if l := LimitsFor(KindMFStatement, false); l.MaxBytes != 2<<20 || l.MaxRows != 5000 {
		t.Errorf("limits %+v", l)
	}
}

// MFH-I25: text starting with a formula character is plain text; CSV exports prefix it.
func TestCSVInjectionText(t *testing.T) {
	sc := scan(t, stmtHdr+"05-Nov-2026,=HYPERLINK(\"http://x\"),Purchase,@cmd,1,10,10,0\n", testEnv("=HYPERLINK(\"http://x\")"))
	if sc.Report.Errors.total != 0 || sc.Rows[0].Folio != "@cmd" || !strings.HasPrefix(sc.Rows[0].FundName, "=") {
		t.Fatalf("stored text must be unchanged: %+v %v", sc.Rows, sc.Report.Errors.items)
	}
	for _, in := range []string{"=1+1", "+1", "-1", "@x", "\tx", "\rx"} {
		if got := SafeCSVCell(in); got != "'"+in {
			t.Errorf("SafeCSVCell(%q) = %q", in, got)
		}
	}
	if got := mfhold.CleanText("a\x00b\x07c "); got != "abc" {
		t.Errorf("control characters not removed: %q", got)
	}
}
