# Python Migration Baseline

This folder contains the Python migration baseline for the TypeScript algo-trading project.

## Included
- Core domain models (`types.py`)
- Technical indicators (`utils/indicators.py`)
- Kite historical provider (`market_data/kite_historical_provider.py`)
- Screener service (`screener/service.py`)
- Backtest engine (`backtest/engine.py`)
- FastAPI server with screener endpoint (`api/server.py`)
- Typer CLI for screener/backtest (`cli.py`)

## Quick start
```bash
cd python_app
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Run API:
```bash
uvicorn algo_trading_py.api.server:app --reload --port 8000
```

Run auth callback server:
```bash
uvicorn algo_trading_py.auth.server:app --reload --port 8000
```
Get login URL:
```bash
algo-trading-py auth-url
```
Callback endpoint:
`http://127.0.0.1:8000/kite/callback`

Run screener from CLI:
```bash
algo-trading-py screener --from-date 2026-02-01 --to-date 2026-02-15 --symbols INFY,TCS
```

Pipeline parity commands:
```bash
algo-trading-py morning
algo-trading-py morning-preview --symbols INFY,TCS
algo-trading-py preflight
algo-trading-py entry
algo-trading-py monitor
algo-trading-py reconcile
algo-trading-py eod-close
algo-trading-py live-loop --interval-seconds 120
```

Operational API parity endpoints now include:
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
