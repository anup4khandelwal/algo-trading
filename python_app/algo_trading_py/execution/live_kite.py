from __future__ import annotations

from datetime import UTC, datetime

import httpx

from algo_trading_py.types import Fill, Order, Signal


class LiveKiteExecutionAdapter:
  def __init__(
    self,
    api_key: str,
    access_token: str,
    base_url: str = "https://api.kite.trade",
    exchange: str = "NSE",
    product: str = "CNC",
    order_variety: str = "regular",
  ) -> None:
    self.api_key = api_key
    self.access_token = access_token
    self.base_url = base_url
    self.exchange = exchange
    self.product = product
    self.order_variety = order_variety
    self.client = httpx.Client(
      timeout=30.0,
      headers={
        "X-Kite-Version": "3",
        "Authorization": f"token {api_key}:{access_token}",
      },
    )

  def preflight_check(self) -> dict[str, object]:
    res = self.client.get(f"{self.base_url}/user/profile")
    if res.status_code >= 400:
      return {"ok": False, "mode": "live", "message": f"Live preflight failed {res.status_code}: {res.text}"}
    data = res.json().get("data") or {}
    return {
      "ok": True,
      "mode": "live",
      "message": "Live preflight passed",
      "accountUserId": data.get("user_id"),
    }

  def get_ltp(self, symbol: str) -> float:
    key = f"{self.exchange}:{symbol}"
    res = self.client.get(f"{self.base_url}/quote", params=[("i", key)])
    res.raise_for_status()
    data = (res.json().get("data") or {}).get(key) or {}
    return float(data.get("last_price") or 0)

  def place_signal(self, signal: Signal) -> tuple[Order, Fill]:
    now = datetime.now(UTC).isoformat()
    form = {
      "tradingsymbol": signal.symbol,
      "exchange": self.exchange,
      "transaction_type": signal.side,
      "order_type": "MARKET",
      "quantity": str(signal.qty),
      "product": self.product,
      "validity": "DAY",
    }
    res = self.client.post(f"{self.base_url}/orders/{self.order_variety}", data=form)
    raw = res.text
    if res.status_code >= 400:
      raise RuntimeError(f"Live order failed {res.status_code}: {raw}")
    order_id = ((res.json().get("data") or {}).get("order_id") or "").strip()
    if not order_id:
      raise RuntimeError(f"Live order missing order_id: {raw}")
    price = self.get_ltp(signal.symbol)
    order = Order(
      order_id=order_id,
      symbol=signal.symbol,
      side=signal.side,
      qty=signal.qty,
      state="FILLED",
      avg_fill_price=price,
      created_at=now,
      updated_at=now,
    )
    fill = Fill(
      order_id=order_id,
      symbol=signal.symbol,
      side=signal.side,
      qty=signal.qty,
      price=price,
      time=now,
    )
    return order, fill
