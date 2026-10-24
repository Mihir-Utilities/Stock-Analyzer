package importers

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// Limits are the per-kind upload limits (docs/01 section 7).
type Limits struct {
	MaxBytes int64
	MaxRows  int
}

const (
	mib = int64(1 << 20)
	// DefaultLimits apply to every kind (5 MB, 50,000 rows).
	defaultMaxBytes = 5 * mib
	defaultMaxRows  = 50_000
	// Prices limits once spike S9 has passed the large upload through the Vercel rewrite.
	largeMaxBytes = 25 * mib
	largeMaxRows  = 300_000
	// ChunkSize is the number of rows per insert statement (docs/01 section 7).
	ChunkSize = 5000
	// MaxReportedIssues caps the error and warning lists of a validate response.
	MaxReportedIssues = 200
	previewRows       = 20
)

// LimitsFor returns the limits for a kind. largePrices is true once S9 passed.
func LimitsFor(kind string, largePrices bool) Limits {
	if kind == KindPrices && largePrices {
		return Limits{MaxBytes: largeMaxBytes, MaxRows: largeMaxRows}
	}
	return Limits{MaxBytes: defaultMaxBytes, MaxRows: defaultMaxRows}
}

// Errors that reject a whole file (the API maps them to 422).
var (
	ErrNotText     = errors.New("importers: file is not UTF-8 text")
	ErrTooManyRows = errors.New("importers: too many rows")
)

type tableSpec struct {
	Columns  []string // every accepted column
	Required []string
}

// table is a streaming CSV reader: one record at a time, never the whole file as structs.
type table struct {
	r       *csv.Reader
	cols    map[string]int
	width   int
	rows    int
	maxRows int
}

// checkText rejects binary and non-UTF-8 content before any parsing (SEC-05). Spreadsheet files
// (xlsx is a zip) and UTF-16 text are refused with a plain message; nothing is ever executed.
func checkText(content []byte) error {
	switch {
	case bytes.HasPrefix(content, []byte("PK\x03\x04")):
		return fmt.Errorf("%w: this looks like a spreadsheet (xlsx) or zip file; export it as CSV (UTF-8)", ErrNotText)
	case bytes.HasPrefix(content, []byte{0xFF, 0xFE}), bytes.HasPrefix(content, []byte{0xFE, 0xFF}):
		return fmt.Errorf("%w: UTF-16 is not supported; save the file as CSV (UTF-8)", ErrNotText)
	case bytes.IndexByte(content, 0) >= 0:
		return fmt.Errorf("%w: binary content found", ErrNotText)
	case bytes.IndexByte(bytes.TrimRight(content, "\r"), '\r') >= 0 && bytes.IndexByte(content, '\n') < 0:
		// Old Mac line endings: encoding/csv would read the whole file as one record.
		return fmt.Errorf("%w: lines end with a lone carriage return (old Mac format); save the file as CSV with normal line endings", ErrNotText)
	}
	return nil
}

func detectDelimiter(content []byte) rune {
	line := content
	if i := bytes.IndexByte(content, '\n'); i >= 0 {
		line = content[:i]
	}
	var commas, semis int
	inQ := false
	for _, b := range line {
		switch {
		case b == '"':
			inQ = !inQ
		case inQ:
		case b == ',':
			commas++
		case b == ';':
			semis++
		}
	}
	if semis > commas {
		return ';'
	}
	return ','
}

// openTable reads and checks the header. A header problem is returned as issues with a nil table.
func openTable(content []byte, spec tableSpec, maxRows int, template string) (*table, []RowIssue, error) {
	if err := checkText(content); err != nil {
		return nil, nil, err
	}
	content = bytes.TrimPrefix(content, []byte("\xEF\xBB\xBF"))
	r := csv.NewReader(bytes.NewReader(content))
	r.Comma = detectDelimiter(content)
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true
	hdr, err := r.Read()
	if errors.Is(err, io.EOF) {
		return nil, []RowIssue{{Row: 0, Message: "The file is empty. Expected a header row: " + strings.Join(spec.Columns, ",") + ". " + template}}, nil
	}
	if err != nil {
		return nil, []RowIssue{{Row: 1, Message: "The header row could not be read: " + csvErrText(err)}}, nil
	}
	if !utf8.ValidString(strings.Join(hdr, "")) {
		return nil, nil, fmt.Errorf("%w: invalid UTF-8 in the header", ErrNotText)
	}
	t := &table{r: r, cols: map[string]int{}, width: len(hdr), maxRows: maxRows}
	known := map[string]bool{}
	for _, c := range spec.Columns {
		known[c] = true
	}
	var problems []string
	for i, h := range hdr {
		name := strings.ToLower(strings.TrimSpace(h))
		switch {
		case !known[name]:
			problems = append(problems, fmt.Sprintf("unexpected column %q", strings.TrimSpace(h)))
		default:
			if _, dup := t.cols[name]; dup {
				problems = append(problems, fmt.Sprintf("column %q appears twice", name))
			}
			t.cols[name] = i
		}
	}
	for _, c := range spec.Required {
		if _, ok := t.cols[c]; !ok {
			problems = append(problems, fmt.Sprintf("missing column %q", c))
		}
	}
	if len(problems) > 0 {
		return nil, []RowIssue{{Row: 1, Message: fmt.Sprintf("Wrong header: %s. Expected columns: %s. %s",
			strings.Join(problems, "; "), strings.Join(spec.Columns, ","), template)}}, nil
	}
	return t, nil, nil
}

func csvErrText(err error) string {
	var pe *csv.ParseError
	if errors.As(err, &pe) && pe.Err != nil {
		return pe.Err.Error()
	}
	return err.Error()
}

// next returns the next non-blank record and its row number. io.EOF ends the file; a *rowError is a
// per-row problem (the caller records it and continues); ErrTooManyRows stops the scan.
func (t *table) next() ([]string, int, error) {
	for {
		rec, err := t.r.Read()
		if errors.Is(err, io.EOF) {
			return nil, 0, io.EOF
		}
		if err != nil {
			line := 0
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				line = pe.Line
			}
			t.rows++
			if t.rows > t.maxRows {
				return nil, 0, ErrTooManyRows
			}
			return nil, line, &rowError{msg: "malformed CSV row: " + csvErrText(err)}
		}
		blank := true
		for _, c := range rec {
			if strings.TrimSpace(c) != "" {
				blank = false
				break
			}
		}
		if blank {
			continue
		}
		line, _ := t.r.FieldPos(0)
		t.rows++
		if t.rows > t.maxRows {
			return nil, 0, ErrTooManyRows
		}
		if len(rec) != t.width {
			return nil, line, &rowError{msg: fmt.Sprintf("expected %d columns but found %d (check delimiters and quotes)", t.width, len(rec))}
		}
		for _, c := range rec {
			if !utf8.ValidString(c) {
				return nil, line, &rowError{msg: "the row is not valid UTF-8 text"}
			}
		}
		return rec, line, nil
	}
}

// get returns the trimmed cell of a column ("" when the column is absent or empty).
func (t *table) get(rec []string, col string) string {
	i, ok := t.cols[col]
	if !ok {
		return ""
	}
	return strings.TrimSpace(rec[i])
}

type rowError struct{ msg string }

func (e *rowError) Error() string { return e.msg }

// issueList keeps the first MaxReportedIssues issues and counts the rest.
type issueList struct {
	items []RowIssue
	total int
}

func (l *issueList) add(row int, col, msg string) {
	l.total++
	if len(l.items) < MaxReportedIssues {
		l.items = append(l.items, RowIssue{Row: row, Column: col, Message: msg})
	}
}
