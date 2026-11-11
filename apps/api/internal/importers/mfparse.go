package importers

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/mfhold"
)

// KindMFStatement is the mutual fund transaction statement (docs/01 7.9, decisions D-MF, D-MF3).
const KindMFStatement = "mf_statement"

// MF statement limits (docs/03 14): 2 MB and 5,000 rows.
const (
	mfMaxBytes = 2 * mib
	mfMaxRows  = 5000
	// mfHeaderScan is how many leading rows are searched for the header row.
	mfHeaderScan = 50
)

// Logical columns of the statement.
const (
	colDate  = "Date"
	colFund  = "Fund Name"
	colType  = "Transaction Type"
	colFolio = "Folio No"
	colUnits = "Units Traded"
	colNAV   = "NAV"
	colAmt   = "Amount"
	colStamp = "Stamp Duty"
)

var mfRequired = []string{colDate, colFund, colType, colFolio, colUnits, colNAV, colAmt}

// mfHeaders maps normalised header text (lower case letters and digits only) to the logical column.
var mfHeaders = map[string]string{
	"date": colDate, "txndate": colDate, "transactiondate": colDate,
	"fundname": colFund, "scheme": colFund, "schemename": colFund,
	"transactiontype": colType, "type": colType, "txntype": colType,
	"foliono": colFolio, "folio": colFolio, "folionumber": colFolio,
	"unitstraded": colUnits, "units": colUnits,
	"nav": colNAV, "navrs": colNAV,
	"amount": colAmt, "amountrs": colAmt,
	"stampduty": colStamp,
}

// mfTypes maps normalised type wording to a ledger type; unsupported ones map to their DB value.
var mfTypes = map[string]string{
	"purchase": mfhold.TypePurchase, "additionalpurchase": mfhold.TypePurchase, "newpurchase": mfhold.TypePurchase,
	"sip": mfhold.TypeSIP, "systematicinvestment": mfhold.TypeSIP, "sipinvestment": mfhold.TypeSIP,
	"redemption": mfhold.TypeRedemption, "redeem": mfhold.TypeRedemption,
	"idcwpayout": mfhold.TypeIDCWPayout, "dividendpayout": mfhold.TypeIDCWPayout,
	"idcwreinvestment": mfhold.TypeIDCWReinvest, "idcwreinvest": mfhold.TypeIDCWReinvest, "dividendreinvestment": mfhold.TypeIDCWReinvest,
	"switchin": mfhold.TypeSwitchIn, "switchout": mfhold.TypeSwitchOut,
	"merger": mfhold.TypeBonusMerger, "bonus": mfhold.TypeBonusMerger, "mergerbonus": mfhold.TypeBonusMerger,
}

var reNonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

func normHeader(s string) string { return reNonAlnum.ReplaceAllString(strings.ToLower(s), "") }

// MFRow is one validated, normalised statement row.
type MFRow struct {
	Line       int
	FundName   string
	FundKey    string
	Folio      string
	Type       string
	Date       time.Time
	Units      decimal.Decimal
	NAV        decimal.Decimal
	Amount     decimal.Decimal
	Stamp      decimal.Decimal
	SchemeCode int32 // 0 until mapped
	Occurrence int   // 1-based index among identical rows of the file
	DedupeKey  string
}

// Cost is the amount + stamp duty of a purchase (MFH-6 correction), the amount otherwise.
func (r MFRow) Cost() decimal.Decimal {
	if r.Type == mfhold.TypePurchase || r.Type == mfhold.TypeSIP {
		return r.Amount.Add(r.Stamp)
	}
	return r.Amount
}

// ErrMFHeader is a header problem (reported as a file-level error).
var ErrMFHeader = errors.New("importers: statement header problem")

// sniffMF splits the content into grids: xlsx by magic bytes, else CSV text.
func sniffMF(content []byte, maxRows int) ([]sheetGrid, error) {
	switch {
	case bytes.HasPrefix(content, []byte("PK\x03\x04")):
		return readXLSX(content, maxRows)
	case bytes.HasPrefix(content, []byte{0xD0, 0xCF, 0x11, 0xE0}):
		return nil, fmt.Errorf("%w: legacy .xls files are not supported; save the statement as .xlsx or CSV", ErrNotText)
	case len(bytes.TrimSpace(content)) == 0:
		return nil, fmt.Errorf("%w: the file is empty", ErrNotText)
	}
	g, err := readCSVGrid(content, maxRows)
	if err != nil {
		return nil, err
	}
	return []sheetGrid{g}, nil
}

func readCSVGrid(content []byte, maxRows int) (sheetGrid, error) {
	var g sheetGrid
	if err := checkText(content); err != nil {
		return g, err
	}
	content = bytes.TrimPrefix(content, []byte("\xEF\xBB\xBF"))
	r := csv.NewReader(bytes.NewReader(content))
	r.Comma = detectDelimiter(content)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	n := 0
	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			return g, nil
		}
		line, _ := r.FieldPos(0)
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				line = pe.StartLine
			}
			g.Rows = append(g.Rows, gridRow{Line: line, Problems: []string{"malformed CSV row: " + csvErrText(err)}})
			continue
		}
		blank := true
		for _, c := range rec {
			if !utf8.ValidString(c) {
				return g, fmt.Errorf("%w: invalid UTF-8 text", ErrNotText)
			}
			if strings.TrimSpace(c) != "" {
				blank = false
			}
		}
		if blank {
			continue
		}
		n++
		if n > maxRows+mfHeaderScan {
			return g, ErrTooManyRows
		}
		g.Rows = append(g.Rows, gridRow{Line: line, Cells: rec})
	}
}

// locateHeader finds the header row by name in the first rows of each sheet and returns the sheet,
// the index of the header row and the column index of each logical column.
func locateHeader(grids []sheetGrid) (sheet int, hdr int, cols map[string]int, err error) {
	for si, g := range grids {
		for ri, row := range g.Rows {
			if ri >= mfHeaderScan {
				break
			}
			m := map[string]int{}
			for ci, c := range row.Cells {
				if lc, ok := mfHeaders[normHeader(c)]; ok {
					if _, dup := m[lc]; !dup {
						m[lc] = ci
					}
				}
			}
			ok := true
			for _, req := range mfRequired {
				if _, has := m[req]; !has {
					ok = false
				}
			}
			if ok {
				return si, ri, m, nil
			}
		}
	}
	return 0, 0, nil, fmt.Errorf("%w: the required columns were not found in the first %d rows; expected the columns %s",
		ErrMFHeader, mfHeaderScan, strings.Join(append(append([]string{}, mfRequired...), colStamp+" (optional)"), ", "))
}

// cell returns the trimmed text of a logical column.
func cell(row gridRow, cols map[string]int, name string) string {
	i, ok := cols[name]
	if !ok || i >= len(row.Cells) {
		return ""
	}
	return strings.TrimSpace(row.Cells[i])
}

var reDMYSlash = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})$`)
var reSept = regexp.MustCompile(`(?i)^(\d{1,2}-)sept(-\d{4})$`)

// parseMFDate accepts DD-Mon-YYYY (English month abbreviations, 'Sept' too), YYYY-MM-DD, DD-MM-YYYY and
// DD/MM/YYYY (day first, a fixed documented format).
func parseMFDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if m := reDMYSlash.FindStringSubmatch(s); m != nil {
		s = m[1] + "-" + m[2] + "-" + m[3]
	}
	s = reSept.ReplaceAllString(s, "${1}Sep${2}")
	return ParseDate(s)
}

// mfDecimal parses a cleaned numeric cell with at most maxDP decimals.
func mfDecimal(raw string, maxDP int32) (decimal.Decimal, string) {
	c, err := CleanNumber(raw)
	if err != nil {
		return decimal.Zero, err.Error()
	}
	d, err := decimal.NewFromString(c)
	if err != nil {
		return decimal.Zero, fmt.Sprintf("%q is not a number", raw)
	}
	if d.Exponent() < -maxDP {
		return decimal.Zero, fmt.Sprintf("%q has more than %d decimal places; it is not rounded silently", raw, maxDP)
	}
	return d, ""
}

var maxUnits = decimal.NewFromInt(1_000_000_000)
var maxMoney = decimal.NewFromInt(10_000_000_000_000)

// mfEnv is what row validation needs from the database.
type mfEnv struct {
	today    time.Time
	holidays map[time.Time]bool
	mappings map[string]mfhold.Mapping
}

// MFFund is one distinct fund name of a file.
type MFFund struct {
	FundName    string  `json:"fund_name"`
	FundNameKey string  `json:"fund_name_key"`
	Rows        int     `json:"rows"`
	Mapped      bool    `json:"mapped"`
	SchemeCode  *int32  `json:"scheme_code"`
	SchemeName  *string `json:"scheme_name"`
	Plan        *string `json:"plan"`
	Option      *string `json:"option"`
}

// MFUnmapped is a fund name without a stored mapping, with the candidates to pick from.
type MFUnmapped struct {
	FundName    string             `json:"fund_name"`
	FundNameKey string             `json:"fund_name_key"`
	Rows        int                `json:"rows"`
	Candidates  []mfhold.Candidate `json:"candidates"`
}

// MFDupGroup lists the file lines of identical rows (informational, MFH-24).
type MFDupGroup struct {
	Rows  []int `json:"rows"`
	Count int   `json:"count"`
}

// MFPreview is data.mf of the validate response.
type MFPreview struct {
	DateFrom       *string          `json:"date_from"`
	DateTo         *string          `json:"date_to"`
	RowsByType     map[string]int   `json:"rows_by_type"`
	Funds          []MFFund         `json:"funds"`
	UnmappedFunds  []MFUnmapped     `json:"unmapped_funds"`
	FundMappings   []mfhold.Mapping `json:"fund_mappings"`
	DuplicateGroup []MFDupGroup     `json:"duplicate_groups"`
	DuplicatesInDB int              `json:"duplicates_in_db"`
}

type mfScan struct {
	Report  *scanReport
	Rows    []MFRow
	Preview MFPreview
	Header  []RowIssue
	// lines is the set of data-row lines (for excluded_rows validation).
	Lines map[int]bool
}

func (l *issueList) addCode(row int, col, code, msg string) {
	l.total++
	if len(l.items) < MaxReportedIssues {
		l.items = append(l.items, RowIssue{Row: row, Column: col, Code: code, Message: msg})
	}
}

func dedupeKey(r MFRow) string {
	h := sha256.Sum256([]byte(strings.Join([]string{r.FundKey, r.Folio, r.Date.Format(time.DateOnly), r.Type,
		r.Units.String(), r.NAV.String(), r.Amount.String(), r.Stamp.String(), fmt.Sprint(r.Occurrence)}, "|")))
	return hex.EncodeToString(h[:])
}

// scanMF parses and validates a statement without touching the database (env carries the lookups).
func scanMF(content []byte, env mfEnv, lim Limits) (*mfScan, error) {
	sc := &mfScan{Report: newReport(), Lines: map[int]bool{}}
	sc.Preview = MFPreview{RowsByType: map[string]int{}, Funds: []MFFund{}, UnmappedFunds: []MFUnmapped{}, FundMappings: []mfhold.Mapping{}, DuplicateGroup: []MFDupGroup{}}
	grids, err := sniffMF(content, lim.MaxRows)
	if err != nil {
		return nil, err
	}
	si, hi, cols, err := locateHeader(grids)
	if err != nil {
		if errors.Is(err, ErrMFHeader) {
			sc.Header = []RowIssue{{Row: 1, Message: strings.TrimPrefix(err.Error(), "importers: statement header problem: ")}}
			return sc, nil
		}
		return nil, err
	}
	rows := grids[si].Rows[hi+1:]
	if len(rows) > lim.MaxRows {
		return nil, ErrTooManyRows
	}
	rep := sc.Report
	identical := map[string][]int{} // identical tuple -> indexes into sc.Rows
	fundRows := map[string]int{}
	fundName := map[string]string{}
	for _, gr := range rows {
		// A row without any of the required cells is blank for our purposes (a footer, a note).
		empty := true
		for _, req := range mfRequired {
			if cell(gr, cols, req) != "" {
				empty = false
			}
		}
		if empty && len(gr.Problems) == 0 {
			continue
		}
		rep.Rows++
		line := gr.Line
		sc.Lines[line] = true
		if len(gr.Problems) > 0 {
			rep.Errors.addCode(line, "", "UNREADABLE_CELL", gr.Problems[0])
			continue
		}
		row, ok := parseMFRow(gr, cols, env, rep)
		if !ok {
			continue
		}
		fundRows[row.FundKey]++
		if _, seen := fundName[row.FundKey]; !seen {
			fundName[row.FundKey] = row.FundName
		}
		if m, mapped := env.mappings[row.FundKey]; mapped {
			row.SchemeCode = m.SchemeCode
		} else {
			rep.Errors.addCode(line, colFund, "UNMAPPED_FUND", fmt.Sprintf("fund %q has no scheme chosen yet; pick the scheme for this fund name", row.FundName))
		}
		id := strings.Join([]string{row.FundKey, row.Folio, row.Date.Format(time.DateOnly), row.Type, row.Units.String(), row.NAV.String(), row.Amount.String(), row.Stamp.String()}, "|")
		identical[id] = append(identical[id], len(sc.Rows))
		row.Occurrence = len(identical[id])
		row.DedupeKey = dedupeKey(row)
		sc.Rows = append(sc.Rows, row)
	}
	// Duplicate groups (MFH-24): informational, never excluded by default.
	var groups []MFDupGroup
	for _, idxs := range identical {
		if len(idxs) < 2 {
			continue
		}
		g := MFDupGroup{Count: len(idxs)}
		for _, i := range idxs {
			g.Rows = append(g.Rows, sc.Rows[i].Line)
			rep.Warnings.addCode(sc.Rows[i].Line, "", "DUPLICATE_IN_FILE",
				fmt.Sprintf("%d rows of the file are identical on every field; each is kept as a separate transaction (untick one if it is a statement glitch)", len(idxs)))
		}
		sort.Ints(g.Rows)
		groups = append(groups, g)
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Rows[0] < groups[j].Rows[0] })
	sc.Preview.DuplicateGroup = append(sc.Preview.DuplicateGroup, groups...)
	// Funds, dates and counts.
	keys := make([]string, 0, len(fundRows))
	for k := range fundRows {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		f := MFFund{FundName: fundName[k], FundNameKey: k, Rows: fundRows[k]}
		if m, ok := env.mappings[k]; ok {
			code, name, plan, opt := m.SchemeCode, m.SchemeName, m.Plan, m.Option
			f.Mapped, f.SchemeCode, f.SchemeName, f.Plan, f.Option = true, &code, &name, &plan, &opt
			sc.Preview.FundMappings = append(sc.Preview.FundMappings, m)
		}
		sc.Preview.Funds = append(sc.Preview.Funds, f)
	}
	var from, to time.Time
	for i, r := range sc.Rows {
		sc.Preview.RowsByType[r.Type]++
		if i == 0 || r.Date.Before(from) {
			from = r.Date
		}
		if i == 0 || r.Date.After(to) {
			to = r.Date
		}
		if len(rep.Preview) < previewRows {
			m := map[string]any{"row": r.Line, "date": r.Date.Format(time.DateOnly), "fund_name": r.FundName, "txn_type": r.Type,
				"folio": r.Folio, "units": r.Units.StringFixed(4), "nav": r.NAV.StringFixed(4), "amount": r.Amount.StringFixed(4),
				"stamp_duty": r.Stamp.StringFixed(4), "scheme_code": nil}
			if r.SchemeCode != 0 {
				m["scheme_code"] = r.SchemeCode
			}
			rep.Preview = append(rep.Preview, m)
		}
	}
	if len(sc.Rows) > 0 {
		f, t := from.Format(time.DateOnly), to.Format(time.DateOnly)
		sc.Preview.DateFrom, sc.Preview.DateTo = &f, &t
	}
	return sc, nil
}

func isWeekend(d time.Time) bool { return d.Weekday() == time.Saturday || d.Weekday() == time.Sunday }

// parseMFRow validates one data row; it records errors and warnings and returns false on any error.
func parseMFRow(gr gridRow, cols map[string]int, env mfEnv, rep *scanReport) (MFRow, bool) {
	line := gr.Line
	r := MFRow{Line: line}
	bad := false
	fail := func(col, code, msg string) {
		rep.Errors.addCode(line, col, code, msg)
		bad = true
	}
	r.FundName = mfhold.CleanText(cell(gr, cols, colFund))
	switch n := utf8.RuneCountInString(r.FundName); {
	case n == 0:
		fail(colFund, "REQUIRED", "Fund Name is required")
	case n > mfhold.MaxFund:
		fail(colFund, "FUND_NAME_TOO_LONG", fmt.Sprintf("Fund Name must be at most %d characters", mfhold.MaxFund))
	default:
		r.FundKey = mfhold.NormalizeFundName(r.FundName)
		if r.FundKey == "" {
			fail(colFund, "REQUIRED", "Fund Name has no letters or digits")
		}
	}
	r.Folio = mfhold.CleanText(cell(gr, cols, colFolio))
	if n := utf8.RuneCountInString(r.Folio); n < 1 || n > mfhold.MaxFolio {
		fail(colFolio, "FOLIO_INVALID", "Folio No must be 1-40 characters")
	}
	if raw := cell(gr, cols, colDate); raw == "" {
		fail(colDate, "REQUIRED", "Date is required")
	} else if d, err := parseMFDate(raw); err != nil {
		fail(colDate, "DATE_INVALID", err.Error())
	} else if d.After(env.today) {
		fail(colDate, "DATE_FUTURE", fmt.Sprintf("%s is in the future", d.Format(time.DateOnly)))
	} else {
		r.Date = d
	}
	typeRaw := cell(gr, cols, colType)
	switch t, ok := mfTypes[normHeader(typeRaw)]; {
	case typeRaw == "":
		fail(colType, "REQUIRED", "Transaction Type is required")
	case !ok:
		fail(colType, "TYPE_UNKNOWN", fmt.Sprintf("Transaction Type %q is not recognised (expected Purchase, SIP, Redemption, IDCW Payout or IDCW Reinvestment)", typeRaw))
	case !mfhold.SupportedType(t):
		fail(colType, "MF_TXN_TYPE_NOT_SUPPORTED", mfhold.TypeUnsupportedMessage)
	default:
		r.Type = t
	}
	num := func(col string, dp int32, positive bool, max decimal.Decimal) decimal.Decimal {
		raw := cell(gr, cols, col)
		if raw == "" {
			if col == colStamp {
				return decimal.Zero
			}
			fail(col, "REQUIRED", col+" is required")
			return decimal.Zero
		}
		d, msg := mfDecimal(raw, dp)
		switch {
		case msg != "":
			fail(col, "NUMBER_INVALID", col+": "+msg)
		case positive && !d.IsPositive():
			fail(col, "NEGATIVE_OR_REVERSAL_ROW", col+" must be greater than 0; reversals and cancelled orders are not modelled (remove both the original and the reversal)")
		case d.IsNegative():
			fail(col, "NEGATIVE_OR_REVERSAL_ROW", col+" must not be negative")
		case d.GreaterThan(max):
			fail(col, "NUMBER_INVALID", col+" is too large")
		default:
			return d
		}
		return decimal.Zero
	}
	r.Units = num(colUnits, 4, true, maxUnits)
	r.NAV = num(colNAV, 4, true, maxMoney)
	r.Amount = num(colAmt, 4, true, maxMoney)
	if _, has := cols[colStamp]; has {
		r.Stamp = num(colStamp, 4, false, maxMoney)
	}
	if bad {
		return r, false
	}
	if (r.Type == mfhold.TypePurchase || r.Type == mfhold.TypeSIP || r.Type == mfhold.TypeIDCWReinvest) && mfhold.AmountMismatch(r.Units, r.NAV, r.Amount) {
		rep.Warnings.addCode(line, colAmt, "AMOUNT_MISMATCH", fmt.Sprintf("units x NAV is %s but Amount is %s (stamp duty is separate)", r.Units.Mul(r.NAV).StringFixed(4), r.Amount.StringFixed(4)))
	}
	if isWeekend(r.Date) || env.holidays[r.Date] {
		rep.Warnings.addCode(line, colDate, "NON_BUSINESS_DAY", fmt.Sprintf("%s was a weekend or listed market holiday", r.Date.Format(time.DateOnly)))
	}
	return r, true
}
