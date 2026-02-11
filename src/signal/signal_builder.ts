import { ScreenerResult, Signal } from "../types.js";

export interface SignalBuilderConfig {
  minRsi: number;
  breakoutBufferPct: number; // e.g. 0.02 for within 2% of 20d high
  atrStopMultiple: number;
  riskPerTrade: number;
  minAdv20: number;
  minVolumeRatio: number;
  maxSignals: number;
}

export class SignalBuilder {
  constructor(private cfg: SignalBuilderConfig) {}

  buildSignals(results: ScreenerResult[], equity: number): Signal[] {
    const candidates = results.filter((r) => {
      const trendOk = r.ema20 > r.ema50 && r.close > r.ema20;
      const nearHigh = r.close >= r.high20 * (1 - this.cfg.breakoutBufferPct);
      const momentumOk = r.rsi14 >= this.cfg.minRsi;
      const liquidityOk = r.adv20 >= this.cfg.minAdv20;
      const volumeOk = r.volumeRatio >= this.cfg.minVolumeRatio;
      return trendOk && nearHigh && momentumOk && liquidityOk && volumeOk;
    });

    const sorted = candidates
      .sort((a, b) => b.rsScore60d - a.rsScore60d)
      .slice(0, this.cfg.maxSignals);

    return sorted
      .map((r) => {
      const entry = r.close;
      const stopDistance = Math.max(r.atr14 * this.cfg.atrStopMultiple, entry * 0.01);
      const stop = Math.max(0.01, entry - stopDistance);
      const capitalAtRisk = equity * this.cfg.riskPerTrade;
      const perShareRisk = Math.max(entry - stop, 1);
      const qty = Math.floor(capitalAtRisk / perShareRisk);

      return {
        symbol: r.symbol,
        side: "BUY" as const,
        entryPrice: entry,
        stopPrice: stop,
        targetPrice: entry + stopDistance * 2,
        qty,
        reason: `Trend+momentum breakout (ATRx${this.cfg.atrStopMultiple.toFixed(1)} stop)`,
        rankScore: r.rsScore60d,
        atr14: r.atr14
      };
      })
      .filter((signal) => signal.qty > 0);
  }
}
