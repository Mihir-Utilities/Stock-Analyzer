package seed_test

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/india-analyzer/api/internal/passhash"
	"github.com/india-analyzer/api/internal/seed"
	"github.com/india-analyzer/api/internal/testdb"
)

func TestParseHolidays(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		wantErr string
		years   map[int]int // year -> rows
	}{
		{"empty year and comment", `{"_comment":"x","2026":[]}`, "", map[int]int{2026: 0}},
		{"valid rows", `{"2027":[{"date":"2027-01-26","description":"Republic Day"}]}`, "", map[int]int{2027: 1}},
		{"bad key", `{"26":[]}`, "four-digit year", nil},
		{"bad date", `{"2027":[{"date":"26-01-2027"}]}`, "bad date", nil},
		{"wrong year", `{"2027":[{"date":"2028-01-26"}]}`, "listed under year", nil},
		{"duplicate", `{"2027":[{"date":"2027-01-26"},{"date":"2027-01-26"}]}`, "duplicate", nil},
		{"unknown field", `{"2027":[{"date":"2027-01-26","x":1}]}`, "unknown field", nil},
		{"not json", `nope`, "market_holidays.json", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := seed.ParseHolidays([]byte(tc.in))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tc.years) {
				t.Fatalf("years = %v", got)
			}
			for y, n := range tc.years {
				if len(got[y]) != n {
					t.Errorf("year %d rows = %d, want %d", y, len(got[y]), n)
				}
			}
		})
	}
}

func TestDefaultSettingsMatchMasterPlan(t *testing.T) {
	got := map[string]string{}
	for _, s := range seed.DefaultSettings {
		got[s.Key] = s.Value
	}
	want := map[string]string{
		"PRICE_HISTORY_YEARS_TRACKED": "5", "LAZY_BACKFILL_MAX_YEARS": "20", "OPENED_STOCKS_LRU_CAP": "150",
		"BROKER_ENABLED": "false", "MFAPI_MIN_INTERVAL_SEC": "0.5", "REFRESH_COOLDOWN_MIN": "15",
		"REFRESH_GLOBAL_PER_HOUR": "30", "RISK_FREE_RATE": "0.065", "SESSION_DAYS": "30",
		"LOGIN_MAX_FAILS": "5", "DB_SOFT_LIMIT_MB": "380",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	for _, banned := range []string{"PRICES_ALREADY_ADJUSTED", "TRAINING_BASKET_MAX"} {
		if _, ok := got[banned]; ok {
			t.Errorf("%s must not be seeded", banned)
		}
	}
}

func count(t *testing.T, conn *pgx.Conn, query string) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(context.Background(), query).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func migrated(t *testing.T) *pgx.Conn {
	t.Helper()
	dsn := testdb.New(t)
	if err := testdb.Migrate(testdb.OpenSQL(t, dsn), testdb.MigrationsDir()); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func TestSeedCreatesOneUserAndDefaults(t *testing.T) {
	conn := migrated(t)
	ctx := context.Background()
	hash, err := passhash.Hash("a long test password")
	if err != nil {
		t.Fatal(err)
	}
	opt := seed.Options{PasswordHash: hash, ConfigDir: testdb.ConfigDir()}

	res, err := seed.Run(ctx, conn, opt)
	if err != nil {
		t.Fatal(err)
	}
	if !res.UserCreated || res.SettingsInserted != len(seed.DefaultSettings) {
		t.Fatalf("result = %+v", res)
	}
	if n := count(t, conn, `SELECT count(*) FROM app_user`); n != 1 {
		t.Errorf("app_user rows = %d, want exactly 1", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM app_setting`); n != len(seed.DefaultSettings) {
		t.Errorf("app_setting rows = %d", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM app_setting WHERE key = 'PRICES_ALREADY_ADJUSTED'`); n != 0 {
		t.Error("PRICES_ALREADY_ADJUSTED must stay unset")
	}
	if n := count(t, conn, `SELECT count(*) FROM instrument`); n != 0 {
		t.Errorf("instrument rows = %d, want 0 (D-2)", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM market_holiday`); n != 0 {
		t.Errorf("market_holiday rows = %d, want 0 (2026 list is empty)", n)
	}
	if len(res.YearsEmpty) != 1 || res.YearsEmpty[0] != 2026 {
		t.Errorf("YearsEmpty = %v, want [2026] so the CLI warns", res.YearsEmpty)
	}
	var broker string
	var soft string
	if err := conn.QueryRow(ctx, `SELECT value::text FROM app_setting WHERE key='BROKER_ENABLED'`).Scan(&broker); err != nil || broker != "false" {
		t.Errorf("BROKER_ENABLED = %q, %v", broker, err)
	}
	if err := conn.QueryRow(ctx, `SELECT value::text FROM app_setting WHERE key='DB_SOFT_LIMIT_MB'`).Scan(&soft); err != nil || soft != "380" {
		t.Errorf("DB_SOFT_LIMIT_MB = %q, %v", soft, err)
	}

	// Second run is a no-op and keeps owner edits and the existing hash.
	if _, err := conn.Exec(ctx, `UPDATE app_setting SET value = '0.07' WHERE key = 'RISK_FREE_RATE'`); err != nil {
		t.Fatal(err)
	}
	other, _ := passhash.Hash("a different long password")
	res2, err := seed.Run(ctx, conn, seed.Options{PasswordHash: other, ConfigDir: testdb.ConfigDir()})
	if err != nil {
		t.Fatal(err)
	}
	if res2.UserCreated || res2.SettingsInserted != 0 {
		t.Errorf("rerun result = %+v, want no changes", res2)
	}
	var stored, rfr string
	_ = conn.QueryRow(ctx, `SELECT password_hash FROM app_user`).Scan(&stored)
	_ = conn.QueryRow(ctx, `SELECT value::text FROM app_setting WHERE key='RISK_FREE_RATE'`).Scan(&rfr)
	if stored != hash || rfr != "0.07" {
		t.Errorf("rerun overwrote data: hash changed=%v, RISK_FREE_RATE=%s", stored != hash, rfr)
	}
}

func TestSeedRejectsNonArgon2idHash(t *testing.T) {
	conn := migrated(t)
	for _, bad := range []string{"", "hunter2hunter2", "$2a$10$abcdefghijklmnopqrstuv"} {
		if _, err := seed.Run(context.Background(), conn, seed.Options{PasswordHash: bad, ConfigDir: testdb.ConfigDir()}); err == nil {
			t.Errorf("hash %q accepted", bad)
		}
	}
	if n := count(t, conn, `SELECT count(*) FROM app_user`) + count(t, conn, `SELECT count(*) FROM app_setting`); n != 0 {
		t.Errorf("rows written despite rejection: %d", n)
	}
}

func TestSeedHolidaysOnlyForYearsWithoutRows(t *testing.T) {
	conn := migrated(t)
	ctx := context.Background()
	dir := t.TempDir()
	for _, f := range seed.RequiredConfigFiles {
		raw, err := os.ReadFile(filepath.Join(testdb.ConfigDir(), f)) //nolint:gosec // repo file
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, f), raw, 0o600); err != nil { //nolint:gosec // temp dir
			t.Fatal(err)
		}
	}
	// Test fixture dates only (not a real exchange calendar).
	cfg := `{"2030":[{"date":"2030-01-01","description":"fixture A"},{"date":"2030-02-01","description":"fixture B"}],
	         "2031":[{"date":"2031-03-03","description":"fixture C"}], "2032":[]}`
	if err := os.WriteFile(filepath.Join(dir, "market_holidays.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	// 2031 already has an owner-imported row: the seed must leave that year alone.
	if _, err := conn.Exec(ctx, `INSERT INTO market_holiday (holiday_date, source) VALUES ('2031-05-05', 'import')`); err != nil {
		t.Fatal(err)
	}
	hash, _ := passhash.Hash("a long test password")
	res, err := seed.Run(ctx, conn, seed.Options{PasswordHash: hash, ConfigDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if res.HolidaysInserted != 2 {
		t.Errorf("inserted = %d, want 2", res.HolidaysInserted)
	}
	got := func(x []int) []int { sort.Ints(x); return x }
	if g := got(res.YearsSeeded); len(g) != 1 || g[0] != 2030 {
		t.Errorf("seeded years = %v", g)
	}
	if g := got(res.YearsSkipped); len(g) != 1 || g[0] != 2031 {
		t.Errorf("skipped years = %v", g)
	}
	if n := count(t, conn, `SELECT count(*) FROM market_holiday WHERE source='seed'`); n != 2 {
		t.Errorf("seed-source rows = %d", n)
	}
	if n := count(t, conn, `SELECT count(*) FROM market_holiday WHERE holiday_date >= '2031-01-01' AND holiday_date < '2032-01-01'`); n != 1 {
		t.Errorf("2031 rows = %d, want only the imported one", n)
	}
	// Re-run adds nothing.
	res, err = seed.Run(ctx, conn, seed.Options{PasswordHash: hash, ConfigDir: dir})
	if err != nil || res.HolidaysInserted != 0 {
		t.Errorf("rerun = %+v, %v", res, err)
	}
}

func TestCheckConfigFiles(t *testing.T) {
	if err := seed.CheckConfigFiles(testdb.ConfigDir()); err != nil {
		t.Fatalf("repo config: %v", err)
	}
	if err := seed.CheckConfigFiles(t.TempDir()); err == nil {
		t.Error("missing config files accepted")
	}
	dir := t.TempDir()
	for _, f := range seed.RequiredConfigFiles {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(""), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := seed.CheckConfigFiles(dir); err == nil {
		t.Error("empty config files accepted")
	}
}
