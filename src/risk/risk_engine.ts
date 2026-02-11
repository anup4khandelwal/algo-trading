import { InMemoryStore } from "../storage/store.js";
import { OrderIntent, RiskCheckResult, RiskLimits, Signal } from "../types.js";

export class RiskEngine {
  private ordersToday = 0;
  private dailyLoss = 0;

  constructor(private store: InMemoryStore, private limits: RiskLimits) {}

  preTradeCheck(signal: Signal): RiskCheckResult {
    if (this.dailyLoss <= -this.limits.maxDailyLoss) {
      return { ok: false, reason: "Daily loss limit breached" };
    }

    if (this.ordersToday >= this.limits.maxOrdersPerDay) {
      return { ok: false, reason: "Max orders per day reached" };
    }

    const openPositions = Array.from(this.store.positions.values());
    if (openPositions.length >= this.limits.maxOpenPositions) {
      return { ok: false, reason: "Max open positions reached" };
    }

    const existing = this.store.positions.get(signal.symbol);
    if (existing && existing.qty > 0) {
      return { ok: false, reason: "Already holding symbol" };
    }

    const exposure = signal.qty * signal.entryPrice;
    if (exposure > this.limits.maxExposurePerSymbol) {
      return { ok: false, reason: "Max exposure per symbol breached" };
    }

    return { ok: true };
  }

  registerOrder(_intent: OrderIntent) {
    this.ordersToday += 1;
  }

  registerLoss(amount: number) {
    this.dailyLoss -= Math.abs(amount);
  }
}
