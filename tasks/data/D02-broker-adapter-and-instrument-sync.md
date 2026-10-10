# D02 - Broker adapter and instrument sync  (REMOVED in manual price mode)

| Field | Value |
|---|---|
| Status | **REMOVED** (decisions D-1 and D-2, 2026-10-10). Do not implement. |
| Track | data |

## Why
The owner chose manual price mode (no broker). Instruments come from `instruments.csv` or the Add stock form (B06a/F13a); prices come from `prices.csv`. `sync_instruments`, `broker_session_check` and the broker adapter are not built, and nothing in the app fetches instrument lists or prices from the internet.

## Where its remaining responsibilities went
- Tracked-set maintenance (`is_tracked`): the API sets it on open (B03), watchlist add / portfolio txn (B11) and prices import (B06a); eviction rules are in D08 (`docs/04` 3.10).
- Detection and analytics after new prices: `post_import` in D03.
- If a broker is ever enabled later, reinstate this task from git history (`docs/01` section 3 is kept as the design reference) after a new owner decision.
