import { ZerodhaAdapter } from "../execution/zerodha_adapter.js";
import { OMS } from "../oms/oms.js";
import { ManagedPositionRecord, Persistence } from "../persistence/persistence.js";
import { PortfolioService } from "../portfolio/portfolio.js";
import { InMemoryStore } from "../storage/store.js";
import { Fill, OrderIntent, Signal } from "../types.js";

export class PositionMonitor {
  private managed = new Map<string, ManagedPositionRecord>();

  constructor(
    private store: InMemoryStore,
    private oms: OMS,
    private exec: ZerodhaAdapter,
    private portfolio: PortfolioService,
    private trailingAtrMultiple: number,
    private persistence: Persistence
  ) {}

  async hydrate(): Promise<void> {
    const persisted = await this.persistence.loadManagedPositions();
    for (const record of persisted) {
      this.managed.set(record.symbol, record);
    }
  }

  async trackEntry(fill: Fill, signal: Signal) {
    if (fill.side !== "BUY") {
      return;
    }
    const record: ManagedPositionRecord = {
      symbol: fill.symbol,
      qty: fill.qty,
      atr14: signal.atr14,
      stopPrice: signal.stopPrice,
      highestPrice: fill.price
    };
    this.managed.set(fill.symbol, record);
    await this.persistence.upsertManagedPosition(record);
    await this.persistence.recordTradeEntryLot(
      fill.symbol,
      fill.qty,
      fill.price,
      signal.stopPrice,
      fill.time
    );
  }

  async evaluateAndAct() {
    for (const position of Array.from(this.managed.values())) {
      const current = this.store.positions.get(position.symbol);
      if (!current || current.qty <= 0) {
        this.managed.delete(position.symbol);
        await this.persistence.deleteManagedPosition(position.symbol);
        continue;
      }

      const ltp = await this.exec.getLtp(position.symbol);
      if (ltp > position.highestPrice) {
        position.highestPrice = ltp;
      }

      const trailingStop = position.highestPrice - position.atr14 * this.trailingAtrMultiple;
      position.stopPrice = Math.max(position.stopPrice, trailingStop);
      this.managed.set(position.symbol, position);
      await this.persistence.upsertManagedPosition(position);

      if (ltp > position.stopPrice) {
        continue;
      }

      const intent: OrderIntent = {
        idempotencyKey: `STOP-${position.symbol}-${Date.now()}`,
        symbol: position.symbol,
        side: "SELL",
        qty: current.qty,
        type: "MARKET",
        timeInForce: "DAY",
        createdAt: new Date().toISOString(),
        signalReason: `Trailing stop hit at ${position.stopPrice.toFixed(2)}`
      };

      const order = await this.oms.createOrder(intent);
      await this.oms.updateState(order.orderId, "OPEN");
      const fill = await this.exec.placeOrder(order);
      await this.oms.updateState(order.orderId, "FILLED", {
        filledQty: fill.qty,
        avgFillPrice: fill.price
      });
      await this.portfolio.applyFill(fill);
      await this.persistence.closeTradeEntryLots(
        fill.symbol,
        fill.qty,
        fill.price,
        fill.time
      );
      this.managed.delete(position.symbol);
      await this.persistence.deleteManagedPosition(position.symbol);
      console.log(
        "STOP_EXIT",
        fill.symbol,
        fill.qty,
        fill.price.toFixed(2),
        `stop=${position.stopPrice.toFixed(2)}`
      );
    }
  }

  async reconcileWithPositions() {
    for (const [symbol] of Array.from(this.managed.entries())) {
      const position = this.store.positions.get(symbol);
      if (!position || position.qty <= 0) {
        this.managed.delete(symbol);
        await this.persistence.deleteManagedPosition(symbol);
      }
    }
  }
}
