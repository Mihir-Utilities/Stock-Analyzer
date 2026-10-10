# Open Questions and Decisions

Claude Code: add questions here instead of guessing. The owner answers; move answered items to "Decisions" with the date.

## Open
| # | Question | Interim assumption | Blocks |
|---|---|---|---|
| OQ-1 | Which broker does the owner already have an account with (Angel One / Fyers / Upstox / DhanHQ) or "none yet"? Owner's answer was left as a placeholder. | Manual price mode (`BROKER_ENABLED=false`). | T01 S2-S5 (no login until owner approves), D02, B08 |
| OQ-2 | Does the owner have a static IP at home (yes / no / not sure)? Answer left as a placeholder. | Treat as "no": no paid static IP; if the broker rejects Actions/Render IPs for data calls, fall back to manual price mode and tell the owner. | S2 fallback, worker hosting plan |
| OQ-3 | Training basket CSV (>= 20 symbols). | D07 ships with the `insufficient_universe` path only unless supplied before D07. | D07 |

## Decisions
| Date | Decision | Reason | Spec files updated |
|---|---|---|---|
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
