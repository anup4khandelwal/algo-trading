# Algo Trading Platform (India Equities)

This repository is a TypeScript-based swing-trading platform for NSE equities with:
- screener + signal generation,
- risk controls,
- order/position tracking,
- trailing stop management,
- Postgres persistence,
- operational scripts,
- web dashboard.

## What Is Implemented

### Trading Engine
- **Screener** (`src/screener/screener.ts`): trend/momentum candidates from Kite historical candles.
- **Signal Builder** (`src/signal/signal_builder.ts`): breakout logic + ATR-based stop + position sizing.
- **Risk Engine** (`src/risk/risk_engine.ts`): daily loss, max orders, max positions, max symbol exposure.
- **Execution Adapter** (`src/execution/zerodha_adapter.ts`):
  - `paper` mode (simulated fill via LTP)
  - `live` mode (Kite order API + polling + broker position reconciliation)
- **Position Monitor** (`src/monitor/position_monitor.ts`): ATR trailing stop and stop-exit handling.

### Persistence
- **Postgres** (`src/persistence/postgres_persistence.ts`) tables:
  - `orders`, `fills`, `positions`, `managed_positions`, `trade_lots`, `daily_snapshots`, `system_state`
- **No-op fallback** if DB unavailable and `REQUIRE_DB=0`.

### Operations & UI
- **Dashboard UI** (`src/ui/server.ts`) at `http://127.0.0.1:3000`.
- **Live loop** (`src/live/live_loop.ts`) for intraday monitor cycles.
- **Scripts** for DB checks, reconciliation, EOD close, strategy analytics, CSV export.

## Setup Guide

## 1) Prerequisites
- Node.js 20+
- PostgreSQL 16+
- Zerodha Kite Connect app (API key/secret)

## 2) Install
```bash
npm install
```

## 3) Configure env
```bash
cp .env.example .env
```
Set required values in `.env`:
- `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_ACCESS_TOKEN`
- `DATABASE_URL=postgres://algo_user:algo_pass@127.0.0.1:5432/algo_trading`

## 4) Initialize database
```bash
npm run db:init
npm run db:check
```

## 5) Generate/refresh Kite access token
```bash
npm run auth
```
Then login via:
`https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_KITE_API_KEY`

## 6) Start UI
```bash
npm run ui
```

## Core Commands
- `npm run morning`: daily workflow (`db:check -> reconcile -> demo -> db:report`)
- `npm run live`: intraday loop mode
- `npm run preflight`: validates live credentials/connectivity before order flow
- `npm run monitor`: single monitor pass
- `npm run entry`: single entry pass
- `npm run eod:close`: square off all open positions
- `npm run db:report`: show orders/fills/positions/stops/snapshots/state
- `npm run strategy:report`: win rate, avg R, drawdown, symbol stats
- `npm run strategy:rebalance`: writes `.env.recommended`
- `npm run weekly`: report + rebalance + CSV export

## Live Trading Safety
Use these env controls before enabling live orders:
- `LIVE_ORDER_MODE=1`
- `CONFIRM_LIVE_ORDERS=YES`
- `ALLOWED_SYMBOLS=...`
- `MAX_NOTIONAL_PER_ORDER=...`
- `HALT_TRADING=1` to pause entries immediately
- Optional Telegram alerts:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`

## Recommended Daily Runbook
1. Refresh token (`npm run auth`) before market open.
2. Run `npm run morning`.
3. Keep `npm run live` running during market hours.
4. Run `npm run eod:close` at close (if strategy requires flat positions).
5. Review with `npm run db:report`.

## Troubleshooting
- `TokenException`: key/token mismatch or expired token.
- `role "user" does not exist`: incorrect `DATABASE_URL` username.
- Frequent rejects: check broker RMS reason in logs, reduce `RISK_PER_TRADE`, tighten `ALLOWED_SYMBOLS`.
