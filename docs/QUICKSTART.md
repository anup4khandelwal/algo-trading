# Quickstart (Python, 5 Minutes)

## 1) Setup environment
```bash
cd python_app
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

## 2) Configure env file
```bash
cd ..
cp .env.example .env
```
Set at minimum:
- `KITE_API_KEY`
- `KITE_API_SECRET`
- `KITE_ACCESS_TOKEN`
- `DATABASE_URL=postgresql://...` (if using Postgres persistence)

## 3) Generate Kite login URL
```bash
cd python_app
algo-trading-py auth-url
```
Open the URL, complete login, and update `.env` with the token.

## 4) Start API server
```bash
uvicorn algo_trading_py.api.server:app --reload --port 8000
```
Open API docs: `http://127.0.0.1:8000/docs`

## 5) Run morning flow from CLI
```bash
algo-trading-py preflight
algo-trading-py morning-preview --symbols INFY,TCS
algo-trading-py morning
```

## 6) Start intraday monitoring
```bash
algo-trading-py live-loop --interval-seconds 120
```

## 7) Screener and backtest
```bash
algo-trading-py screener --from-date 2026-02-01 --to-date 2026-02-15 --symbols INFY,TCS
algo-trading-py backtest --from-date 2026-01-01 --to-date 2026-02-15 --symbols INFY,TCS
```

## Safety before live mode
Set:
```env
LIVE_ORDER_MODE=1
CONFIRM_LIVE_ORDERS=YES
ALLOWED_SYMBOLS=INFY,TCS,RELIANCE
MAX_NOTIONAL_PER_ORDER=100000
```
Keep `HALT_TRADING=1` during setup and debugging.
