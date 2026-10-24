package importers

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

var instrumentsSpec = tableSpec{
	Columns:  []string{"symbol", "name", "isin", "series", "kind", "listing_date", "face_value", "previous_symbol", "status"},
	Required: []string{"symbol", "name"},
}

var (
	instrumentKinds    = map[string]bool{"equity": true, "etf": true, "reit": true, "invit": true, "sme": true, "other": true}
	instrumentStatuses = map[string]bool{"active": true, "suspended": true, "delisted": true}
)

// instOp is one planned instruments.csv row. Optional fields are nil when the cell was empty or
// (ISIN) malformed: on insert they take the column default, on update the stored value is kept.
type instOp struct {
	Row     int
	Symbol  string
	Name    string
	ISIN    *string
	Series  *string
	Kind    *string
	Listing *time.Time
	Face    *string // numeric(10,2) text
	Status  *string
	Action  string // insert | update | rename

	// Rename (docs/01 7.0): the instrument id, its current symbol and the aliases to record.
	RenameID   int32
	RenameFrom string
	AliasOld   []string
}

// scanInstruments validates instruments.csv as a stream and plans each row against the instrument
// index (symbol or alias match for previous_symbol). It mutates the index copy so later rows of the
// same file see earlier renames and inserts; nothing is written here.
func scanInstruments(content []byte, idx *instrumentIndex, lim Limits, onOp func(instOp) error) (*scanReport, []RowIssue, error) {
	t, hdr, err := openTable(content, instrumentsSpec, lim.MaxRows, templateHint(KindInstruments))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := map[string]int{}
	for {
		rec, row, err := t.next()
		if errors.Is(err, io.EOF) {
			break
		}
		var re *rowError
		if errors.As(err, &re) {
			rep.Rows++
			rep.Errors.add(row, "", re.msg)
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		rep.Rows++
		op, ok := planInstrumentRow(t, rec, row, idx, rep, seen)
		if !ok {
			continue
		}
		rep.Valid++
		if len(rep.Preview) < previewRows {
			rep.Preview = append(rep.Preview, previewInstrument(op))
		}
		if onOp != nil {
			if err := onOp(op); err != nil {
				return nil, nil, err
			}
		}
	}
	return rep, nil, nil
}

func previewInstrument(op instOp) map[string]any {
	m := map[string]any{"symbol": op.Symbol, "name": op.Name, "action": op.Action}
	put := func(k string, v *string) {
		if v != nil {
			m[k] = *v
		}
	}
	put("isin", op.ISIN)
	put("series", op.Series)
	put("kind", op.Kind)
	put("face_value", op.Face)
	put("status", op.Status)
	if op.Listing != nil {
		m["listing_date"] = op.Listing.Format(time.DateOnly)
	}
	if op.RenameFrom != "" {
		m["renamed_from"] = op.RenameFrom
	}
	return m
}

func planInstrumentRow(t *table, rec []string, row int, idx *instrumentIndex, rep *scanReport, seen map[string]int) (instOp, bool) {
	var op instOp
	op.Row = row
	bad := false
	fail := func(col, msg string) { rep.Errors.add(row, col, msg); bad = true }

	n, errs, warns := ValidateInstrumentFields(InstrumentFields{Symbol: t.get(rec, "symbol"), Name: t.get(rec, "name"), ISIN: t.get(rec, "isin")})
	for _, e := range errs {
		fail(e.Field, e.Message)
	}
	for _, w := range warns {
		rep.Warnings.add(row, w.Field, w.Message)
	}
	op.Symbol, op.Name = n.Symbol, n.Name
	if n.ISIN != "" {
		isin := n.ISIN
		op.ISIN = &isin
	}
	if op.Symbol != "" {
		if first, dup := seen[op.Symbol]; dup {
			fail("symbol", fmt.Sprintf("symbol %s appears twice in the file (first on row %d)", op.Symbol, first))
		}
		seen[op.Symbol] = row
	}

	if v := upperTrim(t.get(rec, "series")); v != "" {
		if !reSeries.MatchString(v) {
			fail("series", fmt.Sprintf("series %q must be 1-10 letters or digits (for example EQ)", t.get(rec, "series")))
		} else {
			op.Series = &v
		}
	}
	if v := strings.ToLower(t.get(rec, "kind")); v != "" {
		if !instrumentKinds[v] {
			fail("kind", fmt.Sprintf("kind %q must be one of equity, etf, reit, invit, sme, other", t.get(rec, "kind")))
		} else {
			op.Kind = &v
		}
	}
	if v := strings.ToLower(t.get(rec, "status")); v != "" {
		if !instrumentStatuses[v] {
			fail("status", fmt.Sprintf("status %q must be one of active, suspended, delisted", t.get(rec, "status")))
		} else {
			op.Status = &v
		}
	}
	if v := t.get(rec, "listing_date"); v != "" {
		if d, err := ParseDate(v); err != nil {
			fail("listing_date", err.Error())
		} else {
			op.Listing = &d
		}
	}
	if v := t.get(rec, "face_value"); v != "" {
		c, err := CleanNumber(v)
		switch {
		case err != nil:
			fail("face_value", err.Error())
		default:
			d, derr := decimal.NewFromString(c)
			switch {
			case derr != nil || d.Sign() <= 0:
				fail("face_value", "face_value must be greater than 0")
			case d.Exponent() < -2 && !d.Equal(d.Round(2)):
				fail("face_value", "face_value may have at most 2 decimal places")
			case d.GreaterThanOrEqual(decimal.NewFromInt(100_000_000)):
				fail("face_value", "face_value is too large")
			default:
				s := d.StringFixed(2)
				op.Face = &s
			}
		}
	}
	prev := upperTrim(t.get(rec, "previous_symbol"))
	if prev != "" && !reSymbol.MatchString(prev) {
		fail("previous_symbol", fmt.Sprintf("previous_symbol %q must use only A-Z, 0-9, & and -", t.get(rec, "previous_symbol")))
		prev = ""
	}
	if bad {
		return op, false
	}

	op.Action = "insert"
	if _, ok := idx.bySymbol[op.Symbol]; ok {
		op.Action = "update"
	}
	if prev != "" {
		planRename(&op, prev, idx, rep, row)
	}
	if op.Action == "insert" {
		idx.bySymbol[op.Symbol] = -1 // later rows of this file see it as taken
	}
	return op, true
}

// planRename applies the previous_symbol rule of docs/01 7.0 (INS-14): rename only when the old
// symbol matches an existing instrument (by symbol or alias) and the new symbol is not taken by a
// different instrument; otherwise the field is ignored with a warning.
func planRename(op *instOp, prev string, idx *instrumentIndex, rep *scanReport, row int) {
	warn := func(msg string) { rep.Warnings.add(row, "previous_symbol", msg) }
	if prev == op.Symbol {
		warn("previous_symbol equals symbol; ignored")
		return
	}
	id, ok := idx.bySymbol[prev]
	if !ok {
		id, ok = idx.alias[prev]
	}
	if !ok || id <= 0 {
		warn(fmt.Sprintf("previous_symbol %s matches no existing instrument; ignored", prev))
		return
	}
	if taken, ok := idx.bySymbol[op.Symbol]; ok {
		if taken == id {
			return // already renamed earlier; a plain update
		}
		warn(fmt.Sprintf("symbol %s already belongs to another instrument; previous_symbol %s ignored", op.Symbol, prev))
		return
	}
	cur := idx.byID[id]
	op.Action, op.RenameID, op.RenameFrom = "rename", id, cur
	op.AliasOld = []string{cur}
	if prev != cur {
		op.AliasOld = append(op.AliasOld, prev)
	}
	delete(idx.bySymbol, cur)
	idx.bySymbol[op.Symbol] = id
	idx.byID[id] = op.Symbol
	for _, a := range op.AliasOld {
		idx.alias[a] = id
	}
}
