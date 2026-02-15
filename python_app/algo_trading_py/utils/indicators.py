from __future__ import annotations

from math import sqrt


def sma(values: list[float]) -> float:
  if not values:
    raise ValueError("sma requires non-empty values")
  return sum(values) / len(values)


def ema(values: list[float], period: int) -> float:
  if period <= 1 or len(values) < period:
    raise ValueError("ema requires len(values) >= period and period > 1")
  k = 2 / (period + 1)
  current = sma(values[:period])
  for v in values[period:]:
    current = v * k + current * (1 - k)
  return current


def rsi(values: list[float], period: int) -> float:
  if period <= 1 or len(values) < period + 1:
    raise ValueError("rsi requires len(values) >= period + 1")
  gains: list[float] = []
  losses: list[float] = []
  for i in range(1, len(values)):
    diff = values[i] - values[i - 1]
    gains.append(max(diff, 0))
    losses.append(max(-diff, 0))
  avg_gain = sma(gains[:period])
  avg_loss = sma(losses[:period])
  for i in range(period, len(gains)):
    avg_gain = (avg_gain * (period - 1) + gains[i]) / period
    avg_loss = (avg_loss * (period - 1) + losses[i]) / period
  if avg_loss == 0:
    return 100.0
  rs = avg_gain / avg_loss
  return 100 - (100 / (1 + rs))


def atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> float:
  if period <= 1 or len(highs) != len(lows) or len(lows) != len(closes) or len(highs) < period + 1:
    raise ValueError("invalid input for atr")
  tr: list[float] = []
  for i in range(1, len(highs)):
    h = highs[i]
    l = lows[i]
    pc = closes[i - 1]
    tr.append(max(h - l, abs(h - pc), abs(l - pc)))
  current = sma(tr[:period])
  for v in tr[period:]:
    current = ((current * (period - 1)) + v) / period
  return current


def pct_change(start: float, end: float) -> float:
  if start == 0:
    raise ValueError("pct_change start cannot be zero")
  return (end - start) / start


def std(values: list[float]) -> float:
  if len(values) < 2:
    return 0.0
  mu = sma(values)
  variance = sum((v - mu) ** 2 for v in values) / len(values)
  return sqrt(variance)
