from __future__ import annotations

import csv
import io
from dataclasses import dataclass

import httpx

from algo_trading_py.types import MarketBar


@dataclass(slots=True)
class InstrumentRecord:
  instrument_token: str
  tradingsymbol: str
  exchange: str
  segment: str
  instrument_type: str


class KiteHistoricalProvider:
  def __init__(self, api_key: str, access_token: str, base_url: str = "https://api.kite.trade") -> None:
    self.base_url = base_url
    self._client = httpx.Client(
      headers={
        "X-Kite-Version": "3",
        "Authorization": f"token {api_key}:{access_token}",
      },
      timeout=30.0,
    )

  def get_instruments(self, exchange: str = "NSE") -> dict[str, InstrumentRecord]:
    url = f"{self.base_url}/instruments/{exchange}"
    res = self._client.get(url)
    res.raise_for_status()
    reader = csv.DictReader(io.StringIO(res.text))
    out: dict[str, InstrumentRecord] = {}
    for row in reader:
      symbol = (row.get("tradingsymbol") or "").strip()
      if not symbol:
        continue
      out[symbol] = InstrumentRecord(
        instrument_token=row.get("instrument_token", ""),
        tradingsymbol=symbol,
        exchange=row.get("exchange", ""),
        segment=row.get("segment", ""),
        instrument_type=row.get("instrument_type", ""),
      )
    return out

  def get_historical_day_bars(self, instrument_token: str, from_date: str, to_date: str) -> list[MarketBar]:
    url = f"{self.base_url}/instruments/historical/{instrument_token}/day"
    res = self._client.get(url, params={"from": from_date, "to": to_date})
    res.raise_for_status()
    candles = ((res.json().get("data") or {}).get("candles") or [])
    bars: list[MarketBar] = []
    for c in candles:
      bars.append(
        MarketBar(
          symbol=instrument_token,
          time=c[0],
          open=float(c[1]),
          high=float(c[2]),
          low=float(c[3]),
          close=float(c[4]),
          volume=float(c[5]),
        )
      )
    return bars

  def get_quotes(self, instrument_keys: list[str]) -> dict[str, dict[str, float]]:
    if not instrument_keys:
      return {}
    url = f"{self.base_url}/quote"
    params: list[tuple[str, str]] = [("i", key) for key in instrument_keys]
    res = self._client.get(url, params=params)
    res.raise_for_status()
    data = (res.json().get("data") or {})
    out: dict[str, dict[str, float]] = {}
    for key, value in data.items():
      out[key] = {
        "last_price": float(value.get("last_price") or 0),
        "volume": float(value.get("volume") or 0),
      }
    return out
