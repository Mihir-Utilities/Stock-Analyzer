# RUNBOOK (kept up to date by every task)

## 1. Daily routine
- Manual price mode (current): after market close, upload the day's `prices.csv` in Import center. Alerts and analytics run automatically right after the import (`post_import`) and at 19:30 IST (EOD). Alerts say "as of the last price import".
- First setup: import `instruments.csv` (or use Add stock), then `prices.csv`.
- Watch DB size (Import center > Storage). Notices at 70/85/95% of 380 MB; at 380 MB price imports are refused. Nothing is deleted automatically: free space with Trim history or Delete prices.
- Broker reconnect is not applicable (broker mode dormant).
## 2. Deploy
(Fill during T00/T02/B01/F01: Neon setup, Render services (API + worker-http), Vercel project, GitHub secrets, environment variables from .env.example.)
## 3. Scheduled jobs
(Link to .github/workflows; how to trigger manually with workflow_dispatch; how to run the worker from a home machine.)
## 4. Failure modes and responses
| Symptom | Likely cause | Action |
|---|---|---|
## 5. Backup and restore drill
(Fill in D08.)
## 6. Plan B
- Render free hours exhausted; broker blocks cloud IP; Neon limit reached; GitHub schedule disabled.
## 7. Incident log
