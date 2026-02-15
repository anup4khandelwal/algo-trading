from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


Trend = Literal["up", "down", "flat"]
Side = Literal["BUY", "SELL"]


@dataclass(slots=True)
class MarketBar:
  symbol: str
  time: str
  open: float
  high: float
  low: float
  close: float
  volume: float


@dataclass(slots=True)
class ScreenerRow:
  symbol: str
  as_of: str
  close: float
  ema20: float
  ema50: float
  rsi14: float
  atr14: float
  high20: float
  volume_ratio: float
  adv20: float
  rs_score_60d: float
  trend: Trend


@dataclass(slots=True)
class Signal:
  symbol: str
  side: Side
  entry_price: float
  stop_price: float
  target_price: float
  qty: int
  reason: str
  rank_score: float
  atr14: float


@dataclass(slots=True)
class Order:
  order_id: str
  symbol: str
  side: Side
  qty: int
  state: Literal["NEW", "FILLED", "REJECTED"]
  avg_fill_price: float
  created_at: str
  updated_at: str


@dataclass(slots=True)
class Fill:
  order_id: str
  symbol: str
  side: Side
  qty: int
  price: float
  time: str


@dataclass(slots=True)
class Position:
  symbol: str
  qty: int
  avg_price: float


@dataclass(slots=True)
class RiskLimits:
  max_daily_loss: float
  max_open_positions: int
  max_orders_per_day: int
  max_exposure_per_symbol: float
  risk_per_trade: float
