from __future__ import annotations

from dataclasses import dataclass

from algo_trading_py.storage.store import InMemoryStore
from algo_trading_py.types import RiskLimits, Signal


@dataclass(slots=True)
class RiskCheckResult:
  ok: bool
  reason: str = ""


class RiskEngine:
  def __init__(self, store: InMemoryStore, limits: RiskLimits) -> None:
    self.store = store
    self.limits = limits
    self.orders_today = 0
    self.daily_loss = 0.0

  def pre_trade_check(self, signal: Signal) -> RiskCheckResult:
    if self.daily_loss <= -self.limits.max_daily_loss:
      return RiskCheckResult(ok=False, reason="Daily loss limit breached")
    if self.orders_today >= self.limits.max_orders_per_day:
      return RiskCheckResult(ok=False, reason="Max orders per day reached")
    if len(self.store.positions) >= self.limits.max_open_positions:
      return RiskCheckResult(ok=False, reason="Max open positions reached")
    if signal.symbol in self.store.positions and self.store.positions[signal.symbol].qty > 0:
      return RiskCheckResult(ok=False, reason="Already holding symbol")
    exposure = signal.qty * signal.entry_price
    if exposure > self.limits.max_exposure_per_symbol:
      return RiskCheckResult(ok=False, reason="Max exposure per symbol breached")
    return RiskCheckResult(ok=True)

  def register_order(self) -> None:
    self.orders_today += 1

  def register_loss(self, amount: float) -> None:
    self.daily_loss -= abs(amount)
