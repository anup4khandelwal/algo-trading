from __future__ import annotations

import json

import typer

from algo_trading_py.backtest.engine import BacktestConfig, run_backtest
from algo_trading_py.config import kite_config_from_env
from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
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
