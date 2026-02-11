# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains all TypeScript source.
- Core runtime flow is in `src/pipeline.ts` (entry, monitor, reconcile, EOD).
- Strategy/signal logic: `src/screener/`, `src/signal/`, `src/risk/`, `src/monitor/`.
- Broker/data adapters: `src/execution/`, `src/market_data/`.
- Persistence layer: `src/persistence/` (Postgres + no-op fallback).
- Operational scripts: `src/scripts/` (`db:*`, `strategy:*`, `trades:export`, `reconcile`, `eod:close`).
- UI server: `src/ui/server.ts`.
- Build output: `dist/` (generated; do not edit directly).

## Build, Test, and Development Commands
- `npm run build`: Compile TypeScript to `dist/`.
- `npm run ui`: Start dashboard server (`http://127.0.0.1:3000` by default).
- `npm run morning`: Standard daily workflow (`db:check -> reconcile -> demo -> db:report`).
- `npm run live`: Intraday loop mode (monitoring during market window).
- `npm run eod:close`: Square off all open positions.
- `npm run db:init` / `npm run db:check` / `npm run db:report`: DB setup, validation, reporting.
- `npm run strategy:report` / `npm run strategy:rebalance` / `npm run weekly`: analytics and tuning workflow.

## Coding Style & Naming Conventions
- Language: TypeScript (`strict` mode enabled).
- Use 2-space indentation, semicolons, and explicit types on public interfaces.
- File naming: `snake_case.ts` for modules (e.g., `strategy_report.ts`), PascalCase for classes.
- Keep side effects in scripts/adapters; keep strategy/risk modules deterministic and pure where possible.

## Testing Guidelines
- No test framework is configured yet. Validate changes via command-level checks:
  - `npm run build`
  - relevant runtime command (e.g., `npm run morning`, `npm run db:check`).
- For new features, add script-level verifiers and include expected output in PR notes.

## Commit & Pull Request Guidelines
- Git history is not available in this workspace; use this convention:
  - Commit format: `type(scope): summary` (e.g., `feat(pipeline): add eod close pass`).
- PRs should include:
  - purpose and risk impact,
  - env/config changes (`.env.example` updates),
  - commands run for validation,
  - screenshots for UI changes.

## Security & Configuration Tips
- Never commit `.env` or secrets.
- Live mode requires explicit safety flags: `LIVE_ORDER_MODE=1` and `CONFIRM_LIVE_ORDERS=YES`.
- Prefer `HALT_TRADING=1` during maintenance or uncertain broker/API state.
