# 00. Legal Safety Policy and Verification Report (Safe Edition)

Date: 10 Oct 2026. This is a design policy, **not legal advice**. No use of financial data that is not licensed to you carries literally zero risk. This edition chooses the lowest-risk configuration found during research: it automatically fetches data **only** from sources whose terms or published offering allow that use, and treats everything else as **owner-supplied data** that the owner enters or uploads personally. If you want certainty, ask a lawyer to review the terms listed in section 3 before you rely on any gray area.

---

## 1. The Safe Edition rules (binding on all implementation work)

1. **Allowed automated sources only:** (a) mfapi.in (free, open, no authentication; asks users to cache), (b) AMFI's public NAV file, (c) the owner's **own broker account** through that broker's official API (OAuth, owner logs in themselves), (d) Telegram Bot API (official).
2. **Forbidden in code (do not implement, even behind a flag):** scraping or automated calls to NSE/BSE websites or their undocumented JSON endpoints (including `nsepython`), Yahoo Finance / `yfinance`, Screener.in pages, Google News/RSS scraping, any XBRL scraping from exchange sites, any other site whose terms prohibit automated access.
3. **Owner-supplied data is allowed** through the app's own entry forms and file imports (CSV templates; optional Excel from the owner's own export). The owner is responsible for the right to use what they upload. The app states: "Enter or import only data you have the right to use. Prefer company filings and your own records."
4. **Private and personal:** single user, login required, no sharing, no public pages, no redistribution of any data or model output, no commercial use.
5. **No trading:** the app never places, modifies or cancels orders and never requests order-capable permissions where a read-only scope exists. This keeps it outside the order-placing API rules described in section 2.
6. **Attribution and disclaimers:** footer on every page: "Personal research tool. Not investment advice. Data may be delayed, incomplete or wrong." MF screens: "NAV data: AMFI, via mfapi.in".
7. **Licence hygiene:** only permissive licences (MIT/Apache-2.0/BSD/ISC/OFL fonts). CI runs a licence scan and fails on GPL/AGPL/unknown. Keep a generated `THIRD_PARTY_NOTICES.md` and ship it with the app.
8. **Secrets and personal data:** broker tokens are encrypted at rest (AES-256-GCM), never logged, never sent to the browser. Portfolio data stays in the owner's database.
9. **No predictions to others:** forecasts are private research output. Do not publish, share or sell them.

## 2. Verified facts that drove this policy (sources)

| Fact | Source |
|---|---|
| Screener.in terms: personal, non-commercial, transitory viewing only; no copying/modifying, no mirroring materials on another server (last updated 2018) | https://www.screener.in/guides/terms/ |
| NSE website terms: users are prohibited from systematic or automated data collection (scraping, data mining, extraction, harvesting) | https://www.nseindia.com/static/nse-terms-of-use |
| NSE copyright page: personal, non-commercial or educational download allowed without alteration; content not to be stored on another website or retrieval system | https://www.nseindia.com/static/nse-copyright |
| NSE Data & Analytics portal terms also bar systematic/automated collection and copying/aggregating data | https://dotexdata.nseindia.com/TermsAndConditions/TermsofUse.pdf |
| yfinance: "intended for personal use only"; unofficial; widespread 429 rate-limit reports | https://pypi.org/project/yfinance/ ; GitHub issues #2125, #2480 |
| Twelve Data free plan: real-time US data only; India coverage needs the top individual tier; free quota 800 requests/day | https://support.twelvedata.com/en/articles/5335783-trial ; https://twelvedata.com/pricing |
| Third-party comparisons list Angel One SmartAPI, Upstox, DhanHQ and Fyers APIs as free for account holders, with market data/historical candles (free-ness of data per broker to be confirmed in the spike) ; Kite Connect personal plan has no market data, data plan Rs 500/month | https://algotest.in/blog/best-brokers-for-algo-trading-in-india/ ; https://www.thefinbaba.com/blog/zerodha-api-charges |
| SEBI retail algo framework (effective 1 Apr 2026): static IP whitelisted at broker for order placement, OAuth-only authentication, sessions closed at end of each trading day, no open APIs, algo orders carry exchange IDs; retail algo systems hosted in India | https://www.tradejini.com/blogs/what-sebis-new-algo-trading-rules-mean-for-you ; https://dev.to/reyazk08/sebis-new-algo-trading-rules-for-retail-traders-what-changed-in-april-2026-4k04 |
| Upstox historical candle API shape: `GET /historical-candle/{instrumentKey}/{interval}/{to_date}/{from_date}`; candle = [timestamp, open, high, low, close, volume, OI]; per-request duration limits per interval; 1-minute data only for the previous months | https://upstox.com/developer/api-documentation/get-historical-candle-data/ ; https://github.com/upstox/upstox-java/blob/master/docs/HistoryApi.md |
| mfapi.in endpoints and free/no-auth statement; updates 3x daily; docs ask for caching | https://www.mfapi.in/docs ; https://mfapi.in |
| AMFI terms of use: site material is AMFI's copyright; NAVs are published daily for investors; AMFI disclaims accuracy | https://www.amfiindia.com/terms-of-use |
| AMFI NAV flat file format (semicolon-separated: code; ISIN payout/growth; ISIN reinvest; name; NAV; date dd-Mon-yyyy) at `https://www.amfiindia.com/spages/NAVAll.txt` | community repos/forum posts (format); fetched once by spike S7 on 2026-10-10: now 8 fields (`Plan` and `Option` columns added, see `01` section 5) |
| Neon free: 0.5 GB, 100 CU-hours/project, scale-to-zero after 5 min | https://neon.com/pricing |
| Render free web service: 750 h/month, 512 MB, sleeps after 15 min, ~1 min wake; free Postgres expires after 30 days | https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026 |
| Telegram: getUpdates and webhook mutually exclusive; updates kept max 24 h; webhook secret-token header | https://core.telegram.org/bots/api |
| GitHub Actions: public repos free; private quota; public repo schedules auto-disabled after 60 days without activity | https://docs.github.com/en/actions/reference/usage-limits-billing-and-administration |
| XBRL for Indian filings is messy (two taxonomies, taxonomy files unreachable, some filings lack XBRL) | https://github.com/dhananjaym182/india-xbrl-filings |

## 3. Terms the owner must read on build day (spike S14 records the outcome in `docs/TERMS_NOTES.md`)
Chosen broker's API terms and data-usage terms; mfapi.in notice; AMFI terms of use; Telegram Bot API terms; Vercel (Hobby is described as non-commercial: confirm), Render, Neon, GitHub Actions terms. Not verified by this research: whether each broker's terms permit storing its market data in a private personal database (typical terms restrict redistribution, not private analysis, but **read them**).

## 4. What the Safe Edition gives up (be explicit with the owner)

| Feature | Previous design | Safe Edition |
|---|---|---|
| Stock prices | Yahoo/NSE automatic for all stocks | Owner's broker API (needs a free broker account, a one-tap login each trading day) **or** owner-uploaded price CSVs |
| Fundamentals (quarterly/annual) | Yahoo + NSE automatic | Owner enters/imports for chosen stocks only (forms + CSV templates); Screener Excel import optional and off by default (still a gray area under Screener's terms) |
| Shareholding (promoter/FII/DII/MF) | NSE automatic | Owner enters/imports per quarter |
| Corporate actions | NSE automatic | Owner enters/imports; the app also **detects probable splits/bonuses** from price gaps and asks the owner to confirm |
| Sector/industry, index membership | Source-provided | Owner imports a CSV; used for peers/screener |
| News | Yahoo/Google | Removed. Replaced by a "Research links" panel (plain hyperlinks the owner clicks; nothing is fetched) |
| FII/DII flows, USDINR/crude/S&P features | NSE/Yahoo | Removed |
| Mutual funds | mfapi/AMFI | Unchanged (fully automatic) |
| Alerts, portfolio, predictions, charts, technicals | Automatic | Automatic on price data (predictions will often be hidden by the honesty guardrail) |

## 5. Residual risks (honest list)
- Broker terms and SEBI rules change; broker sessions expire daily (SEBI framework), so a daily login is part of the workflow. Re-verify static-IP requirements for **data-only** access with the chosen broker (spike S1). If the broker demands a static IP even for data, the worker must run from a fixed IP (home machine with a static IP) or the owner uses manual price uploads.
- Even personal storage of exchange-derived data can conflict with some terms. Mitigation: private, personal, non-commercial, no redistribution; keep only what the owner uses.
- Free tiers can change or throttle (Render, Neon, GitHub).
- Owner-uploaded data quality is the owner's responsibility; the UI always labels the source as "manual/import" with the import date.
- Model forecasts can be wrong; guardrails reduce but do not eliminate misleading output.

## 6. Unverified items (each maps to a spike in `08-phase0-spikes.md`)
Which broker to use and its exact data terms, token lifetime, static-IP needs for data-only calls, rate limits and daily-candle history depth (S1-S3); whether broker candles are split-adjusted (S4); index/VIX candles availability (S5); mfapi history depth and AMFI agreement (S6-S7); hosting behavior (S9); DB sizing (S10); GitHub Actions budget (S11); Telegram webhook after cold start (S12); CSV/Excel import formats (S13); terms re-read (S14); ratio accuracy of manual entry validations (S16).
