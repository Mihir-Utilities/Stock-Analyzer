package screener

import (
	"fmt"
	"strings"
)

// argList collects bind parameters and hands out their `$n` placeholders.
type argList struct{ args []any }

func (a *argList) add(v any) string {
	a.args = append(a.args, v)
	return fmt.Sprintf("$%d", len(a.args))
}

// universeWhere returns the universe predicates. Only placeholders and fixed text are interpolated.
func universeWhere(u Universe, a *argList) []string {
	w := []string{"i.instrument_kind = " + a.add(u.Kind), "i.status = 'active'"}
	if u.CompanyType != "" {
		w = append(w, "i.company_type = "+a.add(u.CompanyType))
	}
	if u.Index != "" {
		// Index names compare without spaces and case (docs/03 section 3).
		norm := strings.ToUpper(strings.ReplaceAll(u.Index, " ", ""))
		w = append(w, "EXISTS (SELECT 1 FROM index_constituent ic WHERE ic.instrument_id = i.id AND replace(upper(ic.index_name), ' ', '') = "+a.add(norm)+")")
	}
	return w
}

// filterWhere turns one validated filter into a predicate. A missing metric makes the expression
// NULL, so the stock never matches (and is counted in excluded_for_missing).
func filterWhere(f Filter, a *argList) string {
	m := byKey[f.Metric] // validated: present
	if m.Kind == Text {
		if f.Op == "in" {
			return "lower(" + m.expr + ") = ANY(" + a.add(lowerAll(f.txt)) + "::text[])"
		}
		return "lower(" + m.expr + ") = " + a.add(strings.ToLower(f.txt[0]))
	}
	if f.Op == "between" {
		return m.expr + " BETWEEN " + a.add(f.num[0]) + "::float8 AND " + a.add(f.num[1]) + "::float8"
	}
	return m.expr + " " + numericOps[f.Op] + " " + a.add(f.num[0]) + "::float8"
}

func lowerAll(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = strings.ToLower(s)
	}
	return out
}

// RequestedKeys lists the metrics shown per result: filter metrics, then the sort metric, then the
// explicit columns, each once.
func (s *Spec) RequestedKeys() []string {
	seen := map[string]bool{}
	var out []string
	add := func(k string) {
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	for _, f := range s.Filters {
		add(f.Metric)
	}
	if s.Sort != nil {
		add(s.Sort.Metric)
	}
	for _, c := range s.Columns {
		add(c)
	}
	return out
}

// buildQuery returns the page query. The ORDER BY uses a whitelisted expression and a fixed
// direction literal; limit and offset are bind parameters.
func buildQuery(s *Spec, p Page) (string, []any) {
	var a argList
	where := universeWhere(s.Universe, &a)
	for _, f := range s.Filters {
		where = append(where, filterWhere(f, &a))
	}
	order := "i.symbol ASC"
	if s.Sort != nil {
		dir := "ASC"
		if s.Sort.Dir == "desc" {
			dir = "DESC"
		}
		order = byKey[s.Sort.Metric].expr + " " + dir + " NULLS LAST, i.symbol ASC"
	}
	q := "SELECT i.id, i.symbol, i.name, sr.as_of, sr.metrics, count(*) OVER () AS total " +
		"FROM screener_row sr JOIN instrument i ON i.id = sr.instrument_id " +
		"WHERE " + strings.Join(where, " AND ") +
		" ORDER BY " + order +
		" LIMIT " + a.add(p.Limit) + " OFFSET " + a.add(p.Offset)
	return q, a.args
}

// buildExcluded counts, per filter metric, the universe stocks that lack the metric.
func buildExcluded(s *Spec) (string, []any, []string) {
	var a argList
	where := universeWhere(s.Universe, &a)
	var keys []string
	seen := map[string]bool{}
	for _, f := range s.Filters {
		if !seen[f.Metric] {
			seen[f.Metric] = true
			keys = append(keys, f.Metric)
		}
	}
	if len(keys) == 0 {
		return "", nil, nil
	}
	cols := make([]string, len(keys))
	for i, k := range keys {
		cols[i] = "count(*) FILTER (WHERE " + byKey[k].expr + " IS NULL)"
	}
	q := "SELECT " + strings.Join(cols, ", ") +
		" FROM screener_row sr JOIN instrument i ON i.id = sr.instrument_id WHERE " + strings.Join(where, " AND ")
	return q, a.args, keys
}
