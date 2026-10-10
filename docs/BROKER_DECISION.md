# Broker Decision (spike S1)

Hard requirements: cost 0; read-only/data scope; OAuth performed personally by the owner; no static IP needed for data-only calls (or owner has a static IP); terms allow private storage/analysis of the data.

## Decision: manual price mode (no broker)

**Decision: manual price mode.** `BROKER_ENABLED=false`. Prices come from owner-uploaded `prices.csv`; the stock list comes from `instruments.csv` or the Add stock form (decisions D-1 and D-2 in `docs/OPEN_QUESTIONS.md`).

Reasons:
- The owner chose manual price mode (D-1, answers Q1 and Q8): no broker is used, so no broker login, no token, no static-IP question and no broker terms to re-read.
- This is the documented fail path of S1 (`docs/08`): "run in manual price mode; remove broker code from scope". Consequently S2, S3 and S5 are `N/A (manual mode)` and S4 becomes the manual adjustment check.
- It keeps the Safe Edition free of any broker integration: nothing to automate, nothing order-capable, no secrets to store (`docs/00` section 1).
- Cost stays 0 and there is no dependency on a broker's session rules (daily expiry under the SEBI framework, `docs/00` section 5).

Comparison table: **not filled, by decision.** No broker was evaluated, and no broker website or API was contacted. If a broker is ever wanted later, reopen S1 and fill the table below from the broker's official developer documentation and terms.

| Criterion | Angel One SmartAPI | Fyers API | Upstox API | DhanHQ |
|---|---|---|---|---|
| Free for account holders (official page) | not evaluated (D-1) | not evaluated | not evaluated | not evaluated |
| Read-only / data-only scope | not evaluated | not evaluated | not evaluated | not evaluated |
| OAuth flow details | not evaluated | not evaluated | not evaluated | not evaluated |
| Token lifetime | not evaluated | not evaluated | not evaluated | not evaluated |
| Static IP needed for data-only calls | not evaluated | not evaluated | not evaluated | not evaluated |
| Rate limits | not evaluated | not evaluated | not evaluated | not evaluated |
| Daily candle limits (per request / total) | not evaluated | not evaluated | not evaluated | not evaluated |
| Instrument master URL and format | not evaluated | not evaluated | not evaluated | not evaluated |
| Index and India VIX availability | not evaluated | not evaluated | not evaluated | not evaluated |
| Candles split-adjusted? | not evaluated | not evaluated | not evaluated | not evaluated |
| Terms on data storage/use | not evaluated | not evaluated | not evaluated | not evaluated |
| Account opening requirements | not evaluated | not evaluated | not evaluated | not evaluated |

Owner approval (date): 2026-10-10 (recorded as decision D-1 in `docs/OPEN_QUESTIONS.md`; owner to re-confirm at T01 review).
