import { LtpProvider } from "./ltp_provider.js";

export interface KiteLtpProviderConfig {
  apiKey: string;
  accessToken: string;
  exchange?: string; // default NSE
  baseUrl?: string; // default https://api.kite.trade
}

export class KiteLtpProvider implements LtpProvider {
  private exchange: string;
  private baseUrl: string;

  constructor(private cfg: KiteLtpProviderConfig) {
    this.exchange = cfg.exchange ?? "NSE";
    this.baseUrl = cfg.baseUrl ?? "https://api.kite.trade";
  }

  async getLtp(symbol: string): Promise<number> {
    const key = this.toInstrumentKey(symbol);
    const url = new URL(`${this.baseUrl}/quote/ltp`);
    url.searchParams.append("i", key);

    const res = await fetch(url.toString(), {
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${this.cfg.apiKey}:${this.cfg.accessToken}`
      }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kite LTP error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      status: string;
      data?: Record<string, { last_price: number }>;
    };

    const ltp = json.data?.[key]?.last_price;
    if (ltp === undefined) {
      throw new Error(`LTP missing for ${key}`);
    }
    return ltp;
  }

  private toInstrumentKey(symbol: string): string {
    if (symbol.includes(":")) {
      return symbol;
    }
    return `${this.exchange}:${symbol}`;
  }
}
