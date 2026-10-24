# Spike Results (see 08-phase0-spikes.md for the spike definitions)

Run on 2026-10-10 by Claude Code (agent) from the owner's Windows 11 machine, manual price mode (D-1). Verdict vocabulary: GO, GO-WITH-CHANGES, NO-GO, `N/A (manual mode)`, `BLOCKED-OWNER` (needs the owner's data, account or hosted service; nothing was guessed). Network access was limited to `api.mfapi.in` (37 requests) and `www.amfiindia.com` (1 request), all with `User-Agent: IndiaAnalyzerPersonal/1.0`, 0.5-0.6 s spacing, no retries needed. Throwaway scripts live in the session scratchpad; repeatable code is under `scripts/spikes/`.

## Summary

| ID | Spike | Verdict | One-line evidence |
|---|---|---|---|
| S1 | Broker decision | GO (manual price mode) | D-1; `docs/BROKER_DECISION.md` records the decision |
| S2 | Broker reachability | N/A (manual mode) | no broker |
| S3 | History depth and limits | N/A (manual mode) | no broker |
| S4 | Adjusted vs raw | BLOCKED-OWNER | needs the owner's price files; procedure below; synthetic wizard sample provided |
| S5 | Index/VIX candles | N/A (manual mode) | replaced by loading `NIFTY50`/`INDIAVIX` rows into `market_series` (checked when B06a exists) |
| S6 | mfapi.in | GO | all endpoints OK; history 11-13 years; latest NAV equals AMFI for 20/20; no 429 in 37 requests |
| S7 | AMFI NAVAll.txt | GO-WITH-CHANGES | 14,372 rows, 55 AMCs, 0 mis-assigned; layout is 8 fields now, section/AMC rule amended |
| S8 | Split detector tuning | GO on synthetic data (mechanics only); real-data run BLOCKED-OWNER | recall 92-100% on reachable ratios, 2 unavoidable false positives; spec findings OQ-13, OQ-14 |
| S9 | Hosting behaviour | BLOCKED-OWNER | needs Render, Vercel and Neon accounts |
| S10 | DB sizing and extensions | GO-WITH-CHANGES (local Postgres 18); Neon part BLOCKED-OWNER | 130.9 bytes/row; trigram on 10k schemes needs an index plan to meet 300 ms |
| S11 | GitHub Actions | GO on computation; drift measurement BLOCKED-OWNER | about 710 min/month typical, about 3,200 worst case; public repo has no minute limit |
| S12 | Telegram | BLOCKED-OWNER | needs the owner's bot and a deployed API |
| S13 | Import formats | GO-WITH-CHANGES (templates and notes done); validator run and owner trial deferred | 10 templates and a synthetic sample set; OQ-9..OQ-11 raised |
| S14 | Terms re-read | BLOCKED-OWNER | `docs/TERMS_NOTES.md` prepared with documents to read |
| S15 | Licence scan | GO | scan passes on 410 packages; ECharts 6.1.0 Apache-2.0, zrender BSD-3, lucide-react ISC, Inter OFL-1.1 confirmed at F02 (850 packages) |
| S16 | Ratio accuracy | GO on synthetic known answers; real-company comparison BLOCKED-OWNER | 22 formula checks pass; definition choice alone moves ROE by 6.8% |
| S17 | Owner effort | BLOCKED-OWNER | needs the owner's timing |

## S1 Broker decision  (2026-10-10, desk, Claude Code)
Steps: recorded decision D-1 in `docs/BROKER_DECISION.md`; no broker docs or sites were read or contacted.
Raw results: Decision = manual price mode (`BROKER_ENABLED=false`).
Verdict: GO (manual price mode). BRK-14 is N/A.
Spec amendments (file + section): none beyond those already made for D-1/D-2.
Fixtures saved: none.

## S2 Broker reachability and session
Verdict: N/A (manual mode). No broker, no login, nothing to measure.

## S3 History depth and limits
Verdict: N/A (manual mode). The depth of history is whatever the owner imports (`prices.csv`, up to 25 MB / 300,000 rows once S9 passes).

## S4 Adjusted vs raw: manual adjustment check  (BLOCKED-OWNER)
Why blocked: it needs 1-3 stocks with a split or bonus that the owner knows of, with price files for them, and the wizard (B06a/F13a, not built yet).
Owner checklist (docs/08 "Manual S4"):
1. Pick 1-3 stocks with a split or bonus you know about from your own records; note the ex-date and ratio.
2. Prepare a `prices.csv` per stock from your price source, spanning the ex-date with at least 5 trading days each side (`symbol,date,open,high,low,close,volume`). Upload it in the prices wizard and stop at the validate step.
3. Choose "I don't know", open the Adjustment check, enter symbol, ex-date and optionally the expected ratio.
4. Gap within 3% of the expected ratio = **raw**; ratio within 3% of 1 = **already adjusted**; anything else = inconclusive (try another stock or check the source).
5. Choose raw / already adjusted in the wizard (sets `PRICES_ALREADY_ADJUSTED`), commit, then record here: stocks, ex-dates, observed ratios, the answer, the date.
Pass: all stocks agree. Mixed answers: the source is mixed; re-export one kind per source before committing.
Record template: `Stocks: ... | observed ratios: ... | answer: raw / adjusted | date: ...`.
Prepared aid: `fixtures/import-samples/prices_synthetic_split.csv` is a fictional stock (`FAKEA`, raw prices, 1:5 split on 2026-02-10, ratio 0.2 with 10x volume that day) for trying the wizard and the check before using real files. Expected hint: `raw_likely`.
Verdict: BLOCKED-OWNER.

## S5 Index/VIX candles
Verdict: N/A (manual mode), replaced by: when B06a exists, import a `prices.csv` containing `NIFTY50` and `INDIAVIX` rows and confirm they land in `market_series` (IMP-21). Not testable yet (no importer).

## S6 mfapi.in  (2026-10-10, home network, Claude Code)
Steps: 5 searches; scheme list paginated to the end; full history for 3 schemes (Direct Growth 122639, Direct IDCW 118954, an old discontinued scheme 111972) and a `startDate/endDate` call for each; `/latest` for 1 scheme; then `/latest` for 20 randomly picked live Direct schemes (seeded) compared with the AMFI file downloaded in S7. 37 requests total, 0.5-0.6 s apart (the spike text asks for 30 spaced calls: 20 consecutive plus the 17 others gave the same information with fewer requests).
Raw results:
- Search: `/mf/search?q=` returns `[{schemeCode, schemeName}]` only; fuzzy (query "SBI Nifty 50 Index" returned Nifty Next 50 funds); no match returns `[]` (e.g. "Axis Bluechip", renamed since). 0.2-1.2 s.
- List: `/mf?limit=10000&offset=N` works; 4 pages, **37,954 schemes**, all unique, 5.7 s total (pages 0.7-1.8 s, 1.3-1.5 MB each). Items carry `schemeCode, schemeName, isinGrowth, isinDivReinvestment` (camelCase). Of these only 14,372 are in AMFI's current file (all AMFI codes are in mfapi); about 23.6k are discontinued/old.
- History: `data` is **newest first** (descending) in all 3 schemes; no duplicate dates; no non-numeric NAV; `status: SUCCESS`; `meta` keys `fund_house, scheme_type, scheme_category, scheme_code, scheme_name, isin_growth, isin_div_reinvestment` (snake_case); NAV strings with 5 decimals. 122639: 3,289 rows from 2013-05-28 (13.4 years); 118954: 3,390 rows from 2013-01-01; 111972 (old, discontinued): 2,618 rows 2009-06-15 to 2020-04-24 (no NAV since 2020-04-24, no ISINs in meta).
- Weekend handling: exactly one weekend-dated row per live scheme history, `31-03-2024` (Sunday, fiscal year-end), with a real NAV. Valid, keep.
- Range query: `startDate=2026-09-01&endDate=2026-10-09` returned 27 rows, newest first; an empty range returns `data: []` with `SUCCESS`.
- Latency: `/latest` and range calls 0.19-0.33 s; full history 0.4-1.1 s (100-130 KB).
- Rate limit: 20 consecutive `/latest` calls at 0.5 s spacing took 14.4 s; no 429 and no rate-limit headers in 37 requests.
- Agreement with AMFI: 20/20 schemes have the same date (09-10-2026) and the same NAV numerically (mfapi 5 decimals, AMFI 4; compare as numbers).
Verdict: GO. No design change; the spec text is updated with the observed facts.
Spec amendments: `docs/01` section 4 (order of `data` now V: descending; weekend NAVs valid; `limit=10000`; key naming); rows MF-16, MF-18 added to `docs/07`.
Fixtures saved: `fixtures/mfapi/` (`search_hdfc_flexi_cap.json`, `search_no_result.json`, `list_first_5.json`, `latest_122639.json`, `history_{122639,118954,111972}_trimmed.json` (first 20 and last 10 rows, array order kept), `history_122639_range_2026-09-01_2026-10-09.json`, `history_{122639,118954}_weekend_row_context.json`).

## S7 AMFI NAVAll.txt  (2026-10-10, home network, Claude Code)
Steps: one download of `https://www.amfiindia.com/spages/NAVAll.txt`; parsed with the state machine from `01` section 5 plus the prefix rule below; cross-checked with the mfapi list.
Raw results:
- HTTP 200, 1,520,604 bytes, 2.9 s, `text/plain`, Last-Modified Sat 10 Oct 2026 07:37 GMT; UTF-8 (contains a typographic apostrophe), CRLF, no BOM; blank lines may contain one space.
- **Header has 8 fields**: `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date`. The spec said 6. Every data row has 8 fields.
- 14,372 data rows (pass: > 10,000), 14,372 unique codes, 0 unparsable rows, 0 `N.A.` NAVs in this file, 55 distinct AMCs, 104 scheme-type lines (Open Ended 9,655 rows, Close Ended 4,676, Interval 41).
- **Section ordering:** a scheme-type line and an AMC line both follow a blank line, so the spec rule "blank line then a no-`;` line = section header" cannot separate them. Scheme-type lines all start with `Open Ended Schemes`, `Close Ended Schemes` or `Interval Fund Schemes`; every other no-`;` line is an AMC. With this rule no row lacked an AMC or type and the AMC list is clean (one name, `ASK MUTUAL FUND`, is upper case); 841 rows have an AMC name whose first word is absent from the scheme name, 780 of them Nippon India (schemes still named "Reliance ...") which is correct, not a mis-assignment.
- `Plan` empty for 5,709 rows and `Option` empty for 5,714 (older and closed-ended schemes); ISIN placeholder `-` appears (802 rows with no growth/payout ISIN).
- Dates: 8,539 rows dated 09-Oct-2026; **115 rows dated 11-Oct-2026**, i.e. after the file date (liquid funds publish a next-day value date); 5,575 rows are older than 30 days and 5,384 older than a year (discontinued schemes still listed).
- Agreement with mfapi: all 14,372 AMFI codes exist in mfapi; latest NAV matched in 20/20 sampled (S6).
Verdict: GO-WITH-CHANGES (format drift, handled in the spec).
Spec amendments: `docs/01` section 5 (8-field layout, read by header name, prefix rule, value dates, availability now V), `docs/00` section 2 fact row; rows MF-17, MF-19, MF-20 added to `docs/07`; OQ-12.
Fixtures saved: `fixtures/amfi/NAVAll_sample.txt` (header plus 3 real sections: normal rows with `-` ISIN, future-dated liquid-fund rows, empty Plan/Option rows; CRLF).

## S8 Split/bonus detector tuning  (2026-10-10, local, Claude Code)
Steps: `scripts/spikes/s08_detector_sim.py` implements the rule of `01` 3.7 and runs it on **synthetic** candles (30 stocks x 1,250 bars, Student-t returns capped at +/-12%, lognormal volume; 15 known events: 13 with ratios 1/2 x4, 1/3, 1/4, 1/5 x3, 1/10 x3, 1/20 and two deliberately below the trigger (2/3, 4/5); about 8% of events given a quiet 1.2-1.3x volume; 2 stocks given a genuine 50% crash; about a third given a 36-46% crash). No market data was used. These numbers test the mechanics of the rule only; the false-positive rate on real prices is unknown.
Raw results (spec parameters 0.35 / 3% / 1.5x, three seeds): recall on the 13 reachable events 12/13 (seed 20261010; the miss is a 1/3 event with quiet volume), 13/13 (seed 1), 13/13 (seed 2); false positives 2 per 150 stock-years (0.4 per 30 stock-years) in every seed, both being the injected 50% crashes, which no price rule can tell from a 1:1 bonus; the 36-46% crashes were never flagged; 0 of 2 unreachable events detected, as expected. Variants: dropping the volume rule or setting it to 1.0x lifts recall to 13/13 with no extra false positives on this data; tolerance 2% or 5% changed nothing; lowering the trigger to 0.30 or 0.20 makes the 2/3 event detectable (1 extra hit, no extra false positives here), which is the only lever for small bonuses and is an owner decision (OQ-13).
Findings about the spec: (a) fractions 2/3, 3/4, 4/5, 5/6 can never pass `abs(r-1) > 0.35`, so the list is misleading (consistent with ACT-07); (b) reverse splits are never matched (rows above 1.35 fail the fraction test and are caught by the 50% sanity rule as `suspect`); (c) "20-day average" does not say whether day t is included.
Verdict: GO on synthetic data for the mechanics (pass criteria met in all seeds). The spike's real criteria (>= 90% of known events, <= 3 false positives per 30 stock-years on 30 real stocks) are **BLOCKED-OWNER**: needs the owner's price files for >= 30 stocks with >= 10 known events (list of ex-dates and ratios from the owner's records). Run `python scripts/spikes/s08_detector_sim.py` logic against those files once D03 has the real detector.
Spec amendments: none (OQ-13, OQ-14 raised); rows ACT-13, ACT-14 added to `docs/07`.
Fixtures saved: none (generator is deterministic); `fixtures/import-samples/prices_synthetic_split.csv` for the wizard.

## S9 Hosting behaviour  (BLOCKED-OWNER)
Needs: Render, Vercel and Neon accounts and a deployed hello-world; nothing in the repo is deployable yet (T02/B01/F01 first).
Owner checklist and what to record:
1. Render free: deploy the hello-world Go API; after 20 minutes idle call it, 5 times; record cold-start seconds each (pass: < 90 s).
2. Neon free: first query after idle (scale-to-zero after 5 minutes); record latency; run `CREATE EXTENSION pg_trgm` (also S10).
3. Vercel Hobby: Next.js with `/api` rewrite to the Render API; log in and confirm the session cookie is set and sent back through the rewrite (pass: cookies work).
4. Memory: record peak RSS of the Go binary and of the Python worker-http under load (limit 512 MB).
5. Upload through the rewrite: POST a 25 MB file and a 300,000-row `prices.csv` (about 20 MB) to a Go endpoint that streams and counts bytes; record the largest size that passes (try 4, 5, 10, 25 MB). If below 25 MB, record the limit; B06a/F13a then implement the browser-side split under that limit (`upload_group`, one transaction at commit); until then the API keeps the 5 MB `prices` limit (D-G).
6. Read the Vercel Hobby terms for personal use (also S14).
Record: date, region, five cold-start numbers, Neon first-query ms, cookie result, memory MB, largest passing upload, verdict.
Verdict: BLOCKED-OWNER.

## S10 DB sizing and extensions  (2026-10-10, local Docker postgres:18-alpine, Claude Code)
Steps: throwaway container; applied the whole `docs/02-database.sql` (applied cleanly, including `CREATE EXTENSION pg_trgm`); `scripts/spikes/s10_sizing.sql` loaded 2,300 synthetic instruments (150 with prices) and 150 x 1,250 = 187,500 `price_daily` rows (random-walk values), plus 10,000 `mf_scheme` rows named from the AMFI file; timed the spec's search form (`name % q`, threshold 0.3, ordered by similarity, limit 20). Container removed afterwards. Server is Postgres 18.6, not Neon's version.
Raw results:
- `pg_total_relation_size('price_daily')` = 24,543,232 bytes for 187,500 rows = **130.9 bytes/row** (table 18.96 MB, primary-key index 5.55 MB). The estimate of ~130 holds (pass: within 20%). 150 stocks x 5 years = about 24.5 MB; the 380 MB limit allows about 2.9 million rows (about 2,300 stocks x 5 years at this width, before other tables).
- Instruments search (2,300 rows): 37-57 ms (pass).
- Scheme search (10,000 rows), default planner: short query 48 ms, but 4-5 word queries 135-590 ms and the plan is a **sequential scan** (332-424 ms in `EXPLAIN ANALYZE`) even after `ANALYZE`; fails the 300 ms bar for long queries. With the index forced (`enable_seqscan=off`) the same queries take 0.5-1.3 ms; with `random_page_cost=1.1` the planner picks the bitmap index plan (12 ms planned run, first execution 246 ms with cold index, second 69 ms). `word_similarity` was not faster (292-679 ms) and a higher threshold (0.45) did not help.
- Extension on Neon: not tested (BLOCKED-OWNER: needs a Neon project; the owner runs `CREATE EXTENSION pg_trgm;` and `scripts/spikes/s10_sizing.sql` there and records `pg_total_relation_size`, plus the scheme search timings from the Render/Neon environment).
Verdict: GO-WITH-CHANGES. Sizing is confirmed; B10 must ensure the trigram index is used (set `random_page_cost=1.1` on the API role, or `SET LOCAL enable_seqscan = off` for that query) and MF-12 must be re-measured on Neon.
Spec amendments: Decisions row in `docs/OPEN_QUESTIONS.md` (S10 finding); MF-12 unchanged (still < 300 ms, now with the planner caveat).
Fixtures saved: none (the SQL script regenerates everything).

## S11 GitHub Actions  (2026-10-10, desk computation, Claude Code)
Steps: counted runs per month for each workflow in `docs/04` section 2 (manual mode: broker workflows are off), at 30.4 days per month, with the timeout as worst case and an assumed typical duration (assumption, to be measured; not data). Checked each cron expression against its IST time: all match (e.g. `30 16 * * *` = 22:00 IST, `30 23 * * 6` = Sunday 05:00 IST).
Raw results (minutes per month):

| Workflow | Runs/month | Worst case (timeout) | Typical (assumed) |
|---|---|---|---|
| process_queued_jobs (20 min, typ 3) | 30.4 | 608 | 91 |
| ingest_mf_navs x2 (30 min, typ 5) | 60.8 | 1,824 | 304 |
| sync_mf_schemes weekly (20 min, typ 5) | 4.3 | 87 | 22 |
| evaluate_alerts EOD weekdays (8 min, typ 3) | 21.7 | 174 | 65 |
| train_models weekly (90 min, typ 45; deferred, D-4) | 4.3 | 391 | 195 |
| housekeeping weekly (20 min, typ 5) | 4.3 | 87 | 22 |
| backup_user_data weekly (10 min, typ 2) | 4.3 | 43 | 9 |
| keepalive monthly (2 min, typ 1) | 1 | 2 | 1 |
| **Total** | | **3,216** (2,825 without training) | **709** (513 without training) |

Plus CI (`ci.yml`) per push/PR, not counted. Each job is billed rounded up to whole minutes, so short jobs cost a little more than shown.
Interpretation: the repository is public (D-2), where standard runners have no minute limit, so the budget is feasible. If it were private, the allowance documented by GitHub would need checking (not verified by this spike; read it in S14): the typical total would likely fit but the worst case would not.
Not done (BLOCKED-OWNER): the 3-day 15-minute cron drift test and the 20-minute billed-minutes test need a throwaway GitHub repo. Checklist: create a public and a private throwaway repo; add a workflow with `schedule: '*/15 * * * *'` that appends `date -u` to a log artifact for 3 days; compare scheduled and actual times (pass: typical drift < 15 min, note skipped runs); run one 20-minute `sleep` job and read billed minutes in Settings > Billing; confirm the 60-day schedule-disable rule in the docs (SYS-04).
Verdict: GO on the budget computation; drift test BLOCKED-OWNER.
Spec amendments: none.

## S12 Telegram  (BLOCKED-OWNER)
Needs the owner's bot (BotFather) and a deployed API on Render (S9). Decision D-9: nothing earlier blocks on it.
Owner checklist and what to record:
1. In Telegram, message @BotFather, `/newbot`, keep the token private (never paste it in the repo or chat logs).
2. After the API is deployed: `setWebhook` with the Render URL and a `secret_token`; confirm `getWebhookInfo` shows no error.
3. Let the API idle 20 minutes, then send `/start <code>` to the bot; record seconds until the link is confirmed (pass: within 2 minutes).
4. Send a message containing `<`, `&` and `>` through the alert path and confirm it displays literally (HTML escaping).
5. Send 20 alerts in one run and confirm the 1.1 s pacing causes no 429.
Fail path: manual link via `getUpdates` with the webhook disabled.
Verdict: BLOCKED-OWNER.

## S13 Import formats  (2026-10-10, desk, Claude Code)
Steps: authored one template per import kind and a fictional sample set; reviewed every format rule in `docs/01` section 7 for ambiguity.
Raw results:
- Templates (header row, plus one clearly fictional example row `DEMOCO`; `holidays.csv` header only, as `01` 7.8 requires): `fixtures/templates/{instruments,prices,results_quarterly,results_annual,balance_cashflow_annual,fundamentals_long,shareholding,corporate_actions,instrument_meta,holidays}.csv`. B06a/B06b serve these from `GET /imports/templates/{kind}` (copy them into the importers package then).
- Sample set for the owner trial and for importer tests, all numbers invented (3 fictional companies `FAKEA/FAKEB/FAKEC`; FAKEC is a bank, `company_type=financial`): `fixtures/import-samples/` with 8 quarters x 3 companies, 3 annual years x 3, balance/cash flow x 3 years, 4 shareholding quarters x 3, 2 corporate actions, instrument meta, instruments, and `prices_synthetic_split.csv`. Internal rules hold by construction (pbt - tax = net profit, shareholding sums 100, mf + insurance <= dii).
- Format notes for the owner (to put in the wizard help): UTF-8 CSV (Excel "CSV UTF-8" is fine; BOM allowed); keep the header row exactly as in the template; dates as `YYYY-MM-DD` text (Excel may silently reformat dates, so format the column as text before saving); numbers without currency signs; empty cell means unknown, never 0; percentages are numbers (12.5 means 12.5%); money in INR crore except EPS in INR; `shares_outstanding` as an absolute share count (not crore or lakh); quarter ends `31 Mar/30 Jun/30 Sep/31 Dec`; symbols uppercase NSE symbols.
- Problems found in the written format rules (not guessed, raised as open questions with interim behaviour): decimal commas in semicolon files (`1234,56` would become 123456 under "commas stripped", OQ-9, row IMP-28); `fundamentals_long.period_type` values unspecified (OQ-10); `total_liabilities` definition and `shares_outstanding` unit (OQ-11).
- Not done: running the validators (they do not exist until B06a/B06b; every `IMP-*` row stays assigned to those tasks) and the owner's trial of 3 companies x 8 quarters. Both are carried by B06b/F13b and the S17 effort test.
Verdict: GO-WITH-CHANGES (templates and notes delivered; validator run and owner clarity review pending; three open questions).
Spec amendments: none yet (OQ-9..OQ-11 interim assumptions); IMP-28 added to `docs/07`.
Fixtures saved: `fixtures/templates/`, `fixtures/import-samples/`.

## S14 Terms re-read  (BLOCKED-OWNER)
The owner reads the terms; Claude did not summarise or judge any of them. `docs/TERMS_NOTES.md` lists each document, the URL (spec-cited or marked "check"), and what to confirm. Broker rows are N/A (manual mode).
Verdict: BLOCKED-OWNER. Acceptance item "Owner has reviewed TERMS_NOTES.md" stays unticked.

## S15 Licence scan  (2026-10-10, local, Claude Code)
Steps: `python scripts/license_scan.py` (the T00 scanner for Go, Python from `uv.lock`, npm from the web lockfile) and inspected `THIRD_PARTY_NOTICES.md`.
Raw results: scan passed on 410 packages (npm 391, Python 13, Go 0 because `apps/api/go.mod` has no dependencies yet); no GPL/AGPL/unknown. `Review` entries (OQ-8, decision D-OQ8): LGPL-3.0 `@img/sharp-*` (libvips) and Apache-2.0 AND LGPL variants, MPL-2.0 `axe-core` and `pathspec`. ECharts, lucide and Inter are not dependencies yet (they arrive with F01/F02), so their licences could not be confirmed from installed packages here; F01/F02 must run the scan after adding them and fail on anything but Apache-2.0 (ECharts), ISC (lucide) and OFL (Inter), as the spec expects.
Verdict: GO (scanner and notices work; asset licences to be confirmed when added).
Spec amendments: none. Fixtures saved: none.

## S16 Ratio accuracy  (2026-10-10, local, Claude Code)
Steps: `scripts/spikes/s16_ratio_checks.py` implements the docs/05 section 5 formulas with `Decimal` on a fictional company (DEMOCO) and checks 22 known answers (EBIT, ROE, ROCE, D/E, interest coverage, margins, CFO/PAT, 3-year CAGR, TTM EPS, P/E, BVPS, P/B, market cap, EV/EBITDA) and the null rules (equity <= 0, missing prior equity -> ending basis, zero/missing interest, non-positive growth base).
Raw results: all 22 checks pass. Definition sensitivity: ROE on average equity 33.66% vs ending equity 31.36% for the same data, a 6.8% relative difference from the definition alone, above the +/-2% tolerance. Published ratios from companies and data vendors often use ending equity or different capital-employed definitions, so a mismatch will not by itself mean the formula is wrong; the real comparison must note which definition the published figure uses.
Not done (BLOCKED-OWNER): comparing 10 real companies' computed ratios with their published ratios or annual reports needs the owner's figures. Owner checklist: pick 10 companies; enter their official figures through the CSV templates; note the published ROE, ROCE, D/E, P/E, margins and 3-year CAGR and the definition each uses; after D05b exists, compare (pass: within +/-2% relative on >= 80% of metrics, differences explained; otherwise fix formulas or label approximate).
Verdict: GO on formula consistency; real-company comparison BLOCKED-OWNER.
Spec amendments: none (OQ-11 touches `shares_outstanding` unit). Fixtures saved: none.

## S17 Owner effort  (BLOCKED-OWNER)
Needs the owner's time. Checklist: after F13b exists, time entering the latest 8 quarters for 10 companies through CSV (pass: <= 20 min per company) and through forms; use `fixtures/templates/results_quarterly.csv` as the starting file; record minutes per company, pain points and whether the workflow is acceptable. Fail path: reduce required metrics; keep optional ones optional.
Verdict: BLOCKED-OWNER.
