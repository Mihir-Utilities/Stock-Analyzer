package migrations_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/testdb"
)

const ddlPath = "../../../../docs/02-database.sql"

var (
	reTable      = regexp.MustCompile(`(?im)^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(\w+)`)
	reIndex      = regexp.MustCompile(`(?im)^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)`)
	reConstraint = regexp.MustCompile(`(?im)\bCONSTRAINT\s+(\w+)`)
)

// ddlObjects extracts the object names from docs/02-database.sql, the schema's source of truth.
func ddlObjects(t *testing.T) (tables, indexes, constraints []string) {
	t.Helper()
	raw, err := os.ReadFile(ddlPath)
	if err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	for _, line := range strings.Split(string(raw), "\n") { // strip comments so words in them are ignored
		if i := strings.Index(line, "--"); i >= 0 {
			line = line[:i]
		}
		sb.WriteString(line + "\n")
	}
	src := sb.String()
	for _, m := range reTable.FindAllStringSubmatch(src, -1) {
		tables = append(tables, m[1])
	}
	for _, m := range reIndex.FindAllStringSubmatch(src, -1) {
		indexes = append(indexes, m[1])
	}
	for _, m := range reConstraint.FindAllStringSubmatch(src, -1) {
		constraints = append(constraints, m[1])
	}
	if len(tables) < 30 || len(indexes) < 20 || len(constraints) < 5 {
		t.Fatalf("DDL parse looks wrong: %d tables, %d indexes, %d constraints", len(tables), len(indexes), len(constraints))
	}
	return tables, indexes, constraints
}

func names(t *testing.T, db *sql.DB, query string) map[string]bool {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		out[n] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func appTables(t *testing.T, db *sql.DB) map[string]bool {
	return names(t, db, `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'goose_db_version'`)
}

func verifySchema(t *testing.T, db *sql.DB) {
	t.Helper()
	tables, indexes, constraints := ddlObjects(t)
	have := appTables(t, db)
	for _, n := range tables {
		if !have[n] {
			t.Errorf("table %s missing", n)
		}
	}
	if len(have) != len(tables) {
		t.Errorf("database has %d tables, DDL declares %d", len(have), len(tables))
	}
	haveIdx := names(t, db, `SELECT indexname FROM pg_indexes WHERE schemaname='public'`)
	for _, n := range indexes {
		if !haveIdx[n] {
			t.Errorf("index %s missing", n)
		}
	}
	haveCon := names(t, db, `SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`)
	for _, n := range constraints {
		if !haveCon[n] {
			t.Errorf("constraint %s missing", n)
		}
	}
	// The three import_batch foreign keys (added in the last migration).
	for _, n := range []string{"fundamental_value_batch_fk", "shareholding_batch_fk", "corporate_action_batch_fk"} {
		if !haveCon[n] {
			t.Errorf("foreign key %s missing", n)
		}
	}
	// import_upload is UNLOGGED (relpersistence 'u'), everything else permanent.
	unlogged := names(t, db, `SELECT relname FROM pg_class WHERE relkind='r' AND relpersistence='u' AND relnamespace='public'::regnamespace`)
	if len(unlogged) != 1 || !unlogged["import_upload"] {
		t.Errorf("unlogged tables = %v, want only import_upload", unlogged)
	}
}

// TestMigrateUpDownUp covers: goose up, down to zero, up again; all DDL objects exist; pg_trgm.
func TestMigrateUpDownUp(t *testing.T) {
	dsn := testdb.New(t)
	db := testdb.OpenSQL(t, dsn)
	dir := testdb.MigrationsDir()

	if err := testdb.Migrate(db, dir); err != nil {
		t.Fatalf("up: %v", err)
	}
	verifySchema(t, db)

	var ext string
	if err := db.QueryRow(`SELECT extname FROM pg_extension WHERE extname='pg_trgm'`).Scan(&ext); err != nil {
		t.Fatalf("pg_trgm extension missing: %v", err)
	}
	var sim float64
	if err := db.QueryRow(`SELECT similarity('RELIANCE','RELIANCE IND')`).Scan(&sim); err != nil || sim <= 0 {
		t.Fatalf("pg_trgm not usable: %v (similarity %v)", err, sim)
	}

	if err := testdb.MigrateDown(db, dir); err != nil {
		t.Fatalf("down: %v", err)
	}
	if left := appTables(t, db); len(left) != 0 {
		t.Fatalf("tables left after down: %v", left)
	}
	if err := db.QueryRow(`SELECT extname FROM pg_extension WHERE extname='pg_trgm'`).Scan(&ext); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("pg_trgm should be dropped by the first down migration, got %v", err)
	}

	if err := testdb.Migrate(db, dir); err != nil {
		t.Fatalf("second up: %v", err)
	}
	verifySchema(t, db)
}

// TestMigrationFiles checks naming, contiguity and Up/Down sections (forward-only discipline).
func TestMigrationFiles(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(testdb.MigrationsDir(), "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations found: %v", err)
	}
	sort.Strings(files)
	re := regexp.MustCompile(`^(\d{4})_[a-z0-9_]+\.sql$`)
	for i, f := range files {
		base := filepath.Base(f)
		m := re.FindStringSubmatch(base)
		if m == nil {
			t.Errorf("%s: name must be NNNN_snake_case.sql", base)
			continue
		}
		if want := i + 1; m[1] != pad4(want) {
			t.Errorf("%s: expected number %s (contiguous numbering)", base, pad4(want))
		}
		raw, _ := os.ReadFile(f) //nolint:gosec // repo file
		s := string(raw)
		if !strings.Contains(s, "-- +goose Up") || !strings.Contains(s, "-- +goose Down") {
			t.Errorf("%s: needs goose Up and Down sections", base)
		}
		if strings.Contains(strings.ToLower(s), "if not exists") && !strings.Contains(base, "extensions") {
			t.Errorf("%s: migrations must be strict (no IF NOT EXISTS) outside the extension step", base)
		}
	}
}

func pad4(n int) string { return fmt.Sprintf("%04d", n) }

// TestSYS07FailedMigrationRollsBack: a migration that fails half-way leaves nothing behind (SYS-07).
func TestSYS07FailedMigrationRollsBack(t *testing.T) {
	dsn := testdb.New(t)
	db := testdb.OpenSQL(t, dsn)

	tmp := t.TempDir()
	src, _ := filepath.Glob(filepath.Join(testdb.MigrationsDir(), "*.sql"))
	for _, f := range src {
		raw, err := os.ReadFile(f) //nolint:gosec // repo file
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(tmp, filepath.Base(f)), raw, 0o600); err != nil { //nolint:gosec // temp dir
			t.Fatal(err)
		}
	}
	bad := "-- +goose Up\nCREATE TABLE sys07_partial (id int);\nINSERT INTO sys07_no_such_table VALUES (1);\n-- +goose Down\nDROP TABLE sys07_partial;\n"
	if err := os.WriteFile(filepath.Join(tmp, "0012_sys07_bad.sql"), []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := testdb.Migrate(db, tmp); err == nil {
		t.Fatal("expected the broken migration to fail")
	}
	if appTables(t, db)["sys07_partial"] {
		t.Fatal("partial migration left sys07_partial behind: migrations must be transactional")
	}
	var version int
	if err := db.QueryRow(`SELECT max(version_id) FROM goose_db_version WHERE is_applied`).Scan(&version); err != nil || version != 11 {
		t.Fatalf("schema version = %d (%v), want 11 (the failed one is not recorded)", version, err)
	}
	verifySchema(t, db) // earlier migrations stay intact
}

// TestAPI05EmptyDatabase: freshly migrated, nothing seeded: queries return empty, never an error (API-05).
func TestAPI05EmptyDatabase(t *testing.T) {
	dsn := testdb.New(t)
	db := testdb.OpenSQL(t, dsn)
	if err := testdb.Migrate(db, testdb.MigrationsDir()); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	q := dbq.New(conn)

	for table := range appTables(t, db) {
		var n int
		if err := db.QueryRow("SELECT count(*) FROM " + pgx.Identifier{table}.Sanitize()).Scan(&n); err != nil || n != 0 {
			t.Errorf("table %s: count %d, err %v (want empty)", table, n, err)
		}
	}
	if s, err := q.ListSettings(ctx); err != nil || len(s) != 0 {
		t.Errorf("ListSettings = %v, %v; want empty and no error", s, err)
	}
	if h, err := q.ListHolidays(ctx); err != nil || len(h) != 0 {
		t.Errorf("ListHolidays = %v, %v; want empty and no error", h, err)
	}
	if _, err := q.GetAppUser(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("GetAppUser on empty DB = %v, want pgx.ErrNoRows (callers map it to an empty/unavailable state)", err)
	}
	if _, err := q.GetSetting(ctx, "PRICES_ALREADY_ADJUSTED"); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("GetSetting(unset) = %v, want pgx.ErrNoRows", err)
	}
}

type constraintCase struct {
	name string
	sql  string
	want string // SQLSTATE; "" means the statement must succeed
}

const (
	checkViolation = "23514"
	uniqueViolat   = "23505"
	fkViolation    = "23503"
	notNullViolat  = "23502"
)

const instrumentSub = `(SELECT id FROM instrument WHERE symbol = 'TEST')`

// TestConstraintsRejectBadRows: at least one invalid row per table family, plus positive controls.
func TestConstraintsRejectBadRows(t *testing.T) {
	dsn := testdb.New(t)
	db := testdb.OpenSQL(t, dsn)
	if err := testdb.Migrate(db, testdb.MigrationsDir()); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()

	setup := []string{
		`INSERT INTO instrument (symbol, name) VALUES ('TEST', 'Test Ltd')`,
		`INSERT INTO mf_scheme (code, name) VALUES (100001, 'Test Fund')`,
		`INSERT INTO alert (target_type, instrument_id, kind, params) VALUES ('stock', ` + instrumentSub + `, 'price_above', '{"threshold":1}')`,
	}
	for _, s := range setup {
		if _, err := conn.Exec(ctx, s); err != nil {
			t.Fatalf("setup %q: %v", s, err)
		}
	}

	cases := []constraintCase{
		// settings / holidays
		{"holiday segment invalid", `INSERT INTO market_holiday (holiday_date, segment) VALUES ('2027-01-26', 'bogus')`, checkViolation},
		{"holiday source auto-detected rejected", `INSERT INTO market_holiday (holiday_date, source) VALUES ('2027-01-26', 'detected')`, checkViolation},
		{"holiday source import ok", `INSERT INTO market_holiday (holiday_date, source) VALUES ('2027-01-26', 'import')`, ""},
		{"holiday duplicate", `INSERT INTO market_holiday (holiday_date, source) VALUES ('2027-01-26', 'import')`, uniqueViolat},
		{"setting value null", `INSERT INTO app_setting (key, value) VALUES ('K', NULL)`, notNullViolat},
		// ops
		{"ingestion_run status invalid", `INSERT INTO ingestion_run (job, status) VALUES ('j', 'weird')`, checkViolation},
		{"ingestion_run running ok", `INSERT INTO ingestion_run (job, status) VALUES ('j', 'running')`, ""},
		{"ingestion_run second running for job", `INSERT INTO ingestion_run (job, status) VALUES ('j', 'running')`, uniqueViolat},
		{"refresh_job kind invalid", `INSERT INTO refresh_job (kind, target) VALUES ('mf_backfill', 'x')`, checkViolation},
		{"refresh_job kind not in list", `INSERT INTO refresh_job (kind, target) VALUES ('instrument_sync', 'x')`, checkViolation},
		{"refresh_job post_import ok", `INSERT INTO refresh_job (kind, target) VALUES ('post_import', 'batch:1')`, ""},
		{"refresh_job duplicate active", `INSERT INTO refresh_job (kind, target) VALUES ('post_import', 'batch:1')`, uniqueViolat},
		{"broker_session status invalid", `INSERT INTO broker_session (broker, token_enc, expires_at, status) VALUES ('b', '\x00', now(), 'zombie')`, checkViolation},
		// import
		{"import_batch kind invalid", `INSERT INTO import_batch (kind) VALUES ('nse_bhavcopy')`, checkViolation},
		{"import_batch kind instruments ok", `INSERT INTO import_batch (kind, upload_group) VALUES ('instruments', gen_random_uuid())`, ""},
		{"import_batch kind holidays ok", `INSERT INTO import_batch (kind) VALUES ('holidays')`, ""},
		{"import_upload accepts rows", `INSERT INTO import_upload (id, kind, content, expires_at) VALUES (gen_random_uuid(), 'prices', '\x00', now() + interval '1 hour')`, ""},
		// reference
		{"instrument company_type invalid", `INSERT INTO instrument (symbol, name, company_type) VALUES ('A1', 'A', 'bank')`, checkViolation},
		{"instrument tracked_reason training_basket removed", `INSERT INTO instrument (symbol, name, tracked_reason) VALUES ('A2', 'A', 'training_basket')`, checkViolation},
		{"instrument tracked_reason imported ok", `INSERT INTO instrument (symbol, name, tracked_reason, is_tracked) VALUES ('A3', 'A', 'imported', true)`, ""},
		{"instrument status invalid", `INSERT INTO instrument (symbol, name, status) VALUES ('A4', 'A', 'gone')`, checkViolation},
		{"instrument symbol duplicate", `INSERT INTO instrument (symbol, name) VALUES ('TEST', 'Dup')`, uniqueViolat},
		{"symbol_alias unknown instrument", `INSERT INTO symbol_alias (instrument_id, old_symbol) VALUES (999999, 'OLD')`, fkViolation},
		// market data
		{"price non-positive close", `INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source) VALUES (` + instrumentSub + `, '2026-10-01', 10, 11, 9, 0, 10, 'import')`, checkViolation},
		{"price high below low", `INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source) VALUES (` + instrumentSub + `, '2026-10-01', 10, 8, 9, 10, 10, 'import')`, checkViolation},
		{"price forbidden source", `INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source) VALUES (` + instrumentSub + `, '2026-10-01', 10, 11, 9, 10, 10, 'yahoo')`, checkViolation},
		{"price unknown instrument", `INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source) VALUES (999999, '2026-10-01', 10, 11, 9, 10, 10, 'import')`, fkViolation},
		{"price valid with src_adjusted default", `INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source) VALUES (` + instrumentSub + `, '2026-10-01', 10, 11, 9, 10, 10, 'import')`, ""},
		{"price duplicate key", `INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source) VALUES (` + instrumentSub + `, '2026-10-01', 10, 11, 9, 10, 10, 'import')`, uniqueViolat},
		// owner data
		{"fundamental basis invalid", `INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, source) VALUES (` + instrumentSub + `, 'group', 'Q', '2026-09-30', 'pnl.revenue', 'manual')`, checkViolation},
		{"fundamental unit invalid", `INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, source, unit) VALUES (` + instrumentSub + `, 'standalone', 'Q', '2026-09-30', 'pnl.revenue', 'manual', 'USD')`, checkViolation},
		{"fundamental forbidden source", `INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, source) VALUES (` + instrumentSub + `, 'standalone', 'Q', '2026-09-30', 'pnl.revenue', 'scraper')`, checkViolation},
		{"fundamental batch fk", `INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, source, import_batch_id) VALUES (` + instrumentSub + `, 'standalone', 'Q', '2026-09-30', 'pnl.revenue', 'manual', 999999)`, fkViolation},
		{"corporate_action type invalid", `INSERT INTO corporate_action (instrument_id, ex_date, action_type, source) VALUES (` + instrumentSub + `, '2026-09-01', 'spinoff', 'manual')`, checkViolation},
		{"corporate_action valid", `INSERT INTO corporate_action (instrument_id, ex_date, action_type, source) VALUES (` + instrumentSub + `, '2026-09-01', 'split', 'manual')`, ""},
		{"corporate_action duplicate (ACT-09)", `INSERT INTO corporate_action (instrument_id, ex_date, action_type, source) VALUES (` + instrumentSub + `, '2026-09-01', 'split', 'manual')`, uniqueViolat},
		{"event_calendar type invalid", `INSERT INTO event_calendar (instrument_id, event_date, event_type) VALUES (` + instrumentSub + `, '2026-11-01', 'ipo')`, checkViolation},
		{"shareholding source invalid", `INSERT INTO shareholding (instrument_id, quarter_end, source) VALUES (` + instrumentSub + `, '2026-09-30', 'derived')`, checkViolation},
		{"flag_dismissals valid", `INSERT INTO flag_dismissals (instrument_id, flag_type, trade_date) VALUES (` + instrumentSub + `, 'large_one_day_drop', '2026-09-01')`, ""},
		{"flag_dismissals duplicate key (D-U)", `INSERT INTO flag_dismissals (instrument_id, flag_type, trade_date) VALUES (` + instrumentSub + `, 'large_one_day_drop', '2026-09-01')`, uniqueViolat},
		{"flag_dismissals other date ok", `INSERT INTO flag_dismissals (instrument_id, flag_type, trade_date) VALUES (` + instrumentSub + `, 'large_one_day_drop', '2026-09-02')`, ""},
		{"flag_dismissals unknown instrument", `INSERT INTO flag_dismissals (instrument_id, flag_type, trade_date) VALUES (999999, 'large_one_day_drop', '2026-09-01')`, fkViolation},
		// analysis / ML
		{"model_run status invalid", `INSERT INTO model_run (model_name, train_start, train_end, n_rows, valid_metrics, baseline_metrics, guardrail_pass, status) VALUES ('dir_5d', '2021-01-01', '2026-01-01', 1, '{}', '{}', false, 'live')`, checkViolation},
		{"model_run valid", `INSERT INTO model_run (model_name, train_start, train_end, n_rows, valid_metrics, baseline_metrics, guardrail_pass) VALUES ('dir_5d', '2021-01-01', '2026-01-01', 1, '{}', '{}', false)`, ""},
		{"prediction horizon invalid", `INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, ref_close) VALUES (` + instrumentSub + `, '2026-10-01', 7, (SELECT id FROM model_run LIMIT 1), 10)`, checkViolation},
		{"prediction valid", `INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, ref_close) VALUES (` + instrumentSub + `, '2026-10-01', 5, (SELECT id FROM model_run LIMIT 1), 10)`, ""},
		// mutual funds
		{"mf_scheme plan invalid", `INSERT INTO mf_scheme (code, name, plan) VALUES (100002, 'F', 'wholesale')`, checkViolation},
		{"mf_nav non-positive", `INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES (100001, '2026-10-01', 0)`, checkViolation},
		{"mf_nav unknown scheme", `INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES (999999, '2026-10-01', 10)`, fkViolation},
		{"mf_nav valid", `INSERT INTO mf_nav (scheme_code, nav_date, nav) VALUES (100001, '2026-10-01', 10.5)`, ""},
		// user features
		{"app_user only id 1", `INSERT INTO app_user (id, password_hash) VALUES (2, 'x')`, checkViolation},
		{"app_user valid", `INSERT INTO app_user (password_hash) VALUES ('$argon2id$test')`, ""},
		{"app_user second row", `INSERT INTO app_user (password_hash) VALUES ('y')`, uniqueViolat},
		{"watchlist neither target", `INSERT INTO watchlist_item (note) VALUES ('n')`, checkViolation},
		{"watchlist both targets", `INSERT INTO watchlist_item (instrument_id, mf_scheme_code) VALUES (` + instrumentSub + `, 100001)`, checkViolation},
		{"watchlist stock ok", `INSERT INTO watchlist_item (instrument_id) VALUES (` + instrumentSub + `)`, ""},
		{"watchlist stock duplicate", `INSERT INTO watchlist_item (instrument_id) VALUES (` + instrumentSub + `)`, uniqueViolat},
		{"portfolio qty zero", `INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) VALUES (` + instrumentSub + `, 'buy', 0, 10, '2026-10-01')`, checkViolation},
		{"portfolio side invalid", `INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) VALUES (` + instrumentSub + `, 'short', 1, 10, '2026-10-01')`, checkViolation},
		{"portfolio negative fees", `INSERT INTO portfolio_txn (instrument_id, side, qty, price, fees, trade_date) VALUES (` + instrumentSub + `, 'buy', 1, 10, -1, '2026-10-01')`, checkViolation},
		{"portfolio valid decimal", `INSERT INTO portfolio_txn (instrument_id, side, qty, price, trade_date) VALUES (` + instrumentSub + `, 'buy', 1.5, 10.1234, '2026-10-01')`, ""},
		{"portfolio_adjustment multiplier zero", `INSERT INTO portfolio_adjustment (instrument_id, effective_date, qty_multiplier) VALUES (` + instrumentSub + `, '2026-10-01', 0)`, checkViolation},
		{"alert kind invalid", `INSERT INTO alert (target_type, instrument_id, kind, params) VALUES ('stock', ` + instrumentSub + `, 'sell_now', '{}')`, checkViolation},
		{"alert stock target needs instrument", `INSERT INTO alert (target_type, mf_scheme_code, kind, params) VALUES ('stock', 100001, 'price_above', '{}')`, checkViolation},
		{"alert mf target with instrument", `INSERT INTO alert (target_type, instrument_id, kind, params) VALUES ('mf', ` + instrumentSub + `, 'nav_above', '{}')`, checkViolation},
		{"alert negative cooldown", `INSERT INTO alert (target_type, instrument_id, kind, params, cooldown_minutes) VALUES ('stock', ` + instrumentSub + `, 'price_above', '{}', -1)`, checkViolation},
		{"alert_event valid", `INSERT INTO alert_event (alert_id, dedupe_key, payload) VALUES ((SELECT id FROM alert LIMIT 1), 'k1', '{}')`, ""},
		{"alert_event duplicate dedupe_key", `INSERT INTO alert_event (alert_id, dedupe_key, payload) VALUES ((SELECT id FROM alert LIMIT 1), 'k1', '{}')`, uniqueViolat},
		{"alert_event status invalid", `INSERT INTO alert_event (alert_id, dedupe_key, payload, delivery_status) VALUES ((SELECT id FROM alert LIMIT 1), 'k2', '{}', 'maybe')`, checkViolation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := conn.Exec(ctx, tc.sql)
			var pgErr *pgconn.PgError
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("expected success, got %v", err)
			case tc.want != "" && err == nil:
				t.Fatalf("expected SQLSTATE %s, statement succeeded", tc.want)
			case tc.want != "" && (!errors.As(err, &pgErr) || pgErr.Code != tc.want):
				t.Fatalf("expected SQLSTATE %s, got %v", tc.want, err)
			}
		})
	}

	// price_daily.src_adjusted defaults to false (amendment).
	var adj bool
	if err := conn.QueryRow(ctx, `SELECT src_adjusted FROM price_daily LIMIT 1`).Scan(&adj); err != nil || adj {
		t.Errorf("src_adjusted default = %v, %v; want false", adj, err)
	}
}
