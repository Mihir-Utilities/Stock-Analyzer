// Package testdb gives integration tests an empty, isolated PostgreSQL database.
//
// If TEST_DATABASE_URL is set (CI service container) a fresh database is created on that server.
// Otherwise a throwaway container is started with testcontainers. If neither is possible (no
// Docker) the test is skipped, and in CI (CI=true) it fails instead so a broken setup is visible.
package testdb

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
	"github.com/pressly/goose/v3"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// OpenSQL opens a database/sql handle (used by goose) on dsn.
func OpenSQL(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// Migrate applies every migration in dir.
func Migrate(db *sql.DB, dir string) error {
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	return goose.Up(db, dir)
}

// MigrateDown reverts every migration in dir.
func MigrateDown(db *sql.DB, dir string) error {
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	return goose.DownTo(db, dir, 0)
}

// MigrationsDir returns the absolute path of db/migrations.
func MigrationsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "db", "migrations")
}

// ConfigDir returns the absolute path of the repo config directory.
func ConfigDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "config")
}

func unavailable(t *testing.T, why string, err error) {
	t.Helper()
	if os.Getenv("CI") == "true" {
		t.Fatalf("%s: %v", why, err)
	}
	t.Skipf("%s (set TEST_DATABASE_URL or start Docker): %v", why, err)
}

// New returns the DSN of a new empty database, dropped when the test ends.
func New(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		base = startContainer(t)
	}
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		unavailable(t, "cannot connect to the test database", err)
		return ""
	}
	defer func() { _ = admin.Close(ctx) }()

	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatal(err)
	}
	name := "t_" + hex.EncodeToString(suffix)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), base)
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	})

	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}

func startContainer(t *testing.T) (dsn string) {
	t.Helper()
	defer func() {
		// testcontainers panics when Docker is missing.
		if r := recover(); r != nil {
			shared.err = fmt.Errorf("%v", r)
			unavailable(t, "Docker is not available", shared.err)
			dsn = ""
		}
	}()
	shared.mu.Lock()
	defer shared.mu.Unlock()
	if shared.dsn != "" {
		return shared.dsn
	}
	if shared.err != nil {
		unavailable(t, "postgres test container unavailable", shared.err)
		return ""
	}
	ctx := context.Background()
	ctr, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("postgres"),
		postgres.WithUsername("analyzer"),
		postgres.WithPassword("test-only-password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(90*time.Second)),
	)
	if err != nil {
		shared.err = err
		unavailable(t, "cannot start the postgres test container", err)
		return ""
	}
	// One container per test binary; the testcontainers reaper removes it when the process exits.
	dsn, err = ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	shared.dsn = dsn
	return dsn
}

var shared struct {
	mu  sync.Mutex
	dsn string
	err error
}
