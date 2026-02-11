# Quickstart (5 Minutes)

## 1) Install dependencies
```bash
npm install
```

## 2) Configure environment
```bash
cp .env.example .env
```
Set at minimum:
- `KITE_API_KEY`
- `KITE_API_SECRET`
- `KITE_ACCESS_TOKEN` (refresh daily)
- `DATABASE_URL=postgres://algo_user:algo_pass@127.0.0.1:5432/algo_trading`

## 3) Initialize and verify DB
```bash
npm run db:init
npm run db:check
```

## 4) Start auth callback server and generate access token
```bash
npm run auth
```
Open:
```text
https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_KITE_API_KEY
```
After login, token is captured via callback and stored in `.env`.

## 5) Run morning workflow
```bash
npm run morning
```
This runs:
- DB health check
- broker/state reconciliation
- entry + monitor pass
- DB report

## 6) Start dashboard
```bash
npm run ui
```
Open `http://127.0.0.1:3000`.

## 7) Optional live loop
```bash
npm run live
```

## Safety before live mode
Set:
```env
LIVE_ORDER_MODE=1
CONFIRM_LIVE_ORDERS=YES
ALLOWED_SYMBOLS=CDSL,MOSCHIP
MAX_NOTIONAL_PER_ORDER=100000
```
Use `HALT_TRADING=1` to stop new entries immediately.
