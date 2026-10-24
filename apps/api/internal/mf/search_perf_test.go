package mf

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/india-analyzer/api/internal/pagination"
	"github.com/india-analyzer/api/internal/testdb"
)

// seedTenThousand inserts 10,000 schemes with realistic, long, repetitive names (S10).
func seedTenThousand(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
INSERT INTO mf_scheme (code, name, fund_house, category, plan, option_type, status)
SELECT 100000 + g,
       (ARRAY['HDFC','ICICI Prudential','SBI','Nippon India','Kotak','Axis','Aditya Birla Sun Life','UTI','DSP','Franklin India'])[1 + g % 10]
         || ' ' || (ARRAY['Flexi Cap','Large Cap','Mid Cap','Small Cap','Liquid','Short Term','Corporate Bond','Balanced Advantage','Index Nifty 50','ELSS Tax Saver'])[1 + (g / 10) % 10]
         || ' Fund Series ' || (g / 100)
         || (ARRAY[' - Direct Plan - Growth Option',' - Regular Plan - Growth',' - Direct Plan - IDCW',' - Regular Plan - IDCW Payout'])[1 + g % 4],
       'House ' || (g % 10), 'Category ' || (g % 10),
       (ARRAY['direct','regular'])[1 + g % 2],
       (ARRAY['growth','growth','idcw','idcw'])[1 + g % 4],
       'active'
FROM generate_series(0, 9999) g`)
	if err != nil {
		t.Fatal(err)
	}
	// A GIN index fed by many inserts keeps them in a pending list that every scan must read and
	// that the planner prices in, so it avoids the index until the list is flushed. Autovacuum
	// does that in production (docs/RUNBOOK.md, MF search); the test flushes it explicitly.
	if _, err := pool.Exec(context.Background(), `SELECT gin_clean_pending_list('mf_scheme_name_trgm')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `ANALYZE mf_scheme`); err != nil {
		t.Fatal(err)
	}
}

func timeSearch(t *testing.T, s *Service, q string) time.Duration {
	t.Helper()
	p, err := ParseSearch(map[string][]string{"q": {q}, "include_all": {"true"}})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	res, err := s.Search(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	_ = res
	return time.Since(start)
}

// MF-12 (S10): with the API pool's random_page_cost=1.1 the planner serves a word search from
// the trigram index and answers in under 300 ms over 10,000 schemes; pages are cursor-based.
func TestMF12SearchUsesTrigramIndexAndIsFast(t *testing.T) {
	dsn := testdb.New(t)
	if err := testdb.Migrate(testdb.OpenSQL(t, dsn), testdb.MigrationsDir()); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["random_page_cost"] = "1.1" // as cmd/api/main.go sets it
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedTenThousand(t, pool)
	svc := New(pool, nil)
	queries := []string{
		"hdfc flexi cap fund series 17 direct plan growth option",
		"icici prudential corporate bond fund series 42",
		"nippon india small cap fund series 99 regular plan",
		"kotak balanced advantage",
		"xyzzy nonexistent",
	}
	for _, q := range queries {
		var worst time.Duration
		for i := 0; i < 3; i++ {
			if d := timeSearch(t, svc, q); d > worst {
				worst = d
			}
		}
		t.Logf("q=%q worst of 3 = %v", q, worst)
		if worst > 300*time.Millisecond {
			t.Errorf("q=%q took %v, want < 300ms", q, worst)
		}
	}

	// The selective queries must be planned on the trigram index, not a sequential scan.
	for _, q := range queries[:3] {
		p, _ := ParseSearch(map[string][]string{"q": {q}, "include_all": {"true"}})
		sqlText, args := buildSearch(p, nil)
		rows, err := pool.Query(context.Background(), "EXPLAIN "+sqlText, args...)
		if err != nil {
			t.Fatal(err)
		}
		var plan strings.Builder
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			plan.WriteString(line + "\n")
		}
		rows.Close()
		if !strings.Contains(plan.String(), "mf_scheme_name_trgm") {
			t.Errorf("q=%q is not planned on mf_scheme_name_trgm:\n%s", q, plan.String())
		}
	}

	// Cursor pagination over a broad query: pages are disjoint and complete.
	p, _ := ParseSearch(map[string][]string{"q": {"fund"}, "include_all": {"true"}, "limit": {"200"}})
	seen := 0
	for pages := 0; pages < 100; pages++ {
		res, err := svc.Search(context.Background(), p)
		if err != nil {
			t.Fatal(err)
		}
		seen += len(res.Items.([]SchemeItem))
		if res.NextCursor == nil {
			break
		}
		p.Page = pagination.Params{Limit: 200, Cursor: *res.NextCursor}
	}
	if seen != 10000 {
		t.Fatalf("paged through %d of 10000 schemes", seen)
	}
}
