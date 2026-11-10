package screener

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

func readRepo(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile("../../../../" + rel) //nolint:gosec // test reads fixed repo paths
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// pyTuple extracts the string literals of `NAME = ( ... )` from a Python source file.
func pyTuple(t *testing.T, src, name string) []string {
	t.Helper()
	re := regexp.MustCompile(`(?s)` + name + `\s*=\s*\((.*?)\)`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("tuple %s not found", name)
	}
	var out []string
	for _, s := range regexp.MustCompile(`"([a-z0-9_]+)"`).FindAllStringSubmatch(m[1], -1) {
		out = append(out, s[1])
	}
	return out
}

// SEC-04: every whitelisted key is a key the worker really writes, and the whitelist is exactly the
// docs/03 section 9 list (no extras, none missing).
func TestWhitelistMatchesWorker(t *testing.T) {
	norm := func(s string) string { return strings.ReplaceAll(s, "\r", "") }
	analysis := norm(readRepo(t, "apps/worker/worker/analysis_db.py"))
	fnd := norm(readRepo(t, "apps/worker/worker/analytics/fundamentals.py"))
	var written []string
	written = append(written, pyTuple(t, analysis, "SCREENER_PRICE_KEYS")...)
	written = append(written, pyTuple(t, analysis, "SCREENER_TEXT_KEYS")...)
	written = append(written, pyTuple(t, fnd, "FUNDAMENTAL_SCREENER_KEYS")...)
	written = append(written, pyTuple(t, fnd, "SCORE_SCREENER_KEYS")...)
	if len(written) < 30 {
		t.Fatalf("parsed too few worker keys: %v", written)
	}
	got := Keys()
	sort.Strings(written)
	sort.Strings(got)
	// price keys the worker writes but docs/03 does not whitelist would show up here too.
	if !reflect.DeepEqual(got, written) {
		t.Errorf("whitelist differs from worker keys\nwhitelist: %v\nworker:    %v", got, written)
	}
}

func TestWhitelistMatchesDocs(t *testing.T) {
	doc := readRepo(t, "docs/03-api-spec.md")
	i := strings.Index(doc, "**Whitelisted metrics**")
	if i < 0 {
		t.Fatal("whitelist paragraph not found")
	}
	line := doc[i:]
	line = line[:strings.Index(line, "\n")]
	var want []string
	for _, m := range regexp.MustCompile("`([a-z0-9_]+)`").FindAllStringSubmatch(line, -1) {
		want = append(want, m[1])
	}
	if !reflect.DeepEqual(Keys(), want) {
		t.Errorf("whitelist order/content differs from docs/03:\n%v\n%v", Keys(), want)
	}
}

func TestWhitelistExpressionsAreFixed(t *testing.T) {
	for _, m := range whitelist {
		if !keyShape.MatchString(m.Key) || strings.ContainsAny(m.expr, ";\"\\") || strings.Contains(m.expr, "--") {
			t.Errorf("%s: unsafe expression %q", m.Key, m.expr)
		}
		if !strings.Contains(m.expr, "'"+m.Key+"'") {
			t.Errorf("%s: expression does not reference its own key", m.Key)
		}
	}
}

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func mustValid(t *testing.T, s *Spec) {
	t.Helper()
	if err := s.Validate(); err != nil {
		t.Fatalf("expected valid spec: %v", err)
	}
}

func fieldsOf(err error) []string {
	ve, ok := AsValidation(err)
	if !ok {
		return nil
	}
	var out []string
	for _, f := range ve.Fields {
		out = append(out, f.Field)
	}
	return out
}

var injections = []string{
	"roe; DROP TABLE instrument;--", "roe' OR '1'='1", "roe) OR (1=1", "ROE", " roe", "roe ", "roe\x00", "roe\n",
	"metrics->>'roe'", "pe)::float8 > 0 OR true --", "", "1", "constructor", "__proto__", "ｒｏｅ", "roe\u0000x",
	"(select 1)", "roe, pe", "roe/**/", "$1", "%", "*", "roe\\", "ro%65",
}

func TestInjectionMetricKey(t *testing.T) {
	for _, inj := range injections {
		s := &Spec{Filters: []Filter{{Metric: inj, Op: ">", Value: raw("1")}}}
		err := s.Validate()
		if got := fieldsOf(err); !reflect.DeepEqual(got, []string{"filters[0].metric"}) {
			t.Errorf("filter metric %q: fields %v err %v", inj, got, err)
		}
		s = &Spec{Sort: &Sort{Metric: inj, Dir: "asc"}}
		if got := fieldsOf(s.Validate()); !reflect.DeepEqual(got, []string{"sort.metric"}) {
			t.Errorf("sort metric %q: fields %v", inj, got)
		}
		s = &Spec{Columns: []string{inj}}
		if got := fieldsOf(s.Validate()); !reflect.DeepEqual(got, []string{"columns[0]"}) {
			t.Errorf("column %q: fields %v", inj, got)
		}
	}
}

func TestInjectionSortDirAndOps(t *testing.T) {
	for _, inj := range []string{"asc; DROP TABLE x", "ascending", "up", "desc,symbol", "1", "asc\x00", "desc --"} {
		s := &Spec{Sort: &Sort{Metric: "roe", Dir: inj}}
		if got := fieldsOf(s.Validate()); !reflect.DeepEqual(got, []string{"sort.dir"}) {
			t.Errorf("dir %q: %v", inj, got)
		}
	}
	for _, inj := range []string{"> 1 OR 1=1 --", "like", "LIKE", "!=", "<>", "in", "IN", "", "= ANY", ">\x00", "between ", "; DROP", "is null", "=="} {
		s := &Spec{Filters: []Filter{{Metric: "roe", Op: inj, Value: raw("1")}}}
		err := s.Validate()
		// "between " is trimmed to a valid operator but then needs an array operand.
		if got := fieldsOf(err); len(got) != 1 || (got[0] != "filters[0].op" && got[0] != "filters[0].value") {
			t.Errorf("op %q: %v %v", inj, got, err)
		}
	}
	for _, inj := range []string{">", "<", "between", "like", "", "!="} {
		s := &Spec{Filters: []Filter{{Metric: "sector", Op: inj, Value: raw(`"IT"`)}}}
		if got := fieldsOf(s.Validate()); !reflect.DeepEqual(got, []string{"filters[0].op"}) {
			t.Errorf("text op %q: %v", inj, got)
		}
	}
	// Direction and operator case: dir is case-insensitive, operators are exact.
	s := &Spec{Sort: &Sort{Metric: "roe", Dir: " DESC "}}
	mustValid(t, s)
	if s.Sort.Dir != "desc" {
		t.Errorf("dir normalised to %q", s.Sort.Dir)
	}
}

func TestFilterValueValidation(t *testing.T) {
	bad := []struct{ metric, op, val string }{
		{"roe", ">", `"15"`}, {"roe", ">", `null`}, {"roe", ">", `true`}, {"roe", ">", `[1]`}, {"roe", ">", `{}`},
		{"roe", ">", `1e999`}, {"roe", ">", `1e16`}, {"roe", ">", `-1e16`}, {"roe", ">", ``}, {"roe", ">", `15; DROP`},
		{"roe", "between", `[1]`}, {"roe", "between", `[1,2,3]`}, {"roe", "between", `5`}, {"roe", "between", `["1","2"]`},
		{"roe", "between", `[20,10]`}, {"roe", "between", `[null,1]`}, {"roe", "=", `[1]`},
		{"sector", "=", `5`}, {"sector", "=", `""`}, {"sector", "=", `"  "`}, {"sector", "=", `["IT"]`}, {"sector", "in", `"IT"`},
		{"sector", "in", `[]`}, {"sector", "in", `[1]`}, {"sector", "in", `[""]`}, {"sector", "=", `"a\u0000b"`},
		{"sector", "=", `"` + strings.Repeat("x", 101) + `"`}, {"sector", "in", manyStrings(51)},
	}
	for _, b := range bad {
		s := &Spec{Filters: []Filter{{Metric: b.metric, Op: b.op, Value: raw(b.val)}}}
		if err := s.Validate(); err == nil {
			t.Errorf("%s %s %s: expected 422", b.metric, b.op, b.val)
		} else if got := fieldsOf(err); !reflect.DeepEqual(got, []string{"filters[0].value"}) {
			t.Errorf("%s %s %s: fields %v", b.metric, b.op, b.val, got)
		}
	}
	good := []struct{ metric, op, val string }{
		{"roe", ">", `15`}, {"roe", ">=", `-3.5`}, {"market_cap_cr", "between", `[5000,100000]`}, {"roe", "between", `[7,7]`},
		{"sector", "in", `["IT","Banks"]`}, {"sector", "=", `"IT"`}, {"roe", "=", `0`}, {"sector", "in", manyStrings(50)},
	}
	for _, g := range good {
		s := &Spec{Filters: []Filter{{Metric: g.metric, Op: g.op, Value: raw(g.val)}}}
		mustValid(t, s)
	}
}

func manyStrings(n int) string {
	xs := make([]string, n)
	for i := range xs {
		xs[i] = "s" + strings.Repeat("a", i%5)
	}
	b, _ := json.Marshal(xs)
	return string(b)
}

func TestSpecLimitsAndUniverse(t *testing.T) {
	var fs []Filter
	for i := 0; i < MaxFilters+1; i++ {
		fs = append(fs, Filter{Metric: "roe", Op: ">", Value: raw("1")})
	}
	if got := fieldsOf((&Spec{Filters: fs}).Validate()); !reflect.DeepEqual(got, []string{"filters"}) {
		t.Errorf("13 filters: %v", got)
	}
	mustValid(t, &Spec{Filters: fs[:MaxFilters]})
	for _, u := range []Universe{{Kind: "stock"}, {Kind: "equity; drop"}, {CompanyType: "bank"}, {Index: "x\x00y"}, {Index: strings.Repeat("N", 101)}} {
		if err := (&Spec{Universe: u}).Validate(); err == nil {
			t.Errorf("universe %+v accepted", u)
		}
	}
	s := &Spec{}
	mustValid(t, s)
	if s.Universe.Kind != "equity" || s.Filters == nil {
		t.Errorf("defaults not applied: %+v", s)
	}
	cols := make([]string, MaxColumns+1)
	for i := range cols {
		cols[i] = "roe"
	}
	if err := (&Spec{Columns: cols}).Validate(); err == nil {
		t.Error("41 columns accepted")
	}
}

func TestParsePage(t *testing.T) {
	cur := func(s string) *string { return &s }
	for _, bad := range []string{`0`, `-1`, `1.5`, `"5"`, `true`, `[]`, `1e999`, `abc`} {
		if _, err := ParsePage(raw(bad), nil, "fp"); fieldsOf(err) == nil || fieldsOf(err)[0] != "limit" {
			t.Errorf("limit %s: %v", bad, err)
		}
	}
	p, err := ParsePage(raw(`1000`), nil, "fp")
	if err != nil || p.Limit != 200 {
		t.Errorf("clamp: %+v %v", p, err)
	}
	if p, _ := ParsePage(nil, nil, "fp"); p.Limit != 50 || p.Offset != 0 {
		t.Errorf("default: %+v", p)
	}
	c, _ := encodeCursor("fp", 40)
	if p, err := ParsePage(nil, &c, "fp"); err != nil || p.Offset != 40 {
		t.Errorf("cursor: %+v %v", p, err)
	}
	for _, bad := range []string{"%%%", "e30", "WzEsMl0", c + "x"} {
		if _, err := ParsePage(nil, cur(bad), "fp"); err == nil {
			t.Errorf("cursor %q accepted", bad)
		}
	}
	if _, err := ParsePage(nil, &c, "other"); err == nil {
		t.Error("cursor of another screen accepted")
	}
	huge, _ := encodeCursor("fp", MaxOffset+1)
	if _, err := ParsePage(nil, &huge, "fp"); err == nil {
		t.Error("offset above cap accepted")
	}
	neg, _ := encodeCursor("fp", -1)
	if _, err := ParsePage(nil, &neg, "fp"); err == nil {
		t.Error("negative offset accepted")
	}
}

// skeleton replaces every user value of a validated spec with neutral ones.
func skeleton(s Spec) Spec {
	out := s
	out.Filters = make([]Filter, len(s.Filters))
	for i, f := range s.Filters {
		g := Filter{Metric: f.Metric, Op: f.Op}
		for range f.num {
			g.num = append(g.num, 1)
		}
		for range f.txt {
			g.txt = append(g.txt, "x")
		}
		out.Filters[i] = g
	}
	if s.Universe.Index != "" {
		out.Universe.Index = "X"
	}
	return out
}

// SEC-04: the SQL text depends only on whitelisted keys, fixed operators and structure; user values are
// bind parameters, so replacing every value must not change the SQL.
func checkSQLHasNoUserValues(t *testing.T, s *Spec) {
	t.Helper()
	q1, a1 := buildQuery(s, Page{Limit: 7, Offset: 3})
	sk := skeleton(*s)
	q2, _ := buildQuery(&sk, Page{Limit: 99, Offset: 0})
	if q1 != q2 {
		t.Fatalf("SQL depends on user values:\n%s\n%s", q1, q2)
	}
	if n := strings.Count(q1, "$"); n != len(a1) {
		t.Fatalf("placeholders %d != args %d", n, len(a1))
	}
	if strings.ContainsAny(q1, "\x00") {
		t.Fatal("NUL in SQL")
	}
	e1, ea1, _ := buildExcluded(s)
	e2, _, _ := buildExcluded(&sk)
	if e1 != e2 || strings.Count(e1, "$") != len(ea1) {
		t.Fatalf("excluded SQL depends on values: %s", e1)
	}
}

func TestSQLBuilderParameterised(t *testing.T) {
	s := &Spec{
		Filters: []Filter{
			{Metric: "roe", Op: ">", Value: raw("15")},
			{Metric: "market_cap_cr", Op: "between", Value: raw("[5000,100000]")},
			{Metric: "sector", Op: "in", Value: raw(`["IT","x'; DROP TABLE instrument;--"]`)},
			{Metric: "industry", Op: "=", Value: raw(`"a' OR '1'='1"`)},
		},
		Sort:     &Sort{Metric: "roe", Dir: "desc"},
		Universe: Universe{Index: "NIFTY 500'; DROP", Kind: "equity", CompanyType: "general"},
	}
	mustValid(t, s)
	checkSQLHasNoUserValues(t, s)
	q, args := buildQuery(s, Page{Limit: 10, Offset: 0})
	for _, bad := range []string{"DROP", "OR '1'", "NIFTY", "x'"} {
		if strings.Contains(q, bad) {
			t.Errorf("SQL contains user text %q: %s", bad, q)
		}
	}
	if !strings.Contains(q, "ORDER BY (CASE WHEN jsonb_typeof(sr.metrics->'roe')") || !strings.Contains(q, "DESC NULLS LAST, i.symbol ASC") {
		t.Errorf("ORDER BY not the whitelisted expression: %s", q)
	}
	if len(args) < 8 {
		t.Errorf("args: %v", args)
	}
}

func FuzzSpecSQL(f *testing.F) {
	seeds := []string{
		`{"filters":[{"metric":"roe","op":">","value":15}],"sort":{"metric":"roe","dir":"desc"}}`,
		`{"filters":[{"metric":"sector","op":"in","value":["IT'; DROP TABLE x;--"]}],"universe":{"index":"N' OR 1=1"}}`,
		`{"filters":[{"metric":"roe) OR (1=1","op":">","value":1}]}`,
		`{"filters":[{"metric":"pe","op":"between","value":[1,2]}],"columns":["pe","roe"]}`,
		`{"filters":[{"metric":"pe","op":"> 1; --","value":1}]}`,
		`{"sort":{"metric":"pe","dir":"asc; DROP"}}`,
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		var s Spec
		dec := json.NewDecoder(strings.NewReader(string(data)))
		dec.DisallowUnknownFields()
		if dec.Decode(&s) != nil {
			return
		}
		if s.Validate() != nil {
			return
		}
		checkSQLHasNoUserValues(t, &s)
		// Every metric that reached the builder is whitelisted.
		for _, k := range s.RequestedKeys() {
			if _, ok := Lookup(k); !ok {
				t.Fatalf("non-whitelisted key %q reached the builder", k)
			}
		}
	})
}

func TestPresetsValid(t *testing.T) {
	ps := Presets()
	if len(ps) != 4 {
		t.Fatalf("presets: %d", len(ps))
	}
	want := map[string]int{"Quality": 4, "Value": 3, "Growth": 2, "Momentum": 2}
	for _, p := range ps {
		if len(p.Spec.Filters) != want[p.Name] {
			t.Errorf("%s: %d filters", p.Name, len(p.Spec.Filters))
		}
		checkSQLHasNoUserValues(t, &p.Spec)
	}
}

func TestSavedNamePattern(t *testing.T) {
	ok := []string{"Quality", "a", "My screen (v2)", "x.y_z-1", strings.Repeat("a", 60)}
	bad := []string{"", " lead", "-lead", strings.Repeat("a", 61), "a\x00b", "a/b", "a;b", "a'b", "a%20b", "a\nb", "名前", "a<b>", "a\\b", "_x"}
	for _, n := range ok {
		if !ValidName(n) {
			t.Errorf("%q rejected", n)
		}
	}
	for _, n := range bad {
		if ValidName(n) {
			t.Errorf("%q accepted", n)
		}
	}
}

func TestStampRules(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	ago := func(days int) *time.Time { t := now.AddDate(0, 0, -days); return &t }
	q := func(days int) *time.Time {
		t := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -days)
		return &t
	}
	cases := []struct {
		name  string
		r     rawStamp
		stale bool
		want  string
		date  string
		src   string
	}{
		{"none", rawStamp{}, true, StaleNoOwnerData, "", ""},
		{"fresh fundamentals", rawStamp{fund: ago(10)}, false, "", "2026-10-10", "fundamentals"},
		{"120 days is not stale", rawStamp{fund: ago(120)}, false, "", "2026-06-22", "fundamentals"},
		{"121 days is stale", rawStamp{fund: ago(121)}, true, StaleFundamentals, "2026-06-21", "fundamentals"},
		{"holding newest", rawStamp{fund: ago(30), hold: ago(5), holdQtr: q(40)}, false, "", "2026-10-15", "shareholding"},
		{"holding 135 days ok", rawStamp{hold: ago(1), holdQtr: q(135)}, false, "", "2026-10-19", "shareholding"},
		{"holding 136 days stale", rawStamp{hold: ago(1), holdQtr: q(136)}, true, StaleShareholding, "2026-10-19", "shareholding"},
		{"old fundamentals fresh holding", rawStamp{fund: ago(200), hold: ago(1), holdQtr: q(40)}, true, StaleFundamentals, "2026-10-19", "shareholding"},
	}
	for _, c := range cases {
		got := c.r.stamp(now)
		if got.Stale != c.stale {
			t.Errorf("%s: stale %v", c.name, got.Stale)
		}
		if c.want != "" && (got.StaleReason == nil || *got.StaleReason != c.want) {
			t.Errorf("%s: reason %v", c.name, got.StaleReason)
		}
		if c.date == "" && got.LastUpdated != nil || c.date != "" && (got.LastUpdated == nil || *got.LastUpdated != c.date) {
			t.Errorf("%s: date %v want %q", c.name, got.LastUpdated, c.date)
		}
		if c.src != "" && (got.LastUpdatedSource == nil || *got.LastUpdatedSource != c.src) {
			t.Errorf("%s: source %v", c.name, got.LastUpdatedSource)
		}
	}
	// IST day: 20:00 UTC on the 19th is already the 20th in IST.
	late := time.Date(2026, 10, 19, 20, 0, 0, 0, time.UTC)
	if s := (rawStamp{fund: &late}).stamp(now); *s.LastUpdated != "2026-10-20" {
		t.Errorf("IST date: %s", *s.LastUpdated)
	}
}

func TestPercentile(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	vals := []map[string]*float64{{"pe": f(10)}, {"pe": f(20)}, {"pe": f(20)}, {"pe": nil}, {"pe": f(30)}}
	want := []float64{0, 50, 50, -1, 100}
	// n = 4: x=10 -> 0/3; x=20 -> (1+0.5)/3 = 50; x=30 -> 3/3 = 100
	for i, w := range want {
		got := percentile(vals, i, "pe")
		if w < 0 {
			if got != nil {
				t.Errorf("%d: want nil got %v", i, *got)
			}
			continue
		}
		if got == nil || *got != w {
			t.Errorf("%d: got %v want %v", i, got, w)
		}
	}
	if percentile([]map[string]*float64{{"pe": f(1)}, {"pe": nil}}, 0, "pe") != nil {
		t.Error("a single value has no percentile")
	}
}

func TestBestDirectionTable(t *testing.T) {
	pe, _ := Lookup("pe")
	roe, _ := Lookup("roe")
	mc, _ := Lookup("market_cap_cr")
	str := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return *p
	}
	if got := str(best(pe, map[string]float64{"A": 20, "B": 12, "C": -5})); got != "B" {
		t.Errorf("lowest positive P/E: %s", got)
	}
	if got := str(best(pe, map[string]float64{"A": 20, "B": -5})); got != "<nil>" {
		t.Errorf("one usable value must not win: %s", got)
	}
	if got := str(best(roe, map[string]float64{"A": 20, "B": 12})); got != "A" {
		t.Errorf("highest ROE: %s", got)
	}
	if got := str(best(roe, map[string]float64{"A": 12, "B": 12, "C": 3})); got != "<nil>" {
		t.Errorf("tie: %s", got)
	}
	if mc.Dir != DirNone {
		t.Error("market cap must not declare a winner")
	}
}

func TestParseCompare(t *testing.T) {
	q := func(s string) url.Values { v, _ := url.ParseQuery(s); return v }
	p, err := ParseCompare(q("symbols=tcs,infy,TCS,M%26M"))
	if err != nil || !reflect.DeepEqual(p.Symbols, []string{"TCS", "INFY", "M&M"}) || p.Range != "1Y" || len(p.Metrics) == 0 {
		t.Errorf("valid: %+v %v", p, err)
	}
	bad := []string{"", "symbols=A", "symbols=A,A", "symbols=A,B,C,D,E,F", "symbols=A,B%3BDROP", "symbols=A,B%00", "symbols=A,B&range=2Y",
		"symbols=A,B&range=1y", "symbols=A,B&metrics=pe,evil", "symbols=A,B&metrics=pe%3Bx", "symbols=" + strings.Repeat("A", 21) + ",B", "symbols=A,,"}
	for _, b := range bad {
		if _, err := ParseCompare(q(b)); err == nil {
			t.Errorf("%q accepted", b)
		}
	}
	p, err = ParseCompare(q("symbols=A,B&metrics=pe,pe,roe&range=MAX"))
	if err != nil || !reflect.DeepEqual(p.Metrics, []string{"pe", "roe"}) || p.Range != "MAX" {
		t.Errorf("metrics: %+v %v", p, err)
	}
}

func TestParsePeers(t *testing.T) {
	q := func(s string) url.Values { v, _ := url.ParseQuery(s); return v }
	p, err := ParsePeers(q("add=tcs,infy&remove=wipro"))
	if err != nil || p.Limit != 8 || !reflect.DeepEqual(p.Add, []string{"TCS", "INFY"}) || !reflect.DeepEqual(p.Remove, []string{"WIPRO"}) {
		t.Errorf("valid: %+v %v", p, err)
	}
	if p, _ := ParsePeers(q("limit=999")); p.Limit != 200 {
		t.Errorf("clamp: %d", p.Limit)
	}
	for _, b := range []string{"limit=0", "limit=x", "limit=1.5", "add=A%3BB", "add=A%00", "remove=a'b", "add=A&remove=a",
		"add=" + strings.Repeat("A,", 11) + "B"} {
		if _, err := ParsePeers(q(b)); err == nil {
			t.Errorf("%q accepted", b)
		}
	}
}

func TestRebaseCommonDates(t *testing.T) {
	d := func(day int) time.Time { return time.Date(2026, 1, day, 0, 0, 0, 0, time.UTC) }
	a, b, c := instRef{ID: 1, Symbol: "A"}, instRef{ID: 2, Symbol: "B"}, instRef{ID: 3, Symbol: "C"}
	bars := map[int32][]bar{
		1: {{d(1), 10}, {d(2), 11}, {d(3), 12}},
		2: {{d(2), 50}, {d(3), 55}, {d(4), 60}},
	}
	r := rebase([]instRef{a, b, c}, []instRef{a, b}, bars)
	if r.Reason != nil || *r.BaseDate != "2026-01-02" || !reflect.DeepEqual(r.Dates, []string{"2026-01-02", "2026-01-03"}) {
		t.Fatalf("%+v", r)
	}
	if !reflect.DeepEqual(r.Series["A"], []float64{100, 109.0909}) || !reflect.DeepEqual(r.Series["B"], []float64{100, 110}) {
		t.Errorf("series: %v", r.Series)
	}
	if v, ok := r.Series["C"]; !ok || v != nil {
		t.Errorf("a stock without prices keeps a null series: %v %v", v, ok)
	}
	bars[2] = []bar{{d(8), 1}}
	if r := rebase([]instRef{a, b}, []instRef{a, b}, bars); r.Reason == nil || *r.Reason != "no_common_dates" {
		t.Errorf("no common dates: %+v", r)
	}
	if r := rebase([]instRef{a, b}, []instRef{a}, bars); r.Reason == nil || *r.Reason != "fewer_than_two_stocks_with_prices" {
		t.Errorf("single: %+v", r)
	}
}

func TestMetricValueAndCoverage(t *testing.T) {
	m := map[string]any{"roe": 12.5, "pe": "oops", "sector": "IT", "industry": "", "zzz": 1.0}
	if v, ok := metricValue("roe", m); !ok || v.(float64) != 12.5 {
		t.Error("roe")
	}
	for _, k := range []string{"pe", "industry", "pb", "zzz"} {
		if _, ok := metricValue(k, m); ok {
			t.Errorf("%s must read as missing", k)
		}
	}
	if c := coverage(m); c != float64(2*10000/len(whitelist))/10000 {
		t.Errorf("coverage %v", c)
	}
	if coverage(map[string]any{}) != 0 {
		t.Error("empty coverage must be 0 fraction, with values null elsewhere")
	}
}

// B13R-4: the coverage denominator quoted in docs/03 is the real whitelist size.
func TestDocsQuoteWhitelistSize(t *testing.T) {
	doc := readRepo(t, "docs/03-api-spec.md")
	if want := fmt.Sprintf("the %d whitelisted metrics", len(Keys())); !strings.Contains(doc, want) {
		t.Errorf("docs/03 must say %q", want)
	}
}
