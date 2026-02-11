import { InMemoryStore } from "../storage/store.js";
import { Order, OrderIntent, OrderState } from "../types.js";
import { Persistence } from "../persistence/persistence.js";

export class OMS {
  constructor(private store: InMemoryStore, private persistence: Persistence) {}

  async createOrder(intent: OrderIntent): Promise<Order> {
    // Idempotency check
    for (const order of this.store.orders.values()) {
      if (order.intent.idempotencyKey === intent.idempotencyKey) {
        return order;
      }
    }

    const now = new Date().toISOString();
    const order: Order = {
      orderId: `ORD-${Math.random().toString(36).slice(2, 10)}`,
      intent,
      state: "NEW",
      filledQty: 0,
      createdAt: now,
      updatedAt: now
    };

    this.store.orders.set(order.orderId, order);
    await this.persistence.upsertOrder(order);
    return order;
  }

  async updateState(
    orderId: string,
    state: OrderState,
    patch?: Partial<Order>
  ): Promise<Order> {
    const order = this.store.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    const updated: Order = {
      ...order,
      ...patch,
      state,
      updatedAt: new Date().toISOString()
    };
    this.store.orders.set(orderId, updated);
    await this.persistence.upsertOrder(updated);
    return updated;
  }
}
