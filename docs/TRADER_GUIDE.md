# Trader Guide (Detailed)

## Purpose
This guide explains how to run the platform safely as an amateur swing trader.

This system helps you:
- generate swing candidates,
- size entries using risk + available funds,
- place paper/live orders,
- monitor and manage open positions,
- track performance and process quality.

This is not financial advice. Use paper mode first.

## 1) System Overview
The platform has 3 layers:
1. Trading engine (`src/`): screener, signal builder, risk, execution, monitoring.
2. Persistence: Postgres stores orders, fills, positions, snapshots, alerts, drift and profile state.
3. Dashboard: React UI for daily operations (`npm run ui`).

Primary entrypoint for daily use: `http://127.0.0.1:3000`.

## 2) First-Time Setup
1. Install dependencies:
```bash
npm install
```
2. Create env file:
```bash
cp .env.example .env
```
3. Configure required values:
- `KITE_API_KEY`, `KITE_API_SECRET`
- `DATABASE_URL`
4. Initialize DB:
```bash
npm run db:init
npm run db:check
```
5. Build backend + UI:
```bash
npm run build
npm run ui:react:build
```
6. Start app:
```bash
npm run ui
```

## 3) Core Modes You Must Understand
1. Paper mode
- `LIVE_ORDER_MODE=0`
- Orders are simulated.
- Best for learning and strategy validation.

2. Live mode
- `LIVE_ORDER_MODE=1`
- `CONFIRM_LIVE_ORDERS=YES`
- Real broker orders are sent.

3. Safe Mode
- Blocks new morning entries.
- Used during incidents, setup, and profile switches.

4. Profile phases
- `phase1` (paper, conservative)
- `phase2` (small live risk)
- `phase3` (moderate live risk)
- Apply from UI card: **Risk Profile Automation**.

## 4) Daily Workflow (Market Day)
### A) Pre-market (08:30-09:05 IST)
1. Start UI (`npm run ui`).
2. Refresh token if required:
```bash
npm run auth
```
3. Keep Safe Mode ON.
4. Check **Pre-Open Checklist** card:
- DB health
- broker health
- token window
- funds snapshot
5. If checklist fails, do not run Morning.

### B) Market open to entry window
1. Disable Safe Mode.
2. Click **Morning** and review **Order Preview** modal.
3. Confirm only when preflight is PASS and eligible signals look valid.
3. Review:
- **Broker Orderbook** (rejections, hints)
- **Positions** and **Managed Stops**
- **System Health**

### C) Intraday monitoring
1. Scheduler can run monitor pass automatically.
2. Watch:
- **Rejection Guard**
- **Live vs Backtest Drift**
- **Ops Events**
3. Use **Position Exit Console** only when needed.

### D) End of day
1. If you need flat book, run **EOD**.
2. Check **Last EOD Summary**:
- orders/fills
- realized/unrealized PnL
- reject blocks
- drift alerts
- profile recommendation

## 5) Dashboard Features (Screen-by-Screen)
Top-level pages:
- `Dashboard`: live operations and analytics cards
- `Config (.env)`: runtime configuration editor
- `Screener`: custom symbol scan and Morning Preview handoff

## System Health
Shows broker/DB status, latency, token info, funds source and update time.
Use this first every day.

## Pre-Open Checklist
Hard gate for Morning run. Morning is blocked until all checks pass.

## Risk Profile Automation
Shows:
- active profile,
- recommended profile,
- score,
- reasons and blockers.

Buttons:
- `Apply Phase 1`
- `Apply Phase 2`
- `Apply Phase 3`

Profile switch behavior:
- updates `.env` from template,
- enables Safe Mode,
- stops scheduler,
- sends alert.

## Position Exit Console
Manual controls:
- partial exit by percent,
- full exit,
- stop update.

Use only as exception handling, not routine strategy override.

## Broker Protections (GTT)
- Live mode now attaches broker-native OCO protection after each BUY fill:
  - stop-loss trigger
  - target trigger
- If protection cannot be created, app exits that position immediately.
- Use dashboard card **Broker Protections (GTT)** to:
  - sync broker/local statuses
  - cancel an active protection for a symbol (manual override)
  - inspect exact broker error/retry logs in **Recent GTT Failures / Retry Logs**

## Broker Orderbook
Detailed broker order feed with diagnostics.
Filters:
- status,
- severity,
- search text.

Also supports CSV export.

## Strategy Analytics
Live closed-lot metrics:
- win rate,
- avg R,
- PnL,
- drawdown,
- symbol breakdown.

## Backtest Analytics
Latest backtest baseline and symbol metrics.
Use as benchmark, not guarantee.

## Strategy Lab
Runs controlled parameter sweeps on your historical data window and ranks candidates by:
- robustness score,
- stability score,
- guardrail pass/fail.

Workflow:
1. Click **Strategy Lab** in the action bar.
2. Wait for run completion.
3. Review top candidates and recommendation.
4. Click `Apply Cxx` only after review.

Apply behavior:
- updates strategy keys in `.env`,
- enables Safe Mode,
- stops scheduler.
Resume trading only after explicit verification.

## Weekly PDF Report
- Dashboard action bar has **Weekly PDF** button.
- It downloads a generated report with:
  - strategy metrics,
  - drift snapshot,
  - reject guard status,
  - profile recommendation,
  - top PnL attribution rows.

## Live vs Backtest Drift
Compares live behavior to backtest baseline.
Alert count > 0 means behavior divergence requires attention.

## Trade Journal
Capture setup quality and mistakes.
Review weekly for process improvement.

## Screener
Use Screener page to scan stocks by date range and criteria before market decisions.
- filters: trend, RSI range, volume ratio, ADV20, price band, RS score, breakout-only
- presets: `Trend Breakout`, `RSI Pullback`, `High Volume Momentum`
- actions:
  - run scan
  - export scan to CSV
  - select symbols and send to Morning Preview in one click

## Daily Equity + Funds Trend
Charts:
- equity curve,
- available cash vs usable equity.

## Rejection Guard
Auto-blocks symbols after repeated broker rejects.
Helps prevent repeated bad attempts.

## Ops Events
Recent critical/system events from alerts and reconcile runs.

## Last EOD Summary
Auto-generated EOD message persisted in `system_state.last_eod_summary`.

## 6) How Position Sizing Works
In live mode:
1. App fetches broker available cash.
2. Computes:
`usableEquity = availableCash * FUND_USAGE_PCT`
3. Signals are sized from usable equity + risk-per-trade.
4. Optional floor: `MIN_CAPITAL_DEPLOY_PCT` increases qty when risk sizing is too small for your preference.
5. During one run, app tracks remaining usable funds and skips unaffordable entries.

This reduces over-allocation risk.

## 7) Recommended Beginner Controls
Start with conservative values:
- `FUND_USAGE_PCT=0.60-0.80`
- `RISK_PER_TRADE=0.003-0.005`
- `MIN_CAPITAL_DEPLOY_PCT=0.08-0.15` (optional floor for minimum deployment per trade)
- `MAX_OPEN_POSITIONS=2-3`
- `MAX_ORDERS_PER_DAY=3-4`
- `ALLOWED_SYMBOLS` limited basket
- `REQUIRE_DB=1`

Always keep:
- `REJECT_GUARD_THRESHOLD=2`
- Safe Mode available.

## 8) Automation Features
1. Scheduler-based runs
- premarket,
- monitor interval,
- eod,
- weekly backtest slot,
- weekly Strategy Lab slot.

2. Token expiry alerts
- configurable by `TOKEN_EXPIRY_ALERT_MINUTES`.

3. Pre-open gate
- prevents accidental morning execution when unhealthy.

4. EOD summary automation
- auto-generated after EOD run,
- includes recommendation context.

## 9) Incident Handling
If something looks wrong:
1. Enable Safe Mode immediately.
2. Stop scheduler.
3. Check System Health and Ops Events.
4. Run preflight/checklist again.
5. Only resume when root cause is clear.

Common cases:
- Token errors: refresh via `npm run auth`.
- DB down: restore DB before live operations.
- Repeated rejects: reduce size, review product/symbol/RMS constraints.

## 10) Weekly Review Routine
1. Run backtest and compare drift.
2. Review strategy and journal analytics.
3. Check rejection guard patterns.
4. Decide profile changes based on score + manual judgment.

Avoid frequent parameter changes. Change one variable at a time and observe.

## 11) Command Reference
```bash
npm run ui                 # unified app (serves React build if present)
npm run ui:api             # API server on 3001
npm run ui:react           # React dev server on 5173
npm run ui:react:build     # build React dashboard
npm run build              # backend TypeScript build
npm run auth               # token workflow
npm run preflight          # broker/session validation
npm run monitor            # one monitor pass
npm run eod:close          # close positions
npm run db:report          # DB state snapshot
npm run backtest           # backtest + persistence
```

## 12) Progression Plan
1. Phase 1 (paper): 30 days discipline + stable ops.
2. Phase 2 (small live): low risk, controlled exposure.
3. Phase 3 (moderate live): only after stable expectancy and low ops noise.

Do not scale up after one good week. Use rolling 20-40 trade evidence.
