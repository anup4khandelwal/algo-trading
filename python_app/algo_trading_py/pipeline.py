from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from dotenv import load_dotenv

from algo_trading_py.config import kite_config_from_env
from algo_trading_py.execution.paper import PaperExecutionAdapter
from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
from algo_trading_py.monitor.position_monitor import PositionMonitor
from algo_trading_py.persistence.base import NoopPersistence, Persistence
from algo_trading_py.persistence.postgres import PostgresPersistence
from algo_trading_py.risk.engine import RiskEngine
from algo_trading_py.screener.service import ScreenerCriteria, default_symbols, run_screener
from algo_trading_py.signal.builder import SignalBuilder, SignalBuilderConfig
from algo_trading_py.storage.store import InMemoryStore
from algo_trading_py.types import Position, RiskLimits


@dataclass(slots=True)
class Runtime:
  store: InMemoryStore
  persistence: Persistence
  provider: KiteHistoricalProvider
  risk: RiskEngine
  signal_builder: SignalBuilder
  execution: PaperExecutionAdapter
  monitor: PositionMonitor


def _today() -> str:
  return datetime.now(UTC).date().isoformat()


def _offset(days: int) -> str:
  return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


def create_runtime() -> Runtime:
  load_dotenv()
  cfg = kite_config_from_env()
  provider = KiteHistoricalProvider(cfg.api_key, cfg.access_token, cfg.base_url)
  db_url = os.getenv("DATABASE_URL", "").strip()
  persistence: Persistence = PostgresPersistence(db_url) if db_url else NoopPersistence()
  persistence.init()
  store = InMemoryStore()
  for p in persistence.load_positions():
    store.positions[p.symbol] = p
  limits = RiskLimits(
    max_daily_loss=float(os.getenv("MAX_DAILY_LOSS", "25000")),
    max_open_positions=int(os.getenv("MAX_OPEN_POSITIONS", "5")),
    max_orders_per_day=int(os.getenv("MAX_ORDERS_PER_DAY", "10")),
    max_exposure_per_symbol=float(os.getenv("MAX_EXPOSURE_PER_SYMBOL", "250000")),
    risk_per_trade=float(os.getenv("RISK_PER_TRADE", "0.015")),
  )
  risk = RiskEngine(store, limits)
  signal_builder = SignalBuilder(
    SignalBuilderConfig(
      min_rsi=float(os.getenv("STRATEGY_MIN_RSI", "55")),
      breakout_buffer_pct=float(os.getenv("STRATEGY_BREAKOUT_BUFFER_PCT", "0.02")),
      atr_stop_multiple=float(os.getenv("ATR_STOP_MULTIPLE", "2")),
      risk_per_trade=float(os.getenv("RISK_PER_TRADE", "0.015")),
      min_capital_deploy_pct=float(os.getenv("MIN_CAPITAL_DEPLOY_PCT", "0")),
      min_adv20=float(os.getenv("STRATEGY_MIN_ADV20", "100000000")),
      min_volume_ratio=float(os.getenv("STRATEGY_MIN_VOLUME_RATIO", "1.2")),
      max_signals=int(os.getenv("STRATEGY_MAX_SIGNALS", "5")),
    )
  )
  return Runtime(
    store=store,
    persistence=persistence,
    provider=provider,
    risk=risk,
    signal_builder=signal_builder,
    execution=PaperExecutionAdapter(),
    monitor=PositionMonitor(
      store=store,
      persistence=persistence,
      provider=provider,
      trailing_atr_multiple=float(os.getenv("TRAILING_ATR_MULTIPLE", "2")),
    ),
  )


def run_preflight() -> dict[str, object]:
  load_dotenv()
  api_key = os.getenv("KITE_API_KEY", "").strip()
  access_token = os.getenv("KITE_ACCESS_TOKEN", "").strip()
  db_ok = bool(os.getenv("DATABASE_URL", "").strip())
  if not api_key or not access_token:
    return {"ok": False, "message": "Missing Kite credentials", "dbConfigured": db_ok}
  return {"ok": True, "message": "Preflight passed", "dbConfigured": db_ok}


def preview_morning(symbols: list[str] | None = None) -> dict[str, object]:
  rt = create_runtime()
  criteria = ScreenerCriteria(
    from_date=_offset(30),
    to_date=_today(),
    symbols=symbols if symbols else default_symbols(),
    trend="up",
  )
  rows = run_screener(rt.provider, criteria)
  signals = rt.signal_builder.build_signals(rows, rt.store.equity)
  preview_rows: list[dict[str, object]] = []
  for s in signals:
    check = rt.risk.pre_trade_check(s)
    notional = s.qty * s.entry_price
    preview_rows.append(
      {
        "symbol": s.symbol,
        "side": s.side,
        "qty": s.qty,
        "entryPrice": s.entry_price,
        "stopPrice": s.stop_price,
        "targetPrice": s.target_price,
        "notional": notional,
        "rankScore": s.rank_score,
        "status": "eligible" if check.ok else "skip",
        "reason": "ok" if check.ok else check.reason,
      }
    )
  return {
    "generatedAt": datetime.now(UTC).isoformat(),
    "symbolsFilter": symbols or [],
    "funds": {"usableEquity": rt.store.equity},
    "summary": {
      "totalSignals": len(preview_rows),
      "eligible": len([x for x in preview_rows if x["status"] == "eligible"]),
      "skipped": len([x for x in preview_rows if x["status"] == "skip"]),
    },
    "rows": preview_rows,
  }


def run_morning() -> dict[str, object]:
  rt = create_runtime()
  criteria = ScreenerCriteria(
    from_date=_offset(30),
    to_date=_today(),
    symbols=default_symbols(),
    trend="up",
  )
  rows = run_screener(rt.provider, criteria)
  signals = rt.signal_builder.build_signals(rows, rt.store.equity)
  placed = 0
  skipped: list[dict[str, str]] = []
  for s in signals:
    check = rt.risk.pre_trade_check(s)
    if not check.ok:
      skipped.append({"symbol": s.symbol, "reason": check.reason})
      continue
    order, fill = rt.execution.place_signal(s)
    rt.risk.register_order()
    rt.persistence.upsert_order(order)
    rt.persistence.insert_fill(fill)
    current = rt.store.positions.get(fill.symbol)
    signed_qty = fill.qty if fill.side == "BUY" else -fill.qty
    if current is None:
      next_pos = Position(symbol=fill.symbol, qty=signed_qty, avg_price=fill.price)
      rt.store.positions[fill.symbol] = next_pos
      rt.persistence.upsert_position(next_pos)
    else:
      new_qty = current.qty + signed_qty
      if new_qty <= 0:
        rt.store.positions.pop(fill.symbol, None)
        rt.persistence.delete_position(fill.symbol)
      else:
        total_cost = current.avg_price * current.qty + fill.price * signed_qty
        next_pos = Position(symbol=fill.symbol, qty=new_qty, avg_price=total_cost / new_qty)
        rt.store.positions[fill.symbol] = next_pos
        rt.persistence.upsert_position(next_pos)
    placed += 1
  rt.persistence.upsert_daily_snapshot(
    trade_date=_today(),
    equity=rt.store.equity,
    realized_pnl=rt.store.realized_pnl,
    unrealized_pnl=0.0,
    open_positions=len(rt.store.positions),
    note="morning",
  )
  rt.persistence.upsert_system_state(
    "last_morning_run",
    json.dumps({"at": datetime.now(UTC).isoformat(), "placed": placed, "skipped": skipped}),
  )
  return {"ok": True, "placed": placed, "skipped": skipped, "positions": len(rt.store.positions)}


def run_monitor() -> dict[str, object]:
  rt = create_runtime()
  rt.monitor.hydrate()
  rt.monitor.reconcile_with_positions()
  actions = rt.monitor.evaluate_and_act()
  rt.persistence.upsert_daily_snapshot(
    trade_date=_today(),
    equity=rt.store.equity,
    realized_pnl=rt.store.realized_pnl,
    unrealized_pnl=0.0,
    open_positions=len(rt.store.positions),
    note="monitor",
  )
  rt.persistence.upsert_system_state(
    "last_monitor_run",
    json.dumps({"at": datetime.now(UTC).isoformat(), "actions": actions}),
  )
  return {"ok": True, "actions": actions, "positions": len(rt.store.positions)}


def run_reconcile() -> dict[str, object]:
  rt = create_runtime()
  rt.persistence.upsert_system_state("last_reconcile_run", datetime.now(UTC).isoformat())
  rt.persistence.upsert_daily_snapshot(
    trade_date=_today(),
    equity=rt.store.equity,
    realized_pnl=rt.store.realized_pnl,
    unrealized_pnl=0.0,
    open_positions=len(rt.store.positions),
    note="reconcile",
  )
  return {"ok": True, "positions": len(rt.store.positions)}


def run_eod_close() -> dict[str, object]:
  rt = create_runtime()
  closed = 0
  for symbol in list(rt.store.positions.keys()):
    rt.persistence.delete_position(symbol)
    rt.store.positions.pop(symbol, None)
    closed += 1
  rt.persistence.upsert_daily_snapshot(
    trade_date=_today(),
    equity=rt.store.equity,
    realized_pnl=rt.store.realized_pnl,
    unrealized_pnl=0.0,
    open_positions=0,
    note="eod_close",
  )
  rt.persistence.upsert_system_state(
    "last_eod_close_run",
    json.dumps({"at": datetime.now(UTC).isoformat(), "closedPositions": closed}),
  )
  return {"ok": True, "closedPositions": closed}
