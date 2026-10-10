// Package seed creates the single owner row, the default app_setting rows (MASTER_PLAN section 5)
// and the market holidays from config/market_holidays.json. It is idempotent and never overwrites
// anything the owner has changed. It never creates instrument rows (decision D-2) and never
// writes PRICES_ALREADY_ADJUSTED (absent = unset, the owner must choose).
package seed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/passhash"
)

// Setting is one default app_setting row; Value is JSON.
type Setting struct {
	Key   string
	Value string
}

// DefaultSettings are the constants of MASTER_PLAN section 5. PRICES_ALREADY_ADJUSTED is
// deliberately absent. No broker settings and no TRAINING_BASKET_MAX (manual price mode).
var DefaultSettings = []Setting{
	{"PRICE_HISTORY_YEARS_TRACKED", "5"},
	{"LAZY_BACKFILL_MAX_YEARS", "20"},
	{"OPENED_STOCKS_LRU_CAP", "150"},
	{"BROKER_ENABLED", "false"},
	{"MFAPI_MIN_INTERVAL_SEC", "0.5"},
	{"REFRESH_COOLDOWN_MIN", "15"},
	{"REFRESH_GLOBAL_PER_HOUR", "30"},
	{"RISK_FREE_RATE", "0.065"},
	{"SESSION_DAYS", "30"},
	{"LOGIN_MAX_FAILS", "5"},
	{"DB_SOFT_LIMIT_MB", "380"},
}

// RequiredConfigFiles must exist and parse as JSON (the "empty config files check").
var RequiredConfigFiles = []string{
	"financial_industry_patterns.json",
	"market_holidays.json",
	"research_links.json",
}

// Options configures Run.
type Options struct {
	PasswordHash string // argon2id PHC string from INITIAL_PASSWORD_HASH
	ConfigDir    string // directory holding market_holidays.json etc.
}

// Result reports what a run changed (for the operator's console and tests).
type Result struct {
	UserCreated      bool
	SettingsInserted int
	HolidaysInserted int
	YearsSeeded      []int
	YearsEmpty       []int // years present in the file with no dates: weekends-only warning applies
	YearsSkipped     []int // years that already had rows in the database
}

type holidayEntry struct {
	Date        string `json:"date"`
	Description string `json:"description"`
}

// Holiday is a validated config row.
type Holiday struct {
	Date        time.Time
	Description string
}

// ParseHolidays validates the content of market_holidays.json: keys are four-digit years, every
// date is YYYY-MM-DD, belongs to the key's year and appears once. Keys starting with "_" are
// comments. Dates are never invented: an empty list stays empty.
func ParseHolidays(raw []byte) (map[int][]Holiday, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, fmt.Errorf("market_holidays.json: %w", err)
	}
	out := make(map[int][]Holiday)
	for key, body := range top {
		if len(key) > 0 && key[0] == '_' {
			continue
		}
		year, err := strconv.Atoi(key)
		if err != nil || len(key) != 4 {
			return nil, fmt.Errorf("market_holidays.json: key %q is not a four-digit year", key)
		}
		var entries []holidayEntry
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&entries); err != nil {
			return nil, fmt.Errorf("market_holidays.json: year %d: %w", year, err)
		}
		seen := make(map[string]bool)
		rows := make([]Holiday, 0, len(entries))
		for _, e := range entries {
			d, err := time.Parse("2006-01-02", e.Date)
			if err != nil {
				return nil, fmt.Errorf("market_holidays.json: year %d: bad date %q (want YYYY-MM-DD)", year, e.Date)
			}
			if d.Year() != year {
				return nil, fmt.Errorf("market_holidays.json: date %s is listed under year %d", e.Date, year)
			}
			if seen[e.Date] {
				return nil, fmt.Errorf("market_holidays.json: duplicate date %s", e.Date)
			}
			seen[e.Date] = true
			rows = append(rows, Holiday{Date: d, Description: e.Description})
		}
		out[year] = rows
	}
	return out, nil
}

// CheckConfigFiles verifies the config files exist, are non-empty files and parse as JSON.
func CheckConfigFiles(dir string) error {
	for _, name := range RequiredConfigFiles {
		raw, err := os.ReadFile(filepath.Join(dir, name)) //nolint:gosec // operator-supplied config directory
		if err != nil {
			return fmt.Errorf("config check: %w", err)
		}
		if !json.Valid(raw) {
			return fmt.Errorf("config check: %s is not valid JSON", name)
		}
	}
	return nil
}

// Run seeds the database inside one transaction.
func Run(ctx context.Context, conn *pgx.Conn, opt Options) (Result, error) {
	var res Result
	if err := passhash.Validate(opt.PasswordHash); err != nil {
		return res, errors.New("INITIAL_PASSWORD_HASH must be an argon2id hash (run `seed hash-password`); refusing to seed")
	}
	if err := CheckConfigFiles(opt.ConfigDir); err != nil {
		return res, err
	}
	raw, err := os.ReadFile(filepath.Join(opt.ConfigDir, "market_holidays.json")) //nolint:gosec // operator-supplied config directory
	if err != nil {
		return res, fmt.Errorf("reading market_holidays.json: %w", err)
	}
	holidays, err := ParseHolidays(raw)
	if err != nil {
		return res, err
	}

	tx, err := conn.Begin(ctx)
	if err != nil {
		return res, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := dbq.New(tx)

	n, err := q.InsertAppUser(ctx, opt.PasswordHash)
	if err != nil {
		return res, fmt.Errorf("insert app_user: %w", err)
	}
	res.UserCreated = n == 1

	for _, s := range DefaultSettings {
		n, err := q.InsertDefaultSetting(ctx, dbq.InsertDefaultSettingParams{Key: s.Key, Value: []byte(s.Value)})
		if err != nil {
			return res, fmt.Errorf("insert setting %s: %w", s.Key, err)
		}
		res.SettingsInserted += int(n)
	}

	years := make([]int, 0, len(holidays))
	for y := range holidays {
		years = append(years, y)
	}
	sort.Ints(years)
	for _, y := range years {
		existing, err := q.CountHolidaysForYear(ctx, int32(y)) //nolint:gosec // four-digit year
		if err != nil {
			return res, fmt.Errorf("count holidays %d: %w", y, err)
		}
		switch {
		case existing > 0:
			res.YearsSkipped = append(res.YearsSkipped, y)
		case len(holidays[y]) == 0:
			res.YearsEmpty = append(res.YearsEmpty, y)
		default:
			for _, h := range holidays[y] {
				n, err := q.InsertSeedHoliday(ctx, dbq.InsertSeedHolidayParams{
					HolidayDate: pgtype.Date{Time: h.Date, Valid: true},
					Description: pgtype.Text{String: h.Description, Valid: h.Description != ""},
				})
				if err != nil {
					return res, fmt.Errorf("insert holiday %s: %w", h.Date.Format("2006-01-02"), err)
				}
				res.HolidaysInserted += int(n)
			}
			res.YearsSeeded = append(res.YearsSeeded, y)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return res, fmt.Errorf("commit: %w", err)
	}
	return res, nil
}
