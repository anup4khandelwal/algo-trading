from __future__ import annotations

from datetime import UTC, datetime

from algo_trading_py.types import Fill, Order, Signal


class PaperExecutionAdapter:
  def place_signal(self, signal: Signal) -> tuple[Order, Fill]:
    now = datetime.now(UTC).isoformat()
    order_id = f"PAPER-{signal.symbol}-{int(datetime.now(UTC).timestamp() * 1000)}"
    order = Order(
      order_id=order_id,
      symbol=signal.symbol,
      side=signal.side,
      qty=signal.qty,
      state="FILLED",
      avg_fill_price=signal.entry_price,
      created_at=now,
      updated_at=now,
    )
    fill = Fill(
      order_id=order_id,
      symbol=signal.symbol,
      side=signal.side,
      qty=signal.qty,
      price=signal.entry_price,
      time=now,
    )
    return order, fill
