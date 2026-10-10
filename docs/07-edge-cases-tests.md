# 07. Edge-Case Catalogue and Test Matrix (Safe Edition)

Gaps in numbering are intentional; IDs are stable references.

Rule: every row needs an automated test before its feature is done. Rows marked **N/A in manual mode** (broker mode inactive, D-1) need no test now; they are kept (IDs never deleted) for a possible future broker mode. Test types: **U** unit, **I** integration (real Postgres via testcontainers), **E** Playwright end-to-end, **F** fixture parser/importer test, **M** manual checklist in RUNBOOK, **CI** pipeline check. New edge cases found later get the next ID in the right category; rows are never deleted. Process rule: every production bug becomes a row plus a regression test. This catalogue cannot prove completeness.

## SAF: Safe Edition guards
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| SAF-01 | Forbidden dependency or hostname appears (yfinance, nsepython, nseindia.com, yahoo, screener.in fetch, news RSS) | CI deny-list test fails the build | CI |
| SAF-02 | App attempts any order endpoint of the broker | No such code exists; deny-list test on broker adapter method names | CI |
| SAF-03 | Footer/disclaimer present on every page; MF pages show AMFI/mfapi attribution | Visual and DOM test | E |
| SAF-04 | Licence scan finds GPL/AGPL/unknown | CI fails | CI |
| SAF-05 | `SCREENER_IMPORT_ENABLED=false` | Endpoint 404; UI hides the option | I/E |
| SAF-06 | Research links never fetched by server/browser | No network call test (no iframes/prefetch) | E |
| SAF-07 | `.env.example` missing a config key from MASTER_PLAN 5 or holding a secret-like value | `scripts/check_env_example.py` fails CI | CI |
| SAF-08 | Dependency with MPL/LGPL licence (weak copyleft, e.g. Next's optional `sharp` libvips) | Scan passes but lists it as `Review` in `THIRD_PARTY_NOTICES.md`; GPL/AGPL/unknown still fail (OQ-8, D-OQ8) | U |
| SAF-09 | Deny-list bypass attempts: directories named tasks/docs/build/dist/vendor, Dockerfile variants, `.env*`, UTF-16 files, split string literals, escapes (backslash-u, backslash-x, %XX), base64 tokens, look-alike package names (`yahoo-finance2`, `yahoo_fin`, `pandas-datareader`), camel-case order methods, REST order paths | Every one is caught; prose (`my finance`, `screener.index`, `replaceOrder`) is not flagged. Values built at runtime (env vars) are covered by the egress allow-list (D01/B01, D-N) | CI |
| SAF-10 | `.gitignore` coverage: `.env*`, local DBs, build output, keys, backups, real-data fixtures; no BOM | `scripts/tests/test_repo_hygiene.py` | CI |
| SAF-11 | Workflow hardening: every action pinned by commit SHA, top-level `permissions`, no job-level write, no fork-secret trigger, no secret echo | `scripts/tests/test_repo_hygiene.py` | CI |
| SAF-13 | Runtime egress: request to a host outside the allow-list (literal, from an env var, via redirect, IP literal, non-https) from the worker or the Go API | Rejected before any socket is opened; direct HTTP client use outside the egress package fails lint (D01, B01, D-N) | U |
| SAF-12 | `THIRD_PARTY_NOTICES.md` generated on Windows must still match on a Linux runner (platform-only packages such as colorama); a locked Python package with no licence fails closed; a Go module without a downloaded `Dir` fails closed | `scripts/tests/test_license_scan.py` | CI |

## BRK: broker session and prices
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| BRK-01 | No broker session | **N/A in manual mode (D-1; broker mode inactive).** Broker jobs `skipped(broker_session_missing)`; banner; one Telegram reminder per slot | I |
| BRK-02 | Token expires mid-job | **N/A in manual mode (D-1; broker mode inactive).** Job stops at the current item, marks `partial`, reminds once | I |
| BRK-03 | OAuth `state` mismatch/expired/reused | **N/A in manual mode (D-1; broker mode inactive).** Callback rejected; nothing stored | I |
| BRK-04 | Token encrypted at rest | **N/A in manual mode (D-1; broker mode inactive).** DB column is ciphertext; no log contains token (scrubber test) | U/I |
| BRK-05 | Broker rate-limited (429) | **N/A in manual mode (D-1; broker mode inactive).** Backoff + circuit breaker; stale chip; no data corruption | I |
| BRK-06 | Imported history shorter than the depth the UI/analytics expect (manual mode) | Use what exists; `limited_history` flag; UI states depth | I |
| BRK-07 | Instrument exists but has no imported prices (manual mode) | `no_prices` flag; selectable; page shows "No prices imported. Import prices.csv" | I |
| BRK-08 | Daily candle sanity failures (OHLC inconsistent, <=0, huge jump) | `suspect=true`, excluded from analytics | U |
| BRK-09 | Weekend rows in `prices.csv` (manual mode) | Dropped with a warning (`01` 3.5); a listed holiday is only a warning; no holiday auto-detection | U |
| BRK-10 | Partial/in-progress bar before 18:00 IST | **N/A in manual mode (D-1; broker mode inactive).** Not persisted | U |
| BRK-11 | < 90% tracked stocks have expected bar at 18:30 | **N/A in manual mode (D-1; broker mode inactive).** Status `partial`; retry at 20:30; UI "prices as of {prev date}" | I |
| BRK-12 | Manual price mode (no broker) | Refresh/backfill rejected `PRICE_MODE_MANUAL`; UI explains and links to prices import | I/E |
| BRK-13 | Prices import overlaps broker data | **N/A in manual mode (D-1; broker mode inactive).** Upsert; `source` shows import; a visible label if one series mixes sources | I |
| BRK-14 | Static-IP/IP block for data calls | **N/A in manual mode (D-1; broker mode inactive).** Source health red; documented home-run procedure | M |
| BRK-15 | Broker changes instrument key | **N/A in manual mode (D-1; broker mode inactive).** Master sync updates `broker_key`; history continuity by `instrument.id` | I |
| BRK-16 | Index/VIX series unavailable | Dashboard shows reason; ML omits market features for all rows | U/E |
| BRK-17 | Price at tiny/huge values | Format correct; no overflow | U |
| BRK-18 | Timezone boundaries (IST vs UTC dates) | Market date test around 00:00 | U |
| BRK-19 | Duplicate candles in a response | Upsert; counts stable | I |
| BRK-20 | Broker returns already-adjusted history | With `PRICES_ALREADY_ADJUSTED=true` no double adjustment (broker mode inactive; manual-mode equivalent: ACT-11, ACT-12) | U |

## ACT: corporate actions and adjustments
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| ACT-01 | Price falls ~50% on one day with volume spike | `detected` action created; banner; analytics warning; ML hidden | U/I |
| ACT-02 | Real crash (no volume spike, ratio not near a fraction) | No detection | U |
| ACT-03 | Owner confirms split 10->2 | `adj_close` history recomputed; indicators recalculated; portfolio lots adjusted | I |
| ACT-04 | Owner rejects detected action | Status `rejected`; not re-detected for same date | I |
| ACT-05 | Bonus 1:1 and 1:2 conventions | multiplier 2 and 1.5 (tests with real examples from owner fixtures) | U |
| ACT-06 | Confirmed multiplier disagrees with detected fraction > 3% | UI warning | U |
| ACT-07 | Small splits/bonus (price ratio 0.65-1) | Not detected; manual entry works | U |
| ACT-08 | Rights/buyback/merger/demerger | Never auto-applied; "review needed" | U |
| ACT-09 | Duplicate action rows | Unique constraint | I |
| ACT-10 | Future ex-date | Not applied until `ex_date <= as_of` | U |
| ACT-11 | Detected action whose ex-date lies inside bars imported as already adjusted | Action inserted as `detected`; stock gets `ADJUSTMENT_CONFLICT`; Data tab warning text; nothing adjusted automatically | I |
| ACT-12 | Mixed `src_adjusted` bars for one stock; owner confirms an action | `adj_close` factors applied only to `src_adjusted=false` bars; `src_adjusted=true` bars keep `adj_close = close`; never adjusted twice | U |
| ACT-13 | Reverse split / consolidation (price ratio above 1.35, e.g. 1:10 gives about x10) | Not matched by the detector (fractions are all below 1); the bar fails the 50% day-change sanity rule and is `suspect`; no action is created; owner enters it manually (S8) | U |
| ACT-14 | Detector reachability | Fractions 2/3, 3/4, 4/5, 5/6 can never pass the `abs(C_t/C_{t-1} - 1) > 0.35` trigger (a 1:2 bonus, ratio 0.667, is not detected, consistent with ACT-07); a unit test pins this so a threshold change is deliberate (S8; see OQ-13) | U |

## IMP: imports and manual entry
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| IMP-01 | Wrong header/column names | Reject with exact message; template link | F |
| IMP-02 | Mixed or ambiguous date formats | Accept ISO, DD-MM-YYYY, DD-Mon-YYYY; reject MM-DD-YYYY | F |
| IMP-03 | Number formats (`1,234.56`, `1.234,56`) | First accepted, second rejected as ambiguous | F |
| IMP-04 | Empty cells | NULL, never 0 | F |
| IMP-05 | Quarterly `period_end` not a quarter end | Error | F |
| IMP-06 | Unit mix-up (net_profit > 2x revenue; revenue > 1e7 crore) | Warning/error per spec | F |
| IMP-07 | Shareholding sums | Accept within 100 +/- 1.0; MF+insurance <= DII + 0.5 | F |
| IMP-08 | Unknown symbol | Row error with nearest suggestion | F |
| IMP-09 | Duplicate rows inside file | Last wins with warning, or error if contradictory | F |
| IMP-10 | Same file twice | Idempotent upsert | I |
| IMP-11 | Preview then commit with errors present | Commit rejected 422 | I |
| IMP-12 | Upload expires (1 h) | 404 on commit | I |
| IMP-13 | Oversized file / >50k rows (`prices`: >300k rows or >25 MB) / wrong MIME | 413/422 | I |
| IMP-14 | Undo batch | Rows removed; overwritten values not restored (warned); price batches not undoable | I |
| IMP-15 | CSV injection (`=cmd|...` cells) | Stored as text; exports prefix with `'` | U |
| IMP-16 | Encoding (UTF-8 BOM, semicolons) | Parsed | F |
| IMP-17 | Manual form validators identical to CSV | Shared validation code; parity test | U |
| IMP-18 | Entering data for delisted/unknown instrument | Rejected with message | I |
| IMP-19 | Optional Screener file with unknown layout (if enabled) | Reject whole file (N/A: Screener import not built, D-5) | F |
| IMP-20 | `instruments.csv` rules | Symbol charset `A-Z 0-9 & -`, uppercase, unique in file; malformed ISIN = warning (stored NULL); `NIFTY50`/`INDIAVIX` rejected; upsert never deletes and never overwrites sector/industry/company_type; batch not undoable | F |
| IMP-21 | Reserved `NIFTY50`/`INDIAVIX` in `prices.csv` | Written to `market_series(code, trade_date, value=close)`, not `price_daily`; 50% sanity rule skipped; absent -> ML/benchmark features degrade (BRK-16) | I |
| IMP-22 | 300,000-row price import (25 MB) | Streamed parse; inserts in chunks of 5,000 inside one transaction; any error (including at the last chunk) rolls back everything; memory stays bounded | I |
| IMP-23 | Projected-size guard | Validate returns `estimated_growth_mb`; commit rejected with `DB_SIZE_LIMIT` and a plain message when current size + estimate > `DB_SOFT_LIMIT_MB`; warning (not block) when tracked stocks would exceed 400 | I |
| IMP-24 | Validated upload survives an API restart before commit | Upload stored in UNLOGGED `import_upload`; restart API; commit succeeds; row deleted on commit; expired rows (1 h) 404 and are removed by housekeeping | I |
| IMP-25 | Prices commit while `PRICES_ALREADY_ADJUSTED` is unset | `422 PRICES_ADJUSTMENT_UNSET`; choosing raw/adjusted persists the setting via `PUT /settings/prices-adjustment`; "I don't know" persists nothing; later commits do not re-ask; each stored bar gets `src_adjusted` = setting at import time | I |
| IMP-26 | Adjustment check on a validated upload | Returns closes for up to 5 trading days each side of the ex-date, observed ratio, nearest fraction and hint (`raw_likely` within 3% of the expected ratio/fraction, `adjusted_likely` within 3% of 1, else `inconclusive`); writes nothing; unknown symbol/ex-date outside file -> 422 | I |
| IMP-27 | `holidays.csv` import | Columns/segment validated; weekend date = warning; duplicate `(date, segment)` = error; replace-per-year on commit; not undoable; template has no example dates; shipped 2026 list is empty (no invented dates) | F |
| IMP-28 | Decimal comma in a semicolon-delimited file (`1234,56`, `12,34`) | Rejected as ambiguous, never silently read as 123456 or 1234.56; a comma is accepted only as a thousands separator in valid groupings (`1,234.56`, Indian `1,23,456.78`) (S13; interim behaviour, see OQ-9) | F |

## INS: instruments
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| INS-14 | `previous_symbol` rename | Matching existing instrument + new symbol free: instrument renamed, `symbol_alias` written, prices/fundamentals/portfolio links kept; new symbol already taken or no match: ignored with warning | I |

## PRC: manual price data actions
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| PRC-21 | Delete prices for {symbol} between {from} and {to} | Preview count, confirm required, rows deleted, audit row written, `post_import` recomputes analytics/detection; `from > to` 422; other symbols untouched | I |

## FND: fundamentals (owner data) and analytics
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| FND-01 | Fiscal labels (Sep 2026 -> Q2 FY27; Mar 2026 -> Q4 FY26) | Correct incl. boundaries | U |
| FND-02 | Consolidated missing | Standalone used with label | I |
| FND-03 | Different bases entered for different periods | Never mixed within one series; UI states | U |
| FND-04 | Loss-making | P/E null `loss_making`; growth from negative base `n/m` | U |
| FND-05 | Zero/missing interest | Coverage null `no_interest` | U |
| FND-06 | Negative equity | ROE/D-E/P-B null `negative_equity` | U |
| FND-07 | Period misalignment (+/-20 days tolerance) | Matching tolerance tested | U |
| FND-08 | TTM EPS with missing quarter | Fallback to annual with label, else null | U |
| FND-09 | Split after results | EPS/BVPS adjusted by confirmed multipliers | U |
| FND-10 | Financial company | Only allowed metrics; quality score N/A | U/E |
| FND-11 | No owner data for a stock | All fundamentals null with `no_data_entered`; CTA to add | E |
| FND-12 | Partial history (2 quarters) | Tables render; growth null | E |
| FND-13 | PE percentile < 750 points | Null `insufficient_history` | U |
| FND-14 | Market cap missing (no shares outstanding) | Dependent metrics null | U |
| FND-15 | Restated period re-entered | Overwrites; audit via batch | I |
| FND-16 | Formula golden tests | All formulas of `05` verified against references/hand values | U |

## SHP: shareholding
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| SHP-01 | Missing MF figure | `mf_available=false`; UI note | E |
| SHP-02 | Pledge unknown | null, not 0 | U |
| SHP-03 | No promoter | Chart still renders | U |
| SHP-04 | Single quarter | No QoQ | U |
| SHP-05 | Non-quarter-end date | Rejected | F |

## MF: mutual funds
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| MF-01 | Direct/Regular x Growth/IDCW variants | Default Direct+Growth; grouping; name parsing | U |
| MF-02 | NAV `N.A.` or non-numeric | Skipped | U |
| MF-03 | Date formats (`dd-mm-yyyy` mfapi; `dd-Mon-yyyy` AMFI) | Both parsed | U |
| MF-04 | Window longer than history | null with tooltip | U |
| MF-05 | IDCW | "Not comparable" warning | E |
| MF-06 | Merged/closed scheme | `inactive` after threshold; banner | I |
| MF-07 | Weekly-NAV schemes | Volatility null | U |
| MF-08 | NAV jump > 25% | Kept, flagged, marker | I |
| MF-09 | mfapi down | AMFI fallback latest; DB history; stale chip | I |
| MF-10 | SIP start before first NAV | Skipped installments counted | U |
| MF-11 | SIP day 29-31 | UI limits to 1-28; API validates | U |
| MF-12 | 10k+ search | Cursor pagination; trigram < 300 ms (S10) | I |
| MF-13 | Wrong scheme code | 404; suggestions | E |
| MF-14 | Compare different starts | Rebased at first common date; flag | U |
| MF-15 | mfapi header `data` order reversed | Sorted ascending always | U |
| MF-16 | Weekend-dated NAV in mfapi history (e.g. `31-03-2024`, a Sunday) | Kept like any other NAV; the weekend-drop rule applies only to stock bars (S6) | U |
| MF-17 | AMFI row whose value date is after the file date (liquid funds, e.g. `11-Oct-2026` in a file of 10 Oct) | Kept with its own date; not rejected as future; `last_nav_date` and as-of display use that date; latest-NAV comparison with mfapi is by date (S7; interim behaviour, see OQ-12) | U |
| MF-18 | `sync_mf_schemes` on the full mfapi list (about 38k schemes, about 23.6k absent from AMFI) | Paginated with `limit=10000`; schemes absent from AMFI or with an old last NAV follow the MF-06 inactive rule; default search excludes inactive; run stays inside the 20-minute workflow timeout (S6) | I |
| MF-19 | AMFI file layout drift | Columns read by header name; missing required header rejects the whole file and keeps old data; extra columns ignored; the 8-field layout and a hypothetical 6-field layout both parse (S7) | U |
| MF-20 | AMFI scheme-type line vs AMC line | A no-`;` line is a scheme-type line only if it starts with `Open Ended Schemes`, `Close Ended Schemes` or `Interval Fund Schemes`, else it is an AMC line; blank lines may hold one space; no row is attached to a missing AMC or type (S7) | U |

## PF: portfolio
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| PF-01 | Sell more than held | 422 `INSUFFICIENT_HOLDINGS` | I |
| PF-02 | Edit/delete earlier buy invalidating later sell | Rejected | I |
| PF-03 | Fractional quantity (4 dp) | Accepted | U |
| PF-04 | Same-day buy and sell | Ordered by id; buys before sells | U |
| PF-05 | Date before listing/future | 422 | I |
| PF-06 | Weekend/holiday trade date | Warning only | U |
| PF-07 | XIRR undefined/short span | Null/absolute with message | U |
| PF-08 | Fully sold position | Realized retained; hidden by default | E |
| PF-09 | Split after purchase | Qty/cost adjusted; value invariant | U/E |
| PF-10 | Missing price | Last close, flagged stale; none -> null | U |
| PF-11 | Idempotency-Key | No duplicates | I |
| PF-12 | Decimal precision (0.1+0.2) | Exact to 4 dp | U |
| PF-13 | Delisted holding | Kept, flagged | I |
| PF-14 | Fee capitalization | In cost, reduces proceeds | U |
| PF-15 | Symbol change | Follows alias | I |

## ALR: alerts and Telegram
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| ALR-01 | Threshold already met | 422 | U |
| ALR-02 | Overnight gap through threshold | Fires next evaluation | U |
| ALR-03 | Duplicate evaluation | Unique key prevents double send | I |
| ALR-04 | Recurring cooldown/hysteresis | As spec | U |
| ALR-05 | Telegram not linked | Pending; delivered when linked (<24 h) | I |
| ALR-06 | Send failure | 5 retries then failed | I |
| ALR-07 | > 10 events | Digest | U |
| ALR-08 | Quiet hours | Held | U |
| ALR-09 | HTML special characters (`M&M`) | Escaped | U |
| ALR-10 | Alert on delisted stock | Expired with note | I |
| ALR-11 | Webhook secret mismatch | 401; nothing stored | I |
| ALR-12 | /start with used/expired code | Polite failure | I |
| ALR-13 | Other chat messages the bot | Ignored | I |
| ALR-14 | No fresh price (broker session expired) | Uses last bar; message says "as of {time}"; no price alert fired if data older than 1 trading day (broker mode only; does not apply in manual mode, see ALR-18) | U |
| ALR-15 | 200-alert limit | 409 | I |
| ALR-16 | Webhook while API asleep | Link UI tolerates delay (S12) | M |
| ALR-17 | `results_upcoming` relies on owner-entered calendar | No event -> no alert; UI hint to add events | U |
| ALR-18 | Manual mode: event-driven evaluation after a prices import | `post_import` evaluates alerts for affected symbols (and 19:30 EOD run); dedupe key includes bar date so the same bar never fires twice; only bars newer than the alert's last evaluated bar can fire; no staleness block; message ends "as of the last price import ({bar date})"; creation-time THRESHOLD_ALREADY_MET uses the last imported bar and says so | I |

## ML: predictions
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| ML-01 | Lookahead | Changing prices after `t` leaves features at `t` unchanged | U |
| ML-02 | Label alignment with holidays | Correct `t+h` rows | U |
| ML-03 | Embargo/purge | No overlap | U |
| ML-04 | Fewer than 20 eligible stocks | `insufficient_universe`; forecasts hidden | I |
| ML-05 | Guardrail fails | `shown=false`, reason; UI explanation | I/E |
| ML-06 | Illiquid / near action / stale / unconfirmed action | Hidden with enum reason | U |
| ML-07 | Live track record gate | Hides after bad live metrics | I |
| ML-08 | Missing index/VIX | Features omitted for all rows | U |
| ML-09 | Training exceeds runner limit | Clean abort, no partial model activated | I |
| ML-10 | Quantile crossing | Sorted monotonic | U |
| ML-11 | Determinism | Same data/seed -> same metrics | U |
| ML-12 | No single target price anywhere in UI | Component test | E |

## SEC/API: security and API
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| SEC-01 | Repeated wrong password | Lockout doubling; identical message; delay | I |
| SEC-02 | Session cookie flags; hashed tokens; revoke on password change | As spec | I |
| SEC-03 | CSRF header missing on non-GET | 403 | I |
| SEC-04 | SQL injection in screener | Whitelist; parameterised; fuzz | I |
| SEC-05 | Upload hardening | Size/type checks; xlsx read-only | I |
| SEC-06 | Open redirect via `next` | Same-origin relative only | U |
| SEC-07 | Worker HMAC replay/old timestamp | Rejected | I |
| SEC-08 | Secrets in logs | Scrubber test | U |
| SEC-09 | Unauthenticated access | 401 except allowed routes | I |
| SEC-10 | Rate limit | 429 + Retry-After | I |
| SEC-11 | XSS in imported text/notes/symbol names | Escaped everywhere | E |
| SEC-12 | Password policy | Min 12, differs | U |
| API-01 | Unknown symbol | 404 | I |
| API-02 | Alias symbol | `redirect_symbol` | I |
| API-03 | Keyset pagination stability | Tested | I |
| API-04 | `range=MAX` | <= 2,000 points; < 150 kB gz | I |
| API-05 | Empty DB | `DATA_UNAVAILABLE`/empty, no 500 | I |
| API-06 | Concurrent refresh clicks | Single job | I |

## UI/SYS
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| UI-01 | API cold start (<= 70 s) | Waking state after 3 s; no error before 70 s | E |
| UI-02 | Every null shows reason | Formatter returns dash + reason | U |
| UI-03 | 320 px width | No horizontal scroll except sticky-column tables | E |
| UI-04 | Dark/light parity and contrast | Pass | E |
| UI-05 | Search 2,200 items | Opens < 100 ms; < 16 ms/keystroke | E |
| UI-06 | Offline | Banner; cached views | E |
| UI-07 | Chart with < 10 bars | Renders | E |
| UI-08 | Long names | Truncate with tooltip | E |
| UI-09 | Every API field visible somewhere | Field-coverage test against `06-frontend-spec.md` matrix | E |
| UI-10 | Every chart has a data-table view | Test per chart | E |
| SYS-01 | Neon cold start | One retry with backoff | I |
| SYS-02 | DB approaches/exceeds 380 MB (manual mode) | One Telegram notice per 70/85/95% crossing and admin warning; at 380 MB price imports rejected (`DB_SIZE_LIMIT`); imported prices never deleted automatically | I |
| SYS-03 | Late/skipped cron | Catch-up from data state | I |
| SYS-04 | Public-repo schedule auto-disable | Keepalive; checklist | M |
| SYS-05 | Overlapping job runs | Second exits `skipped` | I |
| SYS-06 | Render hours exhausted | RUNBOOK plan B | M |
| SYS-07 | Migration failure | Forward-only, transactional; rollback plan | M |
| SYS-08 | Backup restore drill | Restore encrypted dump; verify counts | M |
| SYS-09 | HMAC clock skew | 120 s tolerance | U |
| SYS-10 | Holiday list missing for the year | Weekends only (no auto-detection); persistent warning on `/admin/status`; `holidays_missing` in profile | U |
| SYS-11 | Dependency drift | Lockfiles; renovate PRs with tests | CI |
| SYS-12 | `post_import` resumes after the 3.5-minute stop | With a slow fixture set, the job stops starting new symbols at 3.5 min, stores `symbols_done/remaining` in `refresh_job.result`, sets `partial`, enqueues the remainder; `process_queued_jobs` completes it; no duplicate actions/snapshots/alerts | I |
| SYS-13 | Staleness rule | With holiday data for the year: stale when last bar < expected last trading date; without: stale only after 4 calendar days without a new bar | U |
| SYS-14 | Missing holiday year surfaces | Persistent warning on `/admin/status` and "holiday list missing" notice in the stock header chip | E |
| SYS-15 | Seed run twice (T02) | Second run changes nothing; owner-edited settings and the stored password hash are kept | I |
| SYS-16 | Seed holidays for a year that already has rows (T02) | Year skipped; only years with no rows are seeded from `config/market_holidays.json`; an empty year only warns | I |
| SYS-17 | `INITIAL_PASSWORD_HASH` is plaintext or not argon2id (T02) | Seed refuses and writes nothing | I |
| SYS-18 | Migration round trip (T02) | up, down to 0, up again on a clean DB; every table/index/named constraint of `docs/02-database.sql` exists; `import_upload` is UNLOGGED; `pg_trgm` present | I |
