package importers

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

var testToday = time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)

func testIdx() *instrumentIndex {
	return &instrumentIndex{
		bySymbol: map[string]int32{"TCS": 1, "INFY": 2, "RELIANCE": 3},
		byID:     map[int32]string{1: "TCS", 2: "INFY", 3: "RELIANCE"},
		alias:    map[string]int32{"OLDINFY": 2},
		tracked:  map[int32]bool{},
	}
}

func scanP(t *testing.T, csv string) (*scanReport, []RowIssue, []priceRow) {
	t.Helper()
	var rows []priceRow
	hol := map[time.Time]bool{time.Date(2026, 1, 26, 0, 0, 0, 0, time.UTC): true}
	rep, hdr, err := scanPrices([]byte(csv), priceEnv{idx: testIdx(), holidays: hol, today: testToday}, LimitsFor(KindPrices, false),
		func(p priceRow) error { rows = append(rows, p); return nil })
	if err != nil {
		t.Fatal(err)
	}
	return rep, hdr, rows
}

func msgs(l issueList) string {
	var b []string
	for _, i := range l.items {
		b = append(b, fmt.Sprintf("r%d/%s: %s", i.Row, i.Column, i.Message))
	}
	return strings.Join(b, "\n")
}

const hdrP = "symbol,date,open,high,low,close,volume\n"

// IMP-01: wrong header names are rejected with the exact expectation and the template link.
func TestPricesHeaderErrors(t *testing.T) {
	for name, csv := range map[string]string{
		"misspelled":  "symbol,date,open,high,low,clos,volume\nTCS,2026-01-05,1,2,1,1,1\n",
		"missing":     "symbol,date,close\nTCS,2026-01-05,1\n",
		"extra":       hdrP[:len(hdrP)-1] + ",notes\nTCS,2026-01-05,1,2,1,1,1,x\n",
		"duplicate":   "symbol,date,open,high,low,close,close\n",
		"empty":       "",
		"only blanks": "\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			rep, hdr, _ := scanP(t, csv)
			if rep != nil || len(hdr) != 1 {
				t.Fatalf("expected one header issue, got rep=%v hdr=%v", rep, hdr)
			}
			if !strings.Contains(hdr[0].Message, "/api/v1/imports/templates/prices") || !strings.Contains(hdr[0].Message, "symbol,date,open,high,low,close,volume") {
				t.Errorf("message lacks expected columns or template link: %s", hdr[0].Message)
			}
		})
	}
}

// IMP-16: UTF-8 BOM, semicolon delimiter, CRLF, header case and spaces.
func TestPricesEncodingAndDelimiters(t *testing.T) {
	good := "TCS;05-01-2026;100.00;102.50;99.20;101.30;1250000\r\n"
	for name, csv := range map[string]string{
		"bom":       "\xEF\xBB\xBF" + hdrP + "TCS,2026-01-05,100.00,102.50,99.20,101.30,1250000\n",
		"semicolon": "symbol;date;open;high;low;close;volume\r\n" + good,
		"case":      " Symbol , DATE,Open,High,Low,Close,Volume\nTCS,2026-01-05,100.00,102.50,99.20,101.30,1250000\n",
		"quoted":    hdrP + `"TCS","2026-01-05","1,100.50","1,102.50","99.20","1,101.30","1,250,000"` + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			rep, hdr, rows := scanP(t, csv)
			if hdr != nil || rep.Errors.total != 0 || len(rows) != 1 || rows[0].sym != "TCS" || rows[0].date.Format(time.DateOnly) != "2026-01-05" {
				t.Fatalf("hdr=%v errs=%s rows=%v", hdr, msgs(rep.Errors), rows)
			}
		})
	}
	if _, _, rows := scanP(t, hdrP+"TCS,2026-01-05,1,2,1,1,1\n"); len(rows) != 1 {
		t.Fatal("plain row")
	}
}

// IMP-28: decimal comma in a semicolon-delimited file is rejected, with the row and column.
func TestPricesDecimalCommaRejected(t *testing.T) {
	csv := "symbol;date;open;high;low;close;volume\nTCS;2026-01-05;1234,56;1240,00;1200,10;1230,00;1000\nTCS;2026-01-06;12,34;13;12;12;5\nTCS;2026-01-07;1,234.50;1,300;1,200;1,250.5;5\n"
	rep, _, rows := scanP(t, csv)
	if len(rows) != 1 || rows[0].date.Day() != 7 || rows[0].o != 1234.5 || rows[0].h != 1300 {
		t.Fatalf("rows %v", rows)
	}
	if rep.Errors.total != 5 { // row 2: open high low close; row 3: open
		t.Fatalf("errors: %d\n%s", rep.Errors.total, msgs(rep.Errors))
	}
	first := rep.Errors.items[0]
	if first.Row != 2 || first.Column != "open" || !strings.Contains(first.Message, "1234,56") {
		t.Errorf("first error %+v", first)
	}
}

// IMP-04: empty cells are never read as 0.
func TestPricesEmptyCells(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+"TCS,2026-01-05,,102,99,101,1000\nTCS,2026-01-06,100,102,99,101,\nTCS,2026-01-07,100,102,99,,5\n")
	if len(rows) != 0 || rep.Errors.total != 3 {
		t.Fatalf("rows=%v errs=%s", rows, msgs(rep.Errors))
	}
	if !strings.Contains(msgs(rep.Errors), "not read as 0") {
		t.Error("message must say empty is not 0")
	}
}

// IMP-08: unknown symbol with the nearest suggestion; renamed symbols point to the new one.
func TestPricesUnknownSymbol(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+"TCSS,2026-01-05,1,2,1,1,1\nZZZZZZ,2026-01-05,1,2,1,1,1\noldinfy,2026-01-05,1,2,1,1,1\ntcs,2026-01-05,1,2,1,1,1\n")
	if len(rows) != 1 || rows[0].sym != "TCS" {
		t.Fatalf("rows %v", rows)
	}
	m := msgs(rep.Errors)
	for _, want := range []string{"did you mean TCS?", "unknown symbol ZZZZZZ", "was renamed to INFY"} {
		if !strings.Contains(m, want) {
			t.Errorf("missing %q in\n%s", want, m)
		}
	}
	if strings.Contains(m, "ZZZZZZ: did you mean") {
		t.Error("no suggestion expected for a far symbol")
	}
}

// IMP-09: identical duplicates warn (last wins); contradictory duplicates are an error.
func TestPricesDuplicates(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+"TCS,2026-01-05,1,2,1,1,10\nTCS,2026-01-05,1,2,1,1,10\n")
	if rep.Errors.total != 0 || rep.Warnings.total != 1 || len(rows) != 2 {
		t.Fatalf("identical: errs=%d warns=%d rows=%d", rep.Errors.total, rep.Warnings.total, len(rows))
	}
	rep, _, _ = scanP(t, hdrP+"TCS,2026-01-05,1,2,1,1,10\nTCS,2026-01-05,1,2,1,1.5,10\n")
	if rep.Errors.total != 1 || !strings.Contains(msgs(rep.Errors), "different values") {
		t.Fatalf("contradictory: %s", msgs(rep.Errors))
	}
}

// BRK-09: weekend rows are dropped with a warning; a listed holiday is only a warning.
func TestPricesWeekendAndHoliday(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+"TCS,2026-01-03,1,2,1,1,10\nTCS,2026-01-04,1,2,1,1,10\nTCS,2026-01-26,1,2,1,1,10\nTCS,2026-01-27,1,2,1,1,10\n")
	if len(rows) != 2 || rep.Errors.total != 0 || rep.Valid != 2 {
		t.Fatalf("rows=%v errs=%s", rows, msgs(rep.Errors))
	}
	m := msgs(rep.Warnings)
	if strings.Count(m, "weekend") != 2 || !strings.Contains(m, "market holiday") {
		t.Errorf("warnings:\n%s", m)
	}
}

// BRK-08 (row level): non-positive prices and high < low are row errors (they cannot be stored);
// high below open/close or low above them is stored as suspect with a warning.
func TestPricesSanityRules(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+
		"TCS,2026-01-05,0,2,1,1,10\n"+ // open 0
		"TCS,2026-01-06,5,4,6,5,10\n"+ // high < low
		"TCS,2026-01-07,10,9,8,9.5,10\n"+ // high < open: suspect
		"TCS,2026-01-08,10,12,11,11.5,10\n"+ // low > open: suspect
		"TCS,2026-01-09,10,12,9,11,-1\n"+ // negative volume
		"TCS,2026-01-12,10,12,9,11,1.5\n"+ // fractional volume
		"TCS,2026-01-13,10,12,9,11,0\n") // fine, zero volume
	if rep.Errors.total != 4 {
		t.Fatalf("errors %d:\n%s", rep.Errors.total, msgs(rep.Errors))
	}
	var susp, ok int
	for _, r := range rows {
		if r.suspect {
			susp++
		} else {
			ok++
		}
	}
	if susp != 2 || ok != 1 || rep.Warnings.total != 2 {
		t.Fatalf("suspect=%d ok=%d warnings=%d", susp, ok, rep.Warnings.total)
	}
}

func TestPricesFutureDate(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+"TCS,2026-10-26,1,2,1,1,10\nTCS,2026-10-23,1,2,1,1,10\n")
	if len(rows) != 1 || rep.Errors.total != 1 || !strings.Contains(msgs(rep.Errors), "future") {
		t.Fatalf("rows=%v errs=%s", rows, msgs(rep.Errors))
	}
}

// IMP-21 (parse level): reserved symbols are market series rows; only close is used.
func TestPricesReservedSymbols(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+"NIFTY50,2026-01-05,,,,22000.5,\nindiavix,2026-01-05,0,0,0,13.2,0\nNIFTY50,2026-01-06,,,,0,\n")
	if len(rows) != 2 || rows[0].code != ReservedNifty50 || rows[0].c != 22000.5 || rows[1].code != ReservedIndiaVIX || rows[1].inst != 0 {
		t.Fatalf("rows %+v", rows)
	}
	if rep.Errors.total != 1 || rep.Series["NIFTY50"] != true || len(rep.Symbols) != 0 {
		t.Fatalf("errs=%s series=%v symbols=%v", msgs(rep.Errors), rep.Series, rep.Symbols)
	}
}

// IMP-13 (rows): the row limit stops the scan.
func TestPricesTooManyRows(t *testing.T) {
	var b strings.Builder
	b.WriteString(hdrP)
	for i := 0; i < 50_001; i++ {
		b.WriteString("TCS,2026-01-05,1,2,1,1,1\n")
	}
	_, _, err := scanPrices([]byte(b.String()), priceEnv{idx: testIdx(), today: testToday}, LimitsFor(KindPrices, false), nil)
	if !errors.Is(err, ErrTooManyRows) {
		t.Fatalf("err %v", err)
	}
	if _, _, err := scanPrices([]byte(b.String()), priceEnv{idx: testIdx(), today: testToday}, LimitsFor(KindPrices, true), nil); err != nil {
		t.Fatalf("large limit: %v", err)
	}
}

// IMP-13 / SEC-05: spreadsheets, UTF-16 and binary content are refused before parsing.
func TestNotTextRejected(t *testing.T) {
	for name, c := range map[string]string{"xlsx": "PK\x03\x04rest", "utf16": "\xFF\xFEs\x00", "nul": hdrP + "TCS\x00,x\n"} {
		_, _, err := scanPrices([]byte(c), priceEnv{idx: testIdx(), today: testToday}, LimitsFor(KindPrices, false), nil)
		if !errors.Is(err, ErrNotText) {
			t.Errorf("%s: %v", name, err)
		}
	}
	_, _, err := scanPrices([]byte(hdrP+"TCS,2026-01-05,1,2,1,\xff\xfe,1\n"), priceEnv{idx: testIdx(), today: testToday}, LimitsFor(KindPrices, false), nil)
	if err != nil {
		t.Errorf("invalid UTF-8 inside a row is a row error, got %v", err)
	}
}

func TestPricesMalformedRows(t *testing.T) {
	rep, _, rows := scanP(t, hdrP+"TCS,2026-01-05,1,2,1,1\nTCS,2026-01-06,\"1,2,1,1,1\nTCS,2026-01-07,1,2,1,1,5\n")
	if len(rows) != 0 && rep.Errors.total == 0 {
		t.Fatalf("malformed rows must not be silently accepted: %v", rows)
	}
	if !strings.Contains(msgs(rep.Errors), "expected 7 columns but found 6") {
		t.Errorf("errors:\n%s", msgs(rep.Errors))
	}
}

// ---- instruments.csv (IMP-20, INS-14 planning) ----

func scanI(t *testing.T, idx *instrumentIndex, csv string) (*scanReport, []RowIssue, []instOp) {
	t.Helper()
	var ops []instOp
	rep, hdr, err := scanInstruments([]byte(csv), idx, LimitsFor(KindInstruments, false), func(o instOp) error { ops = append(ops, o); return nil })
	if err != nil {
		t.Fatal(err)
	}
	return rep, hdr, ops
}

const hdrI = "symbol,name,isin,series,kind,listing_date,face_value,previous_symbol,status\n"

func TestInstrumentsRules(t *testing.T) {
	rep, hdr, ops := scanI(t, testIdx(), hdrI+
		"NEWCO,New Co Ltd,INE123456789,,,17-05-2010,2.00,,\n"+ // ok, insert
		"TCS,Tata Consultancy,BADISIN,EQ,equity,,10,,suspended\n"+ // update + isin warning
		"NIFTY50,Index,,,,,,,\n"+ // reserved
		"bad sym,Name,,,,,,,\n"+ // charset
		"NEWCO,Duplicate,,,,,,,\n"+ // duplicate in file
		"X1,,,,,,,,\n"+ // name missing
		"X2,Name,,,weird,,,,\n"+ // kind
		"X3,Name,,,,,,,symbol_changed\n"+ // status system-set
		"X4,Name,,,,,0,,\n"+ // face value 0
		"X5,Name,,,,,1.234,,\n"+ // 3 decimals
		"X6,Name,,,,31-02-2020,,,\n") // date
	if hdr != nil {
		t.Fatal(hdr)
	}
	if len(ops) != 2 || rep.Errors.total != 9 || rep.Warnings.total != 1 {
		t.Fatalf("ops=%d errs=%d warns=%d\n%s", len(ops), rep.Errors.total, rep.Warnings.total, msgs(rep.Errors))
	}
	if ops[0].Action != "insert" || ops[0].Face == nil || *ops[0].Face != "2.00" || ops[0].Listing == nil || ops[0].ISIN == nil {
		t.Errorf("op0 %+v", ops[0])
	}
	if ops[1].Action != "update" || ops[1].ISIN != nil || ops[1].Status == nil || *ops[1].Status != "suspended" {
		t.Errorf("op1 %+v", ops[1])
	}
	// IMP-04: empty optional cells stay nil (never 0, never a default written over stored data).
	if ops[0].Series != nil || ops[0].Kind != nil || ops[0].Status != nil {
		t.Errorf("empty cells must be nil: %+v", ops[0])
	}
}

// INS-14 (plan level): previous_symbol rename rules.
func TestInstrumentsPreviousSymbol(t *testing.T) {
	idx := testIdx()
	rep, _, ops := scanI(t, idx, hdrI+
		"INFYNEW,Infosys,,,,,,INFY,\n"+ // rename INFY -> INFYNEW
		"TCS2,Tata 2,,,,,,GONE,\n"+ // no match: ignored with warning
		"RELIANCE,Reliance,,,,,,TCS,\n"+ // new symbol belongs to another instrument: ignored with warning
		"INFYNEWER,Infosys again,,,,,,OLDINFY,\n") // matched through alias, instrument currently INFYNEW
	if rep.Errors.total != 0 || len(ops) != 4 || rep.Warnings.total != 2 {
		t.Fatalf("errs=%s warns=%s", msgs(rep.Errors), msgs(rep.Warnings))
	}
	if o := ops[0]; o.Action != "rename" || o.RenameID != 2 || o.RenameFrom != "INFY" || len(o.AliasOld) != 1 || o.AliasOld[0] != "INFY" {
		t.Errorf("op0 %+v", o)
	}
	if ops[1].Action != "insert" || ops[2].Action != "update" {
		t.Errorf("ignored previous_symbol must fall back to insert/update: %+v %+v", ops[1], ops[2])
	}
	if o := ops[3]; o.Action != "rename" || o.RenameID != 2 || o.RenameFrom != "INFYNEW" || strings.Join(o.AliasOld, ",") != "INFYNEW,OLDINFY" {
		t.Errorf("op3 %+v", o)
	}
}

func TestInstrumentsSemicolonAndHeader(t *testing.T) {
	_, hdr, _ := scanI(t, testIdx(), "symbol;nm\nA;B\n")
	if len(hdr) != 1 || !strings.Contains(hdr[0].Message, "templates/instruments") {
		t.Fatalf("hdr %v", hdr)
	}
	rep, _, ops := scanI(t, testIdx(), "symbol;name;face_value\nABC;Abc Ltd;1,234.50\nDEF;Def;1234,50\n")
	if len(ops) != 1 || rep.Errors.total != 1 || *ops[0].Face != "1234.50" {
		t.Fatalf("ops=%v errs=%s", ops, msgs(rep.Errors))
	}
}
