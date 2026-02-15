from __future__ import annotations

from datetime import UTC, datetime

from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
from algo_trading_py.persistence.base import ManagedPosition, Persistence
from algo_trading_py.storage.store import InMemoryStore
from algo_trading_py.types import Fill, Position, Signal


class PositionMonitor:
  def __init__(
    self,
    store: InMemoryStore,
    persistence: Persistence,
    provider: KiteHistoricalProvider,
    trailing_atr_multiple: float,
  ) -> None:
    self.store = store
    self.persistence = persistence
    self.provider = provider
    self.trailing_atr_multiple = trailing_atr_multiple
    self.managed: dict[str, ManagedPosition] = {}

  def hydrate(self) -> None:
    for p in self.persistence.load_managed_positions():
      self.managed[p.symbol] = p

  def track_entry(self, fill: Fill, signal: Signal) -> None:
    if fill.side != "BUY":
      return
    rec = ManagedPosition(
      symbol=fill.symbol,
      qty=fill.qty,
      atr14=signal.atr14,
      stop_price=signal.stop_price,
      highest_price=fill.price,
    )
    self.managed[fill.symbol] = rec
    self.persistence.upsert_managed_position(rec)

  def reconcile_with_positions(self) -> None:
    for symbol in list(self.managed.keys()):
      pos = self.store.positions.get(symbol)
      if pos is None or pos.qty <= 0:
        self.managed.pop(symbol, None)
        self.persistence.delete_managed_position(symbol)

  def evaluate_and_act(self) -> list[dict[str, object]]:
    actions: list[dict[str, object]] = []
    instruments = self.provider.get_instruments("NSE")
    keys: list[str] = []
    for symbol in self.managed.keys():
      inst = instruments.get(symbol)
      if inst:
        keys.append(f"{inst.exchange}:{inst.tradingsymbol}")
    quotes = self.provider.get_quotes(keys) if keys else {}
    by_symbol_quote: dict[str, float] = {}
    for symbol, inst in instruments.items():
      key = f"{inst.exchange}:{inst.tradingsymbol}"
      if key in quotes:
        by_symbol_quote[symbol] = quotes[key]["last_price"]
    for symbol, managed in list(self.managed.items()):
      pos = self.store.positions.get(symbol)
      if pos is None or pos.qty <= 0:
        self.managed.pop(symbol, None)
        self.persistence.delete_managed_position(symbol)
        continue
      ltp = by_symbol_quote.get(symbol, pos.avg_price)
      if ltp > managed.highest_price:
        managed.highest_price = ltp
      trailing_stop = managed.highest_price - managed.atr14 * self.trailing_atr_multiple
      managed.stop_price = max(managed.stop_price, trailing_stop)
      self.persistence.upsert_managed_position(managed)
      if ltp > managed.stop_price:
        continue
      now = datetime.now(UTC).isoformat()
      order_id = f"STOP-{symbol}-{int(datetime.now(UTC).timestamp() * 1000)}"
      fill = Fill(order_id=order_id, symbol=symbol, side="SELL", qty=pos.qty, price=ltp, time=now)
      self._apply_fill(fill)
      self.managed.pop(symbol, None)
      self.persistence.delete_managed_position(symbol)
      actions.append({"symbol": symbol, "qty": fill.qty, "price": fill.price, "stop": managed.stop_price})
    return actions

  def _apply_fill(self, fill: Fill) -> None:
    self.persistence.insert_fill(fill)
    existing = self.store.positions.get(fill.symbol)
    signed_qty = fill.qty if fill.side == "BUY" else -fill.qty
    if existing is None:
      next_pos = Position(symbol=fill.symbol, qty=signed_qty, avg_price=fill.price)
      self.store.positions[fill.symbol] = next_pos
      self.persistence.upsert_position(next_pos)
      return
    new_qty = existing.qty + signed_qty
    if new_qty <= 0:
      self.store.positions.pop(fill.symbol, None)
      self.persistence.delete_position(fill.symbol)
      return
    total_cost = existing.avg_price * existing.qty + fill.price * signed_qty
    next_pos = Position(symbol=fill.symbol, qty=new_qty, avg_price=total_cost / new_qty)
    self.store.positions[fill.symbol] = next_pos
    self.persistence.upsert_position(next_pos)
