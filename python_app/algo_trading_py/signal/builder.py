from __future__ import annotations

from dataclasses import dataclass

from algo_trading_py.types import ScreenerRow, Signal


@dataclass(slots=True)
class SignalBuilderConfig:
  min_rsi: float = 55
  breakout_buffer_pct: float = 0.02
  atr_stop_multiple: float = 2
  risk_per_trade: float = 0.015
  min_capital_deploy_pct: float = 0
  min_adv20: float = 100_000_000
  min_volume_ratio: float = 1.2
  max_signals: int = 5


class SignalBuilder:
  def __init__(self, cfg: SignalBuilderConfig) -> None:
    self.cfg = cfg

  def build_signals(self, rows: list[ScreenerRow], equity: float) -> list[Signal]:
    candidates = [
      r
      for r in rows
      if r.ema20 > r.ema50
      and r.close > r.ema20
      and r.close >= r.high20 * (1 - self.cfg.breakout_buffer_pct)
      and r.rsi14 >= self.cfg.min_rsi
      and r.adv20 >= self.cfg.min_adv20
      and r.volume_ratio >= self.cfg.min_volume_ratio
    ]
    candidates.sort(key=lambda x: x.rs_score_60d, reverse=True)
    out: list[Signal] = []
    for r in candidates[: self.cfg.max_signals]:
      entry = r.close
      stop_distance = max(r.atr14 * self.cfg.atr_stop_multiple, entry * 0.01)
      stop = max(0.01, entry - stop_distance)
      cap_risk = equity * self.cfg.risk_per_trade
      per_share_risk = max(entry - stop, 1)
      qty_by_risk = int(cap_risk // per_share_risk)
      qty_by_floor = (
        int(((equity * self.cfg.min_capital_deploy_pct) / max(entry, 0.01)) + 0.9999)
        if self.cfg.min_capital_deploy_pct > 0
        else 0
      )
      qty = max(qty_by_risk, qty_by_floor)
      if qty <= 0:
        continue
      out.append(
        Signal(
          symbol=r.symbol,
          side="BUY",
          entry_price=entry,
          stop_price=stop,
          target_price=entry + stop_distance * 2,
          qty=qty,
          reason=f"Trend+momentum breakout (ATRx{self.cfg.atr_stop_multiple:.1f} stop)",
          rank_score=r.rs_score_60d,
          atr14=r.atr14,
        )
      )
    return out
