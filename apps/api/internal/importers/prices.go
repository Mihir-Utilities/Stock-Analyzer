package importers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"github.com/india-analyzer/api/internal/dbq"
)

var pricesSpec = tableSpec{
	Columns:  []string{"symbol", "date", "open", "high", "low", "close", "volume"},
	Required: []string{"symbol", "date", "open", "high", "low", "close", "volume"},
}

const ohlcTolerance = 1e-6 // docs/01 3.5 sanity rule

// priceRow is one accepted bar. inst is 0 and code is set for the reserved market series.
type priceRow struct {
	inst    int32
	sym     string
	code    string
	date    time.Time
	o, h, l float64
	c       float64
	vol     int64
	suspect bool
}

type priceEnv struct {
	idx      *instrumentIndex
	holidays map[time.Time]bool
	today    time.Time
	// seen, when set, is shared by every part of a group so a contradictory duplicate across parts
	// is caught (IMP-09); it also ends up holding the unique keys for the new-row count (IMP-23).
	// Nil: a per-file map.
	seen map[dupKey]uint64
}

type dupKey struct {
	sym  string
	day  int64
	inst int32
}

// scanReport is the outcome of one scan over a file.
type scanReport struct {
	Rows     int // data rows read
	Valid    int // rows accepted (weekend rows are dropped, not counted)
	Errors   issueList
	Warnings issueList
	Preview  []map[string]any
	Symbols  map[int32]bool // stock instruments with accepted rows
	Series   map[string]bool
	// per instrument: first and last accepted date (for the suspect pass)
	MinDate map[int32]time.Time
	MaxDate map[int32]time.Time
}

func newReport() *scanReport {
	return &scanReport{Symbols: map[int32]bool{}, Series: map[string]bool{}, MinDate: map[int32]time.Time{}, MaxDate: map[int32]time.Time{}}
}

func loadHolidays(ctx context.Context, db dbq.DBTX) (map[time.Time]bool, error) {
	rows, err := db.Query(ctx, `SELECT DISTINCT holiday_date FROM market_holiday WHERE segment = 'trading'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[time.Time]bool{}
	for rows.Next() {
		var d time.Time
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		m[time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)] = true
	}
	return m, rows.Err()
}

func rowHash(p priceRow) uint64 {
	h := uint64(14695981039346656037)                                                                                                          // FNV-1a over the stored values
	for _, v := range [...]uint64{math.Float64bits(p.o), math.Float64bits(p.h), math.Float64bits(p.l), math.Float64bits(p.c), uint64(p.vol)} { //nolint:gosec // volume is >= 0 here
		for i := 0; i < 8; i++ {
			h ^= v >> (8 * i) & 0xff
			h *= 1099511628211
		}
	}
	return h
}

// scanPrices validates the file as a stream and calls onRow for every accepted bar (duplicates
// included: a later duplicate wins when the chunk is written). The same function serves validate
// and commit, so what the owner previewed is what is written (IMP-17 style single code path).
func scanPrices(content []byte, env priceEnv, lim Limits, onRow func(priceRow) error) (*scanReport, []RowIssue, error) {
	t, hdr, err := openTable(content, pricesSpec, lim.MaxRows, templateHint(KindPrices))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := env.seen
	if seen == nil {
		seen = map[dupKey]uint64{}
	}
	unknown := map[string]string{} // symbol -> message, so a bad symbol costs one suggestion search
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
		p, ok := scanPriceRow(t, rec, row, env, rep, unknown)
		if !ok {
			continue
		}
		key := dupKey{sym: p.sym, day: p.date.Unix() / 86400, inst: p.inst}
		if p.code != "" {
			key.sym = p.code
		}
		h := rowHash(p)
		if prev, dup := seen[key]; dup {
			if prev != h {
				rep.Errors.add(row, "date", fmt.Sprintf("%s on %s appears twice in the file with different values; keep one row", key.sym, p.date.Format(time.DateOnly)))
				continue
			}
			rep.Warnings.add(row, "date", fmt.Sprintf("%s on %s appears twice with identical values; the later row is used", key.sym, p.date.Format(time.DateOnly)))
		}
		seen[key] = h
		rep.Valid++
		if p.code != "" {
			rep.Series[p.code] = true
		} else {
			rep.Symbols[p.inst] = true
			if mn, ok := rep.MinDate[p.inst]; !ok || p.date.Before(mn) {
				rep.MinDate[p.inst] = p.date
			}
			if mx, ok := rep.MaxDate[p.inst]; !ok || p.date.After(mx) {
				rep.MaxDate[p.inst] = p.date
			}
		}
		if len(rep.Preview) < previewRows {
			rep.Preview = append(rep.Preview, previewPrice(p))
		}
		if onRow != nil {
			if err := onRow(p); err != nil {
				return nil, nil, err
			}
		}
	}
	return rep, nil, nil
}

func previewPrice(p priceRow) map[string]any {
	if p.code != "" {
		return map[string]any{"symbol": p.code, "date": p.date.Format(time.DateOnly), "close": p.c, "target": "market_series"}
	}
	return map[string]any{"symbol": p.sym, "date": p.date.Format(time.DateOnly), "open": p.o, "high": p.h, "low": p.l,
		"close": p.c, "volume": p.vol, "suspect": p.suspect}
}

func scanPriceRow(t *table, rec []string, row int, env priceEnv, rep *scanReport, unknown map[string]string) (priceRow, bool) {
	var p priceRow
	bad := false
	fail := func(col, msg string) { rep.Errors.add(row, col, msg); bad = true }

	sym := upperTrim(t.get(rec, "symbol"))
	switch {
	case sym == "":
		fail("symbol", "symbol is required")
	case IsReserved(sym):
		p.code = sym
	default:
		if id, ok := env.idx.bySymbol[sym]; ok && id > 0 {
			p.inst = id
		} else if msg, ok := unknown[sym]; ok {
			fail("symbol", msg)
		} else {
			msg := "unknown symbol " + sym + ": add it with instruments.csv or the Add stock form first"
			if aid, ok := env.idx.alias[sym]; ok {
				msg = fmt.Sprintf("symbol %s was renamed to %s; use the new symbol", sym, env.idx.byID[aid])
			} else if s := env.idx.suggest(sym); s != "" {
				msg = fmt.Sprintf("unknown symbol %s: did you mean %s?", sym, s)
			}
			unknown[sym] = msg
			fail("symbol", msg)
		}
	}
	p.sym = sym

	d, err := ParseDate(t.get(rec, "date"))
	if err != nil {
		fail("date", err.Error())
		return p, false
	}
	p.date = d
	if d.After(env.today) {
		fail("date", fmt.Sprintf("%s is in the future", d.Format(time.DateOnly)))
	}
	if wd := d.Weekday(); wd == time.Saturday || wd == time.Sunday {
		if !bad {
			rep.Warnings.add(row, "date", fmt.Sprintf("%s is a weekend; the row was dropped", d.Format(time.DateOnly)))
		}
		return p, false
	}
	if env.holidays[d] && !bad {
		rep.Warnings.add(row, "date", fmt.Sprintf("%s is listed as a market holiday; the row was kept", d.Format(time.DateOnly)))
	}

	num := func(col string) (float64, bool) {
		raw := t.get(rec, col)
		if raw == "" {
			fail(col, col+" is required (an empty cell is not read as 0)")
			return 0, false
		}
		f, err := ParseFloat(raw)
		if err != nil {
			fail(col, err.Error())
			return 0, false
		}
		return f, true
	}
	positive := func(col string) float64 {
		f, ok := num(col)
		if ok && f <= 0 {
			fail(col, col+" must be greater than 0")
			return 0
		}
		return f
	}
	if p.code != "" { // only the close is used for market series (docs/01 7.1)
		p.c = positive("close")
		return p, !bad
	}
	p.o, p.h, p.l, p.c = positive("open"), positive("high"), positive("low"), positive("close")
	if raw := t.get(rec, "volume"); raw == "" {
		fail("volume", "volume is required (an empty cell is not read as 0)")
	} else if v, err := ParseWhole(raw); err != nil {
		fail("volume", err.Error())
	} else if v < 0 {
		fail("volume", "volume must be 0 or more")
	} else {
		p.vol = v
	}
	if bad {
		return p, false
	}
	if p.h < p.l {
		fail("high", "high must be greater than or equal to low")
		return p, false
	}
	// docs/01 3.5: stored but flagged suspect (excluded from analytics) when the OHLC is inconsistent.
	if p.h < math.Max(p.o, p.c)-ohlcTolerance || p.l > math.Min(p.o, p.c)+ohlcTolerance {
		p.suspect = true
		rep.Warnings.add(row, "high", "open/high/low/close are inconsistent; the bar is stored as suspect and excluded from analytics")
	}
	return p, true
}

// upperTrim is the one symbol normaliser of every importer path: it trims white space and upper-
// cases ASCII letters only, so look-alikes such as dotless i or long s (which Unicode upper-casing
// would fold into I and S) stay non-ASCII and fail the symbol charset check (IMP-17 parity).
func upperTrim(s string) string {
	b := []byte(strings.TrimSpace(s))
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}
