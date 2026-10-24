package importers

import (
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"time"
)

// ownerEnv is what the B06b scanners need: the instruments and the market date (IST).
type ownerEnv struct {
	idx   *instrumentIndex
	today time.Time
}

// ownerKinds is the table of the B06b kinds; scanOwner serves validate (sink nil) and commit alike, so
// the preview equals what is written (IMP-34 style single code path).
func scanOwner(kind string, content []byte, env ownerEnv, lim Limits, sink *ownerSink) (*scanReport, []RowIssue, error) {
	var rep *scanReport
	var hdr []RowIssue
	var err error
	switch kind {
	case KindResultsQuarterly, KindResultsAnnual, KindBalanceCashflow:
		rep, hdr, err = scanFundamentalsWide(kind, content, env, lim, sink)
	case KindFundamentalsLong:
		rep, hdr, err = scanFundamentalsLong(content, env, lim, sink)
	case KindShareholding:
		rep, hdr, err = scanShareholding(content, env, lim, sink)
	case KindCorporateActions:
		rep, hdr, err = scanActions(content, env, lim, sink)
	case KindInstrumentMeta:
		rep, hdr, err = scanMeta(content, env, lim, sink)
	case KindHolidays:
		rep, hdr, err = scanHolidays(content, env, lim, sink)
	default:
		return nil, nil, ErrKindNotBuilt
	}
	if err == nil && hdr == nil && sink != nil {
		err = sink.flushAll()
	}
	return rep, hdr, err
}

// streamRows drives the per-record loop shared by every scanner.
func streamRows(t *table, rep *scanReport, handle func(rec []string, row int) error) error {
	for {
		rec, row, err := t.next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		var re *rowError
		if errors.As(err, &re) {
			rep.Rows++
			rep.Errors.add(row, "", re.msg)
			continue
		}
		if err != nil {
			return err
		}
		rep.Rows++
		if err := handle(rec, row); err != nil {
			return err
		}
	}
}

func appendPreview(rep *scanReport, m map[string]any) {
	if len(rep.Preview) < previewRows {
		rep.Preview = append(rep.Preview, m)
	}
}

// fnv folds 64-bit words into a hash used to tell identical duplicate rows from contradictory ones.
type fnv uint64

func newFNV() fnv { return fnv(14695981039346656037) }

func (h fnv) word(v uint64) fnv {
	x := uint64(h)
	for i := 0; i < 8; i++ {
		x ^= v >> (8 * i) & 0xff
		x *= 1099511628211
	}
	return fnv(x)
}

func (h fnv) str(s string) fnv {
	x := uint64(h)
	for i := 0; i < len(s); i++ {
		x ^= uint64(s[i])
		x *= 1099511628211
	}
	return fnv(x*1099511628211 ^ 0xff)
}

func (h fnv) float(p *float64) fnv {
	if p == nil {
		return h.word(0x7ff8dead)
	}
	return h.word(math.Float64bits(*p))
}

// ---- results_quarterly / results_annual / balance_cashflow (docs/01 7.2) ----

type fundKind struct {
	ptype   string
	metrics []metricDef
	spec    tableSpec
}

func wideSpec(metrics []metricDef) tableSpec {
	cols := []string{"symbol", "basis", "period_end"}
	for _, m := range metrics {
		cols = append(cols, m.Col)
	}
	return tableSpec{Columns: cols, Required: []string{"symbol", "basis", "period_end"}}
}

var fundKinds = map[string]fundKind{
	KindResultsQuarterly: {periodQuarter, resultMetrics, wideSpec(resultMetrics)},
	KindResultsAnnual:    {periodAnnual, resultMetrics, wideSpec(resultMetrics)},
	KindBalanceCashflow:  {periodAnnual, balanceMetrics, wideSpec(balanceMetrics)},
}

type fundKey struct {
	inst  int32
	basis string
	ptype string
	day   int64
	key   string // metric key (long format only)
}

// issueRows reports validator issues of one row; the column is the template column of a canonical key.
func issueRows(rep *scanReport, row int, errs, warns []FieldIssue, col func(string) string) bool {
	for _, e := range errs {
		rep.Errors.add(row, col(e.Field), e.Message)
	}
	for _, w := range warns {
		rep.Warnings.add(row, col(w.Field), w.Message)
	}
	return len(errs) > 0
}

func scanFundamentalsWide(kind string, content []byte, env ownerEnv, lim Limits, sink *ownerSink) (*scanReport, []RowIssue, error) {
	fk := fundKinds[kind]
	t, hdr, err := openTable(content, fk.spec, lim.MaxRows, templateHint(kind))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := map[fundKey]uint64{}
	unknown := map[string]string{}
	err = streamRows(t, rep, func(rec []string, row int) error {
		sym := upperTrim(t.get(rec, "symbol"))
		id, msg := env.idx.resolveData(sym, unknown)
		cells := map[string]string{}
		for _, d := range fk.metrics {
			if _, ok := t.cols[d.Col]; ok {
				cells[d.Key] = t.get(rec, d.Col)
			}
		}
		n, errs, warns := ValidateFundamentals(FundamentalInput{Basis: t.get(rec, "basis"), PeriodType: fk.ptype,
			PeriodEnd: t.get(rec, "period_end"), Cells: cells}, env.today)
		bad := issueRows(rep, row, errs, warns, metricShortName)
		if msg != "" {
			rep.Errors.add(row, "symbol", msg)
			bad = true
		}
		if bad {
			return nil
		}
		keys := make([]string, 0, len(n.Values))
		for k := range n.Values {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if len(keys) == 0 {
			rep.Warnings.add(row, "", "the row has no values; nothing was stored for it")
			return nil
		}
		h := newFNV()
		op := fundOp{Inst: id, Sym: sym, Period: n.NormalizedPeriod}
		for _, k := range keys {
			v := n.Values[k]
			h = h.str(k).float(&v)
			op.Metrics = append(op.Metrics, metricVal{Key: k, Unit: canonicalUnits[k], Val: &v})
		}
		key := fundKey{inst: id, basis: n.Basis, ptype: n.PeriodType, day: n.End.Unix() / 86400}
		if prev, dup := seen[key]; dup {
			if prev != uint64(h) {
				rep.Errors.add(row, "period_end", fmt.Sprintf("%s %s %s appears twice in the file with different values; keep one row", sym, n.Basis, n.End.Format(time.DateOnly)))
				return nil
			}
			rep.Warnings.add(row, "period_end", fmt.Sprintf("%s %s %s appears twice with identical values; stored once", sym, n.Basis, n.End.Format(time.DateOnly)))
			return nil
		}
		seen[key] = uint64(h)
		rep.Valid++
		rep.Symbols[id] = true
		pv := map[string]any{"symbol": sym, "basis": n.Basis, "period_type": n.PeriodType, "period_end": n.End.Format(time.DateOnly)}
		for _, k := range keys {
			pv[metricShortName(k)] = n.Values[k]
		}
		appendPreview(rep, pv)
		if sink != nil {
			return sink.addFund(op)
		}
		return nil
	})
	return rep, nil, err
}

// ---- fundamentals_long (docs/01 7.2) ----

var fundLongSpec = tableSpec{
	Columns:  []string{"symbol", "basis", "period_type", "period_end", "metric_key", "value", "unit"},
	Required: []string{"symbol", "basis", "period_type", "period_end", "metric_key", "value"},
}

type longGroup struct {
	row  int
	sym  string
	vals map[string]float64
}

func scanFundamentalsLong(content []byte, env ownerEnv, lim Limits, sink *ownerSink) (*scanReport, []RowIssue, error) {
	t, hdr, err := openTable(content, fundLongSpec, lim.MaxRows, templateHint(KindFundamentalsLong))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := map[fundKey]uint64{}
	unknown := map[string]string{}
	groups := map[fundKey]*longGroup{}
	var order []fundKey
	err = streamRows(t, rep, func(rec []string, row int) error {
		sym := upperTrim(t.get(rec, "symbol"))
		id, msg := env.idx.resolveData(sym, unknown)
		bad := false
		if msg != "" {
			rep.Errors.add(row, "symbol", msg)
			bad = true
		}
		p, errs, warns := ValidatePeriod(t.get(rec, "basis"), t.get(rec, "period_type"), t.get(rec, "period_end"), env.today)
		if issueRows(rep, row, errs, warns, func(f string) string { return f }) {
			bad = true
		}
		mk := strings.ToLower(t.get(rec, "metric_key"))
		unit, known := canonicalUnits[mk]
		switch {
		case mk == "":
			rep.Errors.add(row, "metric_key", "metric_key is required")
			bad = true
		case !known:
			rep.Errors.add(row, "metric_key", fmt.Sprintf("unknown metric_key %q; use a canonical key such as pnl.revenue, bs.total_assets or cf.cfo (docs/05 section 2)", t.get(rec, "metric_key")))
			bad = true
		}
		if u := strings.ToUpper(t.get(rec, "unit")); known && u != "" && u != unit {
			rep.Errors.add(row, "unit", fmt.Sprintf("unit %q does not match %s, which is stored in %s", t.get(rec, "unit"), mk, unit))
			bad = true
		}
		var val *float64
		if raw := t.get(rec, "value"); raw != "" {
			v, err := ParseFloat(raw)
			if err != nil {
				rep.Errors.add(row, "value", err.Error())
				bad = true
			} else if e := checkMetric(mk, v); len(e) > 0 {
				rep.Errors.add(row, "value", e[0].Message)
				bad = true
			} else {
				val = &v
			}
		} // an empty value is stored as NULL ("reported but missing"), never 0
		if bad {
			return nil
		}
		key := fundKey{inst: id, basis: p.Basis, ptype: p.PeriodType, day: p.End.Unix() / 86400, key: mk}
		h := uint64(newFNV().float(val))
		if prev, dup := seen[key]; dup {
			if prev != h {
				rep.Errors.add(row, "value", fmt.Sprintf("%s %s %s appears twice with different values; keep one row", sym, mk, p.End.Format(time.DateOnly)))
				return nil
			}
			rep.Warnings.add(row, "value", fmt.Sprintf("%s %s %s appears twice with identical values; stored once", sym, mk, p.End.Format(time.DateOnly)))
			return nil
		}
		seen[key] = h
		rep.Valid++
		rep.Symbols[id] = true
		if val != nil {
			gk := fundKey{inst: id, basis: p.Basis, ptype: p.PeriodType, day: key.day}
			g := groups[gk]
			if g == nil {
				g = &longGroup{row: row, sym: sym, vals: map[string]float64{}}
				groups[gk], order = g, append(order, gk)
			}
			g.vals[mk] = *val
		}
		pv := map[string]any{"symbol": sym, "basis": p.Basis, "period_type": p.PeriodType, "period_end": p.End.Format(time.DateOnly), "metric_key": mk, "unit": unit}
		if val != nil {
			pv["value"] = *val
		}
		appendPreview(rep, pv)
		if sink != nil {
			return sink.addFund(fundOp{Inst: id, Sym: sym, Period: p, Metrics: []metricVal{{Key: mk, Unit: unit, Val: val}}})
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	for _, gk := range order { // cross-row warnings once every row of a period has been read
		g := groups[gk]
		for _, w := range checkCross(g.vals) {
			rep.Warnings.add(g.row, "value", w.Message)
		}
	}
	return rep, nil, nil
}

// ---- shareholding (docs/01 7.3) ----

var shareholdingSpec = tableSpec{
	Columns: []string{"symbol", "quarter_end", "promoter", "fii", "dii", "mf", "insurance", "govt", "public",
		"pledged_of_promoter", "shareholders_count", "filed_on"},
	Required: []string{"symbol", "quarter_end"},
}

func scanShareholding(content []byte, env ownerEnv, lim Limits, sink *ownerSink) (*scanReport, []RowIssue, error) {
	t, hdr, err := openTable(content, shareholdingSpec, lim.MaxRows, templateHint(KindShareholding))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := map[fundKey]uint64{}
	unknown := map[string]string{}
	err = streamRows(t, rep, func(rec []string, row int) error {
		sym := upperTrim(t.get(rec, "symbol"))
		id, msg := env.idx.resolveData(sym, unknown)
		n, errs, warns := ValidateShareholding(ShareholdingInput{
			QuarterEnd: t.get(rec, "quarter_end"), Promoter: t.get(rec, "promoter"), FII: t.get(rec, "fii"), DII: t.get(rec, "dii"),
			MF: t.get(rec, "mf"), Insurance: t.get(rec, "insurance"), Govt: t.get(rec, "govt"), Public: t.get(rec, "public"),
			Pledged: t.get(rec, "pledged_of_promoter"), Count: t.get(rec, "shareholders_count"), FiledOn: t.get(rec, "filed_on"),
		}, env.today)
		bad := issueRows(rep, row, errs, warns, func(f string) string { return f })
		if msg != "" {
			rep.Errors.add(row, "symbol", msg)
			bad = true
		}
		if bad {
			return nil
		}
		h := newFNV()
		for _, p := range []*float64{n.Promoter, n.FII, n.DII, n.MF, n.Insurance, n.Govt, n.Public, n.Pledged} {
			h = h.float(p)
		}
		if n.Count != nil {
			h = h.word(uint64(*n.Count)) //nolint:gosec // non-negative
		}
		if n.FiledOn != nil {
			h = h.str(n.FiledOn.Format(time.DateOnly))
		}
		key := fundKey{inst: id, day: n.QuarterEnd.Unix() / 86400}
		if prev, dup := seen[key]; dup {
			if prev != uint64(h) {
				rep.Errors.add(row, "quarter_end", fmt.Sprintf("%s %s appears twice in the file with different values; keep one row", sym, n.QuarterEnd.Format(time.DateOnly)))
				return nil
			}
			rep.Warnings.add(row, "quarter_end", fmt.Sprintf("%s %s appears twice with identical values; stored once", sym, n.QuarterEnd.Format(time.DateOnly)))
			return nil
		}
		seen[key] = uint64(h)
		rep.Valid++
		rep.Symbols[id] = true
		pv := map[string]any{"symbol": sym, "quarter_end": n.QuarterEnd.Format(time.DateOnly)}
		for col, p := range map[string]*float64{"promoter": n.Promoter, "fii": n.FII, "dii": n.DII, "mf": n.MF, "insurance": n.Insurance,
			"govt": n.Govt, "public": n.Public, "pledged_of_promoter": n.Pledged} {
			if p != nil {
				pv[col] = *p
			}
		}
		if n.Count != nil {
			pv["shareholders_count"] = *n.Count
		}
		if n.FiledOn != nil {
			pv["filed_on"] = n.FiledOn.Format(time.DateOnly)
		}
		appendPreview(rep, pv)
		if sink != nil {
			return sink.addShare(shareOp{Inst: id, Sym: sym, N: n})
		}
		return nil
	})
	return rep, nil, err
}

// ---- corporate_actions (docs/01 7.4) ----

var actionsSpec = tableSpec{
	Columns:  []string{"symbol", "ex_date", "type", "ratio_num", "ratio_den", "amount_per_share", "purpose_text"},
	Required: []string{"symbol", "ex_date", "type"},
}

type actionKey struct {
	inst    int32
	day     int64
	typ     string
	purpose string
}

func scanActions(content []byte, env ownerEnv, lim Limits, sink *ownerSink) (*scanReport, []RowIssue, error) {
	t, hdr, err := openTable(content, actionsSpec, lim.MaxRows, templateHint(KindCorporateActions))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := map[actionKey]uint64{}
	unknown := map[string]string{}
	err = streamRows(t, rep, func(rec []string, row int) error {
		sym := upperTrim(t.get(rec, "symbol"))
		id, msg := env.idx.resolveData(sym, unknown)
		n, errs, warns := ValidateAction(ActionInput{ExDate: t.get(rec, "ex_date"), Type: t.get(rec, "type"), RatioNum: t.get(rec, "ratio_num"),
			RatioDen: t.get(rec, "ratio_den"), Amount: t.get(rec, "amount_per_share"), Purpose: t.get(rec, "purpose_text")})
		bad := issueRows(rep, row, errs, warns, func(f string) string { return f })
		if msg != "" {
			rep.Errors.add(row, "symbol", msg)
			bad = true
		}
		if bad {
			return nil
		}
		h := newFNV()
		for _, p := range []*string{n.RatioNum, n.RatioDen, n.Amount} {
			if p == nil {
				h = h.str("<nil>")
			} else {
				h = h.str(*p)
			}
		}
		key := actionKey{inst: id, day: n.ExDate.Unix() / 86400, typ: n.Type, purpose: n.Purpose}
		if prev, dup := seen[key]; dup {
			if prev != uint64(h) {
				rep.Errors.add(row, "ex_date", fmt.Sprintf("%s %s on %s appears twice with different values; keep one row", sym, n.Type, n.ExDate.Format(time.DateOnly)))
				return nil
			}
			rep.Warnings.add(row, "ex_date", fmt.Sprintf("%s %s on %s appears twice with identical values; stored once", sym, n.Type, n.ExDate.Format(time.DateOnly)))
			return nil
		}
		seen[key] = uint64(h)
		rep.Valid++
		rep.Symbols[id] = true
		pv := map[string]any{"symbol": sym, "ex_date": n.ExDate.Format(time.DateOnly), "type": n.Type, "purpose_text": n.Purpose}
		for col, p := range map[string]*string{"ratio_num": n.RatioNum, "ratio_den": n.RatioDen, "amount_per_share": n.Amount} {
			if p != nil {
				pv[col] = *p
			}
		}
		appendPreview(rep, pv)
		if sink != nil {
			return sink.addAction(actionOp{Inst: id, Sym: sym, N: n})
		}
		return nil
	})
	return rep, nil, err
}

// ---- instrument_meta (docs/01 7.5) ----

var metaSpec = tableSpec{
	Columns:  []string{"symbol", "sector", "industry", "company_type", "index_tags"},
	Required: []string{"symbol"},
}

func scanMeta(content []byte, env ownerEnv, lim Limits, sink *ownerSink) (*scanReport, []RowIssue, error) {
	t, hdr, err := openTable(content, metaSpec, lim.MaxRows, templateHint(KindInstrumentMeta))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := map[string]uint64{}
	unknown := map[string]string{}
	err = streamRows(t, rep, func(rec []string, row int) error {
		sym := upperTrim(t.get(rec, "symbol"))
		id, msg := env.idx.resolveData(sym, unknown)
		n, errs, warns := ValidateMeta(t.get(rec, "sector"), t.get(rec, "industry"), t.get(rec, "company_type"), t.get(rec, "index_tags"))
		bad := issueRows(rep, row, errs, warns, func(f string) string { return f })
		if msg != "" {
			rep.Errors.add(row, "symbol", msg)
			bad = true
		}
		if bad {
			return nil
		}
		h := newFNV()
		for _, p := range []*string{n.Sector, n.Industry, n.CompanyType} {
			if p == nil {
				h = h.str("<nil>")
			} else {
				h = h.str(*p)
			}
		}
		h = h.str(strings.Join(n.Tags, "|"))
		if prev, dup := seen[sym]; dup {
			if prev != uint64(h) {
				rep.Errors.add(row, "symbol", fmt.Sprintf("symbol %s appears twice in the file with different values; keep one row", sym))
				return nil
			}
			rep.Warnings.add(row, "symbol", fmt.Sprintf("symbol %s appears twice with identical values; stored once", sym))
			return nil
		}
		seen[sym] = uint64(h)
		rep.Valid++
		rep.Symbols[id] = true
		pv := map[string]any{"symbol": sym, "index_tags": n.Tags}
		for col, p := range map[string]*string{"sector": n.Sector, "industry": n.Industry, "company_type": n.CompanyType} {
			if p != nil {
				pv[col] = *p
			}
		}
		appendPreview(rep, pv)
		if sink != nil {
			return sink.addMeta(metaOp{Inst: id, Sym: sym, N: n})
		}
		return nil
	})
	return rep, nil, err
}

// ---- holidays (docs/01 7.8) ----

var holidaysSpec = tableSpec{
	Columns:  []string{"date", "description", "segment"},
	Required: []string{"date"},
}

type holidayKey struct {
	day int64
	seg string
}

func scanHolidays(content []byte, env ownerEnv, lim Limits, sink *ownerSink) (*scanReport, []RowIssue, error) {
	t, hdr, err := openTable(content, holidaysSpec, lim.MaxRows, templateHint(KindHolidays))
	if err != nil || hdr != nil {
		return nil, hdr, err
	}
	rep := newReport()
	seen := map[holidayKey]int{}
	err = streamRows(t, rep, func(rec []string, row int) error {
		n, errs, warns := ValidateHoliday(t.get(rec, "date"), t.get(rec, "description"), t.get(rec, "segment"), env.today)
		if issueRows(rep, row, errs, warns, func(f string) string { return f }) {
			return nil
		}
		key := holidayKey{day: n.Date.Unix() / 86400, seg: n.Segment}
		if first, dup := seen[key]; dup {
			rep.Errors.add(row, "date", fmt.Sprintf("%s (%s) appears twice in the file (first on row %d)", n.Date.Format(time.DateOnly), n.Segment, first))
			return nil
		}
		seen[key] = row
		rep.Valid++
		pv := map[string]any{"date": n.Date.Format(time.DateOnly), "segment": n.Segment}
		if n.Description != nil {
			pv["description"] = *n.Description
		}
		appendPreview(rep, pv)
		if sink != nil {
			return sink.addHoliday(holidayOp{N: n})
		}
		return nil
	})
	return rep, nil, err
}
