# Operations Runbook

## Daily Checklist (Market Days)

## Pre-market (8:45-9:10 IST)
1. Ensure Postgres is up.
2. Refresh Kite access token (`npm run auth`).
3. Confirm `.env` risk limits and safety flags.
4. Run live preflight:
```bash
npm run preflight
```
5. Run:
```bash
npm run morning
```

## Intraday (9:15-15:30 IST)
1. Start monitor loop:
```bash
npm run live
```
2. Use UI (`npm run ui`) to watch:
- running job state
- positions
- managed stops
- broker sync time

## End-of-day
1. If strategy requires flat book:
```bash
npm run eod:close
```
2. Review:
```bash
npm run db:report
```

## Weekly Checklist
Run analytics and export:
```bash
npm run weekly
```
This executes:
- `strategy:report`
- `strategy:rebalance`
- `trades:export`

Review `.env.recommended` and selectively apply updates.

## Incident/Safety Procedures
- Immediate halt:
```env
HALT_TRADING=1
```
- Force strict DB dependency:
```env
REQUIRE_DB=1
```
- If repeated order failures: reduce `RISK_PER_TRADE`, tighten `ALLOWED_SYMBOLS`, lower `MAX_NOTIONAL_PER_ORDER`.
- Reconcile state after restart:
```bash
npm run reconcile
```

## Common Diagnostics
- DB: `npm run db:check`
- Reports: `npm run db:report`
- Strategy health: `npm run strategy:report`
- Broker token errors: regenerate via `npm run auth`
