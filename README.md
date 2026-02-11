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

## Modern React Dashboard
Run API + React UI in two terminals:
```bash
# terminal 1 (API)
npm run ui:api

# terminal 2 (React dashboard)
npm run ui:react
```
Open: `http://127.0.0.1:5173`

To serve React from the same API server (`http://127.0.0.1:3000`), build it once:
```bash
npm run ui:react:build
npm run ui
```
When `dashboard/dist/index.html` exists, `npm run ui` serves React UI by default.

## Profile Automation (Phase 1 / 2 / 3)
- Profile templates are stored in:
  - `profiles/phase1.env`
  - `profiles/phase2.env`
  - `profiles/phase3.env`
- React dashboard includes **Risk Profile Automation** card:
  - shows active profile, recommended profile, score, reasons, blockers
  - one-click apply profile buttons (Phase 1/2/3)
  - switching profile auto-enables Safe Mode and stops scheduler
- profile templates ship with:
  - `SCHEDULER_ENABLED=1`
  - `HALT_TRADING=1` (safe by default pre-open)
- API endpoints:
  - `GET /api/profile/status`
  - `GET /api/profile/recommendation`
  - `POST /api/profile/switch` with `{ profile, reason }`

## Daily Automation Safety Additions
- **Pre-open checklist gate** blocks Morning run unless checks pass:
  - DB health
  - broker connectivity
  - token validity window
  - funds snapshot availability
- API: `GET /api/preopen-check`
- **Token expiry risk alert** sends Telegram warning when token time-left drops below:
  - `TOKEN_EXPIRY_ALERT_MINUTES` (default `120`)
- **Auto EOD summary** generated after EOD job:
  - includes orders/fills, PnL snapshot, reject blocks, drift alerts, profile recommendation
  - persisted in `system_state.last_eod_summary`
  - API: `GET /api/eod-summary`

## Core Commands
- `npm run morning`: daily workflow (`db:check -> reconcile -> demo -> db:report`)
- `npm run live`: intraday loop mode
- `npm run preflight`: validates live credentials/connectivity before order flow
- `npm run live:check`: hard pre-live checklist (env safety, DB schema, market-hours policy, broker token)
- `npm run monitor`: single monitor pass
- `npm run entry`: single entry pass
- `npm run eod:close`: square off all open positions
- `npm run db:report`: show orders/fills/positions/stops/snapshots/state
- `npm run strategy:report`: win rate, avg R, drawdown, symbol stats
- `npm run strategy:rebalance`: writes `.env.recommended`
- `npm run backtest`: historical replay backtest + metrics + JSON export + DB snapshot
- `npm run journal:export`: exports joined closed-trade + journal tags CSV
- `npm run weekly`: report + rebalance + CSV export

## Live Trading Safety
Use these env controls before enabling live orders:
- `LIVE_ORDER_MODE=1`
- `CONFIRM_LIVE_ORDERS=YES`
- `ALLOWED_SYMBOLS=...`
- `MAX_NOTIONAL_PER_ORDER=...`
- `STARTING_EQUITY=1000000` (paper-mode base equity)
- `FUND_USAGE_PCT=0.95` (live: usable equity = available broker cash * this factor)
- `KITE_ORDER_VARIETY=regular|amo`
- `KITE_ENABLE_AMO_FALLBACK=1` (auto-retry AMO if broker returns `switch_to_amo`)
- `HALT_TRADING=1` to pause entries immediately
- `REJECT_GUARD_THRESHOLD=2` (auto-block symbol for the day after repeated broker rejects)
- Optional Telegram alerts:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
- `LIVE_CHECK_MARKET_POLICY=warn|strict` (`strict` fails checklist outside 09:15-15:30 IST)

## Backtest
Set optional env (or keep defaults):
- `BACKTEST_FROM=2025-01-01`
- `BACKTEST_TO=2026-01-31`
- `BACKTEST_SYMBOLS=RELIANCE,TCS,INFY`

Run:
```bash
npm run backtest
```
Results:
- latest run persisted in `backtest_runs` table
- JSON export at `exports/backtest-latest.json` (configurable via `BACKTEST_EXPORT_PATH`)
- UI shows latest backtest in **Backtest Analytics**.

## Trade Journal
- UI section **Trade Journal** lets you tag closed lots with:
  - `setupTag`, `confidence (1-5)`, `mistakeTag`, notes, screenshot URL
- Analytics shown in UI:
  - expectancy by setup
  - win rate by weekday
  - average hold days
  - top mistakes
- Export with:
```bash
npm run journal:export
```

## UI Scheduler Automation
From UI (`http://127.0.0.1:3000`) you can:
- `Start Scheduler` / `Stop Scheduler`
- run `Morning`, `Monitor`, `EOD Close`, and `Backtest` directly

Scheduler env (optional):
- `SCHEDULER_ENABLED=1` to auto-start with UI server
- `SCHEDULER_PREMARKET_AT=08:55`
- `SCHEDULER_MONITOR_INTERVAL_SECONDS=300`
- `SCHEDULER_EOD_AT=15:31`
- `SCHEDULER_BACKTEST_WEEKDAY=Sat`
- `SCHEDULER_BACKTEST_AT=10:30`

## Live Health Panel
UI now includes **Live Health** with:
- DB heartbeat + latency
- broker preflight heartbeat + latency (in live mode)
- Kite token time-left estimate (after token generation)
- scheduler on/off snapshot
- recent error timeline (runtime, scheduler, critical alerts)

Token countdown notes:
- `npm run auth` now updates both `KITE_ACCESS_TOKEN` and `KITE_ACCESS_TOKEN_CREATED_AT`
- expiry shown is an estimate using IST reset window:
  - `KITE_TOKEN_RESET_HOUR_IST` (default `6`)
- `KITE_TOKEN_RESET_MINUTE_IST` (default `0`)

## Live vs Backtest Drift
UI includes a **Live vs Backtest Drift** panel:
- compares live closed-trade performance to latest backtest baseline
- shows drift in `win rate`, `avg R`, and `expectancy`
- symbol-level drift table with alert flags

Thresholds:
- `DRIFT_WINRATE_ALERT_PCT` (default `12`)
- `DRIFT_AVGR_ALERT` (default `0.5`)

## Broker Orderbook UI
Dashboard includes **Broker Orderbook** (today scope):
- live broker orders with `status`, `reason`, and action hints
- advanced filters: `status`, `severity`, text search
- manual refresh button
- CSV export button
- server-side cache for API protection (`BROKER_ORDERS_CACHE_MS`, default `30000`)

## Manual Position Controls
UI includes **Position Exit Console**:
- exit partial position by percent
- exit full position
- update managed stop price

## Safe Mode + Rejection Guard
- Safe Mode (UI toggle) blocks morning entries and scheduler-start until disabled.
- Safe Mode state is persisted in `system_state` and alert is sent via Telegram (if configured).
- Rejection guard persists per-day reject counts and blocked symbols in `system_state` (`reject_guard_YYYY-MM-DD`).

## Daily PnL + Exposure
UI includes:
- daily line chart from `daily_snapshots` for equity, realized PnL, unrealized PnL
- current symbol exposure bars from open positions

## Fund-Based Position Sizing
- In live mode, app fetches broker funds (`/user/margins/equity`) and computes usable equity:
  - `usableEquity = availableCash * FUND_USAGE_PCT`
- Signal sizing and order placement use this usable equity.
- During one run, app tracks remaining usable funds and skips entries that exceed remaining budget.
- React dashboard shows:
  - current `available cash` vs `usable equity`
  - funds trend line chart from persisted `funds_history`

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
