import { Order, Fill } from "../types.js";
import { LtpProvider } from "../market_data/ltp_provider.js";
import { InMemoryStore } from "../storage/store.js";
import { Persistence } from "../persistence/persistence.js";

export class ZerodhaAdapter {
  constructor(
    private ltpProvider: LtpProvider,
    private cfg: {
      mode: "paper" | "live";
      apiKey?: string;
      accessToken?: string;
      baseUrl?: string;
      product?: string;
      exchange?: string;
    } = { mode: "paper" }
  ) {}

  async getLtp(symbol: string): Promise<number> {
    return this.ltpProvider.getLtp(symbol);
  }

  isLiveMode(): boolean {
    return this.cfg.mode === "live";
  }

  async placeOrder(order: Order): Promise<Fill> {
    if (this.isLiveMode()) {
      return this.placeLiveOrder(order);
    }

    // Paper mode: simulate immediate fill at current LTP.
    const price =
      order.intent.price ?? (await this.ltpProvider.getLtp(order.intent.symbol));
    return {
      orderId: order.orderId,
      symbol: order.intent.symbol,
      side: order.intent.side,
      qty: order.intent.qty,
      price,
      time: new Date().toISOString()
    };
  }

  async reconcileBrokerPositions(
    store: InMemoryStore,
    persistence: Persistence
  ): Promise<void> {
    if (!this.isLiveMode()) {
      return;
    }
    const { apiKey, accessToken } = this.credentials();
    const baseUrl = this.cfg.baseUrl ?? "https://api.kite.trade";
    const res = await fetch(`${baseUrl}/portfolio/positions`, {
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${apiKey}:${accessToken}`
      }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Broker position reconcile failed ${res.status}: ${body}`);
    }
    const json = (await res.json()) as {
      status: string;
      data?: { net?: Array<{ tradingsymbol: string; quantity: number; average_price: number }> };
    };
    const net = json.data?.net ?? [];

    const liveLongs = net.filter((p) => p.quantity > 0);
    const liveMap = new Map(liveLongs.map((p) => [p.tradingsymbol, p]));

    for (const symbol of Array.from(store.positions.keys())) {
      if (!liveMap.has(symbol)) {
        store.positions.delete(symbol);
        await persistence.deletePosition(symbol);
      }
    }

    for (const p of liveLongs) {
      store.positions.set(p.tradingsymbol, {
        symbol: p.tradingsymbol,
        qty: p.quantity,
        avgPrice: p.average_price
      });
      await persistence.upsertPosition({
        symbol: p.tradingsymbol,
        qty: p.quantity,
        avgPrice: p.average_price
      });
    }
  }

  private async placeLiveOrder(order: Order): Promise<Fill> {
    const { apiKey, accessToken } = this.credentials();
    const baseUrl = this.cfg.baseUrl ?? "https://api.kite.trade";
    const variety = "regular";
    const exchange = this.cfg.exchange ?? "NSE";
    const product = this.cfg.product ?? "CNC";

    const form = new URLSearchParams({
      exchange,
      tradingsymbol: order.intent.symbol,
      transaction_type: order.intent.side,
      quantity: String(order.intent.qty),
      order_type: order.intent.type,
      product,
      validity: order.intent.timeInForce === "IOC" ? "IOC" : "DAY"
    });
    if (order.intent.type === "LIMIT" && order.intent.price) {
      form.set("price", String(order.intent.price));
    }

    const placeRes = await fetch(`${baseUrl}/orders/${variety}`, {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${apiKey}:${accessToken}`
      },
      body: form
    });
    if (!placeRes.ok) {
      const body = await placeRes.text();
      throw new Error(`Live place order failed ${placeRes.status}: ${body}`);
    }
    const placed = (await placeRes.json()) as {
      status: string;
      data?: { order_id: string };
      message?: string;
    };
    const brokerOrderId = placed.data?.order_id;
    if (!brokerOrderId) {
      throw new Error(`Live place order missing order_id: ${placed.message ?? "unknown"}`);
    }

    const averagePrice = await this.pollAveragePrice(baseUrl, apiKey, accessToken, brokerOrderId);
    const fallbackPrice = order.intent.price ?? (await this.ltpProvider.getLtp(order.intent.symbol));
    return {
      orderId: order.orderId,
      symbol: order.intent.symbol,
      side: order.intent.side,
      qty: order.intent.qty,
      price: averagePrice ?? fallbackPrice,
      time: new Date().toISOString()
    };
  }

  private async pollAveragePrice(
    baseUrl: string,
    apiKey: string,
    accessToken: string,
    brokerOrderId: string
  ): Promise<number | null> {
    const maxPolls = Number(process.env.BROKER_STATUS_POLL_COUNT ?? "5");
    const pollMs = Number(process.env.BROKER_STATUS_POLL_MS ?? "1500");
    for (let i = 0; i < maxPolls; i += 1) {
      const res = await fetch(`${baseUrl}/orders`, {
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${apiKey}:${accessToken}`
        }
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{
            order_id: string;
            status: string;
            average_price: number;
            status_message?: string;
            status_message_raw?: string;
            rejected_reason?: string;
          }>;
        };
        const row = (json.data ?? []).find((o) => o.order_id === brokerOrderId);
        if (row?.status === "COMPLETE") {
          return row.average_price ?? null;
        }
        if (row?.status === "REJECTED" || row?.status === "CANCELLED") {
          const reason =
            row.rejected_reason ??
            row.status_message_raw ??
            row.status_message ??
            "no reason from broker";
          throw new Error(
            `Live order ${row.status}: ${reason}`
          );
        }
      }
      await sleep(pollMs);
    }
    return null;
  }

  private credentials() {
    const apiKey = this.cfg.apiKey;
    const accessToken = this.cfg.accessToken;
    if (!apiKey || !accessToken) {
      throw new Error("Live mode requires KITE_API_KEY and KITE_ACCESS_TOKEN");
    }
    return { apiKey, accessToken };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
