from __future__ import annotations

from abc import ABC, abstractmethod

from algo_trading_py.types import Fill, Order, Position


class ManagedPosition:
  def __init__(self, symbol: str, qty: int, atr14: float, stop_price: float, highest_price: float) -> None:
    self.symbol = symbol
    self.qty = qty
    self.atr14 = atr14
    self.stop_price = stop_price
    self.highest_price = highest_price


class Persistence(ABC):
  @abstractmethod
  def init(self) -> None: ...

  @abstractmethod
  def upsert_order(self, order: Order) -> None: ...

  @abstractmethod
  def insert_fill(self, fill: Fill) -> None: ...

  @abstractmethod
  def upsert_position(self, position: Position) -> None: ...

  @abstractmethod
  def delete_position(self, symbol: str) -> None: ...

  @abstractmethod
  def load_positions(self) -> list[Position]: ...

  @abstractmethod
  def upsert_managed_position(self, position: ManagedPosition) -> None: ...

  @abstractmethod
  def delete_managed_position(self, symbol: str) -> None: ...

  @abstractmethod
  def load_managed_positions(self) -> list[ManagedPosition]: ...

  @abstractmethod
  def upsert_daily_snapshot(
    self,
    trade_date: str,
    equity: float,
    realized_pnl: float,
    unrealized_pnl: float,
    open_positions: int,
    note: str,
  ) -> None: ...

  @abstractmethod
  def upsert_system_state(self, key: str, value: str) -> None: ...

  @abstractmethod
  def load_system_state(self, key: str) -> str | None: ...


class NoopPersistence(Persistence):
  def init(self) -> None:
    return

  def upsert_order(self, order: Order) -> None:
    return

  def insert_fill(self, fill: Fill) -> None:
    return

  def upsert_position(self, position: Position) -> None:
    return

  def delete_position(self, symbol: str) -> None:
    return

  def load_positions(self) -> list[Position]:
    return []

  def upsert_managed_position(self, position: ManagedPosition) -> None:
    return

  def delete_managed_position(self, symbol: str) -> None:
    return

  def load_managed_positions(self) -> list[ManagedPosition]:
    return []

  def upsert_daily_snapshot(
    self,
    trade_date: str,
    equity: float,
    realized_pnl: float,
    unrealized_pnl: float,
    open_positions: int,
    note: str,
  ) -> None:
    return

  def upsert_system_state(self, key: str, value: str) -> None:
    return

  def load_system_state(self, key: str) -> str | None:
    return None
