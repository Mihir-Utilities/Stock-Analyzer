# Open Questions and Decisions

Claude Code: add questions here instead of guessing. The owner answers; move answered items to "Decisions" with the date.

## Open
| # | Question | Interim assumption | Blocks |
|---|---|---|---|
| OQ-5 | In manual price mode, are the owner's uploaded prices **raw** (unadjusted for splits/bonuses) or already **adjusted**? (Replaces `BROKER_PRICES_ADJUSTED`, spike S4.) The importer cannot tell. | Assume **raw**: `adj_close` = close x factor of confirmed actions; the owner confirms detected splits. Wrong if the source file is already adjusted (double adjustment). | D03 (adjustment/detection), B06a template wording, owner's data source |
| OQ-6 | Which dates are market holidays in manual mode? `config/market_holidays.json` is owner/Claude maintained (`01` 8); broker-candle holiday detection no longer exists. Expected-trading-date logic needs the file for each year. | Weekends + holiday file; admin warning if the year is missing (SYS-10 wording to be adjusted: no auto-detection). | D03, SYS-10, T00 skeleton |
| OQ-7 | Numbering: the spec rows INS-14 and PRC-21 imply categories INS and PRC with earlier IDs, but only these rows exist. Confirmed as given by the owner; lower IDs in those categories are intentionally unused. | Keep as is. | docs/07 |

## Decisions
| Date | Decision | Reason | Spec files updated |
|---|---|---|---|
| 2026-10-10 | D-1 (answers Q1 and Q8) **Manual price mode.** `BROKER_ENABLED=false`; prices come from `prices.csv` uploads. No broker is chosen, no broker login, no static-IP question. Per `08` S1 fail path, broker code is removed from scope. Impact to apply when each task runs (spec text to be amended then, not silently): T01 records S1 as "manual price mode" and skips S2-S5; D02 reduces to instrument master from an owner-supplied file (needs owner question, see OQ-4); B08, B09 broker parts, D03 broker ingestion, F12 broker UI and Telegram broker reminders are dropped; `prices.csv` import (B06/F13) becomes the primary price path. | Owner choice | MASTER_PLAN 9 |
| 2026-10-10 | **D-2 (closes OQ-4) Instrument source.** Build both: (a) import kind `instruments` (`instruments.csv`; columns symbol, name, isin, series, kind, listing_date, face_value, plus D-F columns); (b) a manual Add stock form (`POST /instruments`) using the same validators. Upsert by symbol, never delete. No code fetches instrument lists or prices from the internet. | Manual mode has no instrument master | docs/01 7.0, docs/02, docs/03 14 |
| 2026-10-10 | D-2.1 Reserved symbols `NIFTY50` and `INDIAVIX` in `prices.csv` write to `market_series` (optional). Prices import commits enqueue `post_import` (detect_actions + compute_analysis + alerts) replacing the nightly price job; Refresh button hidden; `sync_instruments`, `broker_session_check`, `ingest_prices_eod`, retry and intraday alerts are off. | Replaces broker pipeline | docs/01 7.1, docs/04 |
| 2026-10-10 | D-2.2 Undo for `instruments` batches: not undoable. | No batch id on instrument rows; never delete | docs/03 14 |
| 2026-10-10 | D-B Prices import marks symbols `is_tracked=true, tracked_reason='imported'`. Guards: projected-size check at validate (rows x ~130 B; commit rejected `DB_SIZE_LIMIT` if over 380 MB; warn, not block, above 400 tracked stocks); validated uploads kept in UNLOGGED table `import_upload` (1 h TTL, deleted on commit and by housekeeping), streamed parsing. | Render restarts; Neon limit | docs/01 7.1, docs/02, docs/03 14 |
| 2026-10-10 | D-C Manual-mode eviction: imported price data is **never** deleted automatically, not even by size. Telegram notice + admin warning at 70/85/95% of 380 MB; at 380 MB price imports are rejected. Owner-initiated "Trim history" (`POST /prices/trim`) and "Delete prices between dates" (`DELETE /stocks/{symbol}/prices`). Imported stocks exempt from LRU cap and the 12-month rule. | Owner cannot easily re-fetch data | docs/04 3.10, docs/03 4 |
| 2026-10-10 | D-D Alerts in manual mode: evaluated at the end of `post_import` and at 19:30 EOD; dedupe key includes the bar date; only bars newer than the alert's last evaluated bar fire; ALR-14 staleness rule does not apply; messages end "as of the last price import ({bar date})"; creation-time THRESHOLD_ALREADY_MET uses the last imported bar. | No intraday data | docs/04 3.9, docs/03 13 |
| 2026-10-10 | D-E `post_import` is resumable: stops starting symbols at 3.5 min, stores progress in `refresh_job.result`, status `partial`, re-enqueues the remainder; daily `process_queued_jobs` continues it. | worker-http 4 min cap | docs/04 3.12-3.13 |
| 2026-10-10 | D-F `instruments.csv` extra optional columns: `previous_symbol` (rename + `symbol_alias`, history and portfolio links kept) and `status` (active/suspended/delisted). | Symbol changes | docs/01 7.0 |
| 2026-10-10 | D-G Large uploads through the Vercel rewrite are unverified: S9 gains a 25 MB upload test. API keeps the lower `prices` limit until S9 passes; if the proxy limit is lower, the wizard splits large price CSVs in the browser and commits them as one logical batch (`upload_group`, one transaction). | Unverified platform limit | docs/08 S9, B06a/F13a |
| 2026-10-10 | D-H (closes OQ-3) ML universe: all tracked stocks with >= 750 valid bars and no unconfirmed actions; no training basket; `TRAINING_BASKET_MAX` and `tracked_reason='training_basket'` removed; 20-stock minimum stays; forecasts remain deferred. | Simplification | docs/05 10.1, MASTER_PLAN 5, D07 |
| 2026-10-10 | D-I Edge-case rows added: IMP-20..24, INS-14, PRC-21, ALR-18, SYS-12 (assigned to B06a, B06a, D03/B06a, D06/D03, F13a). | | docs/07 |
| 2026-10-10 | D-J (Claude, for owner review) B06 split into B06a (instruments + prices importers, needed first because prices are the primary data path) and B06b (rest); F13 into F13a/F13b; D02 removed; B08 reduced to a status endpoint. | In manual mode no stock can show a chart until B06a/F13a exist; the original B06 sat behind B05 in wave 5 | tasks/README.md, B06, F13, D02, B08 |
| 2026-10-10 | D-2 Repo is public. Zero secrets in code (GitHub Actions secrets + host env vars only). Keep the monthly keep-alive workflow. Never commit `.env` or real data. | More free Actions minutes | MASTER_PLAN 9 |
| 2026-10-10 | D-3 No keep-warm pings; accept ~1 min wake-up. UI "waking up the server" state handles it. | Preserves Render free hours | MASTER_PLAN 9 |
| 2026-10-10 | D-4 Forecasts deferred; build everything else first. Owner decides the basket before D07; fewer than 20 symbols -> D07 ships `insufficient_universe` path only. | Prediction needs >= 20 tracked stocks | MASTER_PLAN 9 |
| 2026-10-10 | D-5 `SCREENER_IMPORT_ENABLED=false`. Do not build the Screener importer or its UI tab now. | Gray area under Screener terms | MASTER_PLAN 9 |
| 2026-10-10 | D-6 Files reorganised into the documented layout; git initialised. | Specs cite `docs/`, `tasks/<track>/`, `config/` | repo layout |
| 2026-10-10 | D-7a `config/research_links.json` is exempt from the deny-list (plain hyperlinks the app never requests); scan source code and lockfiles only. | Matches T00 scope | T00 |
| 2026-10-10 | D-7b "No browser calls to third-party sites" means no programmatic requests, iframes, prefetch or previews. Owner opens links in a new tab; links carry `rel="noopener noreferrer"`. | Clarifies CLAUDE.md 7 vs 01 section 9 | none (interpretation) |
| 2026-10-10 | D-8 If the broker rejects Actions/Render IPs for data calls: run the worker at home only if the owner has a static IP; otherwise do not pay for one, fall back to manual price mode and tell the owner. | Free-tier constraint | 00 section 5 (to amend if S2 triggers) |
| 2026-10-10 | D-9 Telegram bot is created by the owner at S12 / alerts tasks; earlier tasks must not block on it. | Not needed earlier | none |

## Spec ambiguities found at kickoff (for reference; resolve in the owning task)
1. MASTER_PLAN phase table vs `tasks/README.md` wave order differ (B03/F03/D05 placement). Waves are authoritative.
2. D02 needs the S1 broker decision; S3-S5 results feed D03/D05. Gate D02 on S1+S2 only.
3. Unverified `U` items (token expiry fallback 03:30 IST, partial-bar rule, candle limits, adjusted/raw, AMFI availability, mfapi `data` order) need a GO in `SPIKE_RESULTS.md` before building on them.
4. Check where `backup_user_data` (04 section 3.11) stores backups: public repo means no data or secrets there. Review before D08.
5. Vercel Hobby non-commercial terms and broker data-storage terms: owner reads them in S14.
