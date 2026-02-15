# Operations Runbook (Python)

## Daily Checklist (Market Days)

## Pre-market (8:45-9:10 IST)
1. Ensure `.env` is valid and token is fresh.
2. Generate login URL if token refresh is needed:
```bash
cd python_app
algo-trading-py auth-url
```
3. Run preflight:
```bash
algo-trading-py preflight
```
4. Run morning preview:
```bash
algo-trading-py morning-preview --symbols INFY,TCS
```
5. Execute morning run:
```bash
algo-trading-py morning
```

## Intraday (9:15-15:30 IST)
1. Start live monitor loop:
```bash
algo-trading-py live-loop --interval-seconds 120
```
2. Optional API-driven checks:
- `GET /api/status`
- `GET /api/scheduler`
- `GET /api/morning/preview`

## End-of-day
1. If strategy requires flat positions:
```bash
algo-trading-py eod-close
```
2. Reconcile state:
```bash
algo-trading-py reconcile
```

## Weekly Checklist
1. Run backtest:
```bash
algo-trading-py backtest --from-date 2026-01-01 --to-date 2026-02-15 --symbols INFY,TCS,RELIANCE
```
2. Review screener health:
```bash
algo-trading-py screener --from-date 2026-02-01 --to-date 2026-02-15 --symbols INFY,TCS,RELIANCE
```

## Incident/Safety Procedures
- Immediate halt:
```env
HALT_TRADING=1
```
- Live-order hard gate:
```env
LIVE_ORDER_MODE=1
CONFIRM_LIVE_ORDERS=YES
```
- If repeated order failures: reduce `RISK_PER_TRADE`, tighten `ALLOWED_SYMBOLS`, lower `MAX_NOTIONAL_PER_ORDER`.
- Reconcile after restart:
```bash
algo-trading-py reconcile
```

## Common Diagnostics
- Runtime status: `GET /api/status`
- Scheduler state: `GET /api/scheduler`
- Preflight: `algo-trading-py preflight`
- Monitoring pass: `algo-trading-py monitor`
- Backtest: `algo-trading-py backtest ...`
- Broker login URL: `algo-trading-py auth-url`
