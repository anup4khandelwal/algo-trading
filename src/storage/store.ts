import { Order, Position, PortfolioSnapshot } from "../types.js";

export class InMemoryStore {
  orders: Map<string, Order> = new Map();
  positions: Map<string, Position> = new Map();
  realizedPnl = 0;
  equity = 1_000_000; // default equity INR

  getSnapshot(): PortfolioSnapshot {
    const positions = Array.from(this.positions.values());
    return {
      equity: this.equity,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: 0,
      positions
    };
  }
}
