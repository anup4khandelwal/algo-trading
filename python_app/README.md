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

Run screener from CLI:
```bash
algo-trading-py screener --from-date 2026-02-01 --to-date 2026-02-15 --symbols INFY,TCS
```
