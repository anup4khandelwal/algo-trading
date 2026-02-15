from __future__ import annotations

from fastapi import FastAPI, Query

from algo_trading_py.config import kite_config_from_env
from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
from algo_trading_py.pipeline import (
  preview_morning,
  run_eod_close,
  run_monitor,
  run_morning,
  run_preflight,
  run_reconcile,
)
from algo_trading_py.screener.service import ScreenerCriteria, default_symbols, run_screener

app = FastAPI(title="Algo Trading Python API", version="0.1.0")


@app.get("/api/health")
def health() -> dict[str, str]:
  return {"status": "ok"}


@app.get("/api/status")
def status() -> dict[str, object]:
  preflight = run_preflight()
  return {
    "runningJob": None,
    "liveMode": False,
    "safeMode": {"enabled": False},
    "lastPreflight": preflight,
  }


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
  return run_morning()


@app.post("/api/run/monitor")
def run_monitor_route() -> dict[str, object]:
  return run_monitor()


@app.post("/api/run/reconcile")
def run_reconcile_route() -> dict[str, object]:
  return run_reconcile()


@app.post("/api/run/eod")
def run_eod_route() -> dict[str, object]:
  return run_eod_close()


@app.post("/api/run/preflight")
def run_preflight_route() -> dict[str, object]:
  return run_preflight()
