package importers

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/india-analyzer/api/internal/mfhold"
)

// B15 review tests (docs/07 MFHX-). Every fixture is SYNTHETIC: made-up names, PAN-shaped text, folios
// and amounts; never a row of a real statement.

// rawXLSX builds a workbook from literal parts so a test controls the XML (cell references, workbook
// properties, hidden sheets).
func rawXLSX(workbookPr string, sheets []string, hidden map[int]string, sheetXML ...string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(body))
	}
	add("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`)
	var wb, rels strings.Builder
	wb.WriteString(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` + workbookPr + `<sheets>`)
	rels.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for i := range sheetXML {
		state := ""
		if st, ok := hidden[i]; ok {
			state = fmt.Sprintf(` state=%q`, st)
		}
		fmt.Fprintf(&wb, `<sheet name="S%d" sheetId="%d"%s r:id="rId%d"/>`, i+1, i+1, state, i+1)
		fmt.Fprintf(&rels, `<Relationship Id="rId%d" Type="ws" Target="worksheets/sheet%d.xml"/>`, i+1, i+1)
		add(fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1), sheetXML[i])
	}
	_ = sheets
	wb.WriteString(`</sheets></workbook>`)
	rels.WriteString(`</Relationships>`)
	add("xl/workbook.xml", wb.String())
	add("xl/_rels/workbook.xml.rels", rels.String())
	add("xl/styles.xml", `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`)
	_ = zw.Close()
	return buf.Bytes()
}

func sheetOf(rows ...string) string {
	return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` + strings.Join(rows, "") + `</sheetData></worksheet>`
}

func istr(ref, text string) string {
	return fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, ref, text)
}

func hdrRow(n int) string {
	var b strings.Builder
	fmt.Fprintf(&b, `<row r="%d">`, n)
	for i, h := range xlHdr {
		b.WriteString(istr(fmt.Sprintf("%c%d", 'A'+i, n), h))
	}
	b.WriteString(`</row>`)
	return b.String()
}

func dataRow(n int, cells ...string) string {
	var b strings.Builder
	fmt.Fprintf(&b, `<row r="%d">`, n)
	for i, c := range cells {
		b.WriteString(c)
		_ = i
	}
	b.WriteString(`</row>`)
	return b.String()
}

// stdRow is a normal inline-text data row at line n; folioCell replaces the folio cell when not empty.
func stdRow(n int, folioCell string) string {
	if folioCell == "" {
		folioCell = istr(fmt.Sprintf("D%d", n), "F1")
	}
	return dataRow(n, istr(fmt.Sprintf("A%d", n), "05-Nov-2026"), istr(fmt.Sprintf("B%d", n), "Alpha Fund"),
		istr(fmt.Sprintf("C%d", n), "Purchase"), folioCell, istr(fmt.Sprintf("E%d", n), "1"),
		istr(fmt.Sprintf("F%d", n), "10"), istr(fmt.Sprintf("G%d", n), "10"), istr(fmt.Sprintf("H%d", n), "0"))
}

// MFHX-01 (B1): hostile cell references never allocate by an unchecked column and never panic.
func TestXLSXCellRefHardening(t *testing.T) {
	cases := map[string]string{
		"max column XFD":      "XFD2",
		"four letters":        "AAAA2",
		"lowercase":           "a2",
		"mixed case":          "Ab2",
		"no letters":          "2",
		"letters only":        "B",
		"symbol":              "B$2",
		"above the tight cap": "IW2", // column 257
	}
	for name, ref := range cases {
		x := rawXLSX("", nil, nil, sheetOf(hdrRow(1), dataRow(2, istr(ref, "x"))))
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s: panic %v", name, r)
				}
			}()
			_, err := scanMF(x, testEnv("Alpha Fund"), mfLimits)
			if !errors.Is(err, ErrXLSX) {
				t.Errorf("%s: %v", name, err)
			}
		}()
	}
	// Column IV (256) is the last accepted one; a row without any r attribute is bounded too.
	if _, err := colIndex("IV7"); err != nil {
		t.Errorf("IV7: %v", err)
	}
	var many strings.Builder
	many.WriteString(`<row r="2">`)
	for i := 0; i < xlsxMaxCol+5; i++ {
		many.WriteString(`<c t="inlineStr"><is><t>x</t></is></c>`)
	}
	many.WriteString(`</row>`)
	if _, err := scanMF(rawXLSX("", nil, nil, sheetOf(hdrRow(1), many.String())), testEnv("Alpha Fund"), mfLimits); !errors.Is(err, ErrXLSX) {
		t.Errorf("cells without references: %v", err)
	}
}

// MFHX-02 (S10): a central directory that lies about the sizes cannot defeat the byte budget.
func TestXLSXLyingCentralDirectory(t *testing.T) {
	// A highly compressible 5 MB comment inside a sheet.
	pad := "<!--" + strings.Repeat("a", 5<<20) + "-->"
	x := rawXLSX("", nil, nil, sheetOf(hdrRow(1), stdRow(2, ""))+pad)
	// The honest file trips the ratio guard.
	if _, err := scanMF(x, testEnv("Alpha Fund"), mfLimits); !errors.Is(err, ErrXLSX) {
		t.Fatalf("honest bomb: %v", err)
	}
	// Patch every central-directory entry to claim 100 bytes uncompressed.
	lie := append([]byte(nil), x...)
	n := 0
	for i := 0; i+46 < len(lie); i++ {
		if lie[i] == 'P' && lie[i+1] == 'K' && lie[i+2] == 1 && lie[i+3] == 2 {
			binary.LittleEndian.PutUint32(lie[i+24:], 100)
			n++
		}
	}
	if n == 0 {
		t.Fatal("no central directory entries found")
	}
	_, err := scanMF(lie, testEnv("Alpha Fund"), mfLimits)
	if !errors.Is(err, ErrXLSX) {
		t.Errorf("lying sizes must be a clean xlsx rejection, got %v", err)
	}
}

// MFHX-03 (S10): a DOCTYPE with an entity payload is never expanded.
func TestXLSXEntityPayload(t *testing.T) {
	bomb := `<?xml version="1.0"?><!DOCTYPE s [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>` +
		`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row></sheetData></worksheet>`
	_, err := scanMF(rawXLSX("", nil, nil, bomb), testEnv("Alpha Fund"), mfLimits)
	if !errors.Is(err, ErrXLSX) {
		t.Errorf("entity reference must be rejected, not expanded: %v", err)
	}
	// An external entity reference is rejected the same way (nothing is ever fetched).
	xxe := `<?xml version="1.0"?><!DOCTYPE s [<!ENTITY x SYSTEM "file:///etc/passwd">]>` +
		`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row></sheetData></worksheet>`
	if _, err := scanMF(rawXLSX("", nil, nil, xxe), testEnv("Alpha Fund"), mfLimits); !errors.Is(err, ErrXLSX) {
		t.Errorf("external entity: %v", err)
	}
}

// MFHX-04 (N4/S10): a hidden sheet is never read; a visible one still is.
func TestXLSXHiddenSheet(t *testing.T) {
	good := sheetOf(hdrRow(1), stdRow(2, ""))
	for _, state := range []string{"hidden", "veryHidden"} {
		only := rawXLSX("", nil, map[int]string{0: state}, good)
		sc, err := scanMF(only, testEnv("Alpha Fund"), mfLimits)
		if err != nil || sc.Header == nil || len(sc.Rows) != 0 {
			t.Errorf("%s only sheet must not be read: %v %+v", state, err, sc)
		}
		two := rawXLSX("", nil, map[int]string{0: state}, sheetOf(hdrRow(1), stdRow(2, "")), good)
		sc, err = scanMF(two, testEnv("Alpha Fund"), mfLimits)
		if err != nil || sc.Header != nil || len(sc.Rows) != 1 {
			t.Errorf("%s + visible: %v rows %d", state, err, len(sc.Rows))
		}
	}
}

// MFHX-05 (S4): date1904 workbooks are offset by 1,462 days.
func TestXLSXDate1904(t *testing.T) {
	row := func(serial string) string {
		return dataRow(2, `<c r="A2" s="1"><v>`+serial+`</v></c>`, istr("B2", "Alpha Fund"), istr("C2", "Purchase"), istr("D2", "F1"),
			istr("E2", "1"), istr("F2", "10"), istr("G2", "10"), istr("H2", "0"))
	}
	// 2026-11-05 is serial 46331 in the 1900 system and 44869 in the 1904 system.
	for _, c := range []struct{ pr, serial string }{
		{"", "46331"},
		{`<workbookPr date1904="1"/>`, "44869"},
		{`<workbookPr date1904="true"/>`, "44869"},
		{`<workbookPr date1904="0"/>`, "46331"},
	} {
		sc, err := scanMF(rawXLSX(c.pr, nil, nil, sheetOf(hdrRow(1), row(c.serial))), testEnv("Alpha Fund"), mfLimits)
		if err != nil || len(sc.Rows) != 1 || sc.Rows[0].Date.Format("2006-01-02") != "2026-11-05" {
			t.Errorf("%q %s: %v %v", c.pr, c.serial, err, sc.Report.Errors.items)
		}
	}
}

// MFHX-06 (S5): numeric folios come from the raw <v> text (no float round trip) with a warning;
// text folios keep leading zeros and raise no warning.
func TestXLSXFolioRawText(t *testing.T) {
	warn := func(sc *mfScan) bool {
		for _, w := range sc.Report.Warnings.items {
			if w.Code == "FOLIO_STORED_AS_NUMBER" {
				return true
			}
		}
		return false
	}
	cases := []struct {
		name, cell, want string
		warned, errored  bool
	}{
		{"16+ digits", `<c r="D2"><v>1234567890123456789</v></c>`, "1234567890123456789", true, false},
		{"17 digits ending in 1", `<c r="D2"><v>12345678901234567</v></c>`, "12345678901234567", true, false},
		{"text with leading zeros", istr("D2", "000123456"), "000123456", false, false},
		{"shared-string-like text", `<c r="D2" t="str"><v>007/89</v></c>`, "007/89", false, false},
		{"plain number", `<c r="D2"><v>12345</v></c>`, "12345", true, false},
		{"scientific notation", `<c r="D2"><v>1.2345678901234567E+19</v></c>`, "", true, true},
	}
	for _, c := range cases {
		sc, err := scanMF(rawXLSX("", nil, nil, sheetOf(hdrRow(1), stdRow(2, c.cell))), testEnv("Alpha Fund"), mfLimits)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if c.errored {
			if sc.Report.Errors.total != 1 || len(sc.Rows) != 0 {
				t.Errorf("%s: want one error, got %v", c.name, sc.Report.Errors.items)
			}
			continue
		}
		if len(sc.Rows) != 1 || sc.Rows[0].Folio != c.want {
			t.Errorf("%s: folio %q (errors %v)", c.name, sc.Rows[0].Folio, sc.Report.Errors.items)
			continue
		}
		if warn(sc) != c.warned {
			t.Errorf("%s: FOLIO_STORED_AS_NUMBER = %v, want %v", c.name, warn(sc), c.warned)
		}
		// The stored (canonical) form carries the same folio text.
		again, err := scanMF(sc.Canonical, testEnv("Alpha Fund"), mfLimits)
		if err != nil || len(again.Rows) != 1 || again.Rows[0].Folio != c.want {
			t.Errorf("%s: canonical folio: %v %+v", c.name, err, again.Rows)
		}
	}
}

// MFHX-07 (N4): a cell above the length cap is an unreadable cell, never a huge string in memory.
func TestXLSXCellTextCap(t *testing.T) {
	long := strings.Repeat("x", xlsxMaxCellRunes+1)
	row := dataRow(2, istr("A2", "05-Nov-2026"), istr("B2", long), istr("C2", "Purchase"), istr("D2", "F1"),
		istr("E2", "1"), istr("F2", "10"), istr("G2", "10"), istr("H2", "0"))
	sc, err := scanMF(rawXLSX("", nil, nil, sheetOf(hdrRow(1), row)), testEnv("Alpha Fund"), mfLimits)
	if err != nil || len(errCodes(sc)) != 1 || errCodes(sc)[0] != "UNREADABLE_CELL" {
		t.Errorf("long cell: %v %v", err, sc.Report.Errors.items)
	}
}

// MFHX-08 (S1): the xlsx path answers a clear error while the flag is off; CSV is unaffected.
func TestXLSXFlagOff(t *testing.T) {
	env := testEnv("Alpha Fund")
	env.xlsx = false
	x := rawXLSX("", nil, nil, sheetOf(hdrRow(1), stdRow(2, "")))
	_, err := scanMF(x, env, mfLimits)
	if !errors.Is(err, ErrXLSX) || !strings.Contains(err.Error(), "xlsx not enabled") {
		t.Errorf("flag off: %v", err)
	}
	sc, err := scanMF([]byte(stmtHdr+"05-Nov-2026,Alpha Fund,Purchase,F1,1,10,10,0\n"), env, mfLimits)
	if err != nil || len(sc.Rows) != 1 {
		t.Errorf("csv with flag off: %v", err)
	}
	env.xlsx = true
	if sc, err := scanMF(x, env, mfLimits); err != nil || len(sc.Rows) != 1 {
		t.Errorf("flag on: %v", err)
	}
}

// MFHX-09 (B2): the stored form holds the 8 logical columns only, keeps the file lines and re-reads to
// the same rows and errors.
func TestCanonicalForm(t *testing.T) {
	raw := "Client Name,PAN,Address\nJane Sample,ABCDE1234F,1 Made-up Road\n\n" +
		"Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty,Balance,Email\n" +
		"05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0,99999.99,jane@example.invalid\n" +
		"06-Nov-2026,Alpha Fund,Purchase,F1,-1.000,10.000,10.00,0,99999.99,jane@example.invalid\n" +
		"07-Nov-2026,Beta Fund,SIP,F2,2.000,10.000,20.00,0.01,99999.99,jane@example.invalid\n" +
		"Statement generated for Jane Sample\n"
	env := testEnv("Alpha Fund")
	sc := scan(t, raw, env)
	for _, secret := range []string{"Jane", "ABCDE1234F", "Made-up", "99999", "jane@", "Statement generated", "Client Name"} {
		if bytes.Contains(sc.Canonical, []byte(secret)) {
			t.Errorf("canonical form contains %q", secret)
		}
	}
	again := scan(t, string(sc.Canonical), env)
	if len(again.Rows) != len(sc.Rows) || again.Report.Rows != sc.Report.Rows || again.Report.Errors.total != sc.Report.Errors.total {
		t.Fatalf("re-read differs: rows %d/%d errors %d/%d", len(again.Rows), len(sc.Rows), again.Report.Errors.total, sc.Report.Errors.total)
	}
	for i := range sc.Rows {
		a, b := sc.Rows[i], again.Rows[i]
		if a.Line != b.Line || a.DedupeKey != b.DedupeKey || a.Folio != b.Folio || !a.Units.Equal(b.Units) {
			t.Errorf("row %d differs: %+v vs %+v", i, a, b)
		}
	}
	for l := range sc.Lines {
		if !again.Lines[l] || again.RowErrors[l] != sc.RowErrors[l] {
			t.Errorf("line %d: present %v errors %d/%d", l, again.Lines[l], again.RowErrors[l], sc.RowErrors[l])
		}
	}
	// An unreadable cell stays an UNREADABLE_CELL error on every later read.
	x := rawXLSX("", nil, nil, sheetOf(hdrRow(1), stdRow(2, ""), dataRow(3, istr("A3", "05-Nov-2026"), istr("B3", "Alpha Fund"), `<c r="C3"><f>1+1</f></c>`)))
	xs := scan(t, string(x), env)
	if xs.Report.Errors.total != 1 || errCodes(xs)[0] != "UNREADABLE_CELL" {
		t.Fatalf("xlsx: %v", xs.Report.Errors.items)
	}
	xa := scan(t, string(xs.Canonical), env)
	if xa.Report.Errors.total != 1 || errCodes(xa)[0] != "UNREADABLE_CELL" || !xa.Lines[3] || xa.RowErrors[3] != 1 {
		t.Errorf("unreadable row lost: %v", xa.Report.Errors.items)
	}
	// Control characters never reach the stored text.
	cc := scan(t, stmtHdr+"05-Nov-2026,\"Alpha\nFund\",Purchase,\"F\r1\",1,10,10,0\n", env)
	if strings.ContainsAny(string(cc.Canonical[len(stmtHdr):]), "\r") || strings.Count(string(cc.Canonical), "\n") != 2 {
		t.Errorf("control characters in canonical form: %q", cc.Canonical)
	}
}

// MFHX-10 (N8): any export of statement text must go through SafeCSVCell; imported text is stored as
// written, so every text field of a row that starts with a formula character is guarded on export.
func TestMFExportTextIsGuarded(t *testing.T) {
	sc := scan(t, stmtHdr+"05-Nov-2026,=cmd|' /C calc'!A0,Purchase,+1,1,10,10,0\n", testEnv("=cmd|' /C calc'!A0"))
	if len(sc.Rows) != 1 {
		t.Fatalf("rows: %v", sc.Report.Errors.items)
	}
	for _, field := range []string{sc.Rows[0].FundName, sc.Rows[0].Folio} {
		if got := SafeCSVCell(field); !strings.HasPrefix(got, "'") {
			t.Errorf("%q is not guarded by SafeCSVCell", field)
		}
	}
	_ = mfhold.TypePurchase
}
