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
| BRK-21 | Imported close moves more than 50% from the previous stored bar | Bar stored `suspect=true` unless a confirmed corporate action lies within one trading day; 40% moves and the reserved market series are not flagged; the detector still reads suspect bars (D03-A9); re-importing a corrected bar clears the row-level flag | I |
| BRK-22 | Prices with `high < low`, or any of open/high/low/close <= 0 | Row error (cannot be stored: DB constraints); `high` below max(open, close) or `low` above min(open, close) beyond 1e-6: stored `suspect=true` with a warning | F |

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
| ACT-15 | One-day drop of 20% or more that is not matched by the 0.35 trigger (for example a 1:2 bonus, ratio 0.667, or a real crash) | Soft notice "split/bonus or real move?" with Dismiss / Add corporate action; no `detected` action, no `UNCONFIRMED_ACTION`, ML not hidden; a drop under 20% raises nothing (D-O) | U |
| ACT-16 | Fewer than 20 bars before a candidate day (D03, assumption D03-A1) | No detection: the volume rule needs a full prior-20-bar average (a zero average is never a spike); the soft flag (ACT-15) still applies | U |
| ACT-17 | The ex-date already has a split/bonus row (owner-entered, detected or rejected) (D03) | The detector adds no second candidate; a rejected date is never re-detected (ACT-04); the soft flag is not shown for that date | I |
| ACT-18 | Ratio 2/3 and the trigger (D03, pins ACT-14) | Exactly 0.667 is not detected; only the sliver r in [0.6467, 0.65) of the 2/3 tolerance band passes the 0.35 trigger and is matched as 2/3 | U |
| ACT-19 | Soft-flag dismissal lifecycle (D-U, D03) | Dismiss inserts one `flag_dismissals` row (repeat is a no-op); Undo deletes it; per bar date (a later drop still shows); survives a prices re-import; the flag disappears once an action exists on that date | I |
| ACT-20 | Confirmed `rights`/`buyback`/`merger`/`demerger` or an untyped `split_or_bonus` (D03) | `adj_close` is never changed; the stock is listed in `review_needed` of the re-adjust result | I |
| ACT-21 | Events read API (B05) | Actions include `detected` and `rejected` with `status`; default window last 5 years (no upper bound), calendar next 90 days; `from`/`to` override both; bad dates or `to < from` -> 422; detected rows add `UNCONFIRMED_ACTION` warnings; nothing entered -> `reason = no_data_entered` | I |
| ACT-22 | Old symbol on fundamentals/shareholding/events/links (B05) | HTTP 200 with `data.redirect_symbol`; unknown symbol -> 404 | I |
| ACT-23 | Imported and manual corporate actions (B06b) | Stored `confirmed` (source `csv_import`/`manual`); repeating the same stock/ex-date/type/purpose updates one row (ACT-09); a future ex-date is stored; ratios keep the owner convention (split 10 to 2 stays 10 and 2; bonus 1:1 stays 1 and 1); split without both ratios, dividend without amount, `split_or_bonus` as a type and equal split ratios are errors; a reverse split is accepted | F/I |

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
| IMP-29 | Browser-split large prices file (`upload_group`, D-G) | Parts validate separately; commit with `upload_ids` + `upload_group` writes all parts in one transaction under one `import_batch`; one missing/expired part rolls everything back and keeps the other parts | I |
| IMP-30 | Spreadsheet, zip, UTF-16 or binary content; wrong MIME type or extension (SEC-05) | 422 on field `file` with a plain message; nothing is stored; only `.csv`/`.txt` with a CSV/text MIME are read | I |
| IMP-31 | Empty required price cell (open/high/low/close/volume); empty optional `instruments.csv` cell | Required price cell: row error naming the column, never read as 0. Optional instrument cell: on insert the column default or NULL, on update the stored value is kept | F |
| IMP-32 | `prices.csv` row uses a symbol that was renamed through `previous_symbol` | Row error "symbol OLD was renamed to NEW; use the new symbol"; never silently mapped | I |
| IMP-33 | Lower-case symbol in `instruments.csv` / Add stock form; lower-case symbol in `prices.csv` | Instruments: upper-cased with a `SYMBOL_UPPERCASED` warning (same in the form); prices: matched case-insensitively | F |
| IMP-34 | Validation and commit share one code path (`scanPrices`, `scanInstruments`) | The preview of validate equals what commit writes; commit re-validates against the current database and refuses if errors appeared since | I |
| IMP-35 | Undo scope and window (B06b) | Results, balance/cash-flow, fundamentals-long, shareholding and corporate-action batches undo once (rows removed, overwritten values not restored, `post_import` queued); a second undo, a batch older than 30 days, and `prices`/`instruments`/`holidays`/`instrument_meta`/manual batches are 409; unknown batch 404 | I |
| IMP-36 | Empty cells in the B06b kinds (B06b-2) | Wide template: an empty cell stores nothing (never 0) and a row with no values is skipped with a warning; long format: an empty `value` is stored as NULL | F/I |
| IMP-37 | Commit of the B06b kinds is atomic (B06b-5) | The batch row is created first and tags every row; a failure after the first chunk rolls back rows and batch; the upload survives and can be retried; a symbol delisted between validate and commit is caught by the commit's re-validation; `upload_ids` groups are refused for these kinds | I |
| IMP-38 | `instrument_meta` semantics (B06b-9) | Sector/industry/company_type update, empty cell keeps the stored value, non-empty `index_tags` replace that stock's memberships, unknown or delisted symbol is a row error, batch not undoable | I |
| IMP-39 | Manual-entry endpoints (B06b-10) | Numbers or numeric strings accepted, boolean cell 400, unknown field 400; 422 `details.fields` name the form field (`values.revenue`); unknown/old symbol 404; delisted 422 on `symbol`; each write leaves a `manual_form` batch with the note and queues `post_import`; 201 on insert, 200 on restatement | I |
| IMP-40 | `fundamentals_long` rules (B06b-15) | Unknown `metric_key`, a unit that differs from the key's, `period_type` not Q/A, a non-quarter-end Q period and `shares_outstanding <= 0` are row errors; cross-metric warnings (net profit vs revenue) are reported once per period | F |

## INS: instruments
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| INS-14 | `previous_symbol` rename | Matching existing instrument + new symbol free: instrument renamed, `symbol_alias` written, prices/fundamentals/portfolio links kept; new symbol already taken or no match: ignored with warning | I |
| INS-15 | Add stock form (`POST /instruments`) | 201 with id; existing symbol 409; invalid symbol/name 422 with `details.fields`; malformed ISIN or lower-case symbol are warnings (`ISIN_MALFORMED`, `SYMBOL_UPPERCASED`); same messages as the CSV validators (IMP-17 for this kind) | I |

## PRC: manual price data actions
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| PRC-21 | Delete prices for {symbol} between {from} and {to} | Preview count, confirm required, rows deleted, audit row written, `post_import` recomputes analytics/detection; `from > to` 422; other symbols untouched | I |
| PRC-22 | Trim history before {date} for chosen stocks | Preview gives rows per symbol and estimated MB freed; confirm required; unknown symbol 422; rows older than the date deleted for those stocks only; one audit row; `post_import` queued for the affected symbols; nothing deleted automatically | I |
| PRC-23 | Delete or trim that removes no rows | `deleted: 0`, no audit row, no job | I |

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
| FND-17 | Source priority and entry recency (B05) | `manual > csv_import > screener_import` per (period, metric); same source: newest entry wins; `derived` rows and NULL values are never served as metrics; `source_by_metric` and `last_updated` report the winners | U |
| FND-18 | Worker snapshot not yet written or period missing in it (B05) | `derived`/`ratios`/`valuation` null with `*_reason = not_computed`; derived series aligned to the returned periods by date | U/I |
| FND-19 | Invalid `basis` or `period` query (B05) | 422 with `details.fields[]` | I |
| FND-20 | Manual results entry and delete (B06b) | A manual period is stored with source `manual` next to any `csv_import` value; re-entering restates it (batch id updated); a unit warning still saves and is returned with its field; `DELETE` removes only manual values (404 when none, 422 for a bad query) and leaves an audit batch | I |

## SHP: shareholding
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| SHP-01 | Missing MF figure | `mf_available=false`; UI note | E |
| SHP-02 | Pledge unknown | null, not 0 | U |
| SHP-03 | No promoter | Chart still renders | U |
| SHP-04 | Single quarter | No QoQ | U |
| SHP-05 | Non-quarter-end date | Rejected | F |
| SHP-06 | Missing quarter between the last two rows (B05) | `qoq_change` all null with `qoq_reason = previous_quarter_missing` (no multi-quarter difference shown as QoQ) | U |
| SHP-07 | No shareholding entered (B05) | `quarters = []`, `reason = no_data_entered`, `mf_available=false`, entry hint | I |
| SHP-08 | Shareholding restatement (B06b-11) | `revision` only grows when a re-entered quarter differs; identical re-import or re-entry keeps it; blank pledge stays NULL and `0` is stored as 0; manual and CSV rows of one quarter overwrite each other | I |

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
| MF-80 | Adapter calls `api.mfapi.in` and `www.amfiindia.com` | Both pass the egress allow-list; any other host is refused (D04-A1) | U |
| MF-81 | mfapi list pagination | Pages of `limit=10000` until an empty page; codes repeated across pages are de-duplicated; bad items rejected and counted | U |
| MF-82 | mfapi down for several tracked schemes | AMFI file downloaded once per run; a code missing from the file is an item error; run `partial` with `amfi_fallback` codes | I |
| MF-83 | Incremental NAV fetch | `startDate = last_nav_date + 1`; no request when that date is after today; re-run never duplicates rows | I |
| MF-84 | Weekly-NAV scheme | Volatility and Sharpe-like both null (`weekly_nav`); drawdown and returns still computed | U |
| MF-85 | `sync_mf_schemes` status rule | Stale or absent-with-no-NAV schemes become `inactive`, fresh ones (also with a value date after the file date) `active`; a failed or invalid AMFI file never changes status | I |
| MF-86 | Flat or short NAV series in `mf_return_cache` | No NaN/Inf anywhere; zero volatility is 0 with Sharpe null (`n/m`); under 1Y volatility null | U |
| MF-87 | mfapi 404 for a tracked code | Item error (not an AMFI-fallback case); other schemes continue | I |
| MF-88 | XIRR golden vector (`internal/finmath`): -1000 on 2020-01-01, +1100 on 2021-01-01; no sign change; fewer than one outflow and one inflow | 0.09973 within 1e-4; monotonic in the terminal value; `ErrNoFlows` / `ErrNoSignChange` surface as null | Go: `TestXIRR*` (finmath) |
| MF-89 | Scheme search text | Words AND-ed, case-insensitive, any order; `%` and `_` in the query are literal; every value is a bind parameter; at most 12 words / 100 chars | Go: `TestMFSearchDefaultsAndGrouping`, `TestBuildSearchParameterised` |
| MF-90 | Scheme with no NAV rows opened | 200 with `backfill {status, job_id}` and warning `NO_NAV_DATA`; `mf_refresh` enqueued once; a refused enqueue (cooldown) gives `status: none` | Go: `TestMFDetailNoNavEnqueuesBackfill` |
| MF-91 | NAV series longer than 2,000 points | Downsampled to <= 2,000 points, first and last kept, ascending; `raw_count` and `downsampled` reported; unknown `range` is 422; scheme without NAV is 404 `DATA_UNAVAILABLE` | Go: `TestMFNavSeries`, `TestDownsample` |
| MF-92 | SIP `end` after the latest NAV; every installment before the first NAV | `end` clamped with warning `END_CLAMPED`; with no executed installment `value`, `xirr_pct` and `absolute_return_pct` are null (never 0) and `NO_INSTALLMENTS` is raised | Go: `TestMFSip`, `TestSIPNoInstallmentsAndShortPeriod` |
| MF-93 | SIP shorter than 30 days between first execution and end | XIRR null with `xirr_reason: period_too_short`; absolute return still shown (docs/05 8.3) | Go: `TestSIPNoInstallmentsAndShortPeriod` |
| MF-94 | Compare input | 2-5 distinct numeric codes else 422; unknown code 404; code without NAV 404 `DATA_UNAVAILABLE`; no shared NAV date in the window 422 `NO_COMMON_DATES`; invalid `range` 422 | Go: `TestMFCompare` |
| MF-95 | Scheme search plan after a bulk `sync_mf_schemes` insert | After autovacuum (or `gin_clean_pending_list`) the planner uses `mf_scheme_name_trgm`; the 10,000-scheme search is < 300 ms and cursor pages are complete and disjoint | Go: `TestMF12SearchUsesTrigramIndexAndIsFast` |

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
| ALR-58 | Alert params per kind (B12) | Each of the 13 kinds has a schema from docs/03 section 13: required fields, inclusive ranges (`pct` 0.1-50, `fast` 5-100, `slow` 20-300 and > fast, `level` 1-99, `days_before` 1-14, `delta_pct` 0.1-20), enums, `price`/`nav` > 0; numeric strings, fractional integers, unknown keys and a missing required key are 422 with `details.fields[].field = params.<key>` | U |
| ALR-59 | Kind/target mismatch (B12) | `nav_*` need a `mf` target, every other kind a `stock` target; unknown symbol or scheme is 404; symbol match is case-insensitive and resolves `symbol_alias` | I |
| ALR-60 | Link code shape (B12) | 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, shown `XXXX-XXXX`; input is case-insensitive and ignores dashes and spaces; anything else is not a code | U |
| ALR-61 | NAV threshold already met (B12) | `nav_above/below` already true at the latest imported NAV: 422 `THRESHOLD_ALREADY_MET` naming the NAV date; with no NAV yet the alert is accepted | I |
| ALR-62 | Create validation and defaults (B12) | `one_shot` defaults true, `cooldown_minutes` 1440, `expires_on` today (IST) accepted and past dates 422; unknown body fields 400; a rejected request stores nothing | I |
| ALR-63 | Alert CRUD and history (B12) | List is newest first with keyset cursor and `status` filter; PATCH pauses/resumes and replaces params (clears `last_state`); fired/expired alerts are 409; DELETE twice is 404; `/alerts/events` shows delivery status and attempts; an empty history is `[]` | I |
| ALR-64 | Link code storage (B12) | Only the sha256 is stored (no plaintext), `expires_at` = now + 15 min, expired rows are purged a day after expiry; without `TELEGRAM_BOT_USERNAME` the bot fields are null with warning `BOT_NOT_CONFIGURED` | I |
| ALR-65 | Unlink and test message (B12) | Test message needs a linked chat (409 otherwise), is sent HTML-escaped, a second one within 60 s is 429 with `Retry-After`, a send failure is 503 without the cause, no bot configured is 503; unlink clears the chat id | I |
| ALR-66 | Alert routes without a service (B12) | While no alerts service is wired the routes answer 501 `NOT_IMPLEMENTED`, never a panic | I |

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
| SEC-13 | Security headers (B01) | HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and `Cache-Control: no-store` on every response (also 404/429/501); `/stocks/index` is not forced to `no-store` | I |
| SEC-14 | Protected route reached before the session checker exists (B01) | The default checker denies everything: 401 `UNAUTHENTICATED` envelope; public routes (`/healthz`, login, Telegram webhook, broker callback) stay reachable | I |
| SEC-15 | Session sliding expiry (B02) | `last_seen_at` and `expires_at` move at most once per hour; an expired or revoked cookie is 401 | I |
| SEC-16 | Lockout bookkeeping (B02) | Attempts made while locked do not increment `failed_logins` and do not extend the lock; the correct password during a lock is refused with the identical response; a success resets the counter; lock = 15 min x 2^(lockouts-1), cap 24 h | I |
| SEC-17 | Change password with wrong current or policy failure (B02) | 422 with one `details.fields[]` entry (`current` or `new`); hash unchanged; sessions untouched | I |
| SEC-18 | Telegram webhook and CSRF (B02) | `POST /telegram/webhook` needs no `X-Requested-With` (it authenticates with its own secret header in B12); every other non-GET without it is 403, before login is evaluated (no failure counted) | I |
| SEC-19 | Log hygiene of auth (B02) | Passwords and session tokens never appear in log output, responses or the `session` table (only sha256) | I |
| SEC-60 | Webhook secret comparison (B12) | Constant-time compare over sha256 of both values; the exact secret only; a configured-empty secret never matches (fail closed, even for an empty header) | U |
| SEC-61 | Telegram client never leaks the token (B12) | API errors and transport errors (the URL contains the token) are scrubbed; the client can reach `api.telegram.org` only (egress allow-list) | U |
| SEC-62 | No secrets in responses or logs (B12) | The webhook secret and the bot token appear in no response body and no log line, including rejected webhook calls (logged as "secret header rejected" without the value) | I |
| API-01 | Unknown symbol | 404 | I |
| API-02 | Alias symbol | `redirect_symbol` | I |
| API-03 | Keyset pagination stability | Tested | I |
| API-04 | `range=MAX` | <= 2,000 points; < 150 kB gz | I |
| API-05 | Empty DB | `DATA_UNAVAILABLE`/empty, no 500 | I |
| API-06 | Concurrent refresh clicks | Single job | I |
| API-07 | Config fail-fast (B01) | Missing or invalid required variable (`DATABASE_URL`, `WORKER_HMAC_KEY` >= 32 chars, `WORKER_BASE_URL`, `BROKER_ENABLED=true`, bad tunable) stops start-up with all problems listed and never prints a value | U |
| API-08 | Router and `openapi.yaml` drift (B01) | `openapi.yaml` validates; every documented operation is registered in the router and vice versa; every stub answers with a JSON envelope (501, or 422 `BROKER_DISABLED`) | I |
| API-09 | Error mapping (B01) | Each code of docs/03 section 1 maps to its status; unknown route 404 and wrong method 405 use the envelope; a panic or a non-`AppError` becomes `INTERNAL` 500 without leaking the cause; a body above the limit gives 413 | U |
| API-10 | Pagination helper (B01) | `limit` default 50, clamped to 200, non-integer or < 1 rejected; malformed or oversized cursor rejected; an empty page serialises as `{"items":[],"next_cursor":null}` | U |
| API-20 | Symbols needing URL-encoding and case (B03) | `/stocks/M%26M`, `/stocks/m%26m`, `/stocks/BAJAJ-AUTO`, `/stocks/bajaj-auto` resolve; an instrument symbol wins over an alias of the same text | I |
| API-21 | Search LIKE metacharacters and typos (B03) | `q=%`, `q=_` match nothing (prefix match is literal); a typo in a name still matches by trigram >= 0.3; ranking exact > symbol prefix > name prefix > trigram; `kind` defaults to equity and `status` to active, other values widen it; `q` present but blank, > 100 chars, bad `kind`/`status` are 422 with `details.fields` | I |
| API-22 | Keyset pagination of a trigram-ranked search (B03) | The float similarity in the cursor round-trips exactly: paging with `limit=3` returns the same sequence as one unpaged call; no duplicates or gaps when a row is inserted between pages | I |
| API-23 | `/stocks/index` caching (B03) | ETag is a hash of the items only; `If-None-Match` gives 304 with no body; the ETag changes when the list or a flag changes; `Cache-Control: private, max-age=3600`; 2,300 instruments < 150 kB gzip | I |
| API-24 | Alias open has no side effects (B03) | A redirect response does not set `last_opened_at` or track the target stock | I |
| API-25 | Opening a tracked stock (B03) | `tracked_reason` of an already tracked stock (watchlist, portfolio, imported) is never overwritten by `opened`; concurrent opens create no job and leave one consistent state | I |
| API-26 | Profile without prices or with a young listing (B03) | `no_prices` plus hint `Import prices.csv for {symbol}`, `prices_as_of` null, never stale; `limited_history` only when the first bar is more than 7 days after max(today - PRICE_HISTORY_YEARS_TRACKED years, listing date); `series_warning` carries the series code when it is not EQ | I |
| API-27 | Expected last trading date edge cases (B03, SYS-13 helper) | Before 18:00 IST the previous trading day is expected; weekends and holidays are skipped; the IST date (not the UTC date) decides; with holiday rows the bar must be >= the expected date; without them stale only when more than 4 calendar days old | U |
| API-28 | Weekly aggregation (B04) | ISO-week candle = open of first, high max, low min, close of last, volume sum, dated with the last trading day of the week; no forward fill | U |
| API-29 | Series expansion (B04, D05a-A6) | Stored columnar `series` returns as `[[date, value]]` pairs, nulls kept at warm-up, no `dates`/`format` keys | U |
| API-36 | Detected split on prices/indicators (B04) | `UNCONFIRMED_ACTION` warning, no marker; confirmed split gives a marker `{date,type,label}`; rejected ignored | I |
| API-37 | Prices/indicators validation and aliases (B04) | Bad `range`/`adjusted`/`downsample` is 422 with `details.fields`; an old symbol answers `redirect_symbol`; bars but no snapshot gives `DATA_UNAVAILABLE` reason `no_history` | I |

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
| SAF-14 | Egress allow-list evasion (D01, D-N): host with user info (`mfapi.in@other`), suffix/prefix look-alikes, trailing dot, non-443 port, decimal/hex IPv4, IPv6 literal, `localhost`, redirect to an unlisted host or from https to http, HTTP(S)_PROXY in the environment | Every one raises `EgressDenied` on the request or the redirect hop before the inner transport is reached; proxies ignored | U |
| SEC-20 | Exact replay of a valid worker-http request inside the 120 s window (D01) | Second identical request rejected (signature cache); the job must also still be `queued` | I |
| SYS-19 | Breaker escalation and half-open (D01) | 5 failures -> 30 min; failed probe -> 2 h, then 12 h; 3 consecutive probe successes close it; state survives a new process (`source_health`); a validation error is not a source failure | I |
| SYS-20 | Stale `running` row (D01) | A running row older than 2x the job timeout is marked `failed` (`stale_run`) by the next run; a fresher row is respected and the new run is `skipped` | I |
| SYS-21 | Runner timeout and isolation (D01) | After the deadline no new item starts, the current item finishes, status `partial` with `timed_out`, `items_remaining`; one failing item never fails the run; only the first 50 errors are stored, scrubbed | U |
| SYS-22 | worker-http concurrency and kinds (D01) | A second `POST /run` while a job runs answers 409 `BUSY` and leaves its row `queued`; kinds outside `post_import`/`mf_refresh` answer 422; unknown job 404; hard cap 4 min marks the job `failed` (`hard_timeout`) | I |
| SYS-23 | One symbol of a `post_import` batch fails (D03) | Recorded in `result.failed` (first 50), the rest still run and finish, status `ok`; a missing or malformed `result.remaining` fails the job cleanly | I |
| SYS-24 | `process_queued_jobs` selection (D03) | Picks `queued` rows older than 15 minutes and `partial` rows with remaining work and no successor; ignores younger `queued` rows; stops at the job deadline and re-enqueues the rest | I |

## F01 additions (app shell, tokens, security headers)
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| SEC-21 | `next` encoded or smuggled: `/%2F%2Fevil.com`, `/%5Cevil.com`, `/\tevil.com`, `/%0d%0a//evil.com`, `//evil.com`, `https://...`, `javascript:`, over 2,048 chars, malformed `%` escape, `/login` loop | All collapse to `/`; login URL carries only a validated path (F01) | U, E |
| SEC-22 | CSP nonce | Each response carries a different nonce; no inline script runs without it; no CSP violation in the console on shell and login (F01) | E |
| UI-11 | Tokens equal the design doc | Every colour in docs/06a 3.1 and the categorical palette equals `tokens.ts`; CSS variables and the ECharts theme are generated from it; no hex literal elsewhere in `src` (F01) | U |
| UI-12 | Known contrast deviations (OQ-16) | The list of semantic text pairs under 4.5:1 and chart colours under 3:1 equals the documented list exactly; primary and secondary text pass 4.5:1 on every surface in both themes (F01) | U |
| UI-13 | Shell at 320, 375, 768, 1024, 1440 px | No horizontal scroll; bottom tabs below 1024 px with 44 px targets, sidebar from 1024 px (F01) | E |
| UI-14 | No external request at runtime | Every network request on shell, login and 404 pages is same-origin; fonts are self-hosted (F01) | E |
| UI-15 | 401 on any API call | Query caches cleared and browser sent to `/login?next=<validated path>`; the login call itself is exempt; never loops on `/login` (F01) | U |
| UI-16 | Chart colour is the only difference between series (OQ-16) | Each series also has its own marker shape, an end-of-line label and a legend glyph; bars use decal patterns; forecasts are dashed; heat cells print their value (F02) | E |
| UI-17 | Unknown, NaN or Infinity value in a chart, table, stat, gauge, range bar or sparkline | Shows a reason or "n/a", never 0, NaN or Infinity; CSV cell is empty (F02) | E |
| UI-18 | Table with more than 100 rows | Rows are virtualized (a bounded number of rows in the DOM); sorting, pinned first column and keyboard navigation still work (F02) | E |
| UI-19 | Theme changes while a chart is mounted | The chart is re-created with the new theme without reload, including when the attribute is set directly (F02) | E |
| UI-20 | axe (wcag2a/aa) on every component story, both themes | Zero violations, including colour contrast in heat cells and chips (F02) | E |
| API-30 | Refresh cooldown (B09) | A `mf_refresh` for a target whose last job finished < `REFRESH_COOLDOWN_MIN` ago gives 429 `RATE_LIMITED` with `details.retry_after_seconds` (= remaining cooldown) and a matching `Retry-After` header; allowed again after the cooldown | I |
| API-31 | Global refresh limit (B09) | At `REFRESH_GLOBAL_PER_HOUR` on-demand jobs in the last hour the next request is 429 with `retry_after_seconds` = time until the oldest ages out; no row is created; `post_import` is exempt | I |
| API-32 | Worker signal fails (B09) | Worker answers non-202 or is down: the request still returns 202, the row stays `queued`, nothing is retried with the same signature | I |
| API-33 | `post_import` enqueue (B09) | Target `batch:<id>`, `result` = `symbols_total`, `symbols_done=0`, ordered `remaining` (`[]` not null when empty); an active job for the same target is returned instead of a second row; after it is `partial` a continuation row is allowed | I |
| API-34 | `GET /jobs/{id}` (B09) | Returns id, kind, target, status, requested_at, started_at, finished_at, error, result (nulls kept); unknown id 404; non-numeric id 422; no session 401 | I |
| API-35 | `POST /mf/schemes/{code}/refresh` input (B09) | Non-numeric, zero, negative or out-of-range code 422 with `details.fields`; unknown scheme 404; missing CSRF header 403 | I |
| SEC-40 | Go signer golden vector (B09) | `jobs.Sign` for fixed key/ts/method/path/body equals the value produced by `worker.http.sign` (Python) | U |
| SEC-41 | Worker signature checks as the Go caller meets them (B09) | A fake worker mirroring `worker/http.py` accepts the Go call (unix-second `X-Timestamp`, path `/run`), and rejects a timestamp 121 s old or ahead, a wrong signature, a tampered body and an exact replay | I |
## IND/RET: indicators, returns and risk (D05a)
| ID | Case | Expected | Type |
|---|---|---|---|
| IND-81 | EMA seed and warm-up (D05a) | Seeded with the SMA of the first n values; within 1e-6 of pandas `ewm(span=n, adjust=False)` after 3n bars; warm-up null | U |
| IND-82 | RSI Wilder (D05a) | Matches a naive Wilder reference; all gains -> 100, flat -> 50, all losses -> 0; first value at bar 15 | U |
| IND-83 | MACD (D05a) | Linear series gives exactly 7 after bar 26; signal valid after 34 bars; earlier positions null | U |
| IND-84 | Bollinger (D05a) | Population std (ddof=0); zero-width band -> `bb_pos` null | U |
| IND-85 | TR/ATR/ADX Wilder (D05a) | Hand-computed values for ATR(3) and ADX(2); flat market DX 0; ADX needs 2n bars | U |
| IND-86 | Stochastic (D05a) | Hand values; HH == LL -> 50 | U |
| IND-87 | OBV (D05a) | Sign of the close change times volume, starting at 0 | U |
| IND-88 | Volume z-score (D05a) | Prior 20 bars exclude today; std 0 -> null | U |
| IND-89 | 52-week range (D05a) | Uses H/L scaled by adj_close/close; null with < 252 rows; distance in percent | U |
| IND-90 | Support/resistance (D05a) | Swing levels clustered within 1.5%, nearest first, max 3 per side; the last 5 bars never form a swing | U |
| IND-91 | Golden/death cross (D05a) | Detected only inside the last 20 bars; null without SMA200 | U |
| IND-92 | Under 60 valid bars / suspect rows (D05a) | No snapshot; suspect rows are excluded before anything else, nothing forward-filled | U |
| RET-81 | Trading-row returns (D05a) | `C_t/C_{t-N}-1` as percent; N+1 rows needed else null `insufficient_history` | U |
| RET-82 | Calendar returns (D05a) | Base = last bar on or before end minus offset (month-end clamped); first bar later -> null | U |
| RET-83 | CAGR (D05a) | Only for windows over one year, `365.25/days` exponent; others `not_applicable` | U |
| RET-84 | Volatility (D05a) | Sample std of log returns x sqrt(252) in percent, hand-computed value | U |
| RET-85 | Max drawdown (D05a) | Own running maximum per window; whole window required | U |
| RET-86 | Beta/correlation (D05a) | Inner join on dates; >= 120 aligned returns; reasons `no_benchmark` / `insufficient_overlap` / `n/m` | U |
| RET-87 | Sharpe-like (D05a) | `(CAGR_3y - RISK_FREE_RATE)/vol_3y`; null without 3 years or with zero vol | U |
| RET-88 | Liquidity (D05a) | `mean(close*volume)` over 60 rows in INR crore; null below 60 rows | U |
| RET-89 | No NaN/Infinity (D05a) | Snapshot is strict-JSON safe; every null scalar has a reason in `null_reasons`; latest snapshot stays under 200 KB | U |
| RET-90 | Snapshot lifecycle (D05a) | Idempotent per `as_of`, scores untouched, latest 30 kept, only newest holds series, stale snapshots removed after delete/trim | I |
| RET-91 | Stock warnings (D05a) | `UNCONFIRMED_ACTION` / `ADJUSTMENT_CONFLICT` come from `actions_db.stock_warnings()` | I |
| RET-92 | screener_row price metrics (D05a) | Only whitelisted price keys replaced; D05b keys kept; nulls omitted | I |
| RET-93 | post_import wiring (D05a) | Analysis per symbol, screener after the last symbol, resumable, no duplicates | I |
