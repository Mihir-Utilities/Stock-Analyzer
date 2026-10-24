package importers

import (
	"fmt"
	"strings"
	"testing"
)

// Unit tests of the B06b validators and scanners; no database. The scanners run against a hand-built
// instrument index (the integration tests cover the SQL).

func testIndex() *instrumentIndex {
	x := &instrumentIndex{bySymbol: map[string]int32{}, byID: map[int32]string{}, alias: map[string]int32{}, tracked: map[int32]bool{}, status: map[int32]string{}}
	for i, s := range []string{"AAA", "BBB", "GONE"} {
		id := int32(i + 1)
		x.bySymbol[s], x.byID[id], x.status[id] = id, s, "active"
	}
	x.status[3] = "delisted"
	x.alias["OLDA"] = 1
	return x
}

func scanKind(t *testing.T, kind, csv string) (*scanReport, []RowIssue) {
	t.Helper()
	rep, hdr, err := scanOwner(kind, []byte(csv), ownerEnv{idx: testIndex(), today: testToday}, LimitsFor(kind, false), nil)
	if err != nil {
		t.Fatalf("%s: %v", kind, err)
	}
	return rep, hdr
}

func hasIssue(items []RowIssue, row int, col, frag string) bool {
	for _, i := range items {
		if i.Row == row && i.Column == col && strings.Contains(i.Message, frag) {
			return true
		}
	}
	return false
}

const (
	resHdr   = "symbol,basis,period_end,revenue,ebitda,operating_income,other_income,interest,depreciation,pbt,tax,net_profit,eps\n"
	shareHdr = "symbol,quarter_end,promoter,fii,dii,mf,insurance,govt,public,pledged_of_promoter,shareholders_count,filed_on\n"
	actHdr   = "symbol,ex_date,type,ratio_num,ratio_den,amount_per_share,purpose_text\n"
	longHdr  = "symbol,basis,period_type,period_end,metric_key,value,unit\n"
)

// IMP-01: a wrong header names what is wrong, lists the expected columns and links the template, per kind.
func TestOwnerHeaders(t *testing.T) {
	for _, kind := range []string{KindResultsQuarterly, KindResultsAnnual, KindBalanceCashflow, KindFundamentalsLong,
		KindShareholding, KindCorporateActions, KindInstrumentMeta, KindHolidays} {
		_, hdr := scanKind(t, kind, "foo,bar\n1,2\n")
		if len(hdr) != 1 || hdr[0].Row != 1 || !strings.Contains(hdr[0].Message, "Expected columns:") ||
			!strings.Contains(hdr[0].Message, "/api/v1/imports/templates/"+kind) || !strings.Contains(hdr[0].Message, `unexpected column "foo"`) {
			t.Errorf("%s: %+v", kind, hdr)
		}
	}
	_, hdr := scanKind(t, KindResultsQuarterly, "symbol,basis,revenue\nAAA,consolidated,1\n")
	if len(hdr) != 1 || !strings.Contains(hdr[0].Message, `missing column "period_end"`) {
		t.Errorf("missing required column: %+v", hdr)
	}
	if _, hdr := scanKind(t, KindHolidays, ""); len(hdr) != 1 || !strings.Contains(hdr[0].Message, "empty") {
		t.Errorf("empty file: %+v", hdr)
	}
}

// IMP-05: a quarterly period_end that is not a calendar quarter end is an error; annual off 31 March is
// a warning; a future period is an error.
func TestQuarterEnd(t *testing.T) {
	rep, _ := scanKind(t, KindResultsQuarterly, resHdr+
		"AAA,consolidated,2026-06-30,100,,,,,,,,,\n"+ // ok
		"AAA,consolidated,2026-06-29,100,,,,,,,,,\n"+
		"AAA,consolidated,30-Sep-2026,100,,,,,,,,,\n"+ // DD-Mon-YYYY, a quarter end
		"AAA,consolidated,2026-12-31,100,,,,,,,,,\n"+ // future
		"AAA,consolidated,06-30-2026,100,,,,,,,,,\n") // MM-DD-YYYY rejected (IMP-02)
	if rep.Valid != 2 || rep.Errors.total != 3 {
		t.Fatalf("valid %d errors %+v", rep.Valid, rep.Errors.items)
	}
	if !hasIssue(rep.Errors.items, 3, "period_end", "not a calendar quarter end") || !hasIssue(rep.Errors.items, 5, "period_end", "in the future") ||
		!hasIssue(rep.Errors.items, 6, "period_end", "MM-DD-YYYY") {
		t.Errorf("%+v", rep.Errors.items)
	}
	ann, _ := scanKind(t, KindResultsAnnual, resHdr+"AAA,consolidated,2026-03-31,100,,,,,,,,,\nAAA,consolidated,2025-12-31,100,,,,,,,,,\n")
	if ann.Valid != 2 || ann.Errors.total != 0 || !hasIssue(ann.Warnings.items, 3, "period_end", "not 31 March") {
		t.Errorf("annual: valid %d err %+v warn %+v", ann.Valid, ann.Errors.items, ann.Warnings.items)
	}
}

// IMP-06 and the rest of 7.2: units, EPS range, shares, PBT - tax mismatch.
func TestResultsRules(t *testing.T) {
	rep, _ := scanKind(t, KindResultsAnnual, resHdr+
		"AAA,consolidated,2026-03-31,100,,,,,,,,201,\n"+ // net profit > 2 x revenue: warning
		"AAA,standalone,2026-03-31,10000000,,,,,,,,,\n"+ // revenue 1e7: error
		"AAA,standalone,2025-03-31,9999999,,,,,,,,,\n"+ // just under: ok
		"BBB,consolidated,2026-03-31,,,,,,,,,,100001\n"+ // EPS out of range
		"BBB,consolidated,2025-03-31,,,,,,,1000,200,500,-99999\n") // pbt - tax = 800 vs 500: warning; EPS ok
	if rep.Valid != 3 || rep.Errors.total != 2 {
		t.Fatalf("valid %d errors %+v", rep.Valid, rep.Errors.items)
	}
	if !hasIssue(rep.Warnings.items, 2, "net_profit", "check units") || !hasIssue(rep.Errors.items, 3, "revenue", "1e7") ||
		!hasIssue(rep.Errors.items, 5, "eps", "outside") || !hasIssue(rep.Warnings.items, 6, "net_profit", "15%") {
		t.Errorf("errors %+v warnings %+v", rep.Errors.items, rep.Warnings.items)
	}
	bs, _ := scanKind(t, KindBalanceCashflow, "symbol,basis,period_end,total_assets,shares_outstanding,capex\n"+
		"AAA,consolidated,2026-03-31,100,0,5\nAAA,consolidated,2025-03-31,100,1000,5\nAAA,consolidated,2024-03-31,,,\n")
	if bs.Valid != 1 || !hasIssue(bs.Errors.items, 2, "shares_outstanding", "greater than 0") || !hasIssue(bs.Warnings.items, 4, "", "no values") {
		t.Errorf("balance: valid %d err %+v warn %+v", bs.Valid, bs.Errors.items, bs.Warnings.items)
	}
}

// IMP-04 and IMP-03/IMP-28 on the B06b kinds: an empty cell is not stored (never 0); a decimal comma is rejected.
func TestEmptyCellsAndNumbers(t *testing.T) {
	var ops []fundOp
	rep, hdr, err := scanFundamentalsWide(KindResultsQuarterly, []byte(resHdr+"AAA,consolidated,2026-06-30,\"1,234.50\",,,,,,,,,\n"),
		ownerEnv{idx: testIndex(), today: testToday}, LimitsFor(KindResultsQuarterly, false), nil)
	_ = ops
	if err != nil || hdr != nil || rep.Valid != 1 || rep.Preview[0]["revenue"] != 1234.5 {
		t.Fatalf("%+v %v", rep, err)
	}
	if _, ok := rep.Preview[0]["ebitda"]; ok {
		t.Error("an empty cell must not appear as a value")
	}
	bad, _ := scanKind(t, KindResultsQuarterly, "symbol;basis;period_end;revenue\nAAA;consolidated;2026-06-30;1234,56\nAAA;consolidated;2026-03-31;12,34\nAAA;consolidated;2025-12-31;1.234,56\n")
	if bad.Valid != 0 || bad.Errors.total != 3 || !hasIssue(bad.Errors.items, 2, "revenue", "ambiguous") || !hasIssue(bad.Errors.items, 4, "revenue", "decimal comma") {
		t.Errorf("%+v", bad.Errors.items)
	}
	// IMP-16: BOM and semicolons parse.
	ok, _ := scanKind(t, KindResultsQuarterly, "\xEF\xBB\xBFsymbol;basis;period_end;revenue\nAAA;consolidated;2026-06-30;1,23,456.5\n")
	if ok.Valid != 1 || ok.Errors.total != 0 {
		t.Errorf("BOM+semicolon: %+v", ok.Errors.items)
	}
}

// IMP-08, IMP-18 (and the renamed-symbol message): unknown, delisted and renamed symbols.
func TestSymbolRules(t *testing.T) {
	rep, _ := scanKind(t, KindResultsQuarterly, resHdr+
		"AAB,consolidated,2026-06-30,1,,,,,,,,,\n"+
		"GONE,consolidated,2026-06-30,1,,,,,,,,,\n"+
		"OLDA,consolidated,2026-06-30,1,,,,,,,,,\n"+
		"aaa,consolidated,2026-06-30,1,,,,,,,,,\n"+
		",consolidated,2026-06-30,1,,,,,,,,,\n")
	if rep.Valid != 1 || rep.Errors.total != 4 {
		t.Fatalf("valid %d %+v", rep.Valid, rep.Errors.items)
	}
	for row, frag := range map[int]string{2: "did you mean AAA", 3: "delisted", 4: "renamed to AAA", 6: "required"} {
		if !hasIssue(rep.Errors.items, row, "symbol", frag) {
			t.Errorf("row %d: want %q in %+v", row, frag, rep.Errors.items)
		}
	}
}

// IMP-09: identical duplicates warn (stored once); contradictory duplicates are an error.
func TestDuplicatesInFile(t *testing.T) {
	rep, _ := scanKind(t, KindResultsQuarterly, resHdr+
		"AAA,consolidated,2026-06-30,100,,,,,,,,,\n"+
		"AAA,consolidated,2026-06-30,100,,,,,,,,,\n"+
		"AAA,consolidated,2026-06-30,101,,,,,,,,,\n"+
		"AAA,standalone,2026-06-30,101,,,,,,,,,\n")
	if rep.Valid != 2 || rep.Errors.total != 1 || rep.Warnings.total != 1 ||
		!hasIssue(rep.Errors.items, 4, "period_end", "different values") || !hasIssue(rep.Warnings.items, 3, "period_end", "identical") {
		t.Errorf("valid %d err %+v warn %+v", rep.Valid, rep.Errors.items, rep.Warnings.items)
	}
	lg, _ := scanKind(t, KindFundamentalsLong, longHdr+
		"AAA,consolidated,Q,2026-06-30,pnl.revenue,100,INR_CR\nAAA,consolidated,Q,2026-06-30,pnl.revenue,100,\nAAA,consolidated,Q,2026-06-30,pnl.revenue,5,\n")
	if lg.Valid != 1 || lg.Errors.total != 1 || lg.Warnings.total != 1 {
		t.Errorf("long: valid %d err %+v warn %+v", lg.Valid, lg.Errors.items, lg.Warnings.items)
	}
	hol, _ := scanKind(t, KindHolidays, "date,description,segment\n2026-01-26,Republic Day,\n2026-01-26,Again,trading\n2026-01-26,Clearing only,clearing\n")
	if hol.Valid != 2 || hol.Errors.total != 1 || !hasIssue(hol.Errors.items, 3, "date", "twice") {
		t.Errorf("holidays: %+v", hol.Errors.items)
	}
}

func TestFundamentalsLong(t *testing.T) {
	rep, _ := scanKind(t, KindFundamentalsLong, longHdr+
		"AAA,consolidated,Q,2026-06-30,pnl.revenue,1200.5,INR_CR\n"+
		"AAA,consolidated,Q,2026-06-30,pnl.net_profit,3000,\n"+ // > 2 x revenue: warning on the group
		"AAA,consolidated,Q,2026-06-30,pnl.eps,,INR\n"+ // empty value: NULL row, not 0
		"AAA,consolidated,Q,2026-06-30,pnl.nope,1,\n"+
		"AAA,consolidated,Q,2026-06-30,pnl.ebitda,1,INR\n"+ // wrong unit
		"AAA,consolidated,X,2026-06-30,pnl.ebitda,1,\n"+
		"AAA,consolidated,Q,2026-06-29,pnl.ebitda,1,\n"+
		"AAA,consolidated,A,2026-03-31,bs.shares_outstanding,0,SHARES\n")
	if rep.Valid != 3 || rep.Errors.total != 5 {
		t.Fatalf("valid %d errors %+v", rep.Valid, rep.Errors.items)
	}
	for row, c := range map[int][2]string{5: {"metric_key", "unknown metric_key"}, 6: {"unit", "does not match"}, 7: {"period_type", "Q or A"},
		8: {"period_end", "quarter end"}, 9: {"value", "greater than 0"}} {
		if !hasIssue(rep.Errors.items, row, c[0], c[1]) {
			t.Errorf("row %d: want %v in %+v", row, c, rep.Errors.items)
		}
	}
	if !hasIssue(rep.Warnings.items, 2, "value", "check units") {
		t.Errorf("group warning: %+v", rep.Warnings.items)
	}
	if v, ok := rep.Preview[2]["value"]; ok {
		t.Errorf("empty value must stay NULL, got %v", v)
	}
}

// IMP-07 and SHP-05.
func TestShareholdingRules(t *testing.T) {
	rep, _ := scanKind(t, KindShareholding, shareHdr+
		"AAA,2026-06-30,50,20,15,9,3,1,14,,,\n"+ // sums to 100: ok, pledge unknown
		"AAA,2026-03-31,50,20,15,9,3,1,14.9,,,\n"+ // 100.9: within 1.0
		"AAA,2025-12-31,50,20,15,9,3,1,15.2,,,\n"+ // 101.2: error
		"AAA,2025-09-30,50,20,15,9,6.5,1,14,,,\n"+ // mf+insurance 15.5 <= dii + 0.5: ok
		"AAA,2025-06-30,50,20,15,9,6.6,1,14,,,\n"+ // 15.6 > 15.5: error
		"AAA,2026-06-15,50,20,15,9,3,1,14,,,\n"+ // not a quarter end (SHP-05)
		"BBB,2026-06-30,50,20,,,,,,,,\n"+ // not all present: no sum check
		"BBB,2026-03-31,101,,,,,,,,,\n"+ // percent above 100
		"BBB,2025-12-31,50,,,,,,,0,,\n"+ // pledged 0 is stored as 0; blank is unknown
		"BBB,2025-09-30,,,,,,,,,-5,\n")
	if rep.Valid != 5 || rep.Errors.total != 5 {
		t.Fatalf("valid %d errors %+v", rep.Valid, rep.Errors.items)
	}
	for row, c := range map[int][2]string{4: {"promoter", "100 +/- 1.0"}, 6: {"mf", "components of dii"}, 7: {"quarter_end", "quarter end"},
		9: {"promoter", "between 0 and 100"}, 11: {"shareholders_count", "whole number"}} {
		if !hasIssue(rep.Errors.items, row, c[0], c[1]) {
			t.Errorf("row %d: want %v in %+v", row, c, rep.Errors.items)
		}
	}
	if _, ok := rep.Preview[0]["pledged_of_promoter"]; ok {
		t.Error("a blank pledge is unknown, not 0")
	}
}

func TestActionRules(t *testing.T) {
	rep, _ := scanKind(t, KindCorporateActions, actHdr+
		"AAA,2026-02-10,split,10,2,,Sub-division\n"+
		"AAA,2026-03-10,bonus,1,1,,\n"+
		"AAA,2026-04-10,dividend,,,12.5,Interim\n"+
		"AAA,2027-01-10,split,5,1,,Future ex-date is fine (ACT-10)\n"+
		"AAA,2026-05-10,split,,,,missing ratios\n"+
		"AAA,2026-05-11,dividend,,,,no amount\n"+
		"AAA,2026-05-12,split_or_bonus,1,2,,system-only type\n"+
		"AAA,2026-05-13,bonus,1,0,,zero\n"+
		"AAA,2026-05-14,rights,1,,,half a ratio\n"+
		"AAA,2026-05-15,split,10,2.12345,,five decimals\n"+
		"AAA,2026-05-16,split,2,2,,no change\n"+
		"AAA,2026-05-17,split,1,10,,reverse split is allowed\n"+
		"AAA,2026-02-10,split,10,2,,Sub-division\n") // identical duplicate: warning
	if rep.Valid != 5 || rep.Errors.total != 7 || rep.Warnings.total != 1 {
		t.Fatalf("valid %d errors %+v warnings %+v", rep.Valid, rep.Errors.items, rep.Warnings.items)
	}
	for row, c := range map[int][2]string{6: {"ratio_num", "needs both ratios"}, 7: {"amount_per_share", "needs amount"}, 8: {"type", "must be one of"},
		9: {"ratio_den", "greater than 0"}, 10: {"ratio_num", "together"}, 11: {"ratio_den", "4 decimal"}, 12: {"ratio_num", "changes nothing"}} {
		if !hasIssue(rep.Errors.items, row, c[0], strings.Fields(c[1])[0]) {
			t.Errorf("row %d: want %v in %+v", row, c, rep.Errors.items)
		}
	}
	// ACT-05 storage side: the ratios are kept exactly as typed (split 10 -> 2 stays 10 and 2; bonus 1:1 stays 1 and 1).
	if rep.Preview[0]["ratio_num"] != "10.0000" || rep.Preview[0]["ratio_den"] != "2.0000" || rep.Preview[1]["ratio_num"] != "1.0000" {
		t.Errorf("%+v %+v", rep.Preview[0], rep.Preview[1])
	}
}

func TestMetaAndHolidayRules(t *testing.T) {
	rep, _ := scanKind(t, KindInstrumentMeta, "symbol,sector,industry,company_type,index_tags\n"+
		"AAA,IT,Services,general,NIFTY50|NIFTY100|NIFTY50\nBBB,,,Financial,\nAAA,Other,,,\nBBB,,,bank,\nCCC,,,,\nGONE,,,,\nBBB,,,financial,\n"+
		"AAA,IT,Services,general,bad;tag\n")
	if rep.Valid != 2 || rep.Errors.total != 5 || rep.Warnings.total != 1 {
		t.Fatalf("valid %d errors %+v warnings %+v", rep.Valid, rep.Errors.items, rep.Warnings.items)
	}
	if tags := rep.Preview[0]["index_tags"].([]string); len(tags) != 2 {
		t.Errorf("tags %v", tags)
	}
	h, _ := scanKind(t, KindHolidays, "date,description,segment\n2026-01-26,Republic Day,\n2026-01-24,A Saturday,trading\n1999-12-31,old,\n2028-01-03,too far,\nxx,bad,\n2026-02-02,Bad segment,weekly\n2027-01-01,Next year is allowed,clearing\n")
	if h.Valid != 3 || h.Errors.total != 4 || h.Warnings.total != 1 || !hasIssue(h.Warnings.items, 3, "date", "Saturday") ||
		!hasIssue(h.Errors.items, 4, "date", "outside 2000") || !hasIssue(h.Errors.items, 7, "segment", "trading or clearing") {
		t.Errorf("holidays: valid %d err %+v warn %+v", h.Valid, h.Errors.items, h.Warnings.items)
	}
}

// IMP-17: the manual form and the CSV importer share their validators, so the same input gives the
// same verdict. Every row of a mixed file is replayed through the form validator.
func TestFormCSVParity(t *testing.T) {
	rows := [][]string{ // basis, period_end, revenue, net_profit, eps
		{"consolidated", "2026-06-30", "100", "30", "1.5"},
		{"consolidated", "2026-06-29", "100", "30", "1.5"},
		{"standalone", "2026-06-30", "10000000", "", ""},
		{"nonsense", "2026-06-30", "1", "", ""},
		{"consolidated", "2026-06-30", "1234,56", "", ""},
		{"consolidated", "2026-06-30", "100", "250", "200000"},
		{"consolidated", "2099-06-30", "100", "", ""},
	}
	var csv strings.Builder
	csv.WriteString("symbol,basis,period_end,revenue,net_profit,eps\n")
	for _, r := range rows {
		fmt.Fprintf(&csv, "AAA,%s,%s,\"%s\",%s,%s\n", r[0], r[1], r[2], r[3], r[4])
	}
	rep, _ := scanKind(t, KindResultsQuarterly, csv.String())
	for i, r := range rows {
		_, errs, warns := ValidateFundamentals(FundamentalInput{Basis: r[0], PeriodType: "Q", PeriodEnd: r[1],
			Cells: map[string]string{"pnl.revenue": r[2], "pnl.net_profit": r[3], "pnl.eps": r[4]}}, testToday)
		row := i + 2
		csvErrs, csvWarns := 0, 0
		for _, e := range rep.Errors.items {
			if e.Row == row {
				csvErrs++
			}
		}
		for _, w := range rep.Warnings.items {
			if w.Row == row {
				csvWarns++
			}
		}
		if csvErrs != len(errs) || csvWarns != len(warns) {
			t.Errorf("row %d: csv %d errors %d warnings, form %d errors %d warnings", row, csvErrs, csvWarns, len(errs), len(warns))
		}
	}
	// Shareholding and actions use the same functions on both paths by construction; spot-check messages.
	_, errs, _ := ValidateShareholding(ShareholdingInput{QuarterEnd: "2026-06-15"}, testToday)
	srep, _ := scanKind(t, KindShareholding, shareHdr+"AAA,2026-06-15,,,,,,,,,,\n")
	if len(errs) != 1 || srep.Errors.total != 1 || srep.Errors.items[0].Message != errs[0].Message {
		t.Errorf("%+v vs %+v", errs, srep.Errors.items)
	}
}

// IMP-15: spreadsheet formulas are stored as text and never executed; exports prefix them with an apostrophe.
func TestInjectionCellsStoredAsText(t *testing.T) {
	rep, _ := scanKind(t, KindCorporateActions, actHdr+"AAA,2026-02-10,other,,,,=cmd|' /C calc'!A0\n")
	if rep.Valid != 1 || rep.Preview[0]["purpose_text"] != "=cmd|' /C calc'!A0" {
		t.Fatalf("%+v", rep)
	}
	if SafeCSVCell("=cmd|' /C calc'!A0") != "'=cmd|' /C calc'!A0" || SafeCSVCell("+1") != "'+1" || SafeCSVCell("@SUM(A1)") != "'@SUM(A1)" {
		t.Error("exports must prefix formula cells")
	}
}

// SEC-05 on the B06b kinds: a spreadsheet, UTF-16 or binary file is refused before any parsing, and the row limit holds.
func TestOwnerUploadHardening(t *testing.T) {
	for _, content := range []string{"PK\x03\x04xl/workbook.xml", "\xFF\xFEs\x00y\x00", "symbol,basis\x00,x\n"} {
		if _, _, err := scanOwner(KindResultsQuarterly, []byte(content), ownerEnv{idx: testIndex(), today: testToday}, LimitsFor(KindResultsQuarterly, false), nil); err == nil || !strings.Contains(err.Error(), "not UTF-8 text") {
			t.Errorf("%q: %v", content, err)
		}
	}
	big := shareHdr + strings.Repeat("AAA,2026-06-30,,,,,,,,,,\n", 50_001)
	if _, _, err := scanOwner(KindShareholding, []byte(big), ownerEnv{idx: testIndex(), today: testToday}, LimitsFor(KindShareholding, false), nil); err == nil || !strings.Contains(err.Error(), "too many rows") {
		t.Errorf("row limit: %v", err)
	}
}
