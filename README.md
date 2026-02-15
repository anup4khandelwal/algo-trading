# Algo Trading Platform (Python)

Current Python version: `1.0.0`  
Version source: `python_app/pyproject.toml`  
Changelog: `CHANGELOG.md`

## What is in scope
- Python trading runtime in `python_app/algo_trading_py/`
- CLI entrypoint: `algo-trading-py`
- FastAPI server for screener/runtime controls
- Live-mode guardrails (`LIVE_ORDER_MODE=1` + `CONFIRM_LIVE_ORDERS=YES`)
- Scheduler + live loop
- Morning preview and screener preset workflows

## Quick Start
1. Create and activate a virtual environment.
```bash
cd python_app
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```
2. Configure environment in repository root:
```bash
cd ..
cp .env.example .env
```
3. Generate Kite login URL:
```bash
cd python_app
algo-trading-py auth-url
```
4. Start API server:
```bash
uvicorn algo_trading_py.api.server:app --reload --port 8000
```

## Core CLI Commands
```bash
algo-trading-py morning
algo-trading-py morning-preview --symbols INFY,TCS
algo-trading-py preflight
algo-trading-py entry --symbols INFY,TCS
algo-trading-py monitor
algo-trading-py reconcile
algo-trading-py eod-close
algo-trading-py live-loop --interval-seconds 120
algo-trading-py screener --from-date 2026-02-01 --to-date 2026-02-15 --symbols INFY,TCS
algo-trading-py backtest --from-date 2026-01-01 --to-date 2026-02-15 --symbols INFY,TCS
```

## API Endpoints
- `GET /api/status`
- `GET /api/scheduler`
- `GET /api/screener`
- `GET /api/morning/preview`
- `POST /api/run/morning`
- `POST /api/run/entry`
- `POST /api/run/monitor`
- `POST /api/run/reconcile`
- `POST /api/run/eod`
- `POST /api/run/preflight`
- `POST /api/run/live-loop`
- `POST /api/scheduler/start`
- `POST /api/scheduler/stop`

## Safety Settings
Required for live orders:
```env
LIVE_ORDER_MODE=1
CONFIRM_LIVE_ORDERS=YES
```
Recommended:
```env
HALT_TRADING=1
ALLOWED_SYMBOLS=INFY,TCS,RELIANCE
MAX_NOTIONAL_PER_ORDER=100000
```

## Additional Docs
- `python_app/README.md`
- `docs/QUICKSTART.md`
- `docs/OPERATIONS.md`
- `docs/TRADER_GUIDE.md`
