// Command api is the India Stock & MF Analyzer HTTP API (B01 skeleton: config, logging, envelope,
// health, stubs for every documented route).
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/india-analyzer/api/internal/auth"
	"github.com/india-analyzer/api/internal/config"
	"github.com/india-analyzer/api/internal/egress"
	"github.com/india-analyzer/api/internal/httpx"
	"github.com/india-analyzer/api/internal/instruments"
	"github.com/india-analyzer/api/internal/jobs"
	"github.com/india-analyzer/api/internal/logx"
)

func main() {
	if err := run(context.Background(), os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "api:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, getenv func(string) string, out io.Writer) error {
	cfg, err := config.Load(getenv) // fail fast: missing or invalid settings stop the process
	if err != nil {
		return err
	}
	scrub := logx.NewScrubber(cfg.Secrets()...)
	log := logx.New(out, cfg.LogLevel, scrub)

	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("DATABASE_URL could not be parsed")
	}
	poolCfg.MaxConns = 5 // Neon free tier: stay small
	poolCfg.MaxConnIdleTime = 4 * time.Minute
	// NewWithConfig does not dial, so a sleeping Neon database does not block start-up; /readyz pings.
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return errors.New("database pool could not be created")
	}
	defer pool.Close()

	accounts := auth.New(pool, auth.Config{SessionDays: cfg.SessionDays, MaxFails: cfg.LoginMaxFails}, log)
	// The only outbound client for the worker: allow-listed to the worker base URL (decision D-N).
	eg, err := egress.New(egress.FromURL(cfg.WorkerBaseURL))
	if err != nil {
		return err
	}
	jobSvc := jobs.New(pool, &jobs.Worker{Base: cfg.WorkerBaseURL, Key: cfg.WorkerHMACKey, HC: eg},
		jobs.Config{Cooldown: time.Duration(cfg.RefreshCooldownMin) * time.Minute, GlobalHour: cfg.RefreshGlobalPerHour}, log)
	defer jobSvc.Wait()
	alertDeps, err := alertsDeps(cfg, pool, log)
	if err != nil {
		return err
	}
	router := httpx.NewRouter(httpx.Deps{Log: log, Pinger: pool, Accounts: accounts, Jobs: jobSvc, Alerts: alertDeps, Stocks: instruments.New(pool), Imports: importService(cfg, pool, jobSvc, log)})
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second, // large import uploads
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16,
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Info().Int("port", cfg.Port).Msg("api listening")

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		log.Info().Msg("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
