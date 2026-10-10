# Terms Notes (spike S14)

Record, on build day, the URL, date read, and a one-paragraph summary of the terms for each service. Owner confirms the app's use (private, personal, non-commercial, no redistribution) is consistent with each.

**Status: PREPARED, NOT READ.** Claude did not summarise any terms (not verified, and the summary is the owner's call). The owner opens each document below in a browser, fills "Date read", "Summary" and "Consistent?" (yes / no / unclear), and flags anything "no" or "unclear" in `docs/OPEN_QUESTIONS.md`. URLs marked (spec) come from `docs/00` section 2; URLs marked (check) are from memory and may have moved: use the service's footer "Terms" / "Legal" link if one 404s.

| Service | URL | What to confirm | Date read | Summary | Consistent with private personal use? |
|---|---|---|---|---|---|
| Chosen broker (API terms) | N/A: manual price mode (D-1), no broker | none | n/a | n/a | n/a |
| Chosen broker (market data terms) | N/A: manual price mode (D-1) | none | n/a | n/a | n/a |
| mfapi.in | https://www.mfapi.in (spec), https://www.mfapi.in/docs (spec) | Free, no auth; any stated rate limit or caching request; any attribution wording; any ban on commercial or bulk use. App fetches the full list (4 requests of 10,000) weekly, ~40 history calls first time, then increments, 0.5 s apart | | | |
| AMFI | https://www.amfiindia.com/terms-of-use (spec) | Copyright and reuse of the published NAV file; whether one automated download per run of `NAVAll.txt` is acceptable for personal use; disclaimer wording to show in the UI | | | |
| Telegram Bot API | https://core.telegram.org/bots/api (spec); bot developer terms (check): https://telegram.org/tos/bot-developers; limits FAQ (check): https://core.telegram.org/bots/faq | Bot use for personal alerts; documented per-chat message pacing (app uses 1.1 s spacing) | | | |
| Vercel (Hobby) | https://vercel.com/legal/terms (check); fair-use guidelines (check): https://vercel.com/docs/limits/fair-use-guidelines | Hobby is for personal, non-commercial use; request/body size limits on rewrites (see S9) | | | |
| Render (free) | https://render.com/terms (check); free tier limits (check): https://render.com/docs/free | Free web service hours, sleep after inactivity, 512 MB memory, acceptable use for a personal app | | | |
| Neon (free) | https://neon.com/pricing (spec); terms (check): https://neon.com/terms-of-service | 0.5 GB storage, compute hours, scale-to-zero, `pg_trgm` availability | | | |
| GitHub Actions | https://docs.github.com/en/actions/reference/usage-limits-billing-and-administration (spec); https://docs.github.com/en/site-policy/github-terms/github-terms-of-service (check) | Free minutes for public and private repos, schedule auto-disable after 60 days of inactivity, acceptable use of scheduled jobs | | | |
