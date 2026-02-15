from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from algo_trading_py.market_data.kite_historical_provider import KiteHistoricalProvider
from algo_trading_py.utils.indicators import atr, ema, pct_change, rsi, sma, std


@dataclass(slots=True)
class BacktestConfig:
  from_date: str
  to_date: str
  symbols: list[str]
  initial_capital: float = 1_000_000
  max_hold_days: int = 15
  slippage_bps: float = 5
  fee_bps: float = 12
  max_open_positions: int = 5
  min_rsi: float = 55
  breakout_buffer_pct: float = 0.02
  atr_stop_multiple: float = 2
  risk_per_trade: float = 0.015
  max_results: int = 5


@dataclass(slots=True)
class BacktestResult:
  from_date: str
  to_date: str
  symbols: list[str]
  trades: int
  win_rate: float
  total_pnl: float
  max_drawdown_abs: float
  max_drawdown_pct: float
  cagr_pct: float
  sharpe_proxy: float


def run_backtest(provider: KiteHistoricalProvider, cfg: BacktestConfig) -> BacktestResult:
  history_from = _offset_from(cfg.from_date, 180)
  bars_by_symbol = _load_bars(provider, cfg.symbols, history_from, cfg.from_date, cfg.to_date)
  symbols = [s for s, bars in bars_by_symbol.items() if bars]
  if not symbols:
    raise RuntimeError("No symbols have enough historical bars for selected range")
  trading_days = sorted({b["time"][:10] for bars in bars_by_symbol.values() for b in bars if cfg.from_date <= b["time"][:10] <= cfg.to_date})
  open_pos: dict[str, dict[str, float | int | str]] = {}
  equity_curve: list[float] = []
  realized = 0.0
  pnls: list[float] = []
  for day in trading_days:
    day_map = {s: next((x for x in bars if x["time"][:10] == day), None) for s, bars in bars_by_symbol.items()}
    # exits
    for s in list(open_pos.keys()):
      pos = open_pos[s]
      bar = day_map.get(s)
      if bar is None:
        pos["days_held"] = int(pos["days_held"]) + 1
        continue
      pos["days_held"] = int(pos["days_held"]) + 1
      exit_price = None
      if bar["low"] <= float(pos["stop"]):
        exit_price = float(pos["stop"])
      elif bar["high"] >= float(pos["target"]):
        exit_price = float(pos["target"])
      elif int(pos["days_held"]) >= cfg.max_hold_days:
        exit_price = float(bar["close"])
      if exit_price is None:
        continue
      filled = _slippage(exit_price, "SELL", cfg.slippage_bps)
      qty = float(pos["qty"])
      entry = float(pos["entry"])
      turnover = (entry * qty) + (filled * qty)
      fees = turnover * (cfg.fee_bps / 10_000)
      pnl = (filled - entry) * qty - fees
      realized += pnl
      pnls.append(pnl)
      del open_pos[s]
    # entries
    if len(open_pos) < cfg.max_open_positions:
      candidates = _build_candidates(day, bars_by_symbol, cfg)
      for c in candidates[: cfg.max_results]:
        if c["symbol"] in open_pos or len(open_pos) >= cfg.max_open_positions:
          continue
        bar = day_map.get(c["symbol"])
        if bar is None:
          continue
        entry = _slippage(c["entry"], "BUY", cfg.slippage_bps)
        open_pos[c["symbol"]] = {
          "entry": entry,
          "stop": c["stop"],
          "target": c["target"],
          "qty": c["qty"],
          "days_held": 0,
        }
    unrealized = 0.0
    for s, pos in open_pos.items():
      bar = day_map.get(s)
      if bar:
        unrealized += (float(bar["close"]) - float(pos["entry"])) * float(pos["qty"])
    equity_curve.append(cfg.initial_capital + realized + unrealized)
  final_cap = cfg.initial_capital + realized
  returns = []
  for i in range(1, len(equity_curve)):
    p = equity_curve[i - 1]
    c = equity_curve[i]
    if p > 0:
      returns.append((c - p) / p)
  return BacktestResult(
    from_date=cfg.from_date,
    to_date=cfg.to_date,
    symbols=symbols,
    trades=len(pnls),
    win_rate=(len([x for x in pnls if x > 0]) / len(pnls)) if pnls else 0.0,
    total_pnl=realized,
    max_drawdown_abs=_max_drawdown_abs(equity_curve),
    max_drawdown_pct=_max_drawdown_pct(equity_curve),
    cagr_pct=_cagr(equity_curve, cfg.initial_capital, final_cap),
    sharpe_proxy=((sma(returns) / std(returns)) * (252**0.5)) if returns and std(returns) > 0 else 0.0,
  )


def _build_candidates(day: str, bars_by_symbol: dict[str, list[dict[str, float | str]]], cfg: BacktestConfig) -> list[dict[str, float | str]]:
  out: list[dict[str, float | str]] = []
  for symbol, bars in bars_by_symbol.items():
    idx = next((i for i, b in enumerate(bars) if str(b["time"]).startswith(day)), -1)
    if idx < 61:
      continue
    s = bars[: idx + 1]
    if len(s) < 80:
      continue
    closes = [float(x["close"]) for x in s]
    highs = [float(x["high"]) for x in s]
    lows = [float(x["low"]) for x in s]
    volumes = [float(x["volume"]) for x in s]
    close = closes[-1]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    rsi14 = rsi(closes, 14)
    if not (close > ema20 > ema50 and rsi14 >= cfg.min_rsi):
      continue
    high20 = max(highs[-20:])
    breakout = high20 * (1 + cfg.breakout_buffer_pct)
    if close < breakout:
      continue
    atr14 = atr(highs, lows, closes, 14)
    stop = close - atr14 * cfg.atr_stop_multiple
    risk_per_share = max(close - stop, 0.01)
    qty = max(1, int((cfg.initial_capital * cfg.risk_per_trade) / risk_per_share))
    target = close + (close - stop) * 2
    rs = pct_change(closes[-61], close)
    vol_ratio = sma(volumes[-20:]) / max(1, sma(volumes[-50:]))
    out.append(
      {
        "symbol": symbol,
        "entry": close,
        "stop": stop,
        "target": target,
        "qty": qty,
        "rank": rs * vol_ratio,
      }
    )
  out.sort(key=lambda x: float(x["rank"]), reverse=True)
  return out


def _load_bars(
  provider: KiteHistoricalProvider,
  symbols: list[str],
  history_from: str,
  from_date: str,
  to_date: str,
) -> dict[str, list[dict[str, float | str]]]:
  instruments = provider.get_instruments("NSE")
  out: dict[str, list[dict[str, float | str]]] = {}
  for symbol in symbols:
    inst = instruments.get(symbol)
    if not inst:
      continue
    bars = provider.get_historical_day_bars(inst.instrument_token, history_from, to_date)
    normalized = [
      {
        "time": b.time,
        "open": b.open,
        "high": b.high,
        "low": b.low,
        "close": b.close,
        "volume": b.volume,
      }
      for b in bars
      if b.close and b.volume
    ]
    if any(from_date <= str(x["time"])[:10] <= to_date for x in normalized):
      out[symbol] = sorted(normalized, key=lambda x: str(x["time"]))
  return out


def _offset_from(yyyy_mm_dd: str, days_back: int) -> str:
  d = datetime.fromisoformat(yyyy_mm_dd).replace(tzinfo=UTC) - timedelta(days=days_back)
  return d.date().isoformat()


def _slippage(price: float, side: str, bps: float) -> float:
  factor = bps / 10_000
  return price * (1 + factor) if side == "BUY" else price * (1 - factor)


def _max_drawdown_abs(series: list[float]) -> float:
  peak = float("-inf")
  out = 0.0
  for v in series:
    peak = max(peak, v)
    out = max(out, peak - v)
  return out


def _max_drawdown_pct(series: list[float]) -> float:
  peak = float("-inf")
  out = 0.0
  for v in series:
    peak = max(peak, v)
    if peak > 0:
      out = max(out, (peak - v) / peak)
  return out


def _cagr(equity_curve: list[float], initial: float, final: float) -> float:
  if len(equity_curve) < 2 or initial <= 0 or final <= 0:
    return 0.0
  years = max(len(equity_curve) / 252, 1 / 252)
  return ((final / initial) ** (1 / years) - 1) * 100
