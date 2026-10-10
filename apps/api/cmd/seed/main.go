// Command seed prepares a freshly migrated database (T02).
//
//	seed                 create the owner user, default settings and holidays (needs DATABASE_URL, INITIAL_PASSWORD_HASH)
//	seed hash-password   read a password from stdin, print its argon2id hash for INITIAL_PASSWORD_HASH
//
// Flags: -config-dir (default "config"). The command never prints secrets and creates no
// instrument rows.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/india-analyzer/api/internal/passhash"
	"github.com/india-analyzer/api/internal/seed"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "seed:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("seed", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configDir := fs.String("config-dir", "config", "directory containing market_holidays.json and the other config files")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		if fs.Arg(0) == "hash-password" && fs.NArg() == 1 {
			return hashPassword(stdin, stdout)
		}
		return fmt.Errorf("unknown command %q", fs.Arg(0))
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return errors.New("cannot connect to the database (check DATABASE_URL)") // never echo the DSN
	}
	defer func() { _ = conn.Close(ctx) }()

	res, err := seed.Run(ctx, conn, seed.Options{
		PasswordHash: os.Getenv("INITIAL_PASSWORD_HASH"),
		ConfigDir:    *configDir,
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "owner user created: %t\nsettings inserted: %d\nholidays inserted: %d (years %v)\n",
		res.UserCreated, res.SettingsInserted, res.HolidaysInserted, res.YearsSeeded)
	for _, y := range res.YearsEmpty {
		_, _ = fmt.Fprintf(stderr, "warning: no holiday list for %d: weekends only until you import it (docs/01 section 7.8)\n", y)
	}
	return nil
}

func hashPassword(stdin io.Reader, stdout io.Writer) error {
	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("reading password: %w", err)
	}
	h, err := passhash.Hash(strings.TrimRight(line, "\r\n"))
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, h)
	return err
}
