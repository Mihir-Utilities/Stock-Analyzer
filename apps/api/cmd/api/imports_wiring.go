package main

import (
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/config"
	"github.com/india-analyzer/api/internal/importers"
	"github.com/india-analyzer/api/internal/jobs"
)

// importService wires the owner-data importers (B06a). IMPORT_PRICES_LARGE_ENABLED=true switches the
// prices limits from 5 MB / 50,000 rows to 25 MB / 300,000 rows; set it only after spike S9 passed
// the large upload through the hosting proxy (docs/01 section 7, decisions D-G and D-S).
func importService(cfg config.Config, pool *pgxpool.Pool, jobSvc *jobs.Service, log zerolog.Logger) *importers.Service {
	svc := importers.New(pool, jobSvc, cfg.DBSoftLimitMB, log)
	svc.LargePrices = strings.EqualFold(strings.TrimSpace(os.Getenv("IMPORT_PRICES_LARGE_ENABLED")), "true")
	return svc
}
