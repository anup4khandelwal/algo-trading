from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


Trend = Literal["up", "down", "flat"]


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
