from __future__ import annotations

import os
from threading import Lock, Thread

from fastapi import FastAPI, Query

from algo_trading_py.config import kite_config_from_env
from algo_trading_py.live.live_loop import run_live_loop
from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
from algo_trading_py.ops.scheduler import TradingScheduler
from algo_trading_py.pipeline import (
  preview_morning,
  run_eod_close,
  run_entry,
  run_monitor,
  run_morning,
  run_preflight,
  run_reconcile,
)
from algo_trading_py.screener.service import ScreenerCriteria, default_symbols, run_screener

app = FastAPI(title="Algo Trading Python API", version="0.1.0")
_job_lock = Lock()
_running_job: str | None = None


def _with_job(name: str, fn):
  global _running_job
  with _job_lock:
    if _running_job is not None:
      return {"ok": False, "error": f"Job already running: {_running_job}"}
    _running_job = name
  try:
    return fn()
  finally:
    with _job_lock:
      _running_job = None


_scheduler = TradingScheduler(
  run_morning=lambda: run_morning(),
  run_monitor=lambda: run_monitor(),
  run_eod_close=lambda: run_eod_close(),
  run_backtest=lambda: None,
  run_strategy_lab=lambda: None,
  can_run=lambda: _running_job is None,
  tick_seconds=int(os.getenv("SCHEDULER_TICK_SECONDS", "20")),
  monitor_interval_seconds=int(os.getenv("SCHEDULER_MONITOR_INTERVAL_SECONDS", "300")),
  premarket_at=os.getenv("SCHEDULER_PREMARKET_AT", "08:55"),
  eod_at=os.getenv("SCHEDULER_EOD_AT", "15:31"),
  backtest_at=os.getenv("SCHEDULER_BACKTEST_AT", "10:30"),
  backtest_weekday=os.getenv("SCHEDULER_BACKTEST_WEEKDAY", "Sat"),
  strategy_lab_at=os.getenv("SCHEDULER_STRATLAB_AT", "11:00"),
  strategy_lab_weekday=os.getenv("SCHEDULER_STRATLAB_WEEKDAY", "Sat"),
)


@app.get("/api/health")
def health() -> dict[str, str]:
  return {"status": "ok"}


@app.get("/api/status")
def status() -> dict[str, object]:
  preflight = run_preflight()
  live_mode = os.getenv("LIVE_ORDER_MODE", "0") == "1"
  return {
    "runningJob": _running_job,
    "liveMode": live_mode,
    "safeMode": {"enabled": False},
    "lastPreflight": preflight,
    "scheduler": _scheduler.get_state(),
  }


@app.get("/api/scheduler")
def scheduler_state() -> dict[str, object]:
  return {"runningJob": _running_job, "scheduler": _scheduler.get_state()}


@app.get("/api/screener")
def screener(
  from_date: str = Query(..., alias="from"),
  to_date: str = Query(..., alias="to"),
  symbols: str | None = None,
  trend: str = "up",
  rsi_min: float = Query(50, alias="rsiMin"),
  rsi_max: float = Query(80, alias="rsiMax"),
  min_volume_ratio: float = Query(1.1, alias="minVolumeRatio"),
  min_adv20: float = Query(50_000_000, alias="minAdv20"),
  min_price: float = Query(50, alias="minPrice"),
  max_price: float = Query(10_000, alias="maxPrice"),
  min_rs_score: float = Query(-0.5, alias="minRsScore"),
  breakout_only: bool = Query(False, alias="breakoutOnly"),
  sort_by: str = Query("rs", alias="sortBy"),
  max_results: int = Query(50, alias="maxResults"),
) -> dict[str, object]:
  cfg = kite_config_from_env()
  provider = KiteHistoricalProvider(cfg.api_key, cfg.access_token, cfg.base_url)
  symbol_list = [x.strip().upper() for x in symbols.split(",")] if symbols else default_symbols()
  criteria = ScreenerCriteria(
    from_date=from_date,
    to_date=to_date,
    symbols=[x for x in symbol_list if x],
    trend=trend if trend in {"up", "down", "any"} else "any",
    rsi_min=rsi_min,
    rsi_max=rsi_max,
    min_volume_ratio=min_volume_ratio,
    min_adv20=min_adv20,
    min_price=min_price,
    max_price=max_price,
    min_rs_score=min_rs_score,
    breakout_only=breakout_only,
    sort_by=sort_by if sort_by in {"rs", "rsi", "volume", "price"} else "rs",
    max_results=max_results,
  )
  rows = run_screener(provider, criteria)
  return {
    "enabled": True,
    "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    "range": {"from": from_date, "to": to_date},
    "criteria": {
      "trend": criteria.trend,
      "rsiMin": criteria.rsi_min,
      "rsiMax": criteria.rsi_max,
      "minVolumeRatio": criteria.min_volume_ratio,
      "minAdv20": criteria.min_adv20,
      "minPrice": criteria.min_price,
      "maxPrice": criteria.max_price,
      "minRsScore": criteria.min_rs_score,
      "breakoutOnly": criteria.breakout_only,
      "sortBy": criteria.sort_by,
      "maxResults": criteria.max_results,
    },
    "universe": {"requested": len(criteria.symbols), "eligible": len(rows)},
    "rows": [
      {
        "symbol": r.symbol,
        "asOf": r.as_of,
        "close": r.close,
        "ema20": r.ema20,
        "ema50": r.ema50,
        "rsi14": r.rsi14,
        "atr14": r.atr14,
        "high20": r.high20,
        "volumeRatio": r.volume_ratio,
        "adv20": r.adv20,
        "rsScore60d": r.rs_score_60d,
        "trend": r.trend,
      }
      for r in rows
    ],
  }


@app.get("/api/morning/preview")
def morning_preview(symbols: str | None = None) -> dict[str, object]:
  parsed = [x.strip().upper() for x in symbols.split(",")] if symbols else None
  parsed = [x for x in (parsed or []) if x]
  return preview_morning(parsed if parsed else None)


@app.post("/api/run/morning")
def run_morning_route() -> dict[str, object]:
  return _with_job("morning", run_morning)


@app.post("/api/run/monitor")
def run_monitor_route() -> dict[str, object]:
  return _with_job("monitor", run_monitor)


@app.post("/api/run/reconcile")
def run_reconcile_route() -> dict[str, object]:
  return _with_job("reconcile", run_reconcile)


@app.post("/api/run/eod")
def run_eod_route() -> dict[str, object]:
  return _with_job("eod", run_eod_close)


@app.post("/api/run/preflight")
def run_preflight_route() -> dict[str, object]:
  return _with_job("preflight", run_preflight)


@app.post("/api/run/entry")
def run_entry_route() -> dict[str, object]:
  return _with_job("entry", run_entry)


@app.post("/api/run/live-loop")
def run_live_loop_route(
  interval_seconds: int = Query(120, alias="intervalSeconds"),
  entry_on_start: bool = Query(True, alias="entryOnStart"),
) -> dict[str, object]:
  def runner():
    run_live_loop(interval_seconds=interval_seconds, run_entry_on_start=entry_on_start)

  thread = Thread(target=lambda: _with_job("live_loop", runner), daemon=True)
  thread.start()
  return {"ok": True, "accepted": True, "job": "live_loop"}


@app.post("/api/scheduler/start")
def scheduler_start() -> dict[str, object]:
  _scheduler.start()
  return {"ok": True, "scheduler": _scheduler.get_state()}


@app.post("/api/scheduler/stop")
def scheduler_stop() -> dict[str, object]:
  _scheduler.stop()
  return {"ok": True, "scheduler": _scheduler.get_state()}
