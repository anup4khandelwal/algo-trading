# Trader Guide (Python Runtime)

## Purpose
This guide explains the Python migration workflow for daily trading operations.

This is not financial advice. Use paper mode first.

## 1) System Overview
The Python runtime has these layers:
1. Trading engine (`python_app/algo_trading_py/`): screener, signal, risk, execution, monitoring.
2. Persistence: in-memory store by default, optional Postgres module.
3. API controls: FastAPI server for run commands, scheduler, preview, and screener.

## 2) First-Time Setup
1. Setup venv and install:
```bash
cd python_app
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```
2. Create `.env` in repo root:
```bash
cd ..
cp .env.example .env
```
3. Configure required values:
- `KITE_API_KEY`
- `KITE_API_SECRET`
- `KITE_ACCESS_TOKEN`
- `LIVE_ORDER_MODE` and `CONFIRM_LIVE_ORDERS` as needed
4. Start API server:
```bash
cd python_app
uvicorn algo_trading_py.api.server:app --reload --port 8000
```

## 3) Core Modes
1. Paper mode:
- `LIVE_ORDER_MODE=0`
- Simulated execution adapter.
2. Live mode:
- `LIVE_ORDER_MODE=1`
- `CONFIRM_LIVE_ORDERS=YES`
- Uses Kite live order flow.
3. Halt mode:
- `HALT_TRADING=1`
- Blocks new entries.

## 4) Daily Workflow
### Pre-market (08:30-09:05 IST)
1. Refresh Kite token if needed using:
```bash
cd python_app
algo-trading-py auth-url
```
2. Run preflight:
```bash
algo-trading-py preflight
```
3. Run preview:
```bash
algo-trading-py morning-preview --symbols INFY,TCS
```
4. Execute morning:
```bash
algo-trading-py morning
```

### Intraday
1. Start monitoring loop:
```bash
algo-trading-py live-loop --interval-seconds 120
```
2. Optional API checks:
- `GET /api/status`
- `GET /api/scheduler`

### End of day
```bash
algo-trading-py eod-close
algo-trading-py reconcile
```

## 5) Screener Workflow
```bash
algo-trading-py screener --from-date 2026-02-01 --to-date 2026-02-15 --symbols INFY,TCS
```
API equivalent:
- `GET /api/screener?from=2026-02-01&to=2026-02-15&symbols=INFY,TCS`

Supported preset logic in app layer:
- Trend Breakout
- RSI Pullback
- High Volume Momentum

## 6) Backtest Workflow
```bash
algo-trading-py backtest --from-date 2026-01-01 --to-date 2026-02-15 --symbols INFY,TCS,RELIANCE
```

## 7) API Command Reference
- `POST /api/run/preflight`
- `POST /api/run/morning`
- `POST /api/run/entry`
- `POST /api/run/monitor`
- `POST /api/run/reconcile`
- `POST /api/run/eod`
- `POST /api/run/live-loop`
- `POST /api/scheduler/start`
- `POST /api/scheduler/stop`
- `GET /api/morning/preview`
- `GET /api/scheduler`
- `GET /api/status`

## 8) Safety Controls
Recommended baseline:
```env
HALT_TRADING=1
LIVE_ORDER_MODE=0
```
Enable live only when ready:
```env
LIVE_ORDER_MODE=1
CONFIRM_LIVE_ORDERS=YES
ALLOWED_SYMBOLS=INFY,TCS,RELIANCE
MAX_NOTIONAL_PER_ORDER=100000
```
