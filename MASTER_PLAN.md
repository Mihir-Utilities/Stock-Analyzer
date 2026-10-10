# MASTER PLAN: India Stock & Mutual Fund Analyzer (Safe Edition)

Status: v3, 10 Oct 2026. This is the **main file**. It is short on purpose; details live in `docs/` (reference specs) and `tasks/` (scoped work packages). Claude Code works one task at a time; each task file names exactly which spec sections to read.

> Design policy, not legal advice. See `docs/00-legal-and-safety.md`. The Safe Edition fetches automatically only from sources whose terms allow it, and treats everything else as owner-supplied data. No literal "zero risk" exists; this is the lowest-risk configuration found.

---

## 1. What we are building
A private, single-user web app (phone-friendly) to research Indian stocks and mutual funds:
- Pick any stock the owner's broker serves -> see price charts with technical indicators, performance/risk analytics, owner-entered fundamentals (quarterly/annual), shareholding trends (promoter/FII/DII/MF), corporate actions, peers, a stock screener, comparison, and **experimental, heavily-guarded** forecasts (direction probability, expected range, trend and risk scores).
- Mutual funds: search any scheme, NAV charts, returns, rolling returns, SIP/lumpsum calculators, compare (fully automatic, via mfapi.in/AMFI).
- Watchlist, portfolio tracker (manual transactions, P&L, XIRR), Telegram alerts.
- Professional, visual-first UI with maximum visualisation and no information loss (`docs/06a-design-system.md`).

## 2. Safe Edition decisions (binding)
| Topic | Decision |
|---|---|
| Automated sources | mfapi.in, AMFI NAV file, Telegram Bot API. (Owner's broker API is **inactive**: manual price mode, D-1) |
| Forbidden | NSE/BSE site scraping or endpoints (incl. nsepython), Yahoo/yfinance, Screener scraping, news scraping |
| Stock prices | **Manual price mode (current):** owner uploads `prices.csv` (up to 25 MB / 300,000 rows once S9 passes); reserved `NIFTY50`/`INDIAVIX` rows feed `market_series`. Broker mode is dormant |
| Stock list | Owner imports `instruments.csv` or uses the Add stock form; the app never downloads an instrument list (D-2) |
| Fundamentals, shareholding, corporate actions, sector/index tags | Owner-entered via forms and CSV templates (own filings/records); no Screener import (D-5) |
| Split/bonus handling | App detects probable events from price gaps; owner confirms before history is adjusted |
| News | Removed; replaced by plain "research links" (never fetched) |
| Predictions | Experimental; hidden unless statistical guardrails pass; need >= 20 tracked stocks to train |
| Alerts | Telegram only |
| Portfolio | Stocks only, manual entry |
| Users/hosting | Single user; Vercel (web), Render free (Go API + worker-http), Neon free (Postgres), GitHub Actions (scheduled jobs) |
| No trading | No order code or order scopes anywhere |

## 3. Architecture
```
Phone/Browser -> Next.js (Vercel) --/api rewrite--> Go API (Render free, sleeps) --> Neon Postgres (0.5 GB)
                                                       |  HMAC call
                                                       v
                                           Python worker-http (Render free, on-demand jobs)
GitHub Actions cron -> Python worker-cli (scheduled jobs) -> mfapi / AMFI / Telegram  (broker API dormant in manual price mode)
Owner -> import wizard / manual forms (instruments, prices, fundamentals CSVs, forms) -> Go API importers -> post_import job (worker-http)
```
Stack: Next.js + TypeScript + Tailwind + shadcn/ui + Apache ECharts; Go (chi, pgx, sqlc, goose); Python (httpx, pandas, numpy, LightGBM, pydantic, FastAPI for worker-http). Details: `docs/` files.

Free-tier facts that shape the design (verified, see `docs/00-legal-and-safety.md`): Render free web service sleeps after 15 min (~1 min wake), 750 h/month; Neon free 0.5 GB and scale-to-zero; GitHub Actions free for public repos, quota for private, schedules in public repos stop after 60 days of inactivity.

## 4. Document map
| File | Purpose |
|---|---|
| `README.md` | How to use this package with Claude Code |
| `PROMPT_FOR_CLAUDE_CODE.md` | Copy-paste prompts (kickoff, per-task, review) |
| `CLAUDE.md` | Rules Claude Code follows (auto-loaded) |
| `docs/00-legal-and-safety.md` | Safe-source policy, verified facts, residual risks |
| `docs/01-data-sources.md` | Broker adapter, mfapi, AMFI, Telegram, CSV templates, validation |
| `docs/02-database.sql` | Full schema |
| `docs/03-api-spec.md` | Every endpoint contract |
| `docs/04-worker-jobs.md` | Every scheduled/on-demand job |
| `docs/05-analytics-spec.md` | Formulas, scores, portfolio/MF math, ML |
| `docs/06-frontend-spec.md` | Screens, states, formatting, field coverage |
| `docs/06a-design-system.md` | Visual language, tokens, components, chart catalogue |
| `docs/07-edge-cases-tests.md` | 170+ edge cases, each needs a test |
| `docs/08-phase0-spikes.md` | Feasibility spikes with pass/fail criteria |
| `tasks/README.md` | Task index, order, parallel tracks |
| `tasks/foundation|backend|data|frontend/*.md` | 39 active work packages (D02 removed in manual mode; B06 and F13 split into a/b) |
| `config/*.json`, `.env.example` | Config templates |

## 5. Configuration constants (rows in `app_setting`, env-overridable)
| Key | Default |
|---|---|
| `PRICE_HISTORY_YEARS_TRACKED` | 5 |
| `LAZY_BACKFILL_MAX_YEARS` | 20 (limited by what the broker serves) |
| `OPENED_STOCKS_LRU_CAP` | 150 (applies only to opened stocks with no imported prices) |
| `BROKER_ENABLED` | false (manual price mode) |
| `MFAPI_MIN_INTERVAL_SEC` | 0.5 |
| `REFRESH_COOLDOWN_MIN` | 15 |
| `REFRESH_GLOBAL_PER_HOUR` | 30 |
| `RISK_FREE_RATE` | 0.065 (owner-editable) |
| `SESSION_DAYS` | 30 |
| `LOGIN_MAX_FAILS` | 5 |
| `DB_SOFT_LIMIT_MB` | 380 (Telegram notice + admin warning at 70/85/95%; price imports rejected at 100%; nothing is deleted automatically) |
(Defaults are our own design choices, not vendor limits.)

## 6. Storage budget (Neon free 0.5 GB; measure in spike S10)
`price_daily` ~130 bytes/row incl. index. Tracked set = watchlist + portfolio + imported + LRU 150 (warn above 400 tracked stocks). Example: 400 stocks x 1,250 rows (5 years) = ~500k rows = ~65 MB; the import's projected-size guard enforces the limit. Owner fundamentals are tiny (a few thousand rows). MF NAV only for watchlisted/opened schemes (cap 150 x 2,500 rows = ~40 MB). At 380 MB price imports are rejected; the owner frees space with Trim history / Delete prices (`04-worker-jobs.md` 3.10); imported prices are never deleted automatically.

## 7. Work packages and order
See `tasks/README.md` for the dependency graph. Phases:

| Phase | Tasks | Exit criteria |
|---|---|---|
| 0 Foundation and spikes | T00, T01, T02 | CI green; all spikes decided; DB migrates |
| 1 App shell | B01, B02, D01, F01, F02, F03 | Log in on phone; design system in Storybook; search palette works on fixture data |
| 2 Prices | B03, D03, B09, B04, B06a, D05 (indicators part), F04, F05, F06, F13a | Import instruments + prices; any stock opens with chart + indicators; split detection banner works |
| 3 Owner data | B05, B06b, B07, F07, F08, F13b | Import CSVs and manual forms; fundamentals/ownership/events screens show owner data with sources |
| 4 Analytics | D05 (rest), B13, F10 | Scores, peers, compare, screener correct against hand-checked samples |
| 5 Mutual funds | D04, B10, F14 | Any scheme searchable; returns match references |
| 6 Portfolio and alerts | B11, B12, D06, F11, F12 | P&L equals hand calc; alert reaches Telegram once |
| 7 Predictions | D07, B14, F09 | Guardrail hides forecasts unless models beat baselines; track record visible |
| 8 Hardening | D08, F15 | Failure drills, budgets, backups, a11y, performance |

## 8. Risk register (top)
| Risk | Response |
|---|---|
| Owner must upload prices regularly | `post_import` runs analytics and alerts at once; last-import chip and stale warnings; alerts say "as of the last price import" |
| Owner-data effort too high | CSV templates, forms, S17 effort test; optional metrics |
| Free-tier changes | Config-driven hosts, RUNBOOK plan B |
| Forecasts misleading | Guardrails, baselines, track record, experimental banners; likely hidden often |
| DB full | Budgets, LRU eviction, admin meter |
| ToS changes | Re-read terms on build day (S14); adapters swappable; no forbidden sources |

## 9. Open decisions for the owner (answer before T01 completes)
Answered 2026-10-10 (details in `docs/OPEN_QUESTIONS.md`):
1. Broker: **none; manual price mode** (`BROKER_ENABLED=false`, prices via `prices.csv`). Broker code removed from scope (per S1 fail path). Open: where the instrument list comes from (OQ-4).
2. Repo: **public**; zero secrets in code (Actions secrets and host env vars only); keep the monthly keep-alive workflow; never commit `.env` or real data.
3. Keep-warm pings: **no**; accept ~1 min wake-up (UI "waking up the server" state).
4. Forecasts: **deferred**. There is no training basket: the ML universe is every tracked stock with >= 750 valid bars and no unconfirmed actions (D-H); under 20 such stocks D07 ships the `insufficient_universe` path only.
5. Screener Excel import: **no**; `SCREENER_IMPORT_ENABLED=false`; importer and UI tab are not built.
6. Static IP: **not applicable**; manual price mode (no broker, no paid IP).
7. Telegram bot: owner creates it at S12 / alerts tasks; no earlier task blocks on it.

## 10. Definition of "finished" for v1
All 39 active tasks done; all rows in `docs/07-edge-cases-tests.md` covered by tests; CI gates green (tests, licence scan, deny-list, Lighthouse/axe, bundle budgets); RUNBOOK complete including restore drill; owner has reviewed `docs/TERMS_NOTES.md`.
