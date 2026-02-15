from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
from algo_trading_py.types import ScreenerRow
from algo_trading_py.utils.indicators import atr, ema, pct_change, rsi, sma


@dataclass(slots=True)
class ScreenerCriteria:
  from_date: str
  to_date: str
  symbols: list[str]
  trend: Literal["up", "down", "any"] = "up"
  rsi_min: float = 50
  rsi_max: float = 80
  min_volume_ratio: float = 1.1
  min_adv20: float = 50_000_000
  min_price: float = 50
  max_price: float = 10_000
  min_rs_score: float = -0.5
  breakout_only: bool = False
  sort_by: Literal["rs", "rsi", "volume", "price"] = "rs"
  max_results: int = 50


def default_symbols() -> list[str]:
  return [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "LT", "AXISBANK", "KOTAKBANK", "ITC",
    "BHARTIARTL", "HCLTECH", "TATAMOTORS", "TATASTEEL", "MARUTI", "SUNPHARMA", "ULTRACEMCO", "NTPC",
    "POWERGRID", "ADANIPORTS", "BAJFINANCE", "WIPRO", "M&M", "TECHM", "INDUSINDBK", "BEL", "TRENT", "PFC",
    "RECLTD", "ZOMATO",
  ]


def run_screener(provider: KiteHistoricalProvider, criteria: ScreenerCriteria) -> list[ScreenerRow]:
  instruments = provider.get_instruments("NSE")
  benchmark = _load_nifty_benchmark(provider, instruments, _offset_from(criteria.from_date, 180), criteria.to_date)
  rows: list[ScreenerRow] = []
  for symbol in criteria.symbols:
    inst = instruments.get(symbol)
    if not inst:
      continue
    if inst.exchange != "NSE" or inst.segment != "NSE" or inst.instrument_type != "EQ":
      continue
    bars = provider.get_historical_day_bars(inst.instrument_token, _offset_from(criteria.from_date, 180), criteria.to_date)
    bars = sorted([b for b in bars if b.close and b.volume], key=lambda b: b.time)
    in_range = [b for b in bars if criteria.from_date <= b.time[:10] <= criteria.to_date]
    if not in_range or len(bars) < 80:
      continue
    latest = in_range[-1]
    latest_idx = next((i for i, b in enumerate(bars) if b.time == latest.time), -1)
    if latest_idx < 61:
      continue
    slice_bars = bars[: latest_idx + 1]
    closes = [b.close for b in slice_bars]
    highs = [b.high for b in slice_bars]
    lows = [b.low for b in slice_bars]
    volumes = [b.volume for b in slice_bars]
    close = closes[-1]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    rsi14 = rsi(closes, 14)
    atr14 = atr(highs, lows, closes, 14)
    high20 = max(highs[-20:])
    vol_ratio = sma(volumes[-20:]) / max(1, sma(volumes[-50:]))
    adv20 = sma([x * y for x, y in zip(closes[-20:], volumes[-20:], strict=True)])
    rs_60 = pct_change(closes[-61], close) - benchmark
    trend = "up" if close > ema20 > ema50 else "down" if close < ema20 < ema50 else "flat"
    row = ScreenerRow(
      symbol=symbol,
      as_of=latest.time[:10],
      close=close,
      ema20=ema20,
      ema50=ema50,
      rsi14=rsi14,
      atr14=atr14,
      high20=high20,
      volume_ratio=vol_ratio,
      adv20=adv20,
      rs_score_60d=rs_60,
      trend=trend,
    )
    if _passes(row, criteria):
      rows.append(row)
  rows.sort(key=lambda x: _sort_key(x, criteria.sort_by), reverse=True)
  return rows[: max(1, min(criteria.max_results, 200))]


def _passes(row: ScreenerRow, c: ScreenerCriteria) -> bool:
  if not (c.min_price <= row.close <= c.max_price):
    return False
  if not (c.rsi_min <= row.rsi14 <= c.rsi_max):
    return False
  if row.volume_ratio < c.min_volume_ratio:
    return False
  if row.adv20 < c.min_adv20:
    return False
  if row.rs_score_60d < c.min_rs_score:
    return False
  if c.trend != "any" and row.trend != c.trend:
    return False
  if c.breakout_only and row.close < row.high20 * 0.995:
    return False
  return True


def _sort_key(row: ScreenerRow, sort_by: str) -> float:
  if sort_by == "rsi":
    return row.rsi14
  if sort_by == "volume":
    return row.volume_ratio
  if sort_by == "price":
    return row.close
  return row.rs_score_60d


def _offset_from(yyyy_mm_dd: str, days_back: int) -> str:
  d = datetime.fromisoformat(yyyy_mm_dd).replace(tzinfo=UTC) - timedelta(days=days_back)
  return d.date().isoformat()


def _load_nifty_benchmark(
  provider: KiteHistoricalProvider,
  instruments: dict[str, object],
  from_date: str,
  to_date: str,
) -> float:
  nifty = instruments.get("NIFTY 50")
  if not nifty:
    return 0.0
  token = getattr(nifty, "instrument_token", "")
  if not token:
    return 0.0
  bars = provider.get_historical_day_bars(token, from_date, to_date)
  if len(bars) < 61:
    return 0.0
  closes = [b.close for b in bars]
  return pct_change(closes[-61], closes[-1])
