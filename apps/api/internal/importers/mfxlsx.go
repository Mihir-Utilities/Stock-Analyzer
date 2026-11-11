package importers

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// A small, stdlib-only reader for the .xlsx statement (decision MFH-15, B15-1). It is read-only,
// never evaluates a formula (only cached values are read), never touches the network and enforces the
// hard limits of docs/01 7.9.
const (
	xlsxMaxEntries      = 50
	xlsxMaxUncompressed = 20 * mib
	xlsxMaxRatio        = 100
	xlsxMaxSheets       = 5
	xlsxMaxLine         = 200_000 // a sheet row number above this is rejected (sparse-sheet guard)
	// xlsxMaxCol bounds the column of a cell reference (B15 review B1): the statement has 8 columns, so a
	// reference such as XFD1 must not make the reader allocate a row of 16,384 cells for every row.
	xlsxMaxCol = 256
	// xlsxMaxCellRunes caps the text of one cell (N4); a longer cell is an unreadable cell.
	xlsxMaxCellRunes = 2000
)

// ErrXLSX is a rejected workbook (the API answers 422 with the message).
var ErrXLSX = errors.New("importers: workbook rejected")

func xlsxErr(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrXLSX, fmt.Sprintf(format, a...))
}

// gridRow is one non-blank spreadsheet or CSV row with its file line.
type gridRow struct {
	Line     int
	Cells    []string
	Problems []string // cell-level problems (formula without a cached value, error cells)
	// Num holds, per column, the raw <v> text of a plain numeric (non-date) xlsx cell, so a number-like
	// identifier (the folio) can be read without a float round trip (S5).
	Num map[int]string
}

// sheetGrid is one sheet (or the whole CSV file).
type sheetGrid struct {
	Rows []gridRow
}

type budget struct{ left int64 }

func (b *budget) read(rc io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(rc, b.left+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > b.left {
		return nil, xlsxErr("the workbook is larger than %d MB when unpacked", xlsxMaxUncompressed/mib)
	}
	b.left -= int64(len(data))
	return data, nil
}

// readXLSX returns the first xlsxMaxSheets sheets of the workbook as grids.
func readXLSX(content []byte, maxRows int) ([]sheetGrid, error) {
	zr, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return nil, xlsxErr("the file is not a readable .xlsx workbook")
	}
	if len(zr.File) > xlsxMaxEntries {
		return nil, xlsxErr("the workbook has more than %d parts", xlsxMaxEntries)
	}
	var total uint64
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		name := strings.ToLower(f.Name)
		total += f.UncompressedSize64
		switch {
		case strings.HasSuffix(name, "vbaproject.bin") || strings.Contains(name, "/macros/"):
			return nil, xlsxErr("macro-enabled workbooks are not accepted; save the statement as a plain .xlsx or CSV")
		case strings.HasPrefix(name, "xl/externallinks/"):
			return nil, xlsxErr("workbooks with external links are not accepted")
		case strings.HasPrefix(name, "xl/embeddings/") || strings.HasPrefix(name, "xl/activex/") || strings.Contains(name, "oleobject"):
			return nil, xlsxErr("workbooks with embedded objects are not accepted")
		}
		files[f.Name] = f
	}
	if total > uint64(xlsxMaxUncompressed) {
		return nil, xlsxErr("the workbook is larger than %d MB when unpacked", xlsxMaxUncompressed/mib)
	}
	if len(content) > 0 && total/uint64(len(content)) > xlsxMaxRatio {
		return nil, xlsxErr("the workbook compresses suspiciously well (more than %d:1)", xlsxMaxRatio)
	}
	b := &budget{left: xlsxMaxUncompressed}
	part := func(name string) ([]byte, bool, error) {
		f, ok := files[name]
		if !ok {
			return nil, false, nil
		}
		rc, err := f.Open()
		if err != nil {
			return nil, true, xlsxErr("a part of the workbook cannot be read")
		}
		defer func() { _ = rc.Close() }()
		data, err := b.read(rc)
		if err != nil && !errors.Is(err, ErrXLSX) {
			// A central directory that lies about the sizes makes the zip reader fail mid-stream.
			err = xlsxErr("a part of the workbook cannot be read (its stored size does not match its content)")
		}
		return data, true, err
	}
	if ct, ok, err := part("[Content_Types].xml"); err != nil {
		return nil, err
	} else if ok && bytes.Contains(bytes.ToLower(ct), []byte("macroenabled")) {
		return nil, xlsxErr("macro-enabled workbooks are not accepted; save the statement as a plain .xlsx or CSV")
	}
	wb, ok, err := part("xl/workbook.xml")
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, xlsxErr("the file has no workbook part; it is not an .xlsx workbook")
	}
	wbInfo, err := parseWorkbook(wb)
	if err != nil {
		return nil, err
	}
	rels := map[string]string{}
	if data, ok, err := part("xl/_rels/workbook.xml.rels"); err != nil {
		return nil, err
	} else if ok {
		if rels, err = parseRels(data); err != nil {
			return nil, err
		}
	}
	var shared []string
	if data, ok, err := part("xl/sharedStrings.xml"); err != nil {
		return nil, err
	} else if ok {
		if shared, err = parseShared(data); err != nil {
			return nil, err
		}
	}
	var dates []bool
	if data, ok, err := part("xl/styles.xml"); err != nil {
		return nil, err
	} else if ok {
		if dates, err = parseStyles(data); err != nil {
			return nil, err
		}
	}
	var grids []sheetGrid
	for i, sh := range wbInfo.sheets {
		if i >= xlsxMaxSheets {
			break
		}
		if sh.hidden { // a hidden sheet is never read (N4): it may hold data the owner did not mean to import
			continue
		}
		target, ok := rels[sh.id]
		if !ok {
			continue
		}
		name := path.Clean(strings.TrimPrefix(target, "/"))
		if !strings.HasPrefix(target, "/") {
			name = path.Clean("xl/" + target)
		}
		data, ok, err := part(name)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		g, err := parseSheet(data, shared, dates, maxRows, wbInfo.date1904)
		if err != nil {
			return nil, err
		}
		grids = append(grids, g)
	}
	return grids, nil
}

func attr(se xml.StartElement, local string) string {
	for _, a := range se.Attr {
		if a.Name.Local == local {
			return a.Value
		}
	}
	return ""
}

func newDecoder(data []byte) *xml.Decoder {
	d := xml.NewDecoder(bytes.NewReader(data))
	d.Strict = true
	d.CharsetReader = func(_ string, in io.Reader) (io.Reader, error) { return in, nil }
	return d
}

type sheetRef struct {
	id     string
	hidden bool
}

type workbookInfo struct {
	sheets   []sheetRef
	date1904 bool // workbookPr date1904: serial dates count from 1904-01-01 (S4)
}

func parseWorkbook(data []byte) (workbookInfo, error) {
	d := newDecoder(data)
	var wi workbookInfo
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return wi, nil
		}
		if err != nil {
			return wi, xlsxErr("the workbook part is not valid XML")
		}
		if se, ok := tok.(xml.StartElement); ok {
			switch se.Name.Local {
			case "sheet":
				st := strings.ToLower(attr(se, "state"))
				wi.sheets = append(wi.sheets, sheetRef{id: attr(se, "id"), hidden: st == "hidden" || st == "veryhidden"})
			case "workbookPr":
				v := strings.ToLower(attr(se, "date1904"))
				wi.date1904 = v == "1" || v == "true"
			}
		}
	}
}

func parseRels(data []byte) (map[string]string, error) {
	d := newDecoder(data)
	out := map[string]string{}
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, xlsxErr("the workbook relationships are not valid XML")
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "Relationship" {
			if strings.EqualFold(attr(se, "TargetMode"), "External") {
				continue
			}
			out[attr(se, "Id")] = attr(se, "Target")
		}
	}
}

// parseShared reads the shared strings; the text of every <t> of an <si> is concatenated (rich text
// runs included, phonetic runs excluded).
func parseShared(data []byte) ([]string, error) {
	d := newDecoder(data)
	var out []string
	var cur strings.Builder
	inSI, inT, inPhonetic := false, false, 0
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, xlsxErr("the shared strings are not valid XML")
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI, cur = true, strings.Builder{}
			case "rPh":
				inPhonetic++
			case "t":
				inT = inSI && inPhonetic == 0
			}
		case xml.CharData:
			if inT {
				cur.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inT = false
			case "rPh":
				inPhonetic--
			case "si":
				inSI = false
				out = append(out, cur.String())
			}
		}
	}
}

// builtinDateFormats are the numFmtId values Excel treats as dates or times.
func builtinDate(id int) bool {
	return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)
}

func customDate(code string) bool {
	c := strings.ToLower(code)
	for _, skip := range []string{"[red]", "[black]", "[blue]", "[green]"} {
		c = strings.ReplaceAll(c, skip, "")
	}
	inQuote := false
	for _, r := range c {
		switch {
		case r == '"':
			inQuote = !inQuote
		case inQuote:
		case r == 'd' || r == 'm' || r == 'y' || r == 'h' || r == 's':
			return true
		}
	}
	return false
}

// parseStyles returns, per cell format index (the s attribute), whether it formats a date.
func parseStyles(data []byte) ([]bool, error) {
	d := newDecoder(data)
	custom := map[int]bool{}
	var xfs []bool
	inXfs := false
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return xfs, nil
		}
		if err != nil {
			return nil, xlsxErr("the styles part is not valid XML")
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "numFmt":
				if id, err := strconv.Atoi(attr(t, "numFmtId")); err == nil {
					custom[id] = customDate(attr(t, "formatCode"))
				}
			case "cellXfs":
				inXfs = true
			case "xf":
				if inXfs {
					id, _ := strconv.Atoi(attr(t, "numFmtId"))
					xfs = append(xfs, builtinDate(id) || custom[id])
				}
			}
		case xml.EndElement:
			if t.Name.Local == "cellXfs" {
				inXfs = false
			}
		}
	}
}

var reCellRef = regexp.MustCompile(`^[A-Z]{1,3}[0-9]+$`)

// colIndex returns the zero-based column of a cell reference such as B12. A reference that is not
// 1-3 upper-case letters followed by digits, or whose column is above xlsxMaxCol, is rejected, so no
// allocation ever depends on an unchecked number from the file.
func colIndex(ref string) (int, error) {
	if !reCellRef.MatchString(ref) {
		return 0, xlsxErr("a cell has an invalid reference %q", truncRef(ref))
	}
	n := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' {
			break
		}
		n = n*26 + int(r-'A') + 1
	}
	if n > xlsxMaxCol {
		return 0, xlsxErr("a cell is in a column beyond the %d columns this reader accepts", xlsxMaxCol)
	}
	return n - 1, nil
}

func truncRef(s string) string {
	if len(s) > 12 {
		return s[:12] + "..."
	}
	return s
}

var (
	excelEpoch     = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
	excelEpoch1904 = time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)
)

// excelDate converts a serial to a date; a 1904 workbook counts from 1904-01-01 (1462 days later).
func excelDate(serial float64, date1904 bool) string {
	if date1904 {
		return excelEpoch1904.AddDate(0, 0, int(serial)).Format(time.DateOnly)
	}
	return excelEpoch.AddDate(0, 0, int(serial)).Format(time.DateOnly)
}

// numText renders a numeric cell without binary noise (999.9500000000001 -> 999.95).
func numText(raw string) string {
	f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return strings.TrimSpace(raw)
	}
	s := strconv.FormatFloat(f, 'f', 9, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

func parseSheet(data []byte, shared []string, dates []bool, maxRows int, date1904 bool) (sheetGrid, error) {
	d := newDecoder(data)
	var g sheetGrid
	var cells []string
	var nums map[int]string
	var problems []string
	var line, autoLine int
	var col int
	var cellType string
	var cellStyle int
	var cellRef string
	var v, inline strings.Builder
	hasFormula, inV, inT, inCell := false, false, false, false
	nonBlank := 0
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return g, nil
		}
		if err != nil {
			return g, xlsxErr("a sheet is not valid XML")
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				autoLine++
				line = autoLine
				if r, err := strconv.Atoi(attr(t, "r")); err == nil && r > 0 {
					line = r
					autoLine = r
				}
				if line > xlsxMaxLine {
					return g, xlsxErr("a sheet row number is above %d", xlsxMaxLine)
				}
				cells, problems, nums, col = nil, nil, nil, 0
			case "c":
				inCell = true
				cellType, cellRef = attr(t, "t"), attr(t, "r")
				cellStyle, _ = strconv.Atoi(attr(t, "s"))
				if cellRef != "" {
					c, err := colIndex(cellRef)
					if err != nil {
						return g, err
					}
					col = c
				} else if col >= xlsxMaxCol {
					return g, xlsxErr("a row has more than %d cells", xlsxMaxCol)
				}
				hasFormula = false
				v.Reset()
				inline.Reset()
			case "f":
				if inCell {
					hasFormula = true
				}
			case "v":
				inV = inCell
			case "t":
				inT = inCell && cellType == "inlineStr"
			}
		case xml.CharData:
			switch {
			case inV:
				v.Write(t)
			case inT:
				inline.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inV = false
			case "t":
				inT = false
			case "c":
				inCell = false
				text, problem, plain := cellText(cellType, v.String(), inline.String(), cellStyle, shared, dates, hasFormula, cellRef, date1904)
				if col >= xlsxMaxCol {
					return g, xlsxErr("a row has more than %d cells", xlsxMaxCol)
				}
				if plain != "" {
					if nums == nil {
						nums = map[int]string{}
					}
					nums[col] = plain
				}
				for len(cells) <= col {
					cells = append(cells, "")
				}
				cells[col] = text
				if problem != "" {
					problems = append(problems, problem)
				}
				col++
			case "row":
				blank := len(problems) == 0
				for _, c := range cells {
					if strings.TrimSpace(c) != "" {
						blank = false
						break
					}
				}
				if blank {
					continue
				}
				nonBlank++
				if nonBlank > maxRows+50 { // header and a few title rows are not data rows
					return g, ErrTooManyRows
				}
				g.Rows = append(g.Rows, gridRow{Line: line, Cells: cells, Problems: problems, Num: nums})
			}
		}
	}
}

// cellText returns the text of a cell, a cell-level problem, and (for a plain numeric cell) the raw <v>
// text. A cell longer than xlsxMaxCellRunes is a problem, not a value (N4).
func cellText(typ, v, inline string, style int, shared []string, dates []bool, formula bool, ref string, date1904 bool) (text, problem, plain string) {
	text, problem, plain = cellTextRaw(typ, v, inline, style, shared, dates, formula, ref, date1904)
	if utf8.RuneCountInString(text) > xlsxMaxCellRunes {
		return "", fmt.Sprintf("cell %s has more than %d characters", ref, xlsxMaxCellRunes), ""
	}
	return text, problem, plain
}

func cellTextRaw(typ, v, inline string, style int, shared []string, dates []bool, formula bool, ref string, date1904 bool) (string, string, string) {
	switch typ {
	case "inlineStr":
		return inline, "", ""
	case "s":
		i, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || i < 0 || i >= len(shared) {
			return "", fmt.Sprintf("cell %s refers to a missing shared string", ref), ""
		}
		return shared[i], "", ""
	case "str":
		if formula && strings.TrimSpace(v) == "" {
			return "", fmt.Sprintf("cell %s has a formula without a stored value", ref), ""
		}
		return v, "", ""
	case "b":
		if strings.TrimSpace(v) == "1" {
			return "TRUE", "", ""
		}
		return "FALSE", "", ""
	case "e":
		return "", fmt.Sprintf("cell %s holds an error value", ref), ""
	}
	if strings.TrimSpace(v) == "" {
		if formula {
			return "", fmt.Sprintf("cell %s has a formula without a stored value", ref), ""
		}
		return "", "", ""
	}
	if style >= 0 && style < len(dates) && dates[style] {
		if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			return excelDate(f, date1904), "", ""
		}
	}
	return numText(v), "", strings.TrimSpace(v)
}
