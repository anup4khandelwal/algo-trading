from __future__ import annotations

import json

import typer

from algo_trading_py.auth.server import kite_login_url
from algo_trading_py.backtest.engine import BacktestConfig, run_backtest
from algo_trading_py.config import kite_config_from_env
from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
from algo_trading_py.live.live_loop import run_live_loop
from algo_trading_py.pipeline import preview_morning, run_eod_close, run_entry, run_monitor, run_morning, run_preflight, run_reconcile
from algo_trading_py.screener.service import ScreenerCriteria, default_symbols, run_screener

app = typer.Typer(help="Python migration CLI for algo-trading")


@app.command()
def screener(
  from_date: str = typer.Option(..., "--from-date"),
  to_date: str = typer.Option(..., "--to-date"),
  symbols: str = typer.Option("", "--symbols", help="CSV list. Empty uses default universe."),
) -> None:
  cfg = kite_config_from_env()
  provider = KiteHistoricalProvider(cfg.api_key, cfg.access_token, cfg.base_url)
  symbol_list = [x.strip().upper() for x in symbols.split(",") if x.strip()] if symbols else default_symbols()
  rows = run_screener(
    provider,
    ScreenerCriteria(from_date=from_date, to_date=to_date, symbols=symbol_list),
  )
  typer.echo(json.dumps([row.__dict__ for row in rows], indent=2))


@app.command()
def backtest(
  from_date: str = typer.Option(..., "--from-date"),
  to_date: str = typer.Option(..., "--to-date"),
  symbols: str = typer.Option("RELIANCE,TCS,INFY", "--symbols", help="CSV list."),
) -> None:
  cfg = kite_config_from_env()
  provider = KiteHistoricalProvider(cfg.api_key, cfg.access_token, cfg.base_url)
  symbol_list = [x.strip().upper() for x in symbols.split(",") if x.strip()]
  result = run_backtest(
    provider,
    BacktestConfig(from_date=from_date, to_date=to_date, symbols=symbol_list),
  )
  typer.echo(json.dumps(result.__dict__, indent=2))


@app.command()
def morning() -> None:
  typer.echo(json.dumps(run_morning(), indent=2))


@app.command("morning-preview")
def morning_preview(symbols: str = typer.Option("", "--symbols", help="Optional CSV list")) -> None:
  parsed = [x.strip().upper() for x in symbols.split(",") if x.strip()] if symbols else None
  typer.echo(json.dumps(preview_morning(parsed), indent=2))


@app.command()
def reconcile() -> None:
  typer.echo(json.dumps(run_reconcile(), indent=2))


@app.command("eod-close")
def eod_close() -> None:
  typer.echo(json.dumps(run_eod_close(), indent=2))


@app.command()
def monitor() -> None:
  typer.echo(json.dumps(run_monitor(), indent=2))


@app.command()
def preflight() -> None:
  typer.echo(json.dumps(run_preflight(), indent=2))


@app.command()
def entry(symbols: str = typer.Option("", "--symbols", help="Optional CSV list")) -> None:
  parsed = [x.strip().upper() for x in symbols.split(",") if x.strip()] if symbols else None
  typer.echo(json.dumps(run_entry(parsed), indent=2))


@app.command("live-loop")
def live_loop(
  interval_seconds: int = typer.Option(120, "--interval-seconds"),
  entry_on_start: bool = typer.Option(True, "--entry-on-start/--no-entry-on-start"),
) -> None:
  typer.echo(json.dumps(run_live_loop(interval_seconds=interval_seconds, run_entry_on_start=entry_on_start), indent=2))


@app.command("auth-url")
def auth_url() -> None:
  typer.echo(kite_login_url())
