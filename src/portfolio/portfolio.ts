import { InMemoryStore } from "../storage/store.js";
import { Fill } from "../types.js";
import { Persistence } from "../persistence/persistence.js";

export class PortfolioService {
  constructor(private store: InMemoryStore, private persistence: Persistence) {}

  async applyFill(fill: Fill) {
    await this.persistence.insertFill(fill);
    const existing = this.store.positions.get(fill.symbol);
    const signedQty = fill.side === "BUY" ? fill.qty : -fill.qty;

    if (!existing) {
      const position = {
        symbol: fill.symbol,
        qty: signedQty,
        avgPrice: fill.price
      };
      this.store.positions.set(fill.symbol, position);
      await this.persistence.upsertPosition(position);
      return;
    }

    const newQty = existing.qty + signedQty;
    if (newQty === 0) {
      this.store.positions.delete(fill.symbol);
      await this.persistence.deletePosition(fill.symbol);
      return;
    }

    const totalCost = existing.avgPrice * existing.qty + fill.price * signedQty;
    const avgPrice = totalCost / newQty;

    const position = {
      symbol: fill.symbol,
      qty: newQty,
      avgPrice
    };
    this.store.positions.set(fill.symbol, position);
    await this.persistence.upsertPosition(position);
  }
}
