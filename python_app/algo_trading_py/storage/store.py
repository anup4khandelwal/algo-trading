from __future__ import annotations

from dataclasses import dataclass, field

from algo_trading_py.types import Order, Position


@dataclass(slots=True)
class InMemoryStore:
  orders: dict[str, Order] = field(default_factory=dict)
  positions: dict[str, Position] = field(default_factory=dict)
  realized_pnl: float = 0.0
  equity: float = 1_000_000.0
