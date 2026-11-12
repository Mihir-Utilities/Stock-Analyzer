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
| ACT-24 | Suspect bars and the volume average (D03 review) | Suspect bars are excluded from the prior-20 average (the next clean bars fill the window; fewer than 20 clean bars means no detection); the suspect split-day bar itself (>50% jump rule) is still detected | U/I |
| ACT-25 | A multi-month hole between the two compared bars (D03 review, OPEN_QUESTIONS D03R-1) | The candidate is still produced (trigger unchanged) but reported as `low_confidence` in the job summary when the bars are more than 14 calendar days apart | U |
| ACT-26 | PATCH confirm/reject of a detected action (B07) | Confirm needs `action_type` split or bonus and both ratios (422 otherwise), stores them, returns the multiplier (10:2 gives 5), queues `post_import` target `action:<id>`; reject is sticky (a rejected candidate cannot be confirmed, 409); repeats are idempotent (`changed=false`); a confirmed action cannot be rejected; a multiplier more than 3% from the detected 1/r gives warning `RATIO_DISAGREES_WITH_DETECTED` but is accepted (ACT-06); a future ex-date is confirmed and flagged `future_ex_date` (ACT-10) | I |
| ACT-27 | A confirmed split/bonus (manual or CSV) already exists on the ex-date of a `detected` row (B06b-12) | Confirming the detected row is refused with 409 (the history would be adjusted twice); rejecting it works; 8 concurrent confirms of one candidate change it once (row lock) | I |
| ACT-28 | PATCH on another stock's action id, unknown id or symbol, no session, no CSRF header | 404 (no IDOR, nothing changed), 401, 403; a queue failure keeps the decision and adds `POST_IMPORT_NOT_QUEUED`, a repeat retries the enqueue | I |
| ACT-20 | Confirmed `rights`/`buyback`/`merger`/`demerger` or an untyped `split_or_bonus` (D03) | `adj_close` is never changed; the stock is listed in `review_needed` of the re-adjust result | I |
| ACT-21 | Events read API (B05) | Actions include `detected` and `rejected` with `status`; default window last 5 years (no upper bound), calendar next 90 days; `from`/`to` override both; bad dates or `to < from` -> 422; detected rows add `UNCONFIRMED_ACTION` warnings; nothing entered -> `reason = no_data_entered` | I |
| ACT-22 | Old symbol on fundamentals/shareholding/events/links (B05) | HTTP 200 with `data.redirect_symbol`; unknown symbol -> 404 | I |
| ACT-23 | Imported and manual corporate actions (B06b) | Stored `confirmed` (source `csv_import`/`manual`); repeating the same stock/ex-date/type/purpose updates one row (ACT-09); a future ex-date is stored; ratios keep the owner convention (split 10 to 2 stays 10 and 2; bonus 1:1 stays 1 and 1); split without both ratios, dividend without amount, `split_or_bonus` as a type and equal split ratios are errors; a reverse split is accepted | F/I |
| ACT-29 | Manual or CSV split/bonus on the ex-date of a confirmed or pending split/bonus (B07R-1, ACT-27b) | Row stored; manual warning `DUPLICATE_EX_DATE_ACTION` names the existing action id; CSV `warnings` carries the code (also for two rows of one file); a repeat of the same key, another date or a non-split type is silent; insert and confirm for one (stock, ex-date) are serialised by an advisory lock (test holds the lock and both calls queue behind it) | I |
| ACT-30 | Two confirmed rows of the same type on one stock and ex-date (B07R-1c) | The worker applies only the lowest id (adj_close divided once, never twice), returns `warnings=['ADJUSTMENT_DUPLICATE_ACTION']` and `stock_warnings()` repeats it; a split plus a bonus on one day still combine | I |
| ACT-31 | PATCH confirm edge cases (B07R-3) | Empty confirm 422 without changing the row; confirm of a manual-source confirmed row with numbers 409; confirmed candidate with other numbers or another type 409; reverse split 2:10 gives multiplier 0.2000 and no warning; a detected row with NULL ratios confirms silently; 3% band over HTTP (5.145 and 5.15 silent, 5.155 warns); `ratio_num` 1e8 is 422 and the row is unchanged | I |
| ACT-32 | `RATIO_EXTREME` (B07R-2) | Multiplier above 100 or below 0.01 warns and is accepted (100 and 0.01 are silent; 99999999.9999 fits and warns) | I |
| ACT-33 | IST date rollover of `future_ex_date` (B07R-3) | At 18:30 UTC (00:00 IST) the next day is today, not future; at 18:29 UTC it is still tomorrow; the day after is future | I |
| ACT-34 | Confirm over `src_adjusted` bars (D-K, B07R-3) | Warning `ADJUSTMENT_SKIPPED_SRC_ADJUSTED` when the ex-date bar or the bar before is already adjusted; none for raw bars | I |
| ACT-35 | Repeat confirm/reject (B07R-5) | Each repeat answers `changed=false` and enqueues `post_import` again (retry path), returning the job id | I |

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
| IMP-50 | Import wizard shows file errors (F13a) | Every error and warning names its row and column (file-level header errors show "File"), the list says when it is cut at 200 of N, Next/commit is blocked while errors exist, nothing is committed | U |
| IMP-51 | Prices wizard review step (F13a) | Required raw / already adjusted / I don't know choice blocks Next while unset; raw/adjusted persist via PUT; changing a stored value asks for confirmation (`confirm=true`); I don't know persists nothing and opens the Adjustment check; estimated growth and the size-guard message block when current size + growth > 380 MB; an unavailable size read does not block (the server decides) | U |
| IMP-52 | Wizard result and failures (F13a) | Commit needs a ConfirmDialog; result shows inserted/updated/renamed and warning sentences; prices and instruments batches show no Undo (the API answers 409); commit 404 offers Start over; `PRICES_ADJUSTMENT_UNSET` and `DB_SIZE_LIMIT` return to the review step with a plain message | U |
| IMP-30 | Spreadsheet, zip, UTF-16 or binary content; wrong MIME type or extension (SEC-05) | 422 on field `file` with a plain message; nothing is stored; only `.csv`/`.txt` with a CSV/text MIME are read | I |
| IMP-31 | Empty required price cell (open/high/low/close/volume); empty optional `instruments.csv` cell | Required price cell: row error naming the column, never read as 0. Optional instrument cell: on insert the column default or NULL, on update the stored value is kept | F |
| IMP-32 | `prices.csv` row uses a symbol that was renamed through `previous_symbol` | Row error "symbol OLD was renamed to NEW; use the new symbol"; never silently mapped | I |
| IMP-33 | Lower-case symbol in `instruments.csv` / Add stock form; lower-case symbol in `prices.csv` | Instruments: upper-cased with a `SYMBOL_UPPERCASED` warning (same in the form); prices: matched case-insensitively | F |
| IMP-34 | Validation and commit share one code path (`scanPrices`, `scanInstruments`) | The preview of validate equals what commit writes; commit re-validates against the current database and refuses if errors appeared since | I |
| IMP-35 | Leading-zero comma number (`0,123`, `00,123`, `0,5`) | Rejected as a decimal comma, never read as 123; `1,234.56` and `1,23,456.78` still accepted | U (`TestCleanNumber`) |
| IMP-36 | Date before 1990-01-01 (`0001-01-01`, `1800-01-01`) in prices or `listing_date` | Row error naming the floor; future price dates stay row errors | U (`TestParseDate`, `TestSymbolLookalikesRejectedInPrices`) |
| IMP-37 | Look-alike letters in a symbol (dotless i, long s); leading `-`/`&`, lone `-`, `=` start | Symbol charset error on both the prices and the instruments path (ASCII-only normaliser) | U (`TestValidateInstrumentFields`) |
| IMP-38 | Size guard near the limit: all-update re-import vs all-new file; the upload's own bytes | Growth = NEW rows x 130 B and the current upload is excluded: the re-import commits, the all-new file is `DB_SIZE_LIMIT` | I (`TestSizeGuardCountsOnlyNewRows`) |
| IMP-39 | More than 10 outstanding validated uploads or 100 MB of them | 429 `RATE_LIMITED` with `Retry-After`; an expired upload frees its slot and expired rows are purged on every validate | I (`TestUploadCap`, `TestImportUploadCapAndBinaryHTTP`) |
| IMP-40 | Commit with more than 10 upload ids or more than 50 MB of parts | 422 on `upload_ids` before any content is loaded; uploads kept | I (`TestCommitCaps`) |
| IMP-41 | Same (symbol, date) with different values in two parts of one group | Commit refused with the row error count, nothing written; identical values only warn | I (`TestUploadGroupCommit`) |
| IMP-42 | Text starting with `=`/`+`/`-`/`@` imported as a name; export | Stored verbatim; `SafeCSVCell` prefixes a quote on export | I (`TestFormulaTextStoredAndExportSafe`) |
| IMP-43 | 300,000-row scan without a database; late-chunk failure of an instruments import; CRLF-only file; lone-CR file | Bounded heap; whole import rolled back; CRLF parses; lone CR refused with a plain message | U/I (`TestScanPricesStreamingMemoryBound`, `TestInstrumentsRollbackOnChunk`, `TestLineEndingsCRLFAndLoneCR`) |
| JOB-ATOMIC | 40 parallel enqueues for different targets with `REFRESH_GLOBAL_PER_HOUR` = 5 | Exactly 5 jobs; the rest 429 (check and insert are atomic under an advisory lock) | I (`TestParallelEnqueueHonoursGlobalLimit`) |
| IMP-44 | Undo scope and window (B06b) | Results, balance/cash-flow, fundamentals-long, shareholding and corporate-action batches undo once (rows removed, overwritten values not restored, `post_import` queued); a second undo, a batch older than 30 days, and `prices`/`instruments`/`holidays`/`instrument_meta`/manual batches are 409; unknown batch 404 | I |
| IMP-45 | Empty cells in the B06b kinds (B06b-2) | Wide template: an empty cell stores nothing (never 0) and a row with no values is skipped with a warning; long format: an empty `value` is stored as NULL | F/I |
| IMP-46 | Commit of the B06b kinds is atomic (B06b-5) | The batch row is created first and tags every row; a failure after the first chunk rolls back rows and batch; the upload survives and can be retried; a symbol delisted between validate and commit is caught by the commit's re-validation; `upload_ids` groups are refused for these kinds | I |
| IMP-47 | `instrument_meta` semantics (B06b-9) | Sector/industry/company_type update, empty cell keeps the stored value, non-empty `index_tags` replace that stock's memberships, unknown or delisted symbol is a row error, batch not undoable | I |
| IMP-48 | Manual-entry endpoints (B06b-10) | Numbers or numeric strings accepted, boolean cell 400, unknown field 400; 422 `details.fields` name the form field (`values.revenue`); unknown/old symbol 404; delisted 422 on `symbol`; each write leaves a `manual_form` batch with the note and queues `post_import`; 201 on insert, 200 on restatement | I |
| IMP-49 | `fundamentals_long` rules (B06b-15) | Unknown `metric_key`, a unit that differs from the key's, `period_type` not Q/A, a non-quarter-end Q period and `shares_outstanding <= 0` are row errors; cross-metric warnings (net profit vs revenue) are reported once per period | F |
| IMP-53 | Undo of corporate actions with dependents (B08-1) | A confirmed imported action with a `portfolio_adjustment` -> undo is 409 `UNDO_HAS_DEPENDENTS`, nothing deleted and the batch not marked undone; after the adjustment is removed the undo works; a stray FK violation (23503) maps to the same 409, never a 500 | I |
| IMP-54 | Queue failure warning on every write (B06b-1) | With a failing enqueuer manual POST, manual DELETE and undo return `POST_IMPORT_NOT_QUEUED` and still save; a healthy queue adds no warning | I |
| IMP-55 | Undo of a re-imported identical file (B08-5) | Import, re-import, undo the second: removed rows listed with `UNDO_REMOVES_EARLIER_IMPORT` and `earlier_batch_ids`; undo the older: `UNDO_REMOVED_NOTHING`; a different file gives no warning | I |
| IMP-56 | Manual number and key hygiene (B08-6/7) | JSON number `1e5` -> 422 "exponent notation not accepted" (never accepted); `values` keys `Revenue` and `revenue` -> 422 "duplicate key", nothing written | I |

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
| PRC-24 | Storage tab meter and forms (F13a) | DB size vs 380 MB with marks at 70/85/95% and a text warning (not colour alone); `/admin/status` unavailable shows an error card, never 0 MB; the Trim history preview is discarded when the selection or date changes; Delete prices rejects from > to before any request | U |

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
| FND-90 | Derived block older than the entered values (B05 review) | `derived_as_of` = snapshot `as_of` (null without a snapshot); `DERIVED_STALE` when a value was fetched on a later IST day | Go: `TestDerivedAsOfAndStale`, `TestFundamentalsDerivedAsOfAndStaleWarning` |
| FND-91 | A metric whose periods come from different sources | `MIXED_SOURCES` warning lists it; `source_by_metric` stays the latest period's source | Go: `TestSourceByMetricFlagsMixedSources`, `TestFundamentalsMixedSourcesWarning` |

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
| SHP-09 | Screener holder keys (D05b) | Latest quarter values; pledge unknown absent (never 0); QoQ changes only for consecutive quarters 70 to 111 days apart; single quarter has no QoQ; no promoter still reports the others | U/I (`test_shp0*`, `test_shp_db_*`) |

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
| MF-83 | Incremental NAV fetch | `startDate = last stored date` (amended by D04R-2: the last date is re-fetched so a corrected NAV is refreshed); no request when that date is after today; re-run never duplicates rows | I |
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
| MF-96 | SIP `end` on a Saturday and `day` equal to it (MF-10 variant) | The installment whose next NAV is after `end` is skipped and counted; no post-End purchase, no cash flow dated after the terminal flow | Go: `TestSIPInstallmentOnNonNAVDayAtEndIsSkipped` |
| MF-97 | Search after a NAV refresh and before the cache recompute | `latest_nav` and `last_nav_date` come from the same cache row | Go: `TestMFSearchNavDateMatchesNav` |
| MF-98 | NUL byte or invalid UTF-8 in `q`, `category`, `fund_house` | 422 `UNPROCESSABLE`, never 500 | Go: `TestMFParamsRejectNulAndInvalidUTF8` |
| MF-99 | Search `meta.as_of` | Newest NAV date on the page; now only when the page has none | Go: `TestMFSearchMetaAsOfIsDataDate` |
| MF-100 | Scheme detail with no NAV rows | Every `r_*` key present as `null` with reason `no_nav_yet` | Go: `TestMFDetailNoNavHasNullReturnsWithReasons` |
| MF-101 | Cached `rolling_1y` and `nav_jumps` | Reach the detail response unchanged | Go: `TestMFDetailPassesRollingAndJumpsThrough` |
| MF-102 | Compare with no shared NAV date | 422 `UNPROCESSABLE`, `details.reason = no_common_dates` (no private code) | Go: `TestMFCompareNoCommonDatesUsesDocumentedCode` |
| MF-103 | NAV series above 2,000 points with one spike | LTTB keeps the spike; first and last kept | Go: `TestDownsampleKeepsNavPeak` |
| MF-104 | XIRR with all flows on one date summing to zero, or no convergence in 200 iterations | `ErrNoSignChange` / `ErrNoConvergence` (never -0.9999 or a half-converged rate); SIP shows `xirr_pct` null with `no_solution` | Go: `TestXIRRSameDateZeroSum`, `TestXIRRNonConvergence` |
| MF-110 | 3Y series without a leap day (1,095 days) (D04 review) | `returns.3y` and Sharpe both present (gate is the base NAV at or before end-36M, not year length); one day shorter: both null | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf110_*` |
| MF-111 | Hostile AMFI rows (code `²`, Arabic-Indic digits, 11-digit code, over-long NAV, Unicode date, 5,000-char line) (D04 review) | Each row is rejected and counted by reason, the parse continues, no exception | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf111_*` |
| MF-112 | NAV above 10,000,000 or with more than 12 digits (D04R-3) | Row rejected (AMFI and mfapi), never sent to the database | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf112_*` |
| MF-113 | AMFI file with 1 row, or under 50% of the previous applied file (D04R-1) | Statuses untouched, job `partial` with `status_skipped`, rows still upserted; first run uses only the 5,000 floor | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf113_*` |
| MF-114 | Response body above the cap (declared length or streamed without length) (D04R-3) | Aborted at the cap, `SchemaError`, no retry, breaker untouched | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf114_*` |
| MF-115 | NaN or Infinity in `mf_return_cache.metrics` | `save_cache` raises before any SQL (`allow_nan=False`) | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf115_*` |
| MF-116 | Source corrects the NAV of the last stored date (D04R-2; amends MF-83) | Next run requests `startDate = last stored date` and the corrected NAV replaces the old one without duplicates | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf116_*` |
| MF-117 | One shared `subtract_months` (returns and MF) | Same function object; month-end clamping (31 Mar - 1 = 28 Feb, 29 Feb - 12M = 28 Feb, 31 Oct - 4 = 30 Jun) | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf117_*` |
| MF-118 | Duplicate scheme codes in the AMFI file (D04R-6) | Last row wins, `duplicates` counted, `amfi_duplicates` in the job summary | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_mf118_*` |

## PF: portfolio
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| PF-01 | Sell more than held | 422 `INSUFFICIENT_HOLDINGS` | I |
| PF-02 | Edit/delete earlier buy invalidating later sell | Rejected | I |
| PF-03 | Fractional quantity (4 dp) | Accepted | U |
| PF-04 | Same-day buy and sell | Ordered by id; buys before sells | U |
| PF-05 | Date before listing/future | 422 | I |
| PF-06 | Weekend/holiday trade date | Warning only | U |
| PF-07 | XIRR undefined/short span (amended by MFH-3, 2026-11-11: the one-year rule replaces the 30-day rule) | A span under 365 days: `xirr_pct` null with `xirr_reason: under_one_year` and the absolute return shown; `period_too_short` only when the absolute return itself cannot be computed; no sign change null | U |
| PF-08 | Fully sold position | Realized retained; hidden by default | E |
| PF-09 | Split after purchase | Qty/cost adjusted; value invariant | U/E |
| PF-10 | Missing price | Last close, flagged stale; none -> null | U |
| PF-11 | Idempotency-Key | No duplicates | I |
| PF-12 | Decimal precision (0.1+0.2) | Exact to 4 dp | U |
| PF-13 | Delisted holding | Kept, flagged | I |
| PF-14 | Fee capitalization | In cost, reduces proceeds | U |
| PF-15 | Symbol change | Follows alias | I |
| PF-16 | Parallel retries with the same Idempotency-Key | Exactly one row, every call 201 with the same body | I |
| PF-17 | Same key with a different body; expired key (> 24 h); malformed key | 409 CONFLICT; treated as new; 422 | I |
| PF-18 | Owner override of an ex-date multiplier | Replaces the confirmed action of that date; an override that would oversell a stored sell is rejected 422 and not stored; a second override for the same date 409 | I |
| PF-19 | Watchlist add/remove tracking (docs/03 section 11) | Add sets tracked with reason watchlist (never downgrades portfolio); remove keeps imported prices and keeps the stock tracked while portfolio or imported prices justify it; nothing is deleted | I |
| PF-22 | Benchmark when the owner's sales outperform NIFTY (B11-10) | Benchmark XIRR is computed (units may go negative), never `benchmark_units_negative` | U |
| PF-23 | XIRR short-span rules on a closed position (B11-11; amended by B15 review S3, B15R-4) | The span of a fully exited position runs from its first flow to its **last flow** (no terminal value). Opened and closed within 5 days, viewed a year later: the equity view says `n/a (period too short)`; a 60-day round trip viewed a year later shows `under_one_year` with the absolute return (the one-year rule of docs/05 8.5.6 supersedes the 30-day rule once MF is built); a closed position older than one year computes | U |
| PF-24 | Buy on a stock whose stored sequence already oversells (B11-13) | The buy is accepted (201), `HOLDINGS_INCONSISTENT` still reported; a sell is 422 | I |
| PF-25 | Override that would invalidate a stored sell (B11-12) | 422 `INSUFFICIENT_HOLDINGS` naming the override (`details.adjustment_date`); nothing stored | I |
| PF-20 | Missing price or no open holding in the summary | Market value, unrealized and XIRR are null with a reason, warning MISSING_PRICE; never 0 | U/I |
| PF-21 | Latest bar older than a confirmed split, or a split between the last two bars | LTP converted to current units so value stays invariant; day change null with reason `corporate_action_in_window` | U |

| PF-26 | Side or date filter selected while the matching rows are on an unloaded page (F11 review) | The empty state says "No match in the loaded rows yet" and Load more stays available; page 2 rows appear | U |
| PF-27 | Save fails with a network error or timeout (reply may be lost), then the owner edits a field and saves (F11 review) | Same body: same Idempotency-Key. The list is refetched on a network error. The message says to check the list before changing values; a changed body gets a new key and a warning. A 409 burns the key (next press uses a new one) with its own message | U |
| PF-28 | Edit form with nothing changed, or only the note changed (F11 review) | Save is disabled and no request is sent; a note-only edit sends `{note}`; "100" typed over "100.0000" is not a change | U |
| PF-29 | Client validation parity with the server (F11 review) | Price or fees above 1e13 and impossible dates (2026-02-31, 2025-02-29) are rejected before sending; the listing-date 422 is shown from the server on the field and in the error summary | U |
| PF-30 | Closing the add or edit form (F11 review) | Focus returns to Add transaction or the row's Edit button; a polite live region announces the result | U |
| PF-31 | "vs Nifty 50" delta wording (F11 review) | `You: +2.0 pts vs Nifty`, `You: -3.5 pts vs Nifty`, `You: 0.0 pts vs Nifty` (your XIRR minus the benchmark) | U |

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
| ALR-67 | Alert evaluation per kind (D06) | `price_*` on `close`; `day_change_pct` on `adj_close`; `wk52_*` need 252 prior bars and use k-scaled highs/lows; MA cross and RSI cross use consecutive values; NAV alerts use `mf_nav`; a NULL `last_state` evaluates the latest bar only; `results_declared` / `holding_change` initialise silently; each fire carries a dedupe key with its bar date, event, period or quarter | U |
| ALR-68 | Delivery pass without a bot token (D-9, D06) | Events stay `pending` with `last_error=bot_not_configured`, no attempt counted, no exception; the owner notifier only logs | I |
| ALR-69 | Concurrent delivery runs (D06) | A claim leases events for 15 min and counts one attempt; four parallel runs send each event once | I |
| ALR-70 | Telegram error mapping (D06) | 429 carries `retry_after` and stops the pass (unsent events released); 403/400 become `telegram_http_<status>: <description>`; network errors never include the URL or token | U |
| ALR-71 | Recurring alert re-arm (D06) | After a fire the alert is disarmed; it re-arms only after the price moves 0.5% back across the threshold, and a fire inside the cooldown is swallowed | U |
| ALR-72 | Owner links after events piled up (docs/04 3.9 step 5) | The first linked pass marks never-attempted events older than 24 h `failed(not_linked)` and sends only the younger ones | I |
| ALR-73 | News imported between alert creation and first evaluation (D06-14) | `results_declared` / `holding_change` fire; with no news the first run stays silent | I |
| ALR-74 | Valid link code from a second chat while linked (B12-11) | Not rebound, code not consumed, fixed reply; works after unlink; same chat may re-link | I |
| ALR-75 | Repeated failed `/start` attempts (B12-11) | After 10 in 15 minutes nothing is processed or answered until the window passes | I |
| ALR-76 | Webhook flood (B12-11) | Per-IP 429 `RATE_LIMITED`; a few rejected secrets log at Debug, not Warn | I |
| ALR-77 | Price/NAV threshold already met at the boundary | Inclusive, compared in decimal (`thresholdMet`) | U |

## ML: predictions
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| ML-01 | Lookahead | Changing prices after `t` leaves features at `t` unchanged | U |
| ML-02 | Label alignment with holidays | A label is exactly h trading days ahead (holidays skipped); a window whose target day has no bar, or a bar on a non-trading day, has a NaN label (D07-19) | U |
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
| ML-13 | Cross-sectional rank at `t` uses only stocks on date `t`; a date with one stock drops the row | Per-date ranks unchanged when other dates change | U |
| ML-14 | Random-noise data (guardrail function over 150 seeds, a calibrated near-0.5 weakly correlated model over 60 seeds, and full LightGBM runs on both horizons 5 and 21) | Never passes the guardrail; the `auc_mean` check is what blocks the LightGBM noise runs | U |
| ML-15 | Each guardrail condition alone; fewer than 12 folds; only the last 8 folds count; deterministic verdict | The bootstrap lower bound alone blocks a good fold-mean AUC; fails with the named check / `insufficient_folds` | U |
| ML-16 | Conformal band calibration | Coverage 80% on fresh data, small-sample coverage at least 80%, median stays inside the band | U |
| ML-17 | Outcome resolution | `realized`, `direction_correct`, `in_band` per docs/05 10.7; flat return is not "up"; unknown inputs give null | U |
| ML-18 | `predict` twice for the same `as_of`; gated model | Stored rows are never rewritten; gated values stored with `shown=false` | I |
| ML-19 | Activation rule | Passing horizon -> active and previous retired; failing -> candidate without artifact, older active kept; newer passing run replaces a gated one | I |
| ML-20 | Universe selection | Stock with < 750 bars or an unconfirmed action is excluded with a reason; a model trained on other features is not used | I/U |
| ML-21 | Market series gaps | Filled forward by at most one row, longer gaps drop the row | U |
| ML-22 | Calibration purge (ML-03 for the calibration set) | Isotonic and conformal fits of fold k never use an earlier out-of-fold row whose label window reaches fold k; the final calibrator uses all; isotonic output stays inside [0.001, 0.999] | U |
| ML-23 | Live gate evidence | 100 resolved rows on fewer than 20 distinct dates never trip; a live AUC that cannot be computed (one class) is insufficient, not a pass (D07-17) | U/I |
| ML-24 | `predict` with fewer than 20 eligible stocks | Writes nothing, status `insufficient_universe` even when an active model exists | I |
| ML-25 | Newer failing run | Stored as `candidate` without artifact and sets `guardrail_pass=false` on the older active pair (hidden, tracked); a later passing run replaces it and is shown at once | I |
| ML-26 | Recovery after a live trip | A newer passing run starts gated (`live_recovery`); shown only after >= 100 resolved on >= 20 dates without a trip; 99 rows, a trip, or an intervening passing run do not shortcut it (D07-18) | I |
| ML-28 | Horizon with no model (`insufficient_folds`) | No `model_run` rows, no hidden prediction rows, `no_model`; `rows_written` counts only horizons with a model | I |
| ML-29 | Outcome horizon | Resolved on exactly the h-th trading day (holidays skipped); a missing bar on that day leaves the prediction pending, a later bar does not stand in for it | I |
| ML-30 | `predict` after `process_queued_jobs` | Result under `details.predict`; skipped (`no_model`, `no_new_bar`); a failure is logged with a traceback and never fails the queue; `CancelledError` propagates | U/I |

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
| API-90 | Index tags `NEXT50`, `NIFTY 100`, `Next 50` (B03 review) | All three set `in_nifty100`; an unrelated index does not | Go: `TestIndexFlagsNext50` |
| API-91 | Profile of a stock whose only bars are suspect (B03/B04 review, BRK-07, BRK-08) | `no_prices` true, `prices_as_of` null, hint shown, exactly like `/prices` (404 `no_prices_imported`); with an older valid bar `prices_as_of` is that bar | Go: `TestProfileIgnoresSuspectBars` |
| API-92 | NUL byte or invalid UTF-8 in `q`, `sector`, `index` or a path symbol (B03/B04 review) | Filters: 422 `UNPROCESSABLE`; path symbols (`/stocks/{symbol}`, `/prices`, `/indicators`): 404; never 500 | Go: `TestNulAndInvalidUTF8AreRejected` |
| API-93 | Percent in a path symbol | Decoded exactly once: `A%2541` finds the symbol `A%41`, not `AA` | Go: `TestSymbolPathIsNotDoubleDecoded` |
| API-94 | `/prices` and `/indicators` without a session | 401 | Go: `TestPricesRequireSession` |
| API-95 | 41 years of daily bars with `range=MAX` (LTTB branch) | Exactly 2,000 weekly points, first and last candle kept, < 150 kB gzip | Go: `TestPricesMaxRangeBudgetLTTB` |
| API-96 | Indicator series longer than 750 points | Every series pair array is cut to the most recent 750 | Go: `TestIndicatorsSeriesCap750` |
| API-97 | Research link placeholder inside the URL path | Spaces become `%20` (not `+`); placeholders after `?` keep query escaping | Go: `TestRenderLinksPathPlaceholderUsesPathEscape` |

## UI/SYS
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| UI-01 | API cold start (<= 70 s) | Waking state after 3 s; no error before 70 s | E |
| UI-02 | Every null shows reason | Formatter returns dash + reason | U |
| UI-03 | 320 px width | No horizontal scroll except sticky-column tables | E |
| UI-04 | Dark/light parity and contrast | Pass | E |
| UI-05 | Search 2,200 items | Opens < 100 ms; < 16 ms/keystroke | E |
| UI-06 | Offline | Banner while `navigator.onLine` is false; already loaded screens keep their data. The service worker caches the app shell only (offline page, icons, hashed static files), never an API response or a page, so there are no cached data views (see UI-06b, PWA-02) | E |
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
| SYS-25 | Stale `queued` job of any kind (docs/04 3.13, B09 review) | `process_queued_jobs` runs a `queued` > 15 min `mf_refresh` through its handler; younger rows and kinds without a handler are left alone; a failing handler marks the row `failed` and frees the active-job index | I |
| SYS-26 | Crash leftovers (docs/04 3.13) | A `refresh_job` `running` longer than 40 minutes is reaped at the start of `process_queued_jobs`: `failed` with a reason, or `partial` for a `post_import` with symbols left; a younger `running` row is untouched | I |
| SYS-27 | Hard cap mid-symbol (docs/04 4) | The 4-minute cap keeps `refresh_job.result` (never NULL); a `post_import` becomes `partial` with `hard_timeout`, keeps `remaining`, and the next `process_queued_jobs` resumes it without redoing finished symbols; other kinds become `failed` | I |
| SYS-28 | `post_import` stage (docs/03 section 7) | `result.stage` is `detect_actions`, `compute_analysis`, `alerts` while a symbol runs and is visible in `GET /jobs/{id}` | I |
| SYS-29 | Detected-action note from worker-http and `process_queued_jobs` (docs/04 3.2) | Production wiring sends exactly one Telegram note per new action (none on a re-run); without `TELEGRAM_BOT_TOKEN`, without a linked chat or when the send fails it is skipped with a status and the job still succeeds | I |
| SYS-30 | Two batches with the same symbols run at once (worker-http plus `process_queued_jobs`) | One `corporate_action` and one note per symbol, both jobs `ok` | I |
| SYS-31 | 3.5-minute stop with a symbol in flight | The symbol in flight completes and is counted, the next one is not started, `remaining` and the continuation row hold the rest | U |
| SYS-32 | Holiday year with clearing rows only (B08-9) | The seed counts only `trading` rows: a year with only `clearing` rows is seeded; same rule as calendar reads | I |
| SYS-33 | Concurrent jobs update one `source_health` row (D01 review) | All 20 concurrent failures are counted (row-locked read-modify-write, `SourceHealthStore.update`) | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_sys33_*`; `test_db_integration.py::test_sys33_concurrent_breaker_failures_are_all_counted` |
| SYS-34 | Probe-success counter after a restart (D01-A1) | The counter is in memory: a new process needs 3 fresh successes to close a half-open breaker | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_sys34_*` |
| SYS-35 | `Retry-After: inf` / `nan` / `-inf` / `1e999` | Parsed without error and the retry delay stays finite within 2..60 s | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_sys35_*` |

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
| UI-25 | Search `M&M`, `MM`, `BAJAJ-AUTO`, `BAJAJAUTO`, `bajaj auto`, `tata mot` (F03) | Symbol found; a literal match (`M&M` for `M&M`) ranks above a loose one (`MM`); tiers exact > prefix > name word-prefix > substring > fuzzy; fuzzy only from 3 characters | U |
| UI-21 | Search palette keyboard use (F03) | Ctrl/Cmd+K toggles, `/` opens unless typing in a field; focus moves to the input and returns to the opener on close; arrows wrap and set `aria-activedescendant`; Enter opens; Esc closes; results announced in an `aria-live` region | U |
| UI-22 | Stock index cache (F03) | Cache < 1 h used with no call; 1-24 h used and revalidated in the background; > 24 h or none fetched; expired cache kept (stale) when the network fails; corrupt cache or recents ignored; exactly 1 h revalidates, exactly 24 h is still served, a future `fetchedAt` (clock skew) is never fresh | U |
| UI-23 | `definitions.ts` drifts from docs/05 (F03) | Unit test fails when the committed file differs from the generator output; generation fails when a spec anchor line is missing | U |
| UI-24 | Formatter edge values (F03) | Negative zero and values rounding to zero show `0.00` unsigned; `1.005` rounds to `1.01`; values >= 1e21 have no exponent; Indian and western grouping; instant across IST midnight shows the next IST date | U |
| UI-20 | axe (wcag2a/aa) on every component story, both themes | Zero violations, including colour contrast in heat cells and chips (F02) | E |
| UI-26 | Touch targets at 375 px | Every `button` and link with a `data-testid` on the shell pages and every F02 story is at least 44 x 44 px below 1024 px and on coarse pointers (`touch-target` utility; the root font is 14 px so rem classes are not used); desktop density is unchanged; only the visually hidden skip link is excluded (F01/F02 review) | E |
| UI-27 | Dialog and drawer focus | Tab ten times never moves focus onto the page behind a modal; Escape closes and returns focus to the trigger; a backdrop click does not dismiss a confirmation; a dialog the browser closes while its parent keeps `open` true is reported through onClose and re-opened (F02 review) | E |
| UI-28 | Login redirect behind a proxy | The redirect is built from `request.nextUrl.clone()` with only path and query replaced; forwarded-host headers never change the target host (F01 review) | E |
| UI-29 | Reduced motion | `prefers-reduced-motion: reduce` turns chart animation off and collapses CSS transition and animation durations; shared `ExternalLink` and a repo test keep `rel="noopener noreferrer"` on every `target="_blank"` (F01/F02 review) | E |
| UI-30 | Import wizard focus and keyboard (F13a review) | After a successful commit focus moves to the result heading (`tabIndex -1`) and a persistent `aria-live` region announces the batch; the whole prices wizard (upload, review, raw/adjusted, commit, confirm) can be completed with the keyboard and a radio keeps focus while its choice is saved | U/E |
| UI-31 | Touch targets on the Import center (F13a review, extends UI-26) | At 375 px every `button` and link with a `data-testid` on all four tabs and in every wizard state (review with the adjustment check, commit step, confirm dialog, result, trim and delete previews) is at least 44 x 44 px; every radio and checkbox has a label hit area of at least 44 px | E |
| UI-32 | Double commit (F13a review) | `ConfirmDialog` has a `busy` state that disables confirm and cancel and ignores Escape; a double click on Commit, Trim history, Delete prices or Change setting sends exactly one request and never shows the 404 'expired' banner | U/E |
| UI-33 | Palette input hardening (F03 review) | A tampered recent (`../x?`, a stock key outside `^[A-Z0-9][A-Z0-9&-]{0,29}$`, a non-numeric fund code) is dropped on read, valid recents survive, route segments are encoded; `/` does not open the palette inside a `contenteditable` element or over another open modal | U |
| UI-34 | Formatter review rows (F03/F13a review) | `formatCrore(99999.6)` is `₹1.00 L Cr` (tier follows the rounded value); `formatPercent` and `formatMultiple` honour the western grouping setting; `formatMb`, `formatRatio` and `formatPercentOf` follow the same rounding rules (no `-0.0%`) and carry a reason when unknown; import screens format ISO dates with `formatDate`; no file under `components/imports` uses `Intl`, `toFixed` or the removed `local-format` | U |
| UI-35 | Dashboard cards when endpoints answer 501 or 404 | Every card renders an empty state with the reason (never 0, NaN or Infinity); index tiles show the BRK-16 reason; errors show Retry and the request id (F04) | U/E |
| UI-36 | Login messaging | 401 for a wrong password and for a lockout show the identical message; 429 shows the Retry-After seconds; an open-redirect `next` falls back to `/` (SEC-01, F04) | U/E |
| UI-37 | Stock header in manual price mode (F05; BRK-12, SYS-14 header part) | No Refresh button; chip "Last price import: {date}" amber with the word stale when `freshness.prices_stale`; "Import prices" link; "Holiday list missing" chip when `holidays_missing`; LTP is the last imported close with source and as-of; a broker-mode profile shows Refresh with the spec's 429/timeout/broker-session copy | I/E |
| UI-38 | Stock page states (F05) | Unknown symbol: not-found with search advice; alias: redirect plus toast; no prices: empty state with the hint and Import prices; backfill queued/running: progress card; a failed indicators call shows Retry on that card only; unavailable values are a dash with a reason, never 0/NaN/Infinity | I |
| UI-39 | Soft-flag notice and UNCONFIRMED_ACTION banner (F05; ACT-01 UI) | A detected date shows the docs/06 sentence with the computed change, Confirm/Reject disabled with a reason until B07; a one-day drop of exactly 20% (float-safe) or more with no action raises "Split/bonus or real move?" with Dismiss (disabled until B07) and Add corporate action; 19% raises nothing; covered dates never double up | U/I |
| UI-40 | Stock page axe and touch targets (F05) | Playwright with the API answered from fixtures: zero axe violations (wcag2a/aa, including label-content-name-mismatch) on the Overview in both themes; every button and link with a `data-testid` is at least 44 px at 375 px | E |
| UI-41 | Login cold start (F04 review; extends UI-01) | `/login` mounts the waking banner: with `/auth/login` delayed beyond 3 s the waking text shows (unit with fake timers in `login.test.tsx`, e2e with a delayed route); a 429 without `Retry-After` shows a generic wait message, never `NaN` | U, E |
| UI-42 | Card staleness is independent of partial (F04 review) | A portfolio with `meta.stale=true` and a null market value shows the partial warning and the `(stale)` as-of chip; a stale-only watchlist has no "0 of N stocks" text; upcoming events say "As of now", render progressively as symbols answer, and ask for at most the first 10 symbols | U |
| UI-43 | Health strip errors, countdown and labels (F04 review) | A 500 on `/watchlist`, `/broker/status` or `/admin/status` shows the request id and a Retry that refetches; the broker countdown drops one minute per minute without a request and is absent in manual mode (no reconnect suggestion); alert kind, delivery status, event type and job status are readable words, and an unknown value is humanised, never snake_case; the day change delta carries a `+` or `-` in text | U |
| UI-44 | Staleness boundary and CI build (F04 review) | Monday 09:00 IST expects Friday's bar (not stale), Monday 18:30 IST expects Monday's; the CI e2e build bakes the dead API address so an unmocked `/api` call fails with 5xx within 5 s | U, E |
| UI-45 | ACT-01 with the detected day not served (F05R-1) | Bars lack the suspect day, `UNCONFIRMED_ACTION` plus a detected 1:5 action: the exact docs/06 sentence with "price changed -80.0%"; no ratio: sentence without the clause; the gap does not raise a soft flag; `ratioChange` is r - 1 of the matched fraction | U/I |
| UI-46 | Soft flag behind the adapter (F05R-2) | A stubbed `getSoftFlags` drives the banner; StockBanners/StockPage import neither `softFlags` nor `coveredDates` | U |
| UI-47 | Refresh abort on unmount (F05R-3) | Fake timers: after unmount no further `/jobs/{id}` poll; `runRefresh` returns `aborted` on a fired signal | U |
| UI-48 | Disabled action reasons (F05R-5) | Alert, Add transaction, Confirm, Reject, Dismiss: `aria-describedby` resolves to visible reason text, no `title` | U |
| UI-49 | Watchlist toggle (F05R-6) | Click sends POST `/watchlist` with `X-Requested-With`, the next click DELETEs `/watchlist/{id}` from `GET /watchlist`; a 409 shows an error toast and leaves the star off | I |
| UI-50 | SAF-06 on the stock page (F05R-8) | All requests are same-origin `/api/v1`; no iframe/embed/prefetch/preload; `javascript:` and `data:` research links are dropped; kept links carry `rel="noopener noreferrer"` | U |
| UI-51 | Field map honesty (F05R-7) | `broker_ok` is `conditional:header-refresh\|...` and header-refresh renders only in broker mode; `tracked` is `not-rendered\|reason` | U |
| UI-52 | Stock route guard and fan-out (F05R-9) | A bad symbol (`../admin`, `TC S`, 31 characters) shows not-found with zero API calls; fundamentals and links are requested before prices resolve | U |
| UI-61 | Chart tab alignment and warm-ups (F06; extends UI-07) | Every pane (volume, RSI, MACD, Stochastic, ADX) shares the price pane's x axis and grid margins; indicator series are mapped by date so warm-up positions and dates outside the stored 750-day window are null (never 0 or a shifted value); with raw prices the adjusted-basis indicators are hidden with a reason | E |
| UI-62 | Chart tab controls and states (F06) | Range chips, Candles/Line/Area, Adjusted/Raw (requests `adjusted=false`), log scale, overlays, panes and compare (typed symbol, rebased to 100 at the first shared date, bad symbol 422-style inline error, missing prices reason); EMA 50 is disabled with its reason; weekly-candle notice on `meta.interval=1w`; API warnings rendered; price error shows Retry; no prices shows the import prompt | E |
| UI-63 | Indicator summary reads (F06) | Reads only compare definitionally (above or below, which line is higher); no overbought, oversold or trend-strength threshold is stated; an unknown value shows its reason (`insufficient history`, `no benchmark data imported`), never 0; the volume z-score row says it uses the prior 20 bars while the chart's 20-day volume line includes today (D-T) | E |
| UI-64 | Analysis tab views (F06; UI-10 per chart) | Drawdown, rolling volatility, return histogram (normal curve fitted from binned counts, labelled approximate), rolling beta, month x year and calendar heatmaps each have Show data (every plotted value) and CSV; unknown cells print `n/a` with a reason; a missing analysis block or beta without a benchmark shows the reason | E |
| UI-65 | Chart tab in a real browser (F06) | Mobile emulation at 375 px renders 2,000 candles (readiness is the `data-ready` attribute, no wall-clock budget) and still answers a click; a CDP two-finger pinch changes the plotted window; axe (wcag2a/aa, reduced motion) and the 44 px touch-target check pass on the Chart and Analysis tabs in both themes at 375 and 1440 px | E |
| UI-72 | Chart tab review fixes: scales, markers, labels (F06R) | Volume and histogram panes never use a fitted axis (volume min 0); markers anchor to the close (or the nearest valid close), are omitted at a null index and on a log axis for non-positive values, never at y = 0; the weekly volume line is labelled 20-week average incl. current week; a price below 0.01 shows significant digits (0.000100), never 0.00; log scale keeps working with compare; a missing RSI series says it is not stored, not warm-up | U |
| UI-73 | Chart tab review fixes: keyboard, zoom, notes (F06R) | The chart is a focusable labelled group: + zooms in, - out, arrows pan, 0 resets, with a visible hint; a height change (pane toggle) resizes without re-creating the chart and a same-range option keeps the zoom window; hollow = up, filled = down in the candle legend; a weekly/daily compare mix is explained; drawdown is titled with the 750-day peak window; the indicator table scroller is a focusable labelled region | U, E |
| UI-74 | axe on compare overlay and the open data table (F06R) | Zero axe violations with a compare overlay drawn and with the Show data table open, in the dark theme at 375 and 1440 px; waits use `data-ready` and the shared `setTheme` helper, not fixed sleeps | E |
| UI-68 | Portfolio summary and holdings honesty (F11; PF-07, PF-20) | Seven summary cards with unit, source and as-of; unknown values (no price, no benchmark) are a dash with the reason, never 0/NaN/Infinity; an XIRR whose period is too short keeps the XIRR label and shows the reason (`period_too_short`) under it, and an absolute return that cannot be computed is a dash with 'not available' (F16 review S3, S4); P&L amounts carry a sign and an arrow; the page says LTP is the latest valid close in manual price mode | U |
| UI-69 | Portfolio warnings and adjustments (F11; PF-09) | `REVIEW_NEEDED` and `UNCONFIRMED_ACTION` banners with the server text; an applied bonus shows quantity x multiplier, value invariant, day change null with the reason; the adjustments panel badges (override, confirmed applied, review needed, unconfirmed); removing an override is disabled with a reason because no route exists | U/E |
| UI-70 | Transaction form (F11; PF-01, PF-06, PF-11, PF-12) | Amounts are sent as strings (0.1 and 0.2 stay exact); Idempotency-Key per attempt, reused on a retry of the same values, new after a change or success; a double click sends one request; oversell shows the server message with held and sold quantities and moves focus to the error; weekend or holiday is a warning and saving still works; same-day buys-before-sells help text | U/E |
| UI-71 | Portfolio and watchlist axe and touch targets (F11) | Zero axe violations (wcag2a/aa, reduced motion) in both themes at 375 and 1440 px; every button or link with a test id is at least 44 px at 375 px; no horizontal page scroll | E |
| UI-75 | Timing assertions scale with load (F13bR) | The UI-05 timing tests (2,300 items per keystroke, index build, palette open) compare against the frame budget multiplied by a measured machine slowness factor (never below 1); vitest `testTimeout` and `hookTimeout` are 15 s | U |
| API-30 | Refresh cooldown (B09) | A `mf_refresh` for a target whose last job finished < `REFRESH_COOLDOWN_MIN` ago gives 429 `RATE_LIMITED` with `details.retry_after_seconds` (= remaining cooldown) and a matching `Retry-After` header; allowed again after the cooldown | I |
| API-31 | Global refresh limit (B09) | At `REFRESH_GLOBAL_PER_HOUR` on-demand jobs in the last hour the next request is 429 with `retry_after_seconds` = time until the oldest ages out; no row is created; `post_import` is exempt | I |
| API-32 | Worker signal fails (B09) | Worker answers non-202 or is down: the request still returns 202, the row stays `queued`, nothing is retried with the same signature | I |
| API-33 | `post_import` enqueue (B09) | Target `batch:<id>`, `result` = `symbols_total`, `symbols_done=0`, ordered `remaining` (`[]` not null when empty); an active job for the same target is returned instead of a second row; after it is `partial` a continuation row is allowed | I |
| API-34 | `GET /jobs/{id}` (B09) | Returns id, kind, target, status, requested_at, started_at, finished_at, error, result (nulls kept); unknown id 404; non-numeric id 422; no session 401 | I |
| API-35 | `POST /mf/schemes/{code}/refresh` input (B09) | Non-numeric, zero, negative or out-of-range code 422 with `details.fields`; unknown scheme 404; missing CSRF header 403 | I |
| SEC-40 | Go signer golden vector (B09) | `jobs.Sign` for fixed key/ts/method/path/body equals the value produced by `worker.http.sign` (Python) | U |
| SEC-41 | Worker signature checks as the Go caller meets them (B09) | A fake worker mirroring `worker/http.py` accepts the Go call (unix-second `X-Timestamp`, path `/run`), and rejects a timestamp 121 s old or ahead, a wrong signature, a tampered body and an exact replay | I |
| SEC-42 | worker-http request hardening (B09 review) | A non-ASCII `X-Signature` is 401 (not 500); a body over 4 KiB is 413 before authentication (declared and streamed); a valid signature for another path/method/body/key is rejected; the Go caller and the Python verifier agree on `fixtures/worker_hmac_vectors.json` | I |
| API-38 | Global refresh limit under parallel clicks (B09 review) | 40 parallel enqueues on different targets with `REFRESH_GLOBAL_PER_HOUR=7` create exactly 7 rows, the rest are 429 (advisory-locked transaction) | I |
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
| IND-93 | ADX warm-up (D05a review) | Exactly `2n` = 28 bars give the first ADX at index 27 (equal to the longer series); 27 bars are all NaN | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_ind93_*` |
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
| RET-94 | NaN volume in the bars (D05a review) | OBV null with a reason; ADV null when the NaN is inside its window; volume z-score unaffected outside its window; the snapshot dumps with `allow_nan=False` | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_ret94_*` |
| RET-95 | Zero, negative or non-finite price on a bar (D05a review) | The row is dropped with warning `dropped N bar(s)...`, no exception, no NaN; under 60 left means no snapshot | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_ret95_*` |
| RET-96 | Infinite return or NaN reaching the writers (D05a review) | Histogram and calendar series filter or null it; `compute_analysis` and `save_cache` raise instead of storing NaN | `apps/worker/tests/test_review_d01_d04_d05a.py` `test_ret96_*`; `test_analysis_db.py::test_ret96_snapshot_writer_refuses_nan` |
| IMP-57 | Wizard for the other kinds (F13b) | All ten importer kinds are offered, none for Screener (SAF-05); a results/shareholding file with errors shows row and column and blocks Next (IMP-01, IMP-11); the commit dialog and result say whether the batch can be undone (Batches tab, 30 days) or not; the holidays wizard says commit replaces every stored holiday of each year in the file (IMP-27); template link per kind | U/E |
| IMP-58 | Manual form validator parity (F13b, IMP-17, D-P, IMP-28, IMP-35, IMP-56) | `entry-validate.ts` accepts `1,234.56` and `1,23,456.78`; rejects `1234,56`, `12,34`, `1.234,56`, `0,123`, `00,123`, exponent notation and non-numbers, always showing the offending value; dates ISO, DD-MM-YYYY, DD-Mon-YYYY (MM-DD-YYYY rejected); quarter end, future date, revenue 1e7 crore, EPS range, percent 0-100, holding sum 100 +/- 1, MF+insurance <= DII + 0.5, split/bonus/dividend ratio rules; an empty cell is null, never 0; nothing is sent while errors exist | U/E |
| IMP-59 | Manual entry UI paths (F13b, IMP-48) | Results, shareholding and action forms send flat bodies with the CSRF header; server `details.fields` (`values.net_profit`) land on the cell; a 404 symbol says to add the stock; `POST_IMPORT_NOT_QUEUED` shows a sentence; the results form carries the B08-8 copy (leaving metrics out keeps old manual values) and a Delete manual period action with confirmation; focus moves to the result heading and the result is a live region | U/E |
| IMP-60 | Batches tab (F13b, IMP-14, IMP-44, IMP-53, IMP-55) | Undo only for undoable kinds, not undone, within 30 days (prices, instruments, holidays, instrument_meta and manual-entry batches show a reason); the dialog warns that overwritten values are not restored; the result lists rows removed and `UNDO_REMOVES_EARLIER_IMPORT` (with earlier batch ids), `UNDO_REMOVED_NOTHING`, `POST_IMPORT_NOT_QUEUED` as sentences; 409 `UNDO_HAS_DEPENDENTS` says nothing changed and to remove the adjustment first; empty, loading and error (Retry) states; the list refreshes after an undo | U/E |
| IMP-61 | Double submit on the new screens (F13b, extends UI-32) | A double submit of a manual form, a double click on the wizard commit and on Undo batch each send exactly one request | U/E |
| IMP-62 | Wizard per kind (F13bR) | `results_annual`, `balance_cashflow`, `fundamentals_long`, `corporate_actions` link their template and say in the commit dialog that the batch can be undone for 30 days; `instrument_meta` links its template and says it cannot be undone | U |
| IMP-63 | Duplicate ex-date warning on a corporate actions commit (F13bR) | The commit result shows `DUPLICATE_EX_DATE_ACTION` as a sentence (two actions on one ex-date are stored, only one is applied), never the raw code | U |
| IMP-64 | Holidays: years replaced (F13bR-1, IMP-27) | The review banner and the commit dialog list the years of the uploaded file (`2026, 2027`); a file without a readable date column says the years could not be read; `holidayYears` accepts the three date formats, a BOM, `;` and quoted cells and skips bad rows | U |
| IMP-65 | Undo window boundary (F13bR) | With an injected clock, a batch created exactly 30 days ago is undoable and one created 30 days + 1 ms ago is not ("Older than 30 days."); the Batches tab honours the injected `now` and the clock when none is given | U |
| IMP-66 | Batches paging (F13bR) | Load more requests `cursor=next_cursor` and appends the page; the button is gone when `next_cursor` is null | U |
| IMP-67 | Manual form resets (F13bR) | After a save or a server field error, editing to a locally invalid value and submitting shows no old saved panel and no old server message (results, shareholding, action); Add stock sends one POST for a same-tick double submit | U/E |
| IMP-68 | Validator parity table (F13b-3) | `fixtures/validation-cases.json` (numbers, dates, results, shareholding, actions: D-P commas, exponent, 1990 floor, MM-DD-YYYY, quarter ends, revenue < 1e7, EPS limit, percent range, 100 +/- 1.0, MF + insurance <= DII + 0.5, whole share count, 4 decimals, equal split) passes in Go (`TestValidationParity*`) and in `validation-parity.test.ts` | U |
| UI-66 | Touch targets on the F13b screens (extends UI-31) | At 375 px every `button`/link with a `data-testid` and every radio/checkbox label is at least 44 x 44 px on the upload kinds, templates, each manual form (also with a saved result and the delete dialog), the Batches tab (list, undo dialog, undo result) and the holidays review | E |
| UI-67 | axe on the F13b screens | Zero wcag2a/aa/21 violations (incl. label-content-name-mismatch and scrollable-region-focusable) in both themes at 375 and 1440 px on the results form with errors, the action form, the Batches list and the undo result | E |
| FND-92 | Fundamentals tab UI (F07): empty CTA, partial history, one basis, stale, reasons | FND-11: reason `no data entered`, Add results and Import CSV, manual form with the symbol locked; FND-12: two quarters render, growth cells are dashes with `not computed yet`; BASIS_NOT_MIXED, DERIVED_STALE and the stale stamp are visible; ratios/valuation rows are dashes with the block reason, never 0 | E (`fundamentals-tab.test.tsx`, `stock-fundamentals.spec.ts`) |
| FND-93 | P&L waterfall equals the table (F07) | Totals (revenue, EBITDA, PBT, net profit) equal the latest-period table cells; steps chain to them; a missing input or a loss names the reason instead of drawing | U (`fundamentals-tab.test.tsx`) |
| FND-94 | Fundamentals tab accessibility (F07, extends UI-26) | Zero axe violations (incl. label-content-name-mismatch) in both themes at 375 and 1440 px with the form open; every button and link at least 44 px at 375 px | E (`stock-fundamentals.spec.ts`) |
| FND-95 | Fundamentals toggles stay reversible and truthful (F07R-1, F07R-2, F07R-5) | An Annual or Standalone choice with no rows still shows the Period and Basis toggles (no dead end); while a toggle's answer loads, labels, caption and the Edit prefill follow the data on screen with a visible "previous view" line and `aria-busy`; a disabled basis is explained in visible text linked by `aria-describedby` | E (`fundamentals-tab.test.tsx`: F07R-1, F07R-2, F07R-5) |
| FND-96 | Source and as-of per row (F07R-3, docs/06 section 3 rule 4) | Derived rows read "Analytics snapshot, as of {date}" or "Analytics snapshot, not computed yet"; the FCF row names its formula (CFO minus capex); the P&L waterfall states that totals are reported and a (balancing) step is not a reported figure | E (`fundamentals-tab.test.tsx`: F07R-3, F07R-3b, F07R-6) |
| FND-97 | Fundamentals scroll regions (F07R-4, extends UI-26) | Both tables sit in a focusable `role="region"` with an accessible name | E (`fundamentals-tab.test.tsx`: F07R-4) |
| FND-98 | Embedded results form isolation (F07R-7, F07R-8; IMP-05, IMP-06, B08-8) | Edit for another period starts a clean form; a stock change rebuilds the form with the new locked symbol; non quarter-end (IMP-05) and revenue >= 1e7 crore (IMP-06) messages are exact; B08-8 copy and Delete manual period (confirm, CSRF, refetch) behave as in F13b | E (`fundamentals-tab.test.tsx`: IMP-05, IMP-06, F13b parity, F07R-7, F07R-8) |
| FND-81 | Basis preference (D05b; B05) | One tree per entered basis; auto = consolidated when entered, else standalone; standalone never borrows consolidated values | U (`test_fundamentals.py::test_fnd81_*`) |
| FND-82 | Source priority, NULL values, restated period, derived rows (D05b) | manual > csv_import > screener_import per (period, metric); newest entry of the winner wins; NULL never wins; `derived` rows never used | U (`test_fnd82_*`) |
| FND-83 | Mixed units (D05b) | A row whose unit differs from the metric's canonical unit is dropped and reported as `UNIT_MISMATCH:<key>`; never reaches a formula | U (`test_fnd83_*`) |
| FND-84 | Partial history, two quarters (D05b) | Tables render; YoY null, QoQ only for the later quarter | U (`test_fnd84_*`) |
| FND-85 | Stock without owner data (D05b) | `fundamentals = {}`, `fundamentals_meta.reason = no_data_entered`, quality score null `no_data_entered`, no fundamental screener keys | U/I (`test_fnd85_*`, `test_fnd_db_no_owner_data_*`) |
| FND-86 | Input stamp (D05b, R-B05-1) | `fundamentals_meta.inputs_fetched_at` = newest entry used; `computed_at` = when the worker computed | U/I |
| FND-87 | No NaN/Infinity in jsonb (D05b, D05aR-2) | NaN/inf inputs become null with reasons; every output serialises with `allow_nan=False` | U (`test_fnd87_*`) |
| FND-88 | Zero revenue (D05b) | Margins null `n/m`, never inf | U (`test_fnd88_*`) |
| FND-89 | Fundamental screener keys (D05b) | Whitelisted keys from the auto basis; unknown values absent, never 0; growth 1y = latest annual YoY, 3y/5y = CAGR | U (`test_fnd89_*`) |
| FND-99 | ROE definition pinned (S16, D05b) | Average of ending and prior equity (`roe_basis=average`), ending equity only when prior is missing (`ending`); the two differ by 6.8% on the S16 data | U (`test_s16_roe_*`) |
| FND-100 | Snapshot tree, scores and screener row from the database (D05b) | `indicators.fundamentals.<basis>.<Q|A>` has periods, aligned derived arrays, numeric-only ratios, valuation; trend/quality in `scores`; the writer is idempotent and a re-run keeps `scores.risk` | I (`test_fundamentals_db.py`) |
| FND-101 | Only confirmed actions adjust EPS/BVPS; confirmed dividends feed the yield (D05b) | `detected` and `rejected` actions are ignored; a confirmed split divides EPS and BVPS | I (`test_fnd09_db_*`) |
| FND-102 | Matching tolerance and fiscal dates (D05b) | +/-20 days matches, 21 does not; month-end clamping for 3-month steps; TTM needs 4 consecutive quarters of one source | U |
| FND-103 | Dividend yield window and split adjustment (D05b) | Ex-dates in (as_of - 365 d, as_of]; per-share dividends divided by splits after them; no dividend entered = null `no_dividend_data` | U |
| FND-104 | Stale rule after a recompute (D05b-10): entry after the last price bar | `DERIVED_STALE` only when the newest `fundamental_value.fetched_at` is later than `indicators.fundamentals_meta.computed_at`; `derived_as_of` = `computed_at` (UTC RFC 3339); an older snapshot without `computed_at` keeps the as_of-date rule and a date `derived_as_of` | Go: `TestDerivedStaleUsesComputedAt`, `TestFundamentalsComputedAtStaleAndPassThrough` (I) |
| FND-105 | Worker output passed through (D05b-9) | `null_reasons`, `ratio_meta`, `valuation.ev_ebitda/market_cap_cr/eps_ttm/bvps/pb_source/eps_period_end/close`, CAGR and `cfo_to_pat_avg` ratios, optional `revenue_qoq/net_profit_qoq/nii_yoy` returned unchanged from a snapshot shaped like the worker's DEMOCO output; null stays null with its reason, never 0 | Go: `TestWorkerSnapshotPassThrough`, `TestWorkerSnapshotQuarterlyOptionalKeys` |
| FND-106 | Reader tolerates the worker's text arrays and a missing snapshot (D05b-9) | `derived.op_margin_source` (strings) no longer breaks decoding (was a 500) and is not returned; no snapshot keeps `not_computed`, null values and empty `null_reasons`/`ratio_meta` objects | Go: `TestWorkerSnapshotPassThrough`, `TestNoSnapshotKeepsNullsAndEmptyReasons` |
| FND-107 | Fundamentals tab shows D05b reasons and provenance (F10) | `derived_as_of` as an RFC 3339 instant is shown in IST with the time (a plain date as a date); a null ratio or valuation shows `null_reasons` for that metric, a null derived cell the reason for that period; `ratio_meta.ratio_period` ("Period used") and the `roe_basis` note are shown; without `null_reasons` the block reason is used | U (`fundamentals-tab.test.tsx`, `screener-lib.test.ts`) |
| FND-108 | ROCE definition (owner decision 2026-11-10) | Primary `ebit / average(equity + borrowings)` (Screener's definition); fallback `total_assets - current_liabilities` only when equity or borrowings is missing in either year; the basis is stored as `ratio_meta.roce_basis` (`equity_plus_debt` \| `assets_less_cl`); a missing `interest` row counts as 0; known difference: Screener excludes exceptional items, we use `pbt + interest` | U (`test_fundamentals.py`: `test_fnd16_roce_falls_back_to_assets_less_current_liabilities`, `test_roce_prefers_equity_plus_debt_screener_definition`, `test_roce_works_without_current_liabilities_and_without_interest_row`) |
| FND-109 | `roce_basis` reaches the Fundamentals tab | The Go reader passes `ratio_meta.roce_basis` through; the ROCE row shows a note naming the basis | U (Go: `TestRatioMetaPassesRoceBasis`; `fundamentals-tab.test.tsx`) |
| UI-80 | Ownership tab (F08; SHP-01..04, SHP-06, SHP-07 UI) | Stacked composition (promoters, FII, DII excluding MF, MF, public, government), pledge line, QoQ bars in percentage points, per-holder table with sparkline and a "Rising/Falling n quarters in a row" badge (3 or more steps, F08-2); no MF figure shows "DII (includes mutual funds)" and no MF series; unknown pledge is a dash with a reason, never 0; single quarter or a missing previous quarter shows the reason and no QoQ chart; nothing entered shows the entry hint and an import link | U/E (`stock-f08.test.tsx`, `stock-f08.spec.ts`) |
| UI-81 | Events tab Confirm/Reject (F08; ACT-03, ACT-04, ACT-06, ACT-26..28 UI) | Confirm needs split or bonus and both ratios (checked before sending), previews the multiplier and the same warnings as the API, asks for confirmation, sends one `PATCH` (single-flight, CSRF header); server warnings, future ex-date and the queue-retry sentence are shown; 409 shows the server message and reloads the list; a confirmed twin on the ex-date warns up front; Reject is confirmed and sticky; nothing is pre-filled or auto-applied | U/E |
| UI-82 | Data tab (F08; ACT-11) | Coverage and freshness dates, history depth from `/prices` MAX, sources used and suspect rows say "not reported by the API", batches link to the Import center, adjustment setting sentence (unset, raw, adjusted) with the no-mixing note and the Adjustment check pointer, `ADJUSTMENT_CONFLICT` shows the docs/01 3.7 sentence, `DeletePricesAction` mounted with the symbol | U/E |
| UI-83 | Peers tab (F08) | The peers route is never called; the tab says peer comparison is not available yet (or asks for a sector import) and links to the import | U/E |
| UI-84 | F08 tabs accessibility (UI-26 extended) | axe clean in both themes at 375 and 1440 px on Ownership, Peers, Events (with a detected candidate) and Data; every interactive element is at least 44 px at 375 px | E |
| UI-85 | Fund search and detail honesty (F14; MF-04, MF-05, MF-07, MF-13, MF-90, MF-100, SAF-03) | NAV with unit and its own date, 1Y with basis and as-of; null NAV/1Y/return/volatility is a dash with a reason; IDCW shows the not-comparable and payout warnings; wrong code is a 404 page with suggestions; no NAV rows shows a backfill note and no chart; the footer shows `NAV data: AMFI, via mfapi.in` on every `/mf` path | Vitest `mf-pages.test.tsx`, Playwright `mf.spec.ts` |
| UI-86 | SIP form and result (F14; MF-10, MF-11, MF-92, MF-93, MF-96) | Day 29-31 is refused in the form (error, focus, no request); amount sent as typed; skipped installments counted and warned; XIRR null shows the reason; no executed installment shows a dash for value and no chart; growth sums use decimal arithmetic | Vitest `mf-lib.test.ts`, `mf-pages.test.tsx` |
| UI-87 | Compare and refresh (F14; MF-14, MF-94, MF-102) | 2-5 codes checked client side; different starts banner; no common dates shows a plain sentence; refresh 429 shows minutes, 409 the busy text, one request per click | Vitest `mf-pages.test.tsx`, `mf-lib.test.ts` |
| UI-88 | axe, touch targets and overflow on the fund screens (F14) | Zero wcag2a/aa/21 violations (incl. color-contrast on the heat-tinted return cell and label-content-name-mismatch) in both themes at 375 and 1440 px on `/mf`, `/mf/{code}` (with a SIP result), `/mf/compare` and the 404 page; buttons/links with a test id and checkbox labels at least 44 x 44 px at 375 px; no horizontal page scroll; every chart has Show data | Playwright `mf.spec.ts` |
| UI-91 | Fund search filters and compare cap (F14 review; F14R-1, F14R-2, F14R-3) | Plan/Option offer Any only with Show all (API defaults to Direct+Growth otherwise); the sixth compare checkbox is disabled; a failed next page keeps loaded rows with a banner and Load more retries | Vitest `mf-review.test.tsx` `F14R-1`, `F14R-2`, `F14R-3` |
| UI-92 | Compare hint, SIP reason and detail remount (F14 review; F14R-4) | One valid code in `?codes=` is a hint, malformed input still a warning; SIP XIRR null without a server reason says no installment was executed; switching fund code resets the refresh note (cache hit) | Vitest `mf-review.test.tsx` `F14R-4`, `F14R-5`, `F14R-6` |
| ALR-78 | Alert form validation parity (F12; extends ALR-01) | All 13 kinds: ranges, required fields, `slow > fast`, decimal prices sent as exact JSON numbers (0.1 stays 0.1, more than 15 digits refused), no request when invalid | U |
| ALR-79 | Alerts screen states (F12) | List with mapped labels, 409 shows the 200-active text, `THRESHOLD_ALREADY_MET` inline at the price field with the bar date, edit changes only params, pause and delete (confirmation, busy), history shows mapped delivery status and held reasons, 501 shows "not available yet", quiet hours "not available yet" | U/E |
| ALR-80 | Telegram card states (F12; ALR-05, ALR-16) | Not linked, bot missing (code without deep link), live code with local countdown and expiry, `/auth/me` polling every 3 s then linked, failed poll tolerated, "Check again" after 2 min, linked test/unlink with rate-limit text; code never in storage or console | U |
| SEC-43 | Sign-out (F12) | Logout and logout-all send the CSRF header, clear the cache and go to `/login`; logout-all asks first; 401 still ends at `/login`; other failures stay on the page with an error; double click sends one request | U/E |
| SEC-44 | Change password form (F12) | Same policy as the API (12..200, differs from current), wrong `current` shown at its field, fields cleared and result heading focused on success, nothing stored | U |
| UI-89 | Touch targets and axe on alerts and settings (F12; extends UI-26) | At 375 px every `button`/link with a `data-testid` is at least 44 px on `/alerts` (with a live code), `/settings` and the open create drawer; zero wcag2a/aa/21 violations in both themes at 375 and 1440 px; no horizontal scroll | E |
| ALR-81 | Telegram link polling review (F12R-3) | A second code made during the polling window restarts the 2 minute window (not the first code's remainder); the card stops asking `/auth/me` when it unmounts; when polling sees the link the code disappears and a status note says so; the linked card says only one chat can be linked and a second chat is refused until unlink | U |
| SEC-45 | Sign-out data and cache headers (F12R-1, F12R-2, F12R-4) | After the server accepted logout the recent-search list is removed and a late API 401 no longer redirects with `next`; a failed logout keeps both; page responses carry `Cache-Control: no-store` (API paths keep their own header) so Back never shows a cached private page | U |
| UI-90 | Account menu keyboard and error focus (F12R-5, F12R-6) | Escape closes the account menu and More menu and returns focus to the trigger, a press outside closes them, `aria-controls` is set; Sign out everywhere moves focus to Cancel and back; a failed Sign out everywhere in Settings closes the dialog so the error shows; a rejected alert or password form focuses the first invalid field | U |

| UI-93 | F08 review fixes (F08R-1..F08R-4; ACT-31, ACT-32, ACT-35 UI) | The confirm preview applies the API limits (4 decimals, below 100,000,000), keeps exactly 3% silent (5.15 against 5), previews 2:10 as 0.2; a saved decision with `POST_IMPORT_NOT_QUEUED` has a Retry that repeats the PATCH without numbers; focus lands on the result message; 404 and 422 are shown; a later error replaces an earlier one; a stacked chart axis starts at zero | U (`stock-f08.test.tsx` "F08R review fixes") |
| UI-94 | Every nav href has a route (F10p-1) | each href in `nav.ts` matches an `app/(app)/**/page.tsx` (dynamic segments allowed), so a nav entry cannot 404 | U (`nav-routes.test.ts`), E (`browse.spec.ts`) |
| UI-95 | Stocks browse (docs/06 6.3; F10p-2..F10p-5) | rows from `GET /stocks` only (no per-row calls), symbol link encoded (`M%26M`), debounced `q`, Load more keeps rows when the next page fails, empty state links to /imports, error shows request id and Retry, unbuilt columns explained | U (`stocks-browse.test.tsx`), E |
| UI-96 | Not-available pages and not-found (F10p-6; F15: /admin/status is now live and covered by UI-99) | /compare and /screener said what they waited for (D05b, B14), made no API call and linked to Home and Stocks; not-found keeps its testids and adds a Stocks link | U (`stocks-browse.test.tsx`), E |
| UI-97 | Touch targets and axe on the new screens (extends UI-26) | At 375 px every `button`/link with a `data-testid` is at least 44 px on /stocks, /compare, /screener, /admin/status; zero wcag violations in both themes at 375 and 1440 px; no horizontal scroll | E (`browse.spec.ts`) |
| UI-98 | Axe, touch targets and overflow on screener and compare (extends UI-26, UI-97) | At 375 and 1440 px, both themes, with results on screen: zero wcag violations, every `button`, link, select and checkbox with a `data-testid` is at least 44 px at 375, no horizontal page scroll; the results heading takes focus after a run; the screener runs from the keyboard | E (`f10.spec.ts`), U (axe in `screener-page.test.tsx`, `compare-page.test.tsx`, `peers-tab.test.tsx`) |

| SCO-81 | Trend score rules (D05b; docs/05 6.1) | 20/20/20/10/10/10/10 points, strict comparisons, bands 0-20 to 81-100, null `insufficient_history` below 200 bars, an unknown input scores 0 points | U (`test_scores.py`) |
| SCO-82 | Risk score universe (D05b; docs/05 6.2) | Percentile ranks over eligible stocks (>= 252 bars); fewer than 20 eligible: null `universe_too_small`; ties share the average rank; labels < 33 low, 33 to 66 medium, > 66 high | U |
| SCO-83 | Risk components missing (D05b) | Weights renormalised; fewer than 3 components: null `insufficient_data`; negative beta counts as 0 | U |
| SCO-84 | Quality score (D05b; docs/05 6.3) | Linear anchors clipped to 0-100, weights sum to 100, coverage < 0.6 null `insufficient_data`, financial companies null `not_applicable_financial`, no-debt company skips coverage | U |
| SCO-85 | Risk pass in the database (D05b) | Needs 20 tracked stocks; writes `scores.risk` into every latest snapshot; the screener hook refreshes everyone and `risk_score` in `screener_row` | I (`test_sco_db_*`) |
| SCO-86 | No-debt company with equity <= 0 (D05bR-3) | Borrowings 0 -> quality D/E component scores 100 although the ratio is null (`negative_equity`); coverage component skipped | U (`test_quality_no_debt_with_nonpositive_equity_still_scores_de_100`) |
| SCO-87 | Screener pass isolation and risk pass cost (D05bR-4) | One stock whose snapshot cannot be mapped is logged and skipped, the others still get their `screener_row`; the risk pass reads only each stock's latest snapshot | I (`test_screener_one_bad_snapshot_does_not_fail_the_batch`, `test_risk_scores_touch_only_the_latest_snapshot_per_stock`) |


## SCR/PEER/CMP: screener, peers and compare (B13)
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| SCR-01 | Screener filters, sort and ties (SEC-04 data path) | Whitelisted metrics only; ops `> >= < <= = between in`; a missing metric excludes the stock and is counted in `meta.excluded_for_missing`; missing sort values last; ties by symbol; unknown values are null with a reason, never 0; a real 0 matches `= 0` | I (`TestScreenerQueryFiltersSortAndExclusions`) |
| SCR-02 | Injection in every user-controlled field (SEC-04) | Metric, sort metric, column, op, direction, universe, limit, cursor and saved name: 422 naming the field; SQL-looking values are bound parameters and match nothing; tables intact; SQL text never changes with the values (fuzz) | U + I (`FuzzSpecSQL`, `TestInjection*`, `TestScreenerInjectionOverHTTP`) |
| SCR-03 | Whitelist equals docs/03 and the keys the worker writes | No extra and no missing key; every key is written by the worker (parsed from the Python constants) | U (`TestWhitelistMatchesWorker`, `TestWhitelistMatchesDocs`) |
| SCR-04 | Limits | At most 12 filters, `in` at most 50 strings of at most 100 characters, `between` ordered, numbers finite within 1e15, limit clamp 200, non-integer or < 1 is 422, cursor bound to its screen, offset cap | U |
| SCR-05 | Last updated and stale per stock (D-R) | Every item has `last_updated` (IST date of the newest owner entry, derived rows ignored), `stale`, `stale_reason`; 120 days for fundamentals, 135 days after the quarter end for shareholding; no owner data is stale with a null date | U + I |
| SCR-06 | Saved screens | Upsert by name case-insensitively (201 then 200), at most 30 (409), name pattern, spec at most 8 KiB, delete 404 when absent, 30 parallel saves lose none | I (`TestScreenerSavedCRUD`, `TestScreenerSavedCapAndConcurrency`) |
| SCR-07 | Auth | Every B13 route needs the session; non-GET needs the CSRF header | I |
| SCR-08 | Delete segment is decoded once (B13R-1) | `DELETE /screener/saved/A%2541` is the name `A%41` (404) and never deletes the screen `AA`; `A%41` is `AA` | I (`TestScreenerDeleteDoesNotDoubleDecode`) |
| SCR-09 | Saved-screen cap under a burst (B13R-5) | 36 parallel saves of distinct names give exactly 30 x 201 and 6 x 409; 30 stored | I (`TestScreenerSavedCapHoldsUnderBurst`) |
| SCR-10 | Docs quote the whitelist size (B13R-4) | The coverage denominator in docs/03 equals the number of whitelisted keys | U (`TestDocsQuoteWhitelistSize`) |
| PEER-01 | Peer selection (docs/05 section 7) | Same industry; fewer than 4 widens to the sector; cap ratio [0.25, 4] then [0.1, 10]; fewer than 4 returns what exists with `few comparable peers`; ranked by abs(ln ratio) | I (`TestPeersAlgorithm`) |
| PEER-02 | Peer errors and overrides | No sector and industry: `no_sector_data`; no market cap: `no_market_cap`; `add`/`remove` temporary, conflicting or unknown symbols 422; alias gives `redirect_symbol` | I |
| PEER-03 | Percentile of peers | Percent 0-100 among peers and self (D05b-4); null for a missing value or fewer than two values | U + I |
| PEER-04 | Non-numeric or non-positive candidate market cap (B13R-3) | A candidate whose `market_cap_cr` is a string or <= 0 is skipped, never a 500 | I (`TestPeersIgnoreNonNumericMarketCap`) |
| CMP-01 | Compare rebase and short history (MF-14 for stocks) | First common date = 100 on `adj_close`; a stock with under 60% of the window dates is `short_history`; a stock without prices has a null series; no common date gives empty dates with a reason | I (`TestCompareRebaseShortHistoryAndNulls`) |
| CMP-02 | Compare metrics (FND-14) | A missing market cap or any missing metric is null with `metric_reasons`, never 0; `best` follows the direction table, null on a tie or fewer than two values | U + I |
| CMP-03 | Compare input | 2-5 distinct symbols of the symbol charset, `range` and `metrics` whitelisted, unknown symbol 404, alias resolved | U + I |
| CMP-04 | Alias plus current symbol (B13R-2) | `symbols=OLD,NEW` naming one stock is one stock: 422 on `symbols` | I (`TestCompareAliasAndCurrentSymbolIsOneStock`) |

| SCR-11 | Screener screen: builder and request (F10; docs/06 6.6) | Metric picker is the typed whitelist and equals docs/03 (test parses the doc); 12 filters accepted, the 13th refused with a reason on the disabled button; empty, non-numeric, non-finite, > 1e15, reversed `between`, `in` > 50 names or a metric outside the list are refused before any request; SQL-looking text stays a JSON string; body carries the CSRF header, `columns`, `universe`, `limit`, `cursor` | U (`screener-lib.test.ts`, `screener-page.test.tsx`) |
| SCR-12 | Screener results: units, nulls, stamps, exclusions (F10; D-R) | Headers carry the unit; a missing value is a dash with its reason (never 0); each row shows the last updated date and source, a stale row says `Stale: <reason>` in words and carries `data-stale`; `excluded_for_missing` is listed per metric; coverage shown as percent; total and stale count in the live status; focus moves to the results heading | U (`screener-page.test.tsx`), E (`f10.spec.ts`) |
| SCR-13 | Screener paging and errors (F10) | Load more sends the opaque cursor unchanged; a failed page keeps the loaded rows with a message and a retry; a 422 shows the server's field messages; a first-page failure shows the request id and Retry | U (`screener-page.test.tsx`) |
| SCR-14 | Saved screens and presets in the UI (F10; SCR-06) | Presets come from the server; load puts the spec into the builder (unknown metrics dropped and named); name validated with the server pattern before any request; same name in any case asks to replace; 30 saved disables a new name with a reason and a 409 is explained; delete asks first, encodes the name in the path, is single-flight; saves send the CSRF header | U (`screener-page.test.tsx`) |
| SCR-15 | Screener CSV export (F10; IMP-15) | Loaded rows only, headers with units, `=`, `+`, `-`, `@`, TAB and CR guarded by the shared CSV helper, unknowns are empty cells, stale and its reason are columns | U (`screener-lib.test.ts`, `screener-page.test.tsx`) |
| SCR-16 | Screener review fixes (F10R-1..F10R-5) | A server 422 `filters[i].value` shows at that filter and clears on edit; a 4xx on a later page says to press Run screen again and a new screen never sends the old cursor; a dropped sort or column is named when a saved screen loads; focus moves into the saved card after a delete; the CSV guard is checked for TAB, CR, `+`, `-`, `@` and a comma or quote | U (`f10-review.test.tsx` F10R-1..F10R-5) |
| PEER-05 | Peers tab (F10; docs/06 6.4) | Sector, industry, basis (industry or widened to sector), market cap band, self row, origin labels, rank as a percent 0-100 (never 0 for null), missing values as a dash with a reason, stale peers highlighted with a note; `no_sector_data` asks for the sector import, `no_market_cap` says so; `few comparable peers` note; add and remove are temporary `add`/`remove` parameters with symbol validation; an old symbol links to the new one | U (`peers-tab.test.tsx`, `stock-f08.test.tsx`) |
| PEER-06 | Peers review fixes (F10R-4) | An add keeps the table and the add box mounted; a stale self row is highlighted like a stale peer (the 10-removal cap is not unit-tested) | U (`f10-review.test.tsx` F10R-8, F10R-9) |
| CMP-06 | Compare screen (F10; MF-14 for stocks) | 2-5 distinct symbols of the server charset are validated before any request and put into the URL encoded (`M&M`); range chips keep the symbols; the rebased chart goes through ChartFrame with a data table and a second encoding (dash and marker); `best` is shown as the word Best plus a mark, absent when the server sends none; short-history badge and `prices_reason` per stock; per-stock last updated stamp and stale highlight; no common dates (200, empty dates) shows the reason and keeps the metrics table; 404 and 5xx show a message with the request id and Retry | U (`compare-page.test.tsx`), E (`f10.spec.ts`) |
| CMP-05 | Browse selection (F10) | /stocks offers a checkbox per row; Compare selected is disabled with a reason until 2 are ticked and at most 5 can be; the link carries the encoded symbols; no per-row request | U (`stocks-browse.test.tsx`) |
| CMP-07 | Compare review fixes | An alias plus its current symbol (422 on `symbols`) shows the server's message and Retry; the symbol box follows the URL on back and forward | U (`f10-review.test.tsx` F10R-6, F10R-7) |
| UI-99 | Admin status (F15; docs/06 6.12) | Reads `GET /admin/status`. Loading skeleton; 501 `NOT_IMPLEMENTED` shows "Not available yet" naming B14 and no numbers; other errors show a card with the request id and Retry. Per-source cards for mfapi, amfi, telegram (a missing row is an honest empty card); last runs with duration, rows written and items failed; coverage; DB meter with marks at 70/85/95 % of 380 MB and the server's `warn_level` (computed client side only when absent); recent errors escaped as text (SEC-11); one persistent holiday warning per missing year with the exact copy; version; no run-job buttons. Missing numbers are a dash with a reason, never 0/NaN/Infinity; every card carries source and as-of | U (`admin-status.test.tsx`), E (`f15.spec.ts`) |
| UI-100 | Field coverage guard (F15; UI-09 enforcement) | Every field in `docs/field-map.json` names a `data-testid` that exists in `src` (or `not-rendered`/`conditional` with a reason); every endpoint of the docs/06 section 8 matrix has a mapping except those listed as not built (`/prediction`, F15-5); every mapped path exists in `openapi.yaml`; all `/admin/status` fields are mapped | U (`f15-polish.test.tsx`) |
| UI-101 | Truncated text keeps a tooltip (UI-08 guard) | Every element with the `truncate` class also has `title=` (fixed navigation labels exempt); the admin job name is clipped at 375 px and its title holds the full text | U (`f15-polish.test.tsx`, `admin-status.test.tsx`), E (`f15.spec.ts`) |
| PWA-01 | Manifest and icons (F15) | `public/manifest.json` has a name, `start_url` `/`, `display` standalone, 192 and 512 PNG icons plus a maskable one (real PNGs of the declared size); the layout links it; the manifest, icons, `/sw.js` and `/offline.html` load without a session while a protected page still redirects to `/login` | U (`f15-polish.test.tsx`), E (`f15.spec.ts`) |
| PWA-02 | Service worker caches the shell only (F15; docs/06 section 1) | Install precaches the offline page, manifest and icons; GET `/_next/static/*` is cache-first; it never intercepts `/api/*`, non-GET or other origins and never stores page HTML; a failed navigation answers with `/offline.html`; in a real browser the worker registers, the cache holds no API or page URL, and an offline reload shows the offline page | U (`f15-polish.test.tsx`, runs `public/sw.js` in a sandbox), E (`f15.spec.ts`) |
| UI-06b | Offline banner (UI-06; F15) | A polite live region in the shell says "You are offline. Showing the data already loaded; it may be out of date." on the `offline` event and clears on `online`; screens keep their loaded data | U (`f15-polish.test.tsx`), E (`f15.spec.ts`) |
| PERF-01 | Bundle budget (docs/06a section 10) | `npm run check:bundle` sums the gzip size of the JS a route loads up front (root main files plus the route's layout and page chunks; lazy chunks excluded) and fails above 250 kB; heavy stock tabs, portfolio sections and charts load on demand | U (`bundle-budget.test.ts`), CI |
| PERF-02 | Lighthouse gate (docs/06a section 10; F15-7) | Mobile performance >= 0.90 and accessibility >= 0.95 on `/login` (the one main route that renders without the API); a missing score fails | U (`bundle-budget.test.ts`), CI |
| A11Y-01 | Axe on the admin screen (UI-04; F15) | Zero violations (wcag2a/aa/21a/21aa, with colour contrast) in the loaded and 501 states, dark and light, at 375 and 1440 px; keyboard: the skip link is the first tab stop and moves focus to the main region | E (`f15.spec.ts`) |
| A11Y-02 | Manual keyboard and screen-reader pass (F15) | Checklist in docs/RUNBOOK.md section 80; run by the owner before release, results recorded there (F15-8) | M |
| PRD-01 | ML-04 API side: no model and fewer than 20 eligible stocks | `GET /stocks/{symbol}/prediction` answers `state=insufficient_universe` with `state_reason`, every horizon `shown=false` with `hidden_reason=no_model`, no `p_up`/`bucket`/`band`, `model`, `track_record`, `ref_close` and `as_of` null (reason given), `experimental=true`, disclaimer present; no key anywhere names a target price. Without any train run the state is `no_model`; trend/risk are null with a reason when there is no analysis snapshot | I (`TestPredictionInsufficientUniverse`, `TestPredictionNoModelState`) |
| PRD-02 | ML-05 API side: guardrail fails | A failed candidate run hides the horizon with `model_not_better_than_baseline` (`insufficient_history` for `insufficient_folds`), state `guardrail_failed`; an active run switched off by the live gate hides rows stored as shown, with no numbers, while the model card stays visible | I (`TestPredictionGuardrailFails`) |
| PRD-03 | ML-06 API side: illiquid / near action / stale / unconfirmed action / short history | Stored stock-level reasons surface as the enum value with no numbers; a shown row older than 3 trading days at read time is `stale_data`; an unknown reason text maps to `model_not_better_than_baseline`; no stored row with an active model is `insufficient_history`; the other horizon without a model is `no_model` | I (`TestPredictionHiddenReasons`) |
| PRD-04 | Shown horizon content | `p_up`, `bucket`, `band` fractions and price levels (`ref_close` x (1+return), 2 decimals), model card (`version`, `oos_auc`, `oos_brier`, `baseline_brier`, `folds`), live track record (`resolved`, hit rate, coverage, `since`), trend/risk scores; top-level `model` and `track_record` mirror the first horizon with a model; no single target price | I (`TestPredictionShown`) |
| PRD-05 | Prediction route rules | Old symbol answers `data.redirect_symbol`; unknown symbol and a NUL byte are 404 `NOT_FOUND`; no session is 401 | I (`TestPredictionRoutes`) |
| PRD-06 | Probability buckets | `<0.40` strongly_down, `0.40-0.47` slightly_down, `0.47-0.53` neutral, `0.53-0.60` slightly_up, `>0.60` strongly_up, with the boundary values on the documented side | U (`TestBuckets`) |
| PRD-07 | Freshness rule in trading days | Trading days between the data date and the expected last trading date; weekends and holidays do not count; more than 3 is stale | U (`TestTradingDaysBehind`) |
| MKT-01 | Market overview with no data | Empty `indices` with `indices_reason`, `vix` null with `vix_reason`, empty movers with `movers_reason`; `market_status` still answers (weekends-only, `holiday_list_loaded=false`); never 0 or NaN | I (`TestMarketOverviewEmpty`) |
| MKT-02 | Market overview with data | Index value, change and `change_pct` (percent number) from the last two `market_series` rows; one row gives null change with `no_previous_value`; movers rank tracked stocks by adjusted-close day change, drop low turnover, untracked, an unconfirmed split in the window | I (`TestMarketOverviewData`) |
| MKT-03 | Market status rule | Open 09:15-15:30 IST Mon-Fri; closed at 15:30; a trading holiday closes the day and names it; `next_open` skips weekends and holidays; the IST date, not the UTC date, decides | U (`TestComputeStatus`) |
| MKT-04 | `GET /market/holidays` | `year_loaded` false with a note for an empty year, true with the trading rows (clearing rows excluded); default year; non-integer year is 422; the overview shows today's holiday | I (`TestMarketHolidays`) |
| ADM-01 | SYS-10 / SYS-14 admin part: holiday list missing | `holiday_list_missing_years` holds the current IST year and the newest bar's year when they have no trading-holiday row, on every read (persistent); clearing-only rows do not count; loading the lists empties it | I (`TestAdminHolidayMissingYears`) |
| ADM-02 | Admin status content | Sources without the broker, latest run per job, `recent_errors` newest first (max 50), coverage counts, `db.size_mb`/`limit_mb`/`used_pct`/`tables`, `version`, flat `storage_policy`; no broker session state (manual mode) | I (`TestAdminStatus`) |
| ADM-03 | SYS-02 admin part: warn level | `ok` below 70 %, `70` at 70 %, `85` at 85 %, `95` at 95 %, `limit` at 100 % of `DB_SOFT_LIMIT_MB`; no limit configured never warns | U (`TestAdminWarnLevel`) |

## HK: housekeeping, backup and workflows (D08)
| ID | Case | Expected | Test |
|---|---|---|---|
| HK-01 | Thresholds at exactly 70/85/95/100 % of `DB_SOFT_LIMIT_MB` (SYS-02) | Levels `70`, `85`, `95`, `limit`; just below stays in the lower band; a non-positive limit is `ok` | `test_housekeeping.py` `test_sys02_warn_level_thresholds` |
| HK-02 | Re-crossing and repeated runs (SYS-02) | One notice per upward crossing; none while the band is unchanged; after a drop the next crossing notifies again; a jump to the limit announces 95 once; an undelivered notice is retried | `test_housekeeping.py` `test_sys02_*`, `test_undelivered_notice_is_retried_next_run` |
| HK-03 | Over the limit with imported prices (SYS-02) | Level `limit` is stored, price rows and tracked imported stocks are untouched | `test_sys02_prices_are_never_deleted_even_over_the_limit` |
| HK-04 | LRU cap (docs/04 3.10) | Only stocks tracked as `opened` with no prices, no watchlist, no portfolio and no owner-entered data are un-tracked, least recently opened first, in one atomic UPDATE | `test_sys02_lru_untracks_only_opened_without_prices...`, `test_hkx04_*`, `test_hkx05_*` |
| HK-05 | Late or skipped cron (SYS-03) | One run deletes everything past its age (sessions, codes, states, jobs, runs, alert events, uploads); active/queued/running rows stay; a second run changes nothing; dry run counts and writes nothing | `test_sys03_catch_up_deletes_everything_past_its_age_in_one_run`, `test_dry_run_through_the_runner_prints_counts_only_and_changes_nothing`, `test_cli_dry_run_prints_scrubbed_details` |
| HK-06 | MF NAV trim | NAVs older than 12 months are deleted only for schemes that are not opened (`last_opened_at`), not tracked, not on the watchlist and not an alert target; a scheme's newest NAV is never deleted | `test_hkx01_*`, `test_hkx02_*`, `test_hkx03_*` |
| HK-07 | Overlapping runs (SYS-05) | A second `housekeeping` while one runs records `skipped` and does not run | `test_sys05_overlapping_housekeeping_second_run_is_skipped` |
| HK-08 | Backup content | No `password_hash`, broker token, session, `broker_key`, secret-looking setting or prices; derived and detected-only rows excluded; every column of an exported table is exported or listed as excluded | `test_backup.py` `test_backup_has_no_broker_token_or_password_hash`, `test_every_column_is_exported_or_deliberately_excluded` |
| HK-09 | Encryption | Only a public `age1...` recipient is accepted (a private key is refused before `age` runs); the file written is ciphertext only, with no plaintext sibling; no key means no backup (dry run needs none) | `test_encrypt_refuses_private_key...`, `test_backup_file_is_ciphertext_only`, `test_backup_needs_a_key_and_dry_run_does_not` |
| HK-10 | Restore drill (SYS-08) | Encrypted dump decrypts and restores into a wiped database in one transaction; counts equal the file header; numeric text, JSON params, ids and FKs survive; sequences continue; the seeded password stays; a locked placeholder is used without an owner row; a failing row rolls everything back; a second restore is refused (HKX-12) | `test_sys08_restore_drill_encrypted_dump_counts_and_values`, `test_restore_*`, `test_parse_dump_*` |
| HK-11 | Workflows (SYS-04, SYS-05, SYS-06, BRK-14) | One workflow per schedule row with the cron and timeout of docs/04 section 2, dispatch, no-cancel concurrency, SHA-pinned actions, no broker variables or removed-job workflows (BRK-14 not applicable), keepalive monthly to `heartbeat`, backup uploads only `*.age` for 14 days (D08-9); runbook has the disabled-schedule checklist, restore drill, home-machine fallback and Render plan B | `test_workflows.py` (the YAML is parsed: cron, timeout, permissions, triggers, upload step, secrets per workflow) |
| HKX-01 | Opened but untracked scheme with a 13-month-old NAV (review B1) | Kept; tracked, watched and alerted schemes keep theirs; an unopened plain scheme loses only the old NAV | `test_hkx01_*`, `test_hkx02_*` |
| HKX-02 | Scheme whose newest NAV is older than 12 months | Its newest NAV is never deleted; older ones go; a second run deletes nothing | `test_hkx03_*` |
| HKX-03 | Stock holding an alert, action, adjustment, fundamentals or shareholding beyond the LRU cap (S6) | Stays tracked; only a stock without owner data is un-tracked | `test_hkx04_*` |
| HKX-04 | LRU un-track atomicity (S6) | One UPDATE statement that re-checks the exemptions and returns the symbols | `test_hkx05_*` |
| HKX-05 | Partial `refresh_job` with remaining symbols older than 90 days | Kept; partial without remaining work and finished rows go | `test_hkx06_*` |
| HKX-06 | Full run before/after counts for every owner table (S4), also over the limit | watchlist_item, portfolio_txn, portfolio_adjustment, alert, corporate_action, price_daily, fundamental_value, shareholding and instrument counts unchanged | `test_hkx07_*` |
| HKX-07 | One source for the soft limit (S3) | `DB_SOFT_LIMIT_MB` from the environment only (empty or invalid = 380, an `app_setting` row is ignored); `DB_WARN_LEVEL` is never written, `DB_WARN_NOTIFIED` is | `test_soft_limit_comes_from_the_environment_only`, `test_an_app_setting_row_does_not_override_the_environment_limit`, `test_sys02_prices_are_never_deleted_even_over_the_limit` |
| HKX-08 | Telegram notice text | HTML-escaped as a whole | `test_notice_text_is_html_escaped` |
| HKX-09 | `--dry-run` output (S2) | Prints scrubbed counts-only details (no symbols, secrets redacted); a real run does not print details; the database is unchanged | `test_dry_run_through_the_runner_*`, `test_cli_dry_run_prints_scrubbed_details` |
| HKX-10 | `app_setting` export (S7) | Exactly the allow-list is exported through the SQL path; secret-looking, unknown and `DB_WARN_*` keys never are; the allow-list is guarded against secret-looking names | `test_hkx10_*`, `test_only_allow_listed_settings_are_backed_up`, `test_allow_list_guard_*` |
| HKX-11 | Corporate action whose batch is an excluded prices batch (S5) | `import_batch_id` exported as NULL, the kept batch reference stays, and the dump restores with no dangling FK | `test_hkx11_*` |
| HKX-12 | Second restore into a filled target (B2) | Refused before anything is written, tables identical, the dry run reports the same | `test_hkx12_*` |
| HKX-13 | Instrument id 1 AAA in the file vs existing id 1 XYZ (B2) | Refused by default; with the check bypassed the insert collides and everything rolls back | `test_hkx13_*` |
| HKX-14 | A conflict swallowed by an insert (B2 defence in depth) | The per-row verification fails and the transaction rolls back (the old lower-bound count passed) | `test_hkx14_*` |
| HKX-15 | Sequence re-sync | Never lowered below its current value or the max id | `test_hkx15_*` |
| HKX-16 | `.age` file restored without `--identity` | Refused with a clear message (exit 2) | `test_hkx16_*` |
| HKX-17 | Plaintext restore | Allowed only with a loud stderr warning | `test_hkx17_*` |
| HKX-18 | `age` wrapper (S4) | Stub executable on PATH: fixed argv and stdin; failure keeps a scrubbed first stderr line; missing binary named; real `age` round trip runs when installed (CI installs it) | `test_run_age_*`, `test_real_age_round_trip` |
| HKX-19 | Header validation | A header missing a known table, or naming an unknown one, is refused | `test_parse_dump_requires_every_table_in_the_header` |
## PRED: prediction tab (F09)
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| PRED-01 | Banner and disclaimer in every state | The experimental banner (no button in it) and the disclaimer are shown while loading, in `no_model`, `insufficient_universe`, `ok`, with odd values and on an API error; a missing disclaimer falls back to the spec text | U (`prediction-tab.test.tsx` PRED-01) |
| PRED-02 | ML-04 UI side: the honest live state | `insufficient_universe` / `no_model` show plain-language copy plus `state_reason`, both horizons hidden with the no-model copy and no `%`/price, no fan chart, no model card, an unknown reference close shown as a dash with its reason, trend/risk gauges with a reason when null (never 0, NaN or Infinity) | U (`prediction-tab.test.tsx` ML-04) |
| PRED-03 | Ok state content | Bucket text in words, numbers only behind "Show the numbers" (fractions rendered as percent, price range from `price_q10` to `price_q90`), dashed forecast fan chart through `ChartFrame`, source and as-of chips, model card (version, date, AUC, Brier vs baseline, folds, guardrail), live track record with its count, "How to read this"; zero resolved predictions says so and shows no rate | U (`prediction-tab.test.tsx` PRED-03) |
| PRED-04 | Degrade per field | A wrong type becomes an explicit UNREADABLE marker per section (model, track record, horizons, trend/risk, resolved, guardrail_pass), shown as "could not be read" and logged, never as "no model", "No resolved predictions yet" or "Not passed"; an unknown bucket reads "Direction not classified", an unknown `hidden_reason` or `state` gets generic copy; a shown horizon with an unusable band says its data could not be read; the tab never blanks | U (`prediction-tab.test.tsx` PRED-04) |
| PRED-05 | Error and stale states | An API error shows the message with a working Retry and the banner stays; `meta.stale` marks the as-of chip "(stale)" | U (`prediction-tab.test.tsx` PRED-05) |
| ML-05 (UI) | Guardrail fails | `guardrail_failed` banner, each hidden horizon shows its reason and no numbers, no fan chart; with the real API shape (model null on every horizon) the empty-card copy says the latest model did not pass its checks and no card is served, never "no model has been trained" | U (`prediction-tab.test.tsx` ML-05) |
| ML-06 (UI) | Every `hidden_reason` enum value | Each of the six values has its own plain-language copy and no numbers; an unconfirmed action ("near_corporate_action") tells the owner to confirm the possible split first and links to the Events tab | U (`prediction-tab.test.tsx` ML-06) |
| ML-12 (UI) | No single target price anywhere | Only the reference close and a price RANGE are rendered (the median price is never shown); the fan chart is three range lines; "target price" appears only in the banner's negation; the prediction source files never name a target price | U (`prediction-tab.test.tsx` ML-12) |
| PREDX-01 | State copy table is complete and extensible | Every state `predict.go` state() can return, plus `training_aborted` (and the hidden reasons `awaiting_predictions`, `not_tracked`), has copy; an unknown or unreadable state gets generic honest copy; each state renders its copy and the served reason | U (`prediction-tab.test.tsx PREDX-02`) |
| PREDX-03 | Events link beside the near_corporate_action message | An inline link inside the hidden-reason message and the bottom link both go to `?tab=events`; other reasons have no inline link | U (`prediction-tab.test.tsx PREDX-03`) |
| PREDX-04 | Model note is owner-facing | No "not served by the API" wording; F09-1 named as an owner decision | U (`prediction-tab.test.tsx PREDX-04`) |
| PREDX-05 | Source and as-of on every block | Gauges, model card and track record each show a source chip and an as-of (model run date, or "not served") | U (`prediction-tab.test.tsx PREDX-05`) |
| PREDX-06 | meta.stale, meta.as_of and warnings[] | meta.stale or a `stale_data` horizon marks the chip stale; warnings are rendered; meta.as_of stands in only when a forecast exists | U (`prediction-tab.test.tsx PREDX-06`) |
| PREDX-07 | Unreadable sections and fraction ranges | p_up, hit rate and band coverage outside 0..1 are unreadable (54 never renders as 5,400%); wrong types never assert a boolean or count | U (`prediction-tab.test.tsx PREDX-07`) |
| PREDX-08 | Track chart as-of | as-of is null ("as of not served"); the source string says "tracking since"; values rounded to 6 places; CSV and table hold no float noise | U (`prediction-tab.test.tsx PREDX-08 and ML-12 (UI)`) |
| PREDX-09 | Repeated horizon days | Unique keys and ids; no duplicate-key warning | U (`prediction-tab.test.tsx PREDX-09`) |
| PREDX-10 | Gauge bands have no gaps | Trend and risk bands touch; 20.5 lands in "Down"; the Overview shares the bands | U (`prediction-tab.test.tsx PREDX-10`) |
| PREDX-11 | Lazy chunk loading state | The banner and the default disclaimer render while the chunk is held back | U (`prediction-lazy.test.tsx`) |
| F15R-01 | UI-09 guard matches whole ids (F15 review B1) | A mapped test id must equal a declared `data-testid`/`testId` string or be produced by a declared template; a prefix, a suffix or a typo fails; wildcard-mapped admin fields render their own text | U (`f15-polish.test.tsx`, `admin-status.test.tsx`) |
| F15R-02 | 501 is not retried (F15 review S2) | `shouldRetry` is false for 501 / `NOT_IMPLEMENTED`; with the app's default query client the admin screen calls `GET /admin/status` exactly once and shows "Not available yet" at once; the e2e run sees exactly one call | U (`admin-status.test.tsx`, `api-client.test.ts`), E (`browse.spec.ts`) |
| F15R-03 | One odd value does not blank Admin status (F15 review S3) | An unknown `warn_level`, a string where a number belongs, a broken job or table row, or a wrong-typed block degrades only that field or card; source rows beyond mfapi/amfi/telegram (broker) are kept and shown | U (`admin-status.test.tsx`) |
| F15R-04 | Paused until (F15 review S4) | Shown only while `disabled_until` is after now (now injected in tests); a past, null or invalid value shows "Not paused" | U (`admin-status.test.tsx`) |
| F15R-05 | Bundle gate cannot pass on nothing (F15 review S5) | Zero measured routes, fewer routes than `app/**/page.tsx` files, or a listed chunk missing on disk is an error | U (`bundle-budget.test.ts`) |
| F15R-06 | Lighthouse gate uses the median of 3 runs (F15 review S6) | Median per category; a missing score is a failure; a pinned `lighthouse` devDependency is used (no `npx --yes`) | U (`bundle-budget.test.ts`), CI |
| F15R-07 | Service worker cache per build (F15 review S10) | The cache name carries the build id (`/sw.js?v=`); activate deletes every other cache; the manifest is not precached; an offline navigation with no cached offline page still gets a Response; `/sw.js` is served with `default-src 'none'; connect-src 'self'` | U (`f15-polish.test.tsx`) |
| F15R-08 | Duration rounding (F15 review nit) | 999.6 ms is `1.0 s`, 59.96 s is `1 min 00 s`, a value under 0.5 ms is `<1 ms` | U (`format.test.ts`) |

## MFH: mutual fund holdings (decision D-MF; owned by B15 backend and F16 web; formulas in docs/05 8.5, API in docs/03 12a, screens in docs/06 6.7a)
Test IDs carry a letter so they cannot be confused with the question numbers MFH-1..24: `MFH-V` validation and API, `MFH-I` importer, `MFH-F` formulas and views, `MFH-U` UI; gaps in numbering are intentional. Questions MFH-2..MFH-24 live in `docs/OPEN_QUESTIONS.md`; a row whose behaviour depends on an open answer is marked with the question number and may change when the owner answers.
| ID | Scenario | Required behavior | Test |
|---|---|---|---|
| MFH-V01 | Create MF txn with units, nav or amount <= 0, units > 1e9, more than 4 decimals, exponent notation, or a non-numeric string | 422 `UNPROCESSABLE`, `details.fields` names each field; nothing stored | U/I (B15) |
| MFH-V02 | `txn_type` is `switch_in`, `switch_out` or `bonus_merger` (API, form and import row) | 422 `MF_TXN_TYPE_NOT_SUPPORTED` with the exact message of docs/06 section 9; import row error; an unknown type text is a different row error listing the text (MFH-4) | U/I (B15) |
| MFH-V03 | `txn_date` in the future (IST) or before 1990-01-01 | 422 on field `txn_date`; import row error | I (B15) |
| MFH-V04 | Unknown `scheme_code`; empty or 41-char folio | 404 `NOT_FOUND` for the scheme; 422 for the folio | I (B15) |
| MFH-V05 | Redemption above the units held at that date in the scheme+folio | 422 `INSUFFICIENT_UNITS` with `details {transaction_id, date, held_units, redeem_units}`; other folios of the same scheme do not count | I (B15) |
| MFH-V06 | Edit or delete an earlier purchase so a later redemption would oversell (PATCH changing folio included: old and new folio are both re-validated) | 422 `INSUFFICIENT_UNITS`, nothing changes | I (B15) |
| MFH-V07 | Two txns on the same date: purchase and redemption of the full holding | Order is unit-adding rows first, then redemptions, each by id (B11-1 rule); the redemption is valid; reversing the ids does not change the outcome | U (B15) |
| MFH-V08 | Redemption exceeds held units by 0.0005 (rounding dust) and by 0.01 | 0.0005: accepted, warning `UNITS_ROUNDED`, clamped, no negative lot; 0.01: 422 `INSUFFICIENT_UNITS` (MFH-8) | U (B15) |
| MFH-V09 | `abs(units x nav - amount)` above max(1.00, 1% of amount) (the statement's amount is units x NAV; stamp duty is separate, MFH-6 correction) vs within tolerance; amount 999.95 with stamp duty 0.05 and units x nav = 999.95 | Stored, warning `AMOUNT_MISMATCH` (never an error) only above the tolerance; the 999.95 + 0.05 row raises no warning and its cost and cash outflow are 1000.00 | U (B15) |
| MFH-V10 | Weekend or listed-holiday `txn_date`; scheme whose first stored NAV is after `txn_date`; identical row already stored | Stored with warnings `NON_BUSINESS_DAY`, `NAV_FEED_STARTS_AFTER_TXN`, `DUPLICATE_LOOKING_TXN` respectively; no error | U (B15) |
| MFH-V11 | Idempotency: same `Idempotency-Key` and body twice; same key and a different body; no key | Replay returns the stored 201 with `Idempotent-Replayed: true` and one row; different body is 409 `CONFLICT`; without a key two identical rows are stored (legitimate repeat SIP) | I (B15) |
| MFH-V12 | POST/PATCH/DELETE without the CSRF header, or without a session | 403 / 401 like every non-GET route | I (B15) |
| MFH-V13 | Writing the first txn of a scheme, then deleting its last txn | `mf_scheme.is_tracked` becomes true on create; on delete it is re-derived (watchlist or remaining holdings keep it); no NAV backfill is forced | I (B15) |
| MFH-V14 | PATCH tries to change `scheme_code` or `source` | 422; delete and re-create is the documented path | I (B15) |
| MFH-V15 | `GET /portfolio/summary?view=` with an unknown value, missing value, and each of all/equity/mf | Unknown: 422 `details.fields`; missing: `equity` and the response equals the pre-D-MF stocks-only contract; the three views return `view` echoed | I (B15) |
| MFH-V16 | Fund-name mapping API (MFH-23): create a mapping; repeat with the same scheme; change it while no transaction depends on it; change it while rows depend on it without and with `remap=true`; unknown scheme; empty and 201-character name; remap that would oversell a sequence | Create 200; same scheme is a no-op; change with 0 rows allowed; with rows and no `remap` `409 FUND_MAPPING_IN_USE` (`details.rows`); `remap=true` rewrites the rows in one transaction, appends the audit note, re-derives `is_tracked`; unknown scheme 404; bad name 422; oversell `422 INSUFFICIENT_UNITS` and nothing changes | I (B15) |
| MFH-I20 | Upload limits and type: file over 2 MB, over 5,000 rows, a `.exe` renamed `.csv`, an `.xlsx` renamed `.csv` (accepted: content decides), a CSV renamed `.xlsx` (accepted as CSV), a non-xlsx zip, empty file | 413 over the size limit; 422 with a plain message over the row limit and for a wrong content type (magic bytes decide, extension alone never); a real xlsx or CSV is accepted whatever its extension (`.csv`, `.txt`, `.xlsx`); empty file 422; nothing stored | I (B15) |
| MFH-I21 | xlsx hardening: macro-enabled workbook (`vbaProject.bin`), external link or embedded object, zip bomb (ratio over 100:1 or over 20 MB uncompressed or over 50 entries), formula cell without cached value, workbook with 6 sheets, a formula cell is never evaluated | Rejected before parsing rows or parsed read-only with the stated limits; formulas are never evaluated; no network access during parsing (egress test); 422 with a plain message (stdlib reader, B15-1) | U/I (B15) |
| MFH-I22 | Header matching: the statement header `Date, Fund Name, Transaction Type, Folio No, Units Traded, NAV, Amount, Stamp Duty` in any case, spacing or column order; a blank row right after the header; blank rows in the middle; extra unknown columns (including personal data columns); a required header missing; header synonyms; header not on line 1 of an xlsx sheet | Columns are read by header name; blank rows are skipped (row numbers stay file lines); extra columns are discarded and never appear in preview, logs or errors; a missing required header rejects the file naming the header; an empty Stamp Duty is 0 | U (B15) |
| MFH-I23 | Fund resolution (MFH-23, replaces the ISIN rule: the statement has no ISIN): a fund name with a stored mapping; a name without one; the same name appearing in several rows; two names that normalise to the same key (case, spacing, `&`); a mapping whose scheme was deleted | Mapped names resolve to the stored scheme; unmapped: every row is error `UNMAPPED_FUND` naming the fund; the name is never auto-matched by name or ISIN; names with the same normalised key share one mapping | U/I (B15) |
| MFH-I24 | Re-import the same statement; an overlapping statement (new file containing old rows); the same file after a mapping was re-mapped | Re-import: `inserted 0`, `skipped_duplicates` = rows; overlap inserts only new rows; the dedupe key uses the normalised fund name, so a re-map does not make old rows importable again (MFH-12, MFH-24) | I (B15) |
| MFH-I25 | CSV injection: `note`/folio/fund text starting with `=`, `+`, `-`, `@`, tab or CR (import, manual form, and any CSV export) | Stored as plain text, never evaluated; any CSV export prefixes such a cell with `'`; control characters removed; HTML-escaped in the UI | U (B15, F16) |
| MFH-I26 | Number and date parsing: `1,234.56`, lakh grouping `1,23,456.78`, `1234,56`, `12,34`, 5-decimal units, `05-Nov-2026` (and `5-nov-2026`, `05-Sept-2026`), `05-Xyz-2026`, `DD-MM-YYYY`, `DD/MM/YYYY`, an Excel date cell, an ambiguous `03/04/2026`, a folio `12345678/90` and `00123` | D-P rules; more than 4 decimals is a row error, not rounded; `DD-Mon-YYYY` is read with English month abbreviations; `DD/MM/YYYY` is read day-first (accepted only because the format is fixed and documented); the folio stays text exactly as typed (slash and leading zeros kept, never read as a date or number); each rejected cell names row and column | U (B15) |
| MFH-I27 | Any row error in the file | Commit is rejected 422 (like every kind); preview lists up to 200 errors with row and column; counts by type, matched schemes and date range are returned | I (B15) |
| MFH-I28 | Undo a `mf_statement` batch within 30 days; after 30 days; twice; when a later manual redemption would then oversell | Rows of the batch are deleted; 409 after 30 days or when already undone; 409 `UNDO_BREAKS_HOLDINGS` with `details {scheme_code, folio, date}` and nothing changed (MFH-20) | I (B15) |
| MFH-I29 | Statement rows for switches or merger/bonus | Row error `MF_TXN_TYPE_NOT_SUPPORTED`; the message names the row and tells the owner to enter a switch as a redemption plus a purchase | U (B15) |
| MFH-I30 | Privacy: statement containing name, PAN, address and balances | Only the listed logical columns are read; none of the others reach the database, the preview, the error list, the response, logs or fixtures; log scrub test finds no PAN-shaped or name text; committed fixtures are synthetic | U (B15) |
| MFH-I31 | Negative, zero or reversal rows | Row error `NEGATIVE_OR_REVERSAL_ROW` (MFH-16) | U (B15) |
| MFH-I32 | Safe Edition: importer and holdings code | No new egress host or URL literal; deny-list and egress tests (SAF-01, SAF-13) pass; NAV comes only from `mf_nav`; no broker or order code | CI (B15) |
| MFH-I33 | Statement shape (synthetic fixture with the 8-column header, a blank row after it, `Purchase` rows, 3-decimal units, 2-decimal amounts, a folio with a slash, `DD-Mon-YYYY` dates) as CSV and as xlsx | Both formats give identical normalised rows; the blank row is skipped; types map to `purchase`; cost per row = amount + stamp duty; no row error | U/I (B15) |
| MFH-I34 | Mapping flow: validate a file with two unmapped fund names; candidates for each; save both mappings; `revalidate` the same upload; commit; a later file with the same names | First validate: `mf.unmapped_funds[]` with candidates (watchlist schemes first; plan and option explicit; at most 10) and one `UNMAPPED_FUND` error per row; commit is 422 while any remains; after `PUT /portfolio/mf/fund-mappings` and `revalidate` (same `upload_id`) there are no errors and commit succeeds; a later file reuses the mappings with no prompts | I (B15) |
| MFH-I35 | Identical rows (MFH-24, multiset): a file with two rows identical on every field; commit; re-import the same file; a file with three such rows; untick one row (`excluded_rows`) | Both rows are warned `DUPLICATE_IN_FILE` (informational, not excluded by default) and both commit as separate transactions; the re-import inserts 0; the three-row file inserts exactly 1 more; an excluded row is not imported and does not shift the occurrence index of the others; an unknown excluded line is 422 | I (B15) |
| MFH-I36 | Valid-looking data facts (synthetic): one fund name mapped to a scheme shared by several plans; the same folio number under two funds of one AMC; a date on a weekend or holiday; several purchases of one fund in one month | Folio is not unique per fund (two separate `(scheme, folio)` ledgers; a redemption in one does not use the other's units); the weekend date is accepted with `NON_BUSINESS_DAY`; several purchases a month are normal; the plan and option shown are those of the mapped scheme | I (B15) |
| MFH-F40 | Value = units x `nav_on_or_before(as_of)`; `as_of` on a weekend/holiday | Uses the last NAV on or before `as_of`; `nav_date` returned; decimal arithmetic exact (0.1 + 0.2 style sum test) | U (B15) |
| MFH-F41 | NAV older than 4 calendar days before `as_of` (stale), exactly 4 days, and a NAV newer than `as_of` | 5 days: value shown with `nav_stale=true` and `NAV_STALE` warning, `meta.stale=true`; exactly 4: not stale; a NAV after `as_of` is ignored | U (B15) |
| MFH-F42 | Scheme with units but no NAV on or before `as_of`; one such scheme among several priced ones | Row `nav`, `market_value`, `unrealized_*`, `xirr_pct` null with `no_nav`; view `market_value` and `total_pnl` null with `missing_nav: <name>` (never a partial sum); units and invested still returned; XIRR of the view null `missing_nav` | I (B15) |
| MFH-F43 | FIFO golden: lots 100 u cost 1000 and 100 u cost 1200; redeem 150 u for 2250; NAV 14; and the same with the first lot bought as amount 999.95 + stamp duty 0.05 | Consumed cost 1600, realised 650, remaining 50 u cost 600 (`invested`), value 700, unrealised 100, `avg_cost` 12; the stamp-duty variant gives identical results (lot cost 1000.00 = amount + stamp duty) | U (B15) |
| MFH-F44 | Invested = cost of units held: SIP of 80 purchases, no redemption | `invested` = sum of amounts; `realized_pnl` and `idcw_income` are `0.0000` (a known zero, not unknown); unrealised = value - invested | U (B15) |
| MFH-F45 | Fully redeemed scheme | Hidden by default, listed with `include_exited=true` (`exited=true`, units 0, no NAV needed); realised P&L stays in totals; no terminal flow | I (B15) |
| MFH-F46 | Unrealised, realised and IDCW income kept apart | Three separate fields; `total_pnl` = their sum; no field mixes them; property test over random ledgers | U (B15) |
| MFH-F47 | `idcw_payout` | Creates no lot, adds to `idcw_income`, is a positive XIRR flow on its date (vector 8.5.5 IDCW: r = 0.07400) | U (B15) |
| MFH-F48 | `idcw_reinvest` | Creates a lot with cost = amount, no XIRR flow, counts in `idcw_income`; total P&L equals the gain computed from cash flows (invariant test) | U (B15) |
| MFH-F49 | XIRR vectors of docs/05 8.5.5: MF only, equity only, SIP, redemption | 0.20214, 0.09971, 0.09213, 0.08033 within 1e-4 | U (B15) |
| MFH-F50 | Pooled XIRR (view `all`) vs the average of the two | 0.12294 within 1e-4; the value 0.15093 (average) is never returned; adding MF transactions does not change the Equity view's XIRR and vice versa | U (B15) |
| MFH-F51 | Under one year: first flow 200 days ago (MF, equity and all), and exactly 365 days | 200 days: `xirr_pct` null, `xirr_reason=under_one_year`, `absolute_return_pct` present with its basis; 365 days: XIRR returned together with the absolute return; same rule per holding row (MFH-3) | U (B15) |
| MFH-F52 | SIP-style holding: first instalment 3 years ago, latest 2 weeks ago | Annualised (flows carry the dates); holding row age uses its first flow, not its last | U (B15) |
| MFH-F53 | XIRR degenerate cases: only purchases and unpriced holding; no sign change; one flow; purchase_cash 0 | `null` with `missing_nav`, `no_sign_change`, `insufficient_flows`, `no_purchases` respectively; never 0 | U (B15) |
| MFH-F54 | All three views on a ledger with only equity, only MF, and both | `all` equals `equity` when there are no MF rows and equals `mf` when there are no stock rows (every total and XIRR); with both, totals are decimal sums and `breakdown[]` has two rows | I (B15) |
| MFH-F55 | Fund merger or closed scheme: `status='inactive'` or last NAV older than 10 days | Valued at the last NAV, warnings `SCHEME_MAY_BE_MERGED` and `NAV_STALE`; flag `merged_suspected`; no crash and no zero value (MFH-13) | U (B15) |
| MFH-F56 | IDCW scheme with no `idcw_*` rows; Growth scheme | Warning `IDCW_PAYOUTS_NOT_RECORDED` only for the IDCW scheme; `plan` and `option` come from `mf_scheme` (unknown shown as `unknown`, never guessed) | U (B15) |
| MFH-F57 | Day change for MF holdings: normal, stale NAV, only one NAV row | `units x (nav - previous_nav)`; null with `nav_stale` or `no_previous_nav`; view total null with a reason naming the schemes | U (B15) |
| MFH-F58 | Absolute return (MFH-18) for a no-redemption SIP and for a ledger with a redemption and IDCW | (value + proceeds + idcw cash - purchase cash) / purchase cash; equals unrealised/invested when nothing was redeemed | U (B15) |
| MFH-F59 | Allocation and weights | `allocation_by_scheme`, `_by_category` sum to 100 within the MF sleeve, stock allocations within the equity sleeve, `by_asset_class` only for `all`; holding `weight_pct` is relative to the view total; unpriced holdings excluded with `allocation_excludes_unpriced` | U (B15) |
| MFH-F60 | Switch pair (deferred, MFH-22): switch_out + switch_in same date | Not implemented in v1; the test is added with the feature: pooled views contribute no net flow, scheme-level view shows both legs; until then MFH-V02 covers the rejection | N/A in v1 |
| MFH-F61 | Backup includes `mf_txn` and `mf_fund_name_map`; restore round-trips rows, `dedupe_key` and `import_batch_id` (null if batch gone) and the mappings | Export list of docs/04 3.11 has both tables; restore test compares row counts and a holdings summary before and after | I (D08 amendment in B15) |
| MFH-F62 | Contract: openapi, docs/03 12a and `field-map.json` agree; generated types current | `npm run check:generated` in `packages/api-types` clean; field-map has an entry for every new response field; UI-09 guard passes | CI (B15, F16) |
| MFH-F63 | Stamp duty (MFH-6 correction): purchase amount 999.95 + stamp duty 0.05; the SIP vector of docs/05 8.5.5 re-run with split amount and stamp duty | Lot cost, `invested`, `purchase_cash`, the XIRR outflow and the absolute-return denominator all use `amount + stamp_duty`; the XIRR equals the vector within 1e-4; a redemption's stamp duty never enters a flow | U (B15) |
| MFHX-01 | B15 review S2/S10: dust clamp boundaries | A redemption exactly 0.001 above the held units is clamped (`UNITS_ROUNDED`); 0.0011 above is `INSUFFICIENT_UNITS`; with nothing held (never bought, or fully redeemed) even 0.0005 units is `INSUFFICIENT_UNITS`; dust left after a redemption stays held (B15R-3) | `TestDustBoundaries`, `TestMFRedemptionSequence` |
| MFHX-02 | B15 review B1: hostile xlsx cell references | `XFD2`, a 4-letter column, lowercase `a2`, `Ab2`, `2`, `B`, `B$2`, column 257 and a row with 261 reference-less cells reject the workbook (`ErrXLSX`, 422) without panic or an unbounded allocation; `IV7` (256) is accepted | `TestXLSXCellRefHardening` |
| MFHX-03 | B15 review S10: central directory that lies about sizes | A workbook whose central directory claims 100 bytes for a 5 MB part is rejected as an xlsx error (never a 500, never read past the byte budget) | `TestXLSXLyingCentralDirectory` |
| MFHX-04 | B15 review S10: DOCTYPE and entity payloads | An internal entity bomb and an external `SYSTEM` entity are never expanded or fetched: the sheet is rejected | `TestXLSXEntityPayload` |
| MFHX-05 | B15 review N4/S10: hidden sheets | A `hidden` or `veryHidden` sheet is never read (header not found when it is the only one); a visible sheet next to it is read | `TestXLSXHiddenSheet` |
| MFHX-06 | B15 review S4: `workbookPr date1904` | Serial 44869 in a 1904 workbook (`1` or `true`) and 46331 in a 1900 workbook (absent or `0`) both read 2026-11-05 | `TestXLSXDate1904` |
| MFHX-07 | B15 review S5: numeric folio cells | A 19-digit and a 17-digit numeric folio keep every digit (raw `<v>` text) with warning `FOLIO_STORED_AS_NUMBER`; a text folio `000123456` or `007/89` keeps its zeros with no warning; scientific notation is row error `FOLIO_INVALID`; the canonical form carries the same folio | `TestXLSXFolioRawText` |
| MFHX-08 | B15 review N4: cell text length | A cell over 2,000 characters is an `UNREADABLE_CELL` row error | `TestXLSXCellTextCap` |
| MFHX-09 | B15 review S1: xlsx feature flag | With `MF_XLSX_ENABLED` off an xlsx (also one renamed `.csv`) is `422` "xlsx not enabled", nothing is stored, CSV works; with it on the same file validates | `TestXLSXFlagOff`, `TestMFXLSXFeatureFlag` |
| MFHX-10 | B15 review B2: canonical stored form | The stored form has no name, PAN, address, balance, email, title or footer text; it re-reads to the same rows, dedupe keys, error rows and line numbers; an unreadable cell stays an `UNREADABLE_CELL` error; control characters are removed | `TestCanonicalForm` |
| MFHX-11 | B15 review B2: `import_upload.content` scan | After validating a CSV and an xlsx with a synthetic name and PAN, no stored `import_upload` row contains either (nor the raw `PK` bytes); `revalidate` and `commit` work from the stripped content with the same row numbers; a header-less file stores a stub only | `TestMFStoredUploadIsStripped` |
| MFHX-12 | B15 review N8: export guard | Imported fund and folio text starting with `=`, `+`, `-`, `@` is stored as written and `SafeCSVCell` prefixes it for any future MF export | `TestMFExportTextIsGuarded` |
| MFHX-13 | B15 review S6: concurrent re-map | A commit that waits on the fund-name advisory lock (7013) while another writer re-maps the name stores its rows under the new scheme; none is left under the old one | `TestMFCommitSeesConcurrentRemap` |
| MFHX-14 | B15 review S7: `GET /portfolio/mf/txns?scheme_code=` | `1abc`, `101abc`, `0`, `-5`, `1.5`, `+101`, ` 1`, `99999999999`, `2147483648`, `abc`, `0x65` are `422` with field `scheme_code`; `101` and `2147483647` are 200 | `TestMFTxnListSchemeCodeParam` |
| MFHX-15 | B15 review S9: exclude errored rows | Of two errored rows, excluding one still blocks (422); excluding both commits the valid rows; an unknown line is 422 `excluded_rows`; a header error cannot be excluded | `TestMFCommitExcludesErroredRow` |
| MFHX-16 | B15 review N2: edit scope | A `PATCH` is validated against its own (old and new) folio only: an unrelated, already inconsistent folio of the scheme does not block it; an own-folio oversell is still `INSUFFICIENT_UNITS`; dust on update warns `UNITS_ROUNDED` | `TestMFUpdateScopedToItsFolios` |
| MFHX-17 | B15 review S10/N1: XIRR from real rows and the benchmark shape | 100 invested 730 days before a value of 150: MF view, holding and `all` view XIRR = sqrt(1.5) - 1 = 22.4745 % (1e-2), absolute return 50, span 730; the benchmark of `all` and `mf` has the keys code, xirr_pct, reason, level_as_of, note (null values, reason `not_defined_for_view`) | `TestMFXIRRFromRows` |
| MFHX-18 | B15 review N3: `unrealized_pct_reason` | A zero cost base gives `unrealized_pct` null with reason `n/m` on holdings and totals; a normal holding has the percentage and no reason | `TestUnrealizedPctReason` |
| MFHX-19 | B15 review S10: `signs` XIRR | -100 (2022-01-01), -100 (2022-06-01) and a terminal 100 on 2025-01-01: XIRR = -21.994 % (1e-4) and absolute return -50 | `TestDegenerateReturns` |
| MFH-U70 | View switcher: default, URL `?view=`, unknown value, keyboard, switching while loading | Default All; URL is the state; unknown value falls back to All; arrow-key operable radio semantics; previous data stays until the next view arrives (no blank flash) | U/E (F16) |
| MFH-U71 | Each view's cards (table of docs/06 6.7a) | All shows breakdown with the no-average footnote and both return-basis labels; Equity hides IDCW card; Mutual funds hides Nifty comparison, estimated dividends and adjustments; hidden items are absent, not zero | U (F16) |
| MFH-U72 | Honesty: unknown, stale and partial MF values | Em dash + reason tooltip, never `0`, `NaN`, `Infinity`; partial total shows 'Value unavailable: {names} have no NAV yet.' (no partial sum); stale chip 'NAV as of {date}' with the value still shown | U (F16) |
| MFH-U73 | Under one year display | XIRR card reads 'Absolute return' with 'XIRR is shown after the first year' in its note (with the span and first transaction); the dash of a missing absolute return says 'absolute return not available', never the first-year sentence; no annualised number anywhere on the card, row or tooltip | U (F16, F16 review S3) |
| MFH-U74 | Empty states: no MF txns in view mf, only equity present in all, nothing at all | Copy of docs/06 section 9 with Import and Add actions; `all` shows the present class and a hint card for the other | U (F16) |
| MFH-U75 | MF transaction form and list | Types offered are the five v1 types; server errors `INSUFFICIENT_UNITS`, `MF_TXN_TYPE_NOT_SUPPORTED`, warnings shown inline; Idempotency-Key sent; focus returns after close; every control has a `data-testid` | U (F16) |
| MFH-U76 | Import wizard for `mf_statement` | Preview shows counts by type, matched schemes and date range, first 20 normalised rows only (no personal columns); errors by row/column; commit disabled while errors exist; Undo shown in batches; 409 `UNDO_BREAKS_HOLDINGS` message shown | U/E (F16) |
| MFH-U77 | Attribution and source lines | 'NAV data: AMFI, via mfapi.in' on MF value cards; units and amounts say 'your statement' or 'your entries'; stock figures say price return, MF figures total return; SAF-03 footer present | U (F16) |
| MFH-U78 | No new network from the browser | The portfolio views call only the app API (no third-party host, no iframe); deny-list passes | E (F16) |
| MFH-U79 | Statement import: errored rows can be unticked (B15R-6) | An Include box per errored data row; excluding only some errored rows still blocks the commit and the page says how many errors remain; a header problem (row 0 or 1) has no box and always blocks; more than 200 errors cannot be unticked; `excluded_rows` carries the file lines | U (F16) |
| MFH-U80 | Unrealised % reason, scheme filter, xlsx copy, escaped API text (B15R-8, B15R-1, B15R-7) | `unrealized_pct_reason` `n/m` shows a dash with the reason on holdings and totals; the scheme filter is sent only as an int32 >= 1; 'xlsx not enabled' shows 'Excel files are not enabled yet; save the statement as CSV.'; API error text containing markup is shown as plain text | U (F16) |
| MFH-U81 | Dashboard snapshot switcher (docs/06 6.2) | Same All / Equity / Mutual funds switcher with `dash-portfolio-view-*` ids, default All, component state only, `view` sent explicitly | U (F16) |
| MKTX-01 | B14 review 1: overview meta | `meta.as_of` is the newest index or mover date (never the clock); `meta.stale`/`stale_age_hours` from the holiday-aware calendar; no data gives a null `as_of` with `as_of_reason: no_data` and `stale=false` | I (`TestReviewOverviewMeta`, `TestReviewOverviewStale`) |
| MKTX-02 | B14 review 2: movers date alignment | Previous bar must be the trading day just before the newest date (holiday aware): a partial import ranks only stocks with both bars; a multi-day gap gives `movers_reason: no_common_dates`; flat or illiquid data gives `no_qualifying_movers`, never `no_prices_imported` | I (`TestReviewMoversDateAlignment`) |
| MKTX-03 | B14 review 3: liquidity filter is the 60-day average traded value | A one-day volume spike does not qualify a stock whose 60-day average is below 0.5 crore; fewer than 60 bars never qualifies (owner to confirm the number, B14-4a) | I (`TestReviewMoversUse60DayADV`, `TestMarketOverviewData`) |
| MKTX-04 | B14 review nits: index whitelist and units | Only `NIFTY50` and `INDIAVIX` show; the VIX unit is not `index points` | I (`TestReviewIndexWhitelist`) |
| MKTX-05 | Trading-day arithmetic | `PreviousTradingDate`, `AddTradingDays` (both directions, holidays, weekends), `TradingDaysBetween` | U (`TestCalendarTradingDayArithmetic`) |
| PRDX-01 | B14 review 4: no stored row | Active model and no row: `awaiting_predictions`; untracked, delisted or non-equity stock: `not_tracked` (also when an old row exists); never `insufficient_history` | I (`TestReviewPredictionNoRowReasons`) |
| PRDX-02 | B14 review 5: track-record query plan | The by-run aggregation reads `prediction` through `prediction_model_run_idx` (no Seq Scan on `prediction`); both horizons answer from one aggregation | I (`TestReviewTrackRecordUsesIndex`) |
| PRDX-03 | B14 review 6: model state from train runs | Skipped and failed runs are ignored; `aborted_timeout` is `training_aborted`; `dry_run` is `no_model` with dry-run wording | I (`TestReviewTrainStateFilters`) |
| PRDX-04 | B14 review 7: corporate action at read time | `detected` of any date, or a non-rejected ex-date within 5 trading days of the prediction date or today, hides a stored shown row as `near_corporate_action`; far or rejected actions do not | I (`TestReviewPredictionActionAtReadTime`) |
| PRDX-05 | B14 review nits: numbers and meta | Unordered quantiles hide the horizon as `stale_data`; prediction `meta.as_of` is the data date, null with a reason without a row; old rows are `meta.stale` | I (`TestReviewPredictionNumbersAndMeta`) |
| PRDX-06 | Cross-language contract for `valid_metrics` | The static fixture `fixtures/ml/guardrail_valid_metrics.json` (worker `GuardrailResult.to_json` output as `store.py` nests it) produces the model card numbers and the `insufficient_folds` and failed-guardrail reasons | I (`TestReviewValidMetricsContractFixture`) |
| ADMX-01 | B14 review 6: skipped run does not mask | `jobs[]` shows the last non-skipped run; a newer skipped run is `last_skipped_at` | I (`TestReviewAdminSkippedRunDoesNotMask`) |
| ADMX-02 | B14 review 8 and nits: db block | `tables[].rows` null for a never-analyzed table (no negative numbers); `used_pct` null without a limit; the handler returns the non-ok `warn_level` (`limit`) | I (`TestReviewAdminDBBlock`) |
| ADMX-03 | Read-time scrub | Secrets in `source_health.note` and `ingestion_run.error` never reach the response | I (`TestReviewAdminScrubsFreeText`) |
| MFHW-01 | F16 review B1: All keeps stock sections stock-only | In All the stock holdings note and the P&L breakdown chart show the stock row of `breakdown` (realised 1,234.50, unrealised 5,000.00), not the combined totals (1,534.50 and 6,510.00); `readView(view)` builds the stock totals from `breakdown[equity]` and never from the combined ones | U (`mf-f16-review.test.tsx`) |
| MFHW-02 | F16 review B1: an unpriced fund | One fund without NAV in All leaves the stock P&L chart ready (no 'unknown until every holding has a price') and the stock weights not partial; the fund side says so in the summary banner | U |
| MFHW-03 | F16 review S1: no added-up total | No 'added up' line and no browser-computed Total bar; the chart has Unrealized and Realized only; `total_pnl` is still parsed | U |
| MFHW-04 | F16 review S2: owner text for definitions | xirr_pooled, absolute_return and mf_total_return contain no ids (MFH-, B15R, D-MF), spec numbers, headings or colon-without-content; the generator reads the owner-text lines of docs/05 8.5.6a | U |
| MFHW-05 | F16 review S3: missing absolute return | Card, MF row and dashboard show a dash with 'absolute return not available', never 'XIRR is shown after the first year' (that sentence is in the note); span and first transaction appear in the note and the row chip through `format.ts` | U |
| MFHW-06 | F16 review S4: `period_too_short` | An XIRR with `period_too_short` keeps the XIRR label and shows 'under 30 days' under it; no absolute-return card replaces it | U |
| MFHW-07 | F16 review S9: reasons without a mouse | Every unknown cell has visually hidden 'Not available: {reason}' for screen readers (the dash is aria-hidden); the unpriced MF row also shows the reason as a visible line | U |
| MFHW-08 | F16 review S10: xlsx copy rule | The plain copy is chosen only for a 422 whose message says 'xlsx not enabled'; the same text on another status, or another 422, does not trigger it (F16R-3). The wizard side is MFHW-24 | U |
| MFHW-09 | F16 review S11: dashboard day-change dates | In All the dashboard card lists 'Stocks (close) as of ...; Mutual funds (NAV) as of ...' | U |
| MFHW-10 | F16 review S12: loading the next view | While loading: dimmed body, 'Updating Mutual funds...' in a polite status, `aria-busy`; old data keeps the label of the view it was asked for even when the answer has no `view` field | U |
| MFHW-11 | F16 review S13: focus | The form heading takes focus on Add and Edit; after a delete focus goes to the Add button | U (group MFHW-18) |
| MFHW-12 | F16 review S8 and N1: amounts and units | The amount hint no longer says 'net amount credited' (F16R-1); units in the list, the delete question and the toast go through `format.ts` (12,34,567.5), never a raw decimal string | U (group MFHW-18) |
| MFHW-13 | F16 review N2, N3: unreadable rows | A stamp duty or folio that cannot be read is a dash with a reason (never 0.00 or empty); such a row, and a row of a type the form does not offer, is listed with its own label and cannot be edited | U (group MFHW-18) |
| MFHW-14 | F16 review N13: stale breakdown | A stale breakdown row shows 'stale' next to its as-of and keeps its real reason text | U |
| MFHW-15 | F16 review N15: wording | The growth card names 'XIRR and benchmark cards' only in Equity and 'the XIRR card' in All | U |
| MFHW-16 | F16 review N5: sorting | Unrealized P&L sorts by the amount (not the percent); XIRR and absolute return are separate sort buttons | U |
| MFHW-17 | F16 review N6: exited rows | Stock and fund tables have their own 'show exited' switch (All asks the server when either is on); the transaction scheme filter keeps exited schemes | U |
| MFHW-18 | F16 review N4, N7, N8: transactions section | The 'sent as a new transaction' warning only after a lost try (network, timeout), not after a 422; fund-name mappings load only when opened; the folio filter asks once after a pause; after a re-map the panel says 'old -> new' and closes the form | U |
| MFHW-19 | F16 review N12: view parameter | Rapid arrow presses are not undone by a late report of an older URL; back/forward is still followed | U |
| MFHW-20 | F16 review N14: fallbacks | The Suspense fallbacks of /portfolio and /imports are skeletons | U |
| MFHW-21 | MFH-U80 (F16 review S7): `n/m` | A zero cost base shows a dash with 'not meaningful: the cost base is zero' on the holdings row and the totals line, never 0.00% | U |
| MFHW-22 | MFH-U76 (F16 review S7): preview size | A response with more than 20 preview rows shows the first 20 only; 20 or fewer are all shown | U |
| MFHW-23 | F16 review N10: commit count | The count is an estimate, a range when an unticked row may already be stored (between 5 and 7 rows), and the dialog title says the same | U |
| MFHW-24 | F16 review S10: xlsx sentence in the wizard | No 'not enabled' sentence before an upload; after a 422 'xlsx not enabled' the plain copy; another 422 shows its own text | U (`mf-f16-review2.test.tsx`) |
| MFHW-25 | F16 review N9: mapping save failure | When the second of two mapping saves fails, the message names the failed and the saved names and the upload is re-read | U |
| MFHW-E1 | F16 review S6: axe on the three views | No axe violation on All, Equity and Mutual funds, dark and light, 375 and 1440 px; no touch target under 44 px and no page-level horizontal scroll at 375 px | E (`portfolio-views.spec.ts`) |
| MFHW-E2 | F16 review S6: axe on the MF form | No axe violation on the add form (heading focused on open) | E |
| MFHW-E3 | F16 review S6: axe on the import wizard | No axe violation on the upload and review steps | E |
| MFHW-E4 | F16 review S6: keyboard | The switcher works by arrows, Home and End, rapid arrows end on the last view, the URL follows; All's stock sections show stock numbers | E |
| MFHW-E5 | F16 review S6: 375 px layout | The MF table scrolls inside its own region and its scheme column stays in view | E |

## INV: investment-context analytics (decision INV, PROPOSED; worker B16, web F17; formulas docs/05 section 12, API docs/03 4a and 11, screens docs/06 6.2a and 6.4a)

Worker rows (INV-M, INV-S, INV-P, INV-D, INV-H, INV-E, INV-V, INV-L, INV-R) are U tests in `apps/worker/tests/test_inv_*.py` with the hand-computed vectors of docs/05 section 12 (names VM1, VS1, ... in the Case column); API rows (INV-A, INV-W) are I tests in `apps/api/internal/httpx`; web rows (INV-C, INV-T, INV-U, INV-E) are U/E tests.

| ID | Case | Expected | Type |
|---|---|---|---|
| INV-M01 | Month return = month-end close over the previous month-end close (VM1) | 2022-12 +10.00, 2023-01 -10.00, 2023-02 +10.00, 2023-03 -10.00, 2023-04 +10.00, 2023-05..12 0.00, 2024-01 +10.00; the first month (2022-11) has no return | U |
| INV-M02 | Month after a gap (VM2): no bars in the previous calendar month | The return is `null` (`gap_before`), never `121/110-1`; regression for the old `month_year` pairing of non-adjacent months | U |
| INV-M03 | Running month (VM1, 2024-02; today 2024-02-15) | Cell is month to date `-10.00` and is identified by `seasonality.running`; it is in no statistic; the running month is the calendar month of today (D-INV) | U |
| INV-M04 | Year return, full year (VM1, 2023) | `-1.99`, kind `full`, `months_covered` 12, base the December-2022 close, end the December-2023 close | U |
| INV-M05 | Year return, first year of history (VM1, 2022) | `+10.00`, kind `partial_first`, `months_covered` 1, base = the close of the first (partial) month; labelled partial | U |
| INV-M06 | Year to date (VM1, 2024) | `-1.00`, kind `ytd`, `months_covered` 2, `end_date` = the last bar; `ytd` only for the year of today when the last bar is in it; a year is `full` once today's year is later (D-INV), and with the last bar in an earlier year there is no row for the running year | U |
| INV-M07 | Year edge cases | Data starting in December: first-year return `null` (`no_base`); a December without a bar in a closed year: `null` (`gap_before`); a December with bars short of its last expected trading day: `null` (`incomplete_month_data`); a single bar: no rows | U |
| INV-M08 | Chain identity | For every full and partial year `1 + Y/100` equals the product of the covered monthly `1 + r/100` within 1e-9 (property test on random data) | U |
| INV-M09 | Price basis and suspect rows | Computed from `adj_close` of valid bars only; a suspect row never becomes a month end; no dividends are added | U |
| INV-M11 | Incomplete month (VM3) | January 2023 has bars only to 2023-01-27 (expected last trading day 2023-01-31): `null`, `incomplete_month_data`, in no statistic; February `null` (`gap_before`, its base month is incomplete); March +4.31; the reason is in `month_year_reasons`; holidays on 01-30 and 01-31 make January complete (+5.00), a holiday on 01-31 only does not; days on which no tracked instrument traded count like holidays when INV-M14 applies | U |
| INV-M12 | Month with no prior base | The first month of the history is `no_base`; a month whose preceding calendar month has no bar is `gap_before` (not `no_base`); a month after an incomplete month is `gap_before`; none of them is counted in a statistic and none is shown as 0 | U |
| INV-M13 | Calendar closing rule (VM4) | With bars ending on the last trading day of a month and today the next day, that month is closed and counted (+10.00) although no later bar exists; with today the last day of the month it is running (MTD, not counted); the month of today is never counted even when its last bar is already imported; `today` is an argument, no wall clock | U |
| INV-M14 | Market-closed days derived from the data (D-INV3) | Synthetic multi-instrument calendars: (a) a month ending on two consecutive holidays (2018-03 shape) is complete, its return and the next month's are shown, and without the rule it is `incomplete_month_data`/`gap_before`; (b) a month ending on a single holiday Monday (2020-11 shape) is complete; (c) a stock lacking a day on which others traded stays `incomplete_month_data`; (d) fewer than 3 tracked instruments fall back to the holidays file alone; (e) a market-wide outage of more than 5 weekdays is not closed (incomplete), 5 or fewer is; (f) weekdays after the newest market bar are not closed; (g) a month with fewer than 3 active instruments is not judged; (h) a newly listed stock: the first partial month is `no_base`, days before the first bar are not judged, the next month is shown; `months_excluded_incomplete` counts closed incomplete months; DB: `compute_analysis` uses tracked peers | U |
| INV-M10 | Year column label | The cell header text is `Year (price return)` and its tooltip says dividends are excluded; the words "total return" never appear without the qualifier "excludes dividends" (grep test over `AnalysisTab` and `definitions.ts`) | U |
| INV-S01 | Seasonality stats (VS1) | Jan: n 2, green 1, share hidden (`too_few_years`), avg 0.00, median 0.00, best +10.00 (2024), worst -10.00 (2023); Dec: n 2, avg 5.00, median 5.00; Nov (flat 0.00): n 1, green 0 | U |
| INV-S02 | Green means strictly above zero on the unrounded value | A 0.00 month is not green; +0.004% is green and still shows `+0.0%`; -0.004% is not | U |
| INV-S03 | Share and small-sample flags (VS2) | Month A: n 4, green 2, `green_pct` 50.00, avg 1.50, median 1.50, small; Month B: n 3, `green_pct` 66.67, median 2.0, small; Month C: n 2, share `null` (`too_few_years`) | U |
| INV-S04 | Best and worst calendar month (VS2) | Best = B (median 2.0), worst = A (1.5); C not eligible; fewer than 2 eligible months: both `null` (`too_few_months`) | U |
| INV-S05 | Year column summary (VS3) | n 4, green 3, 75.00, avg 7.00, median 8.00, best +20.0 (2021), worst -8.0 (2020); partial first year and YTD excluded | U |
| INV-S06 | All history, not only the displayed 10 years | A 14-year series: `seasonality.months[*].n_years` counts all years while `month_year` and `year_returns` return the last 10 calendar years | U |
| INV-S07 | Data depth | `first_bar`, `last_bar`, `years_of_history` correct; a 14-month history has `n_years` of at most 2 per month (the first month has no return, so one month appears twice) and no share anywhere (corrected by B16: the earlier text said at most 1) | U |
| INV-S08 | `analysis` stays strict-JSON safe | No NaN/Infinity in any new block; every null scalar has its sibling `*_reason`; the snapshot grows by less than 20 KB and stays under 200 KB (extends RET-89) | U |
| INV-P01 | Price position vector (VP1) | Range position 80.0 (band `upper`), distance from the 52-week highest close -6.6667, `pctile_52w` 70.0, `pctile_all` 50.0, distance from the highest close in history -30.0, extension over the average 5.0 | U |
| INV-P02 | Band edges | Position exactly 100/3 is `middle`, just under is `lower`; exactly 200/3 is `upper` | U |
| INV-P03 | Flat range and short history | High equals low: `null` (`flat_range`); under 252 rows: 52-week values `null` (`insufficient_history`); under 504 rows: `pctile_all` `null`; under 200 bars: extension `null` | U |
| INV-P04 | Percentile ties | A sample of equal values gives exactly 50.0 for the last value (mid-rank) | U |
| INV-D01 | Drawdown profile vector (VD1) | Current -4.5455, 1 day since the high, time below a high 61.5385, average depth -11.8182, 4 episodes | U |
| INV-D02 | Maximum drawdown with dates (VD1) | -20.0, peak 2024-01-01, trough 2024-01-03 (the earlier of two ties), recovery 2024-01-05, recovered true | U |
| INV-D03 | Recovery time from a 10% and a 20% fall (VD1, minimum lowered to 2) | 10%: episodes 2, recovered 2, open 0, median 3.0 days; 20%: median 2.0 days; crossing date to recovery date, calendar days | U |
| INV-D04 | Minimum episodes rule | At the default minimum (3 recovered) the same data gives `median_days` `null` (`too_few_episodes`); counts are still returned | U |
| INV-D05 | Open episode | The open episode is counted in `open` and excluded from the median; `recovered` false for `max_dd` when it never recovered | U |
| INV-D06 | Float tolerance | `90/100-1` counts as a 10% fall (tolerance 1e-9); 89.99 vs 100 does as well; 90.01 does not | U |
| INV-D07 | Monotonic series | No drawdown: current 0, `max_dd` depth 0 with null dates, no episodes, medians `null` | U |
| INV-H01 | Rolling window vector (VH1, w = 2) | windows 4, share positive 75.0, median 16.25, best 20.0 (first end date of the tie), worst -10.0, independent periods 2, small sample true | U |
| INV-H02 | Window availability | `N <= w`: `null` (`insufficient_history`); windows under 20: `null` (`too_few_windows`); the 3-year row needs 756 rows plus 20 windows | U |
| INV-H03 | Overlap statement | The UI card prints that windows overlap and shows `independent_periods`; a snapshot test of the card text | U |
| INV-E01 | Entry-point vector (VE1, X 10, h 2) | Events at rows 3, 7, 12; forward +10.0, +12.5, -10.0; episodes 3, median 10.0, best 12.5, worst -10.0, share positive 66.67, pending 0 | U |
| INV-E02 | Conditional versus unconditional | `all_windows_median_pct` = -5.0 for VE1 and is shown next to the conditional median | U |
| INV-E03 | Minimum sample (VE1, X 20) | One episode: statistics `null` (`too_few_episodes`), count shown, no number hidden behind a 0 | U |
| INV-E04 | Pending forward windows (VE1 cut to 14 rows) | The event at row 12 is counted in `pending`, not in `episodes`; episodes 2, hidden | U |
| INV-E05 | Non-overlapping rule (VE1, h 5) | The crossing at row 7 inside the first event's window is skipped and not deferred; events at rows 3 and 12 | U |
| INV-E06 | Fresh crossing only | A stock already below the line at its first defined row has no event there; a day further below an existing breach is not a new event | U |
| INV-E07 | Strong small-sample copy | Fewer than 10 episodes always renders the sentence "Only {n} past episodes. This is an anecdote about this stock, not a pattern." inside the card (not a tooltip only) | U |
| INV-V01 | Volatility percentile (VV1) | Sample [12, 18, 15, 18, 25, 18], current 18: 58.3333, band `typical` | U |
| INV-V02 | Band edges and history | 19.99 `lower`, 20.0 `typical`, 79.99 `typical`, 80.0 `higher`; fewer than 252 volatility values: `null` (`insufficient_history`) | U |
| INV-V03 | Window is 21 trading rows | The block's values equal `analysis.rolling_vol_21` for the same dates (INV-13) | U |
| INV-L01 | SIP vs lump vector (VL1, minimum lowered to 4) | Units 45, invested 4000, SIP value 9000, lump value 8000, ratio 1.125, absolute 125.0 and 100.0, worst unrealised -25.0 and -50.0, XIRR `null` (`under_one_year`) | U |
| INV-L02 | XIRR of the two plans | SIP vector -1000 on 2024-01-05, 02-05, 03-05 and +3300 on 2025-03-05 = 0.09213; lump -4000 on 2024-01-01 and +8000 on 2025-01-01 = 0.99622 (1e-4); uses the section 8.3 solver | U |
| INV-L03 | Chosen day and skipped instalments | `day = 15` with bars 01-16, 02-15, 03-15, 04-10: instalments 3, skipped 1; execution on the first bar on or after the day | U |
| INV-L04 | Minimum history | Fewer than 12 instalments: every figure `null` (`history_under_12_months`); exactly 12 are computed | U |
| INV-L05 | Variants | 29 variants (`day` null and 1..28), each internally consistent; amounts 2 decimals; the amount only scales INR figures, never the percents | U |
| INV-L06 | Backtest wording | The card shows "A replay of the past with hindsight, not an estimate of the future" and never uses the words "return you will get" | U |
| INV-R01 | Downside deviation (VR1) | Returns +1, -2, +3, -4 percent: 35.4965 (1e-3); an all-positive window: 0 and the ratio is `null` | U |
| INV-R02 | Return per downside | CAGR 15.0 over 35.4965 = 0.4226 | U |
| INV-R03 | Calmar | CAGR 15.0 and maximum drawdown -30.0 = 0.5; maximum drawdown 0: `null` (`no_drawdown`); under 3 years: `null` (`insufficient_history`) | U |
| INV-R04 | Same window | CAGR and maximum drawdown use the same calendar 3-year window (a series where the 756-row and the calendar window differ proves it) | U |
| INV-R05 | No Sharpe in the card | The risk card never renders `sharpe_3y` and says nothing about a risk-free rate | U |
| INV-C01 | Entry context composition | The strip shows four facts in the fixed order with each fact's own as-of; no combined figure; no red/green fill, no arrow icons | U |
| INV-C02 | Context wording | Bands map to "lower / middle / upper third of its 52-week range" and "quieter than usual / typical / bigger than usual for this stock"; the words buy, sell, cheap, expensive, bullish, bearish, target and signal appear nowhere except in the negative sentence "Context, not advice or a signal." (grep test over the new components) | U |
| INV-C03 | One fact null | The other three still render; the null one shows an em dash with its reason | U |
| INV-C04 | Current month in the strip | Uses the IST current month entry of `seasonality`; "so far" month-to-date is separate context and never in the share | U |
| INV-A01 | Contract: indicators | `GET /stocks/{symbol}/indicators` returns the new blocks; an old snapshot without them still answers 200 and the web shows "Not computed yet" | I |
| INV-A02 | Contract: field map and types | `openapi.yaml`, `packages/api-types` (`npm run check:generated`) and `docs/field-map.json` agree; every new field is mapped | CI |
| INV-A03 | No new route | `TestRoutesMatchOpenAPI` passes with no new entry in `routes.go`; `GET /stocks/{symbol}/analysis` stays non-existent | I |
| INV-A04 | Expansion passes the new blocks through | `prices/expand.go` leaves `year_returns`, `seasonality`, `position`, `drawdown_profile`, `holding_periods`, `entry_study`, `vol_regime`, `sip_backtest` and `risk_adjusted` unchanged and still aligns the old arrays | I |
| INV-A05 | Snapshot lifecycle | Idempotent per `as_of`; pruning of older snapshots keeps `analysis.seasonality` in the newest one; recompute after a price import, trim and delete | I |
| INV-A06 | Settings | `INV_*` defaults are read from `app_setting` with the documented fallbacks; a changed `INV_MIN_YEARS` changes `min_years` and `share_shown` | U |
| INV-W01 | Watchlist seasonality field | Each stock row carries `seasonality` for the current IST month with `n_years`, `n_green`, `green_pct`, `data_since`, `small_sample`, `min_years`, `mtd_*` | I |
| INV-W02 | Month selection | With a fake clock on 2026-11-11 IST the November entry is returned; at 23:59 IST on 30 November the November entry, at 00:00 on 1 December the December entry, with no recompute | I |
| INV-W03 | Running month excluded | Today's month never counts in `n_years` even when the snapshot already has bars of it | I |
| INV-W04 | MTD when the snapshot is from an older month | `mtd_return_pct` `null` with `no_bar_this_month`; the share is still returned | I |
| INV-W05 | No snapshot | `seasonality` `null` with `seasonality_reason` `no_prices_imported` or `no_history`; the watchlist still answers 200 | I |
| INV-W06 | Fewer than 3 years | `green_pct` `null` with `too_few_years`; `n_years` and `data_since` still present | I |
| INV-W07 | Existing fields unchanged | `ltp`, `change_pct`, `price_stale` and the funds list are exactly as before (regression on the existing watchlist tests) | I |
| INV-W08 | Cost | The watchlist with 50 stocks and full-size snapshots answers within the existing budget (p95 under 500 ms locally); if not, the fallback column of INV-8 is required | I |
| INV-T01 | Tile ranking | Default sort is `green_pct` descending, then more years, then symbol; the "minimum years" select (3, 5, 8) moves stocks into "Not enough years yet" | U |
| INV-T02 | Tile text | "{n_green} of {n_years} years green ({pct}%)" and "{n_years} years of this month, history starts {Mon YYYY}"; never "since listing" | U |
| INV-T03 | Tile month to date | Shown separately with sign and arrow or an em dash with the reason; never inside the share | U |
| INV-T04 | Tile states | Loading, empty (no watchlist), nothing ranked, partial, stale, error each render with their copy; the tile failing does not blank the Dashboard | U |
| INV-T05 | Tile small sample | Fewer than 5 years shows the "Small sample" chip and "Only {n} years: a rough guide" | U |
| INV-T06 | Tile keyboard and a11y | Sort and minimum controls operable by keyboard; `aria-sort` follows the sort; a live region announces the count; axe clean in both themes | E |
| INV-T07 | Tile mobile | At 375 px one column, no horizontal page scroll, targets at least 44 px | E |
| INV-T08 | Tile footnote | The footnote text of docs/06 6.2a is always present (`dash-seasonality-note`) | U |
| INV-U01 | Heatmap Year column | Header `Year (price return)`; the first year suffixed "partial", the running year "YTD"; its own colour scale; every cell prints its value | U |
| INV-U02 | Heatmap summary rows | Average, Median, % of years green, Best, Worst, Years in that order, from `seasonality`; shares under 3 years show an em dash; footnote with the years and the start month | U |
| INV-U03 | Running month cell | The running month's cell is outlined and suffixed "MTD" (text, not colour only) with its tooltip | U |
| INV-U04 | Analysis cards: shared parts | Every INV card has the source/as-of chip, the sample size, the "How to read" disclosure and "Past behaviour is not a forecast." | U |
| INV-U05 | Cards: states | Each card renders loading, not computed, partial, stale and error; one failing card does not blank the tab | U |
| INV-U06 | Cards: no verdict | No card renders a score, a rank, a target or the words of INV-C02; null reasons are visible text on mobile | U |
| INV-U07 | Day selector | The SIP day selector switches variants without a request; keyboard operable; a live region announces the result | U |
| INV-U08 | Analysis tab axe and 375 px | Axe clean in both themes at 375 and 1440 px; no horizontal page scroll; tables scroll inside labelled regions | E |
| INV-U09 | Definitions | The ten owner-text keys of docs/05 12.12 exist in `definitions.ts` after `npm run gen:definitions`; `--check` passes; the tooltips contain no ids or section numbers | U |
| INV-U10 | Heatmap component | `Heatmap` with trailing columns and footer rows keeps the existing callers unchanged (MF detail, calendar) and its scroll region stays focusable | U |
| INVA-01 | All-stocks scope | `GET /stocks/seasonality` (default scope) lists every tracked stock with `seasonality` of today's IST month; the same object as `GET /watchlist` for a stock on both | I |
| INVA-02 | Watchlist filter | `scope=watchlist` lists only watchlisted stocks; `scope=all` lists them too | I |
| INVA-03 | on_watchlist marker | `on_watchlist` is true exactly for stocks with a watchlist item | I |
| INVA-04 | Untracked excluded | A stock with a snapshot but `is_tracked = false` is not listed in either scope | I |
| INVA-05 | Stock without snapshot | Tracked stock with no snapshot: `seasonality` null with `no_history` (prices imported) or `no_prices_imported`; 200 and the other rows are unaffected | I |
| INVA-06 | Empty universe | No tracked stocks -> `stocks: []`, `as_of` null, `month` still set, 200 | I |
| INVA-07 | scope validation | `scope=foo` -> 422 `UNPROCESSABLE` (field error `scope`); an empty `scope=` means the default | I |
| INVA-08 | Month boundary | With a fake clock the month flips at 00:00 IST (18:30 UTC) and `month`, `month_name` and every row follow; no recompute | I |
| INVA-09 | Auth and contract | 401 without a session (envelope); route in `openapi.yaml` and `routes.go`; `GET /watchlist` fields unchanged | I |
| INVA-10 | Cost | 48, 100 and 200 tracked stocks with full-size snapshots answer under 500 ms locally; the measured value is in the test log and OPEN_QUESTIONS | I |
| INVA-11 | Tile scope control | Default All stocks; radio-group semantics (`role=radiogroup`, two radios, arrow keys select); switching refetches with the scope in the query key; component state only | U |
| INVA-12 | Tile watchlist chip | In All mode a watchlisted stock shows the Watchlist chip (text and icon); unlisted stocks have none | U |
| INVA-13 | Tile copy by scope | Empty copy, nothing-ranked copy and caption follow the scope; footnote and "history starts" text unchanged | U |
| INVA-14 | Tile 48 stocks | 48 stocks: ranking, collapsed short group, sort and min-years still work; 375 px no horizontal scroll; axe clean in both themes at 375 and 1440 px with the scope control | E |
| INV-Z01 | Safe Edition | No new egress, no new dependency with a forbidden licence; deny-list, SAF-13 and licence scan pass | CI |

## SWD: swing dips (decision SWD, PROPOSED; worker B18, web F19; formulas docs/05 12.13, API docs/03 4a-swing, card docs/06 6.4a item 4a)

Worker rows (SWD-W) are U tests in `apps/worker/tests/test_swing_dips.py` with the hand-computed vectors SW1-SW4 of docs/05 12.13; API rows (SWD-A) are I tests in `apps/api/internal/httpx`; web rows (SWD-U) are U tests in `apps/web/tests/unit/swd-f19.test.tsx`; E rows are Playwright (`tests/e2e/swd-f19.spec.ts`). Prices are on consecutive calendar days in the vectors; there is no wall clock and no network.

| ID | Case | Expected | Type |
|---|---|---|---|
| SWD-W01 | SW1 rule A, X = 10 (two falls under one peak, three dips) | `dips` 3, `recovered` 2, `open` 1; the second fall to 85 under the 100 peak is part of dip 1 (low 85 on 01-07, depth -15.0, 4 days peak to low, recovery 01-09, 2 days); dip 2 depth -11.5385, 2 and 1 days; dip 3 open, depth -10.4762 | U |
| SWD-W02 | SW1 summary X = 10 at the default minimum 3 | `recovered_share_pct` 66.6667, `median_depth_pct` -11.5385, `worst_depth_pct` -15.0, `median_days_peak_to_low` 2.0, `longest_open_days` 2, `small_sample` true; `median_days_to_recover` null with `too_few_episodes` (2 recovered) | U |
| SWD-W03 | SW1 with `INV_MIN_EPISODES` 2 | `median_days_to_recover` 1.5 (completed dips only; the open dip is excluded) | U |
| SWD-W04 | SW1 X = 20 (no dip) | `dips` 0, medians null `too_few_episodes`, `worst_depth_pct` null `no_dips`, `longest_open_days` null `no_open_dip`, `records` empty | U |
| SWD-W05 | SW2: a stock that never recovers and a fall that starts before `w` rows exist | The dip starts at row `w-1` (01-03) with peak 01-01; `dips` 1, `open` 1, `recovered` 0, depth -50.0, `longest_open_days` 6, status open, `days_low_to_recovery` null with `open_dip`; medians hidden | U |
| SWD-W06 | SW3: a fall recovered inside the first `w-1` rows | Not counted: `dips` 0 | U |
| SWD-W07 | `N < w` | Counts and statistics null, `reason` `insufficient_history`, `records` empty, no 0 | U |
| SWD-W08 | Threshold tolerance and equal recovery | A close exactly 10% below the high (`100, 90`, `w = 2`) starts a dip at X = 10; a close exactly equal to the reference high recovers it | U |
| SWD-W09 | Ties for the low and for the peak | The earliest equal low is kept; the peak is the latest of equal highs in the window | U |
| SWD-W10 | Records limit and order | With more than 8 dips `records` has 8, newest first, while the summary counts all dips | U |
| SWD-W11 | SW4 rule A on a long decline | One open dip with `ref` 95 (X = 10, depth -47.3684, 7 days) and one with `ref` 90 (X = 20, depth -44.4444, 5 days) | U |
| SWD-W12 | SW4 rule B, X = 10 (the zig-zag swings) | `legs` 4, `bounced` 3, `open` 1, `median_depth_pct` -22.1501, `worst_depth_pct` -24.2424, `median_days_peak_to_low` 1.0, `median_days_to_bounce` 1.0; the bounce of exactly +10.0% counts | U |
| SWD-W13 | SW4 rule B, X = 20 and SW1 rule B | X = 20: `legs` 1, `open` 1, depth -50.0; SW1 X = 10: `legs` 3, `bounced` 2, `open` 1, `median_days_to_bounce` null (`too_few_episodes`), 1.0 with the minimum 2; SW1 X = 20: `legs` 0 | U |
| SWD-W14 | Percent and day units | `depth_pct` is a negative percent number; days are calendar days between bar dates, a weekend gap counts its calendar days; no NaN, Infinity or `-0.0` anywhere (`json.dumps(allow_nan=False)`) | U |
| SWD-W15 | Block failure isolation | When `swing_dips` raises, `_analysis` still returns every other block, `swing_dips` is null, `swing_dips_reason` is `compute_error` and the error is logged without secrets | U |
| SWD-W16 | The existing drawdown profile is unchanged | VD1 (INV-D01..D03) still passes and `drawdown_profile` is byte-identical with and without the new block | U |
| SWD-W17 | Snapshot wiring | `compute_analysis` output carries `analysis.swing_dips` with the contract keys, JSON-safe, and the snapshot size grows by under 6 KB for a 25-year stock | U |
| SWD-W18 | Integration | With `TEST_DATABASE_URL`: a stored snapshot of a seeded stock contains the block and `GET`-shaped JSON round-trips | I |
| SWD-A01 | Contract: passthrough | `GET /stocks/{symbol}/indicators` returns `analysis.swing_dips` and `swing_dips_reason` unchanged (incl. the null plus `compute_error` shape); an old snapshot without them still answers 200 | I |
| SWD-A02 | Contract: field map and types | `openapi.yaml`, `packages/api-types` (`npm run check:generated`) and `docs/field-map.json` agree; every new field is mapped to a real test id | CI |
| SWD-U01 | Card renders the block | Title "Swing dips" next to "Drawdown profile" (which still renders unchanged), per-row counts, medians and the last-dips table from the fixture | U |
| SWD-U02 | Open dip is visibly labelled | The open dip's row has the text chip "Open" and "not recovered yet"; the summary shows "still open" with its count; it is never absent | U |
| SWD-U03 | Hidden medians show reasons | A null median is an em dash with visually hidden reason text, a tooltip and an entry in `inv-swing-reasons` ("at least 3 are needed"); never 0, NaN or Infinity | U |
| SWD-U04 | Sample size, Small sample chip, How to read, note | `inv-swing-sample` states the counts, `inv-swing-small` shows below 10 dips, `inv-swing-howto` is a native details, the line "Past behaviour is not a forecast." is present | U |
| SWD-U05 | "How this differs" sentence | `inv-swing-differs` is present and mentions the all-time-high view of the Drawdown profile | U |
| SWD-U06 | Missing block, `compute_error`, wrong shape, insufficient history | "Not computed yet" for a missing block; the `compute_error` message for null plus reason; a card-level error for a wrong shape without affecting other cards; the 252-day sentence for `insufficient_history` | U |
| SWD-U07 | Per-field degradation | A string where a number is expected degrades that cell to an em dash with a reason; one bad record does not blank the table | U |
| SWD-U08 | 10% / 20% choice | The radio group switches the last-dips table between the two thresholds, keyboard operable (arrow keys), and says "Showing the last {k} of {n} dips" | U |
| SWD-U09 | Swing legs table | Rule B rows show legs, bounced, open and the medians, with the caption that a bounce is not a recovery | U |
| SWD-U10 | Definitions | `definitions.swing_dips` equals the owner text of docs/05 12.13 (generated; `npm run gen:definitions` leaves no diff) and contains no ids | U |
| SWD-U11 | Lazy loading and bundle | The card is loaded with `next/dynamic`; `npm run check:bundle` stays within budget | CI |
| SWD-U12 | Field coverage guard | `f15-polish` UI-09 passes with the five mapped ids | U |
| SWD-E01 | axe in both themes at 375 and 1440 px | No serious or critical violation on the Analysis tab with the card visible | E |
| SWD-E02 | Keyboard and no page scroll | The tables' regions and the 10/20 radios are reachable and operable by keyboard; no horizontal page scroll at 375 px | E |
| SWD-Z01 | Safe Edition | No new egress, no new dependency; deny-list, SAF-13 and licence scan pass | CI |
