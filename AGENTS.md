# Repository Guidelines

## Project Structure & Module Organization
- Active Python runtime is under `python_app/algo_trading_py/`.
- Core runtime flow is in `python_app/algo_trading_py/pipeline.py` (entry, morning, monitor, reconcile, EOD).
- Strategy/signal logic: `python_app/algo_trading_py/screener/`, `python_app/algo_trading_py/signal/`, `python_app/algo_trading_py/risk/`, `python_app/algo_trading_py/monitor/`.
- Broker/data adapters: `python_app/algo_trading_py/execution/`, `python_app/algo_trading_py/market_data/`.
- Persistence layer: `python_app/algo_trading_py/persistence/`.
- API server: `python_app/algo_trading_py/api/server.py`.
- CLI entrypoint: `python_app/algo_trading_py/cli.py`.
- Legacy TypeScript source remains in `src/` for reference only on this branch.

## Build, Test, and Development Commands
- Setup:
  - `cd python_app && python3 -m venv .venv && source .venv/bin/activate && pip install -e .`
- API server:
  - `cd python_app && uvicorn algo_trading_py.api.server:app --reload --port 8000`
- Runtime commands:
  - `cd python_app && algo-trading-py preflight`
  - `cd python_app && algo-trading-py morning`
  - `cd python_app && algo-trading-py entry`
  - `cd python_app && algo-trading-py monitor`
  - `cd python_app && algo-trading-py reconcile`
  - `cd python_app && algo-trading-py eod-close`
  - `cd python_app && algo-trading-py live-loop --interval-seconds 120`
- Research commands:
  - `cd python_app && algo-trading-py screener --from-date 2026-02-01 --to-date 2026-02-15 --symbols INFY,TCS`
  - `cd python_app && algo-trading-py backtest --from-date 2026-01-01 --to-date 2026-02-15 --symbols INFY,TCS,RELIANCE`

## Coding Style & Naming Conventions
- Language: Python 3.11+.
- Use 2-space indentation only where existing files already do; otherwise follow standard 4-space Python indentation.
- Add type hints for public functions and dataclasses.
- File naming: `snake_case.py`; classes use PascalCase.
- Keep strategy/risk modules deterministic and side-effect free where possible.

## Testing Guidelines
- No test framework is configured yet. Validate changes via command-level checks:
  - `python3 -m compileall python_app/algo_trading_py`
  - relevant runtime command (e.g., `cd python_app && algo-trading-py morning`).
- For new features, add script-level verifiers and include expected output in PR notes.

## Commit & Pull Request Guidelines
- Git history is not available in this workspace; use this convention:
  - Commit format: `type(scope): summary` (e.g., `feat(python): add eod close pass`).
- PRs should include:
  - purpose and risk impact,
  - env/config changes (`.env.example` updates),
  - commands run for validation,
  - screenshots for UI changes.

## Security & Configuration Tips
- Never commit `.env` or secrets.
- Live mode requires explicit safety flags: `LIVE_ORDER_MODE=1` and `CONFIRM_LIVE_ORDERS=YES`.
- Prefer `HALT_TRADING=1` during maintenance or uncertain broker/API state.
