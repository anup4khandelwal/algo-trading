import { MarketBar } from "../types.js";

export interface KiteHistoricalProviderConfig {
  apiKey: string;
  accessToken: string;
  baseUrl?: string;
}

export interface InstrumentRecord {
  instrumentToken: string;
  tradingsymbol: string;
  exchange: string;
  segment: string;
  instrumentType: string;
}

interface HistoricalResponse {
  status: string;
  data?: {
    candles: [string, number, number, number, number, number][];
  };
}

interface QuoteResponse {
  status: string;
  data?: Record<string, { last_price: number; volume: number }>;
}

export class KiteHistoricalProvider {
  private baseUrl: string;
  private lastRequestTs = 0;
  private readonly minGapMs = 120;
  private readonly maxRetries = 3;

  constructor(private cfg: KiteHistoricalProviderConfig) {
    this.baseUrl = cfg.baseUrl ?? "https://api.kite.trade";
  }

  async getInstruments(exchange = "NSE"): Promise<Map<string, InstrumentRecord>> {
    const res = await this.requestWithRetry(`${this.baseUrl}/instruments/${exchange}`);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kite instruments error ${res.status}: ${body}`);
    }

    const csv = await res.text();
    const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
      throw new Error("Kite instruments response is empty");
    }

    const header = lines[0].split(",");
    const tokenIdx = header.indexOf("instrument_token");
    const symbolIdx = header.indexOf("tradingsymbol");
    const exchangeIdx = header.indexOf("exchange");
    const segmentIdx = header.indexOf("segment");
    const instrumentTypeIdx = header.indexOf("instrument_type");

    if (
      tokenIdx < 0 ||
      symbolIdx < 0 ||
      exchangeIdx < 0 ||
      segmentIdx < 0 ||
      instrumentTypeIdx < 0
    ) {
      throw new Error("Kite instruments CSV missing expected columns");
    }

    const map = new Map<string, InstrumentRecord>();
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(",");
      const tradingsymbol = cols[symbolIdx];
      if (!tradingsymbol) {
        continue;
      }

      map.set(tradingsymbol, {
        instrumentToken: cols[tokenIdx],
        tradingsymbol,
        exchange: cols[exchangeIdx],
        segment: cols[segmentIdx],
        instrumentType: cols[instrumentTypeIdx]
      });
    }

    return map;
  }

  async getHistoricalDayBars(
    instrumentToken: string,
    from: string,
    to: string
  ): Promise<MarketBar[]> {
    const url = new URL(
      `${this.baseUrl}/instruments/historical/${instrumentToken}/day`
    );
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    const res = await this.requestWithRetry(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kite historical error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as HistoricalResponse;
    const candles = json.data?.candles ?? [];

    return candles.map((candle) => ({
      symbol: instrumentToken,
      time: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5]
    }));
  }

  async getQuotes(
    instrumentKeys: string[]
  ): Promise<Record<string, { lastPrice: number; volume: number }>> {
    if (instrumentKeys.length === 0) {
      return {};
    }

    const out: Record<string, { lastPrice: number; volume: number }> = {};
    const batchSize = 200;
    for (let i = 0; i < instrumentKeys.length; i += batchSize) {
      const batch = instrumentKeys.slice(i, i + batchSize);
      const url = new URL(`${this.baseUrl}/quote`);
      for (const key of batch) {
        url.searchParams.append("i", key);
      }

      const res = await this.requestWithRetry(url.toString());
      const json = (await res.json()) as QuoteResponse;
      const data = json.data ?? {};
      for (const [key, value] of Object.entries(data)) {
        out[key] = {
          lastPrice: value.last_price ?? 0,
          volume: value.volume ?? 0
        };
      }
    }
    return out;
  }

  private async requestWithRetry(url: string): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      await this.rateLimit();
      try {
        const res = await fetch(url, { headers: this.headers() });
        if (res.ok) {
          return res;
        }
        const body = await res.text();
        if (res.status >= 500 || res.status === 429) {
          lastError = new Error(`Kite API ${res.status}: ${body}`);
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`Kite API ${res.status}: ${body}`);
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
      }
    }
    throw lastError ?? new Error("Kite API request failed");
  }

  private async rateLimit() {
    const now = Date.now();
    const waitMs = Math.max(0, this.minGapMs - (now - this.lastRequestTs));
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestTs = Date.now();
  }

  private async backoff(attempt: number) {
    const jitter = Math.floor(Math.random() * 60);
    const delay = Math.min(1200, attempt * 200 + jitter);
    await sleep(delay);
  }

  private headers() {
    return {
      "X-Kite-Version": "3",
      Authorization: `token ${this.cfg.apiKey}:${this.cfg.accessToken}`
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
