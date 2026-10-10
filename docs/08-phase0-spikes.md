# 08. Phase 0 Spikes (Safe Edition)

Purpose: turn every unverified item into a measured fact **before** building on it. The planning environment had no internet access; none of this has been run. Each spike writes an entry in `SPIKE_RESULTS.md` (date, environment, steps, raw outcome, verdict GO / GO-WITH-CHANGES / NO-GO, spec sections to amend) and saves redacted fixtures under `/fixtures/`.

Global rules:
- Only allowed sources are touched (`00-legal-and-safety.md`). **Do not test forbidden sources.**
- Keep request volume tiny and respect the broker's documented limits.
- A NO-GO stops the work: amend the specs and tell the owner before continuing.
- Where a spike needs the owner (broker account, login), Claude Code must ask the owner to perform the login step; never automate it.

| ID | Spike | Steps | Pass criteria | If it fails |
|---|---|---|---|---|
| S1 | **Broker decision** | For Angel One SmartAPI, Fyers, Upstox, DhanHQ read the official developer docs and terms. Fill a comparison table in `docs/BROKER_DECISION.md`: free for account holders (cost must be 0); read-only/data-only scope available; OAuth redirect flow the owner performs personally; token lifetime; whether **data-only** calls need a registered static IP; rate limits; daily-candle limits per request and total depth; instrument master URL/format; index and India VIX availability; terms on storing/using market data privately; account-opening requirements. Apply the rubric in `01` 3.1 | At least one broker satisfies every hard requirement | Run in **manual price mode** (prices.csv uploads); remove broker code from scope |
| S2 | Broker reachability and session | With the chosen broker: owner completes OAuth once; from (a) home, (b) a GitHub Actions runner, (c) a Render free service call: instrument master, 5 days of candles for 3 stocks, quotes for 10 symbols. Measure success, latency, errors; observe token expiry time and behavior after expiry | >= 95% success from the environment hosting the worker; token lifetime known; no static-IP block for data | Run worker from the owner's static-IP machine; or manual price mode |
| S3 | History depth and limits | For 20 stocks (large/mid/small/recent IPO) request daily candles back as far as allowed (chunk loop); record rows, first date, per-request cap, rate-limit behavior; compare 15 closing prices and volumes against the owner's broker app/terminal for the same dates | >= 5 years for >= 90% of non-recent stocks; prices match within 0.2%; volumes plausible | Document depth; adjust `PRICE_HISTORY_YEARS_TRACKED`; UI states depth |
| S4 | Adjusted vs raw | Pick 3 stocks with known splits/bonuses in the last 5 years (owner supplies from their records); inspect candles around ex-dates; decide `PRICES_ALREADY_ADJUSTED` (manual mode: see below) | Behavior consistent and documented | If inconsistent per stock: force raw-detection mode and rely on owner-confirmed actions |
| S5 | Index/VIX candles | Request NIFTY 50 and India VIX daily candles | Both available for >= 3 years | Dashboard/ML/portfolio benchmark degrade per specs (BRK-16) |
| S6 | mfapi.in | Search 5 names; list pagination to the end (count, time); history for 3 schemes (Direct Growth, IDCW, an older merged scheme) with and without `startDate/endDate`; check order of `data`, earliest date, weekend handling, latency; 30 calls spaced 0.5 s to detect 429; compare latest NAV with AMFI file for 20 schemes | All endpoints OK; history >= 5 years for older schemes; latest NAV equals AMFI for >= 19/20 | AMFI as primary for latest; adjust throttles |
| S7 | AMFI NAVAll.txt | Download once; parse with the state machine in `01` section 5; check section ordering | > 10,000 rows; no mis-assigned AMC | mfapi only |
| S8 | Split/bonus detector tuning | Run the detector over 5 years of candles for 30 stocks (include >= 10 known events); count false positives/negatives | >= 90% of known events (ratio <= 0.65) detected; <= 3 false positives per 30 stock-years | Adjust thresholds/volume rule; document limits |
| S9 | Hosting behavior | Hello-world Go API on Render free: cold start (idle 20 min then request) x5; Neon cold-query latency; Next.js on Vercel Hobby with `/api` rewrite to Render; verify cookies through the rewrite; check Vercel Hobby terms for personal use; memory of Go binary and Python worker-http (512 MB limit); **upload a 25 MB file (and a 300,000-row prices CSV) through the Vercel `/api` rewrite to the Go API, record the largest size that passes** | Cold start < 90 s; cookies work; worker-http within 512 MB; 25 MB upload passes | Slim worker; proxy via Next route handlers; for uploads: the import wizard splits large price CSVs in the browser into parts under the measured limit and commits them as one logical batch (same `upload_group`, one transaction at commit); amend B06/F13. **The API keeps the lower (5 MB) limit for `prices` until this spike passes** |
| S10 | DB sizing and extensions | Neon free: `CREATE EXTENSION pg_trgm`; load synthetic 150 stocks x 1,250 rows; measure `pg_total_relation_size`; trigram search latency on 2,300 instruments and 10,000 schemes | pg_trgm works; bytes/row within 20% of ~130; search < 300 ms | Adjust storage budget |
| S11 | GitHub Actions | Throwaway repo (public and private): 15-minute cron for 3 days (drift/skips); a 20-minute job to measure billed minutes; read current free-minute allowance; confirm schedule-disable policy | Drift < 15 min typical; budget feasible | Run worker at home |
| S12 | Telegram | Create a bot (BotFather); set webhook with secret token to the Render API; send `/start code` after 20 min idle; test HTML escaping and 1.1 s pacing for 20 messages | Linking succeeds within 2 minutes after wake | Manual "link" fallback via getUpdates with webhook disabled |
| S13 | Import formats | Build CSV templates; owner enters/imports 3 companies x 8 quarters + 3 annual + 4 shareholding quarters + 2 actions; run validators; try every error case in `07` IMP-* | All validators behave; templates clear to the owner | Revise templates/messages |
| S14 | Terms re-read | On build day read and record (URL + date) the terms of: chosen broker (API + data), mfapi.in, AMFI, Telegram Bot API, Vercel Hobby, Render free, Neon free, GitHub Actions | Consistent with private personal single-user use | Adjust sources; owner decision |
| S15 | Licence scan | Set up the licence scanner for Go, Python, npm; generate `THIRD_PARTY_NOTICES.md`; confirm ECharts, lucide, Inter licences | No GPL/AGPL/unknown | Replace dependency |
| S16 | Ratio accuracy | For 10 companies, enter official figures, compute ROE, ROCE, D/E, P/E, margins, 3Y CAGR and compare with the company's published ratios/annual report | Within +/-2% relative on >= 80% of metrics; differences explained | Fix formulas or label approximate |
| S17 | Owner effort | Time the owner entering 10 companies' latest 8 quarters through CSV and through forms | <= 20 min per company via CSV; owner accepts workflow | Reduce required metrics; keep optional ones optional |

## Manual price mode (decisions D-1, D-2)
S1 is recorded as "manual price mode" (no broker comparison needed); **S2, S3 and S5 are skipped** (record them as `N/A (manual mode)` in `SPIKE_RESULTS.md`). **S4 becomes the manual adjustment check** (steps below). S8 runs on owner-imported price files (the owner supplies >= 30 stocks of history). S9 adds the 25 MB upload check. S5 is replaced by checking that reserved `NIFTY50` / `INDIAVIX` rows in `prices.csv` load into `market_series`.

### Manual S4: adjustment check (replaces S4 in manual mode)
1. Pick 1-3 stocks with a split or bonus you know about (from your own records), and note the ex-date and ratio.
2. Prepare `prices.csv` for each from your price source, spanning the ex-date with at least 5 trading days on each side. Upload it in the prices wizard and stop at the validate step (do not commit).
3. Choose "I don't know" and open the Adjustment check: enter symbol, ex-date and optionally the expected ratio. The app shows the closes around the ex-date, the observed ratio and an advisory hint.
4. A gap near the expected ratio (within 3%) = the source is **raw**. A ratio within 3% of 1 = **already adjusted**. Otherwise inconclusive: check another stock or the source.
5. Choose raw / already adjusted in the wizard (this sets `PRICES_ALREADY_ADJUSTED`), commit, and record stocks, observed ratios, the answer and the date in `SPIKE_RESULTS.md`.
Pass: all checked stocks agree. Fail (mixed answers): the price source is mixed; the owner must use one kind per source (re-export) before any prices are committed.

## Result template (`SPIKE_RESULTS.md`)
```
## S<id> <name>  (date, environment, who)
Steps:
Raw results (counts, latencies, samples):
Verdict: GO | GO-WITH-CHANGES | NO-GO
Spec amendments (file + section):
Fixtures saved:
```
