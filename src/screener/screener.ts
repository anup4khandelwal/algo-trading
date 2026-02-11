import { KiteHistoricalProvider } from "../market_data/kite_historical_provider.js";
import { ScreenerResult } from "../types.js";
import { atr, ema, pctChange, rsi, sma } from "../utils/indicators.js";
import { asyncPool } from "../utils/async_pool.js";

export class ScreenerService {
  constructor(private historicalProvider?: KiteHistoricalProvider) {}

  async getCandidates(): Promise<ScreenerResult[]> {
    if (!this.historicalProvider) {
      throw new Error("ScreenerService requires Kite historical provider");
    }
    const provider = this.historicalProvider;

    const instruments = await provider.getInstruments("NSE");
    const { from, to } = lookbackWindow(160);
    const symbols = await this.getTopLiquidUniverse(instruments);
    const benchmark = await this.loadNiftyReturn(instruments);
    const concurrency = Number(process.env.SCREENER_CONCURRENCY ?? "6");

    const computed = await asyncPool(symbols, concurrency, async (symbol) => {
      const instrument = instruments.get(symbol);
      if (!instrument) {
        console.warn(`Skipping ${symbol}: instrument not found`);
        return null;
      }

      const bars = await provider.getHistoricalDayBars(
        instrument.instrumentToken,
        from,
        to
      );

      if (bars.length < 80) {
        console.warn(`Skipping ${symbol}: insufficient candles (${bars.length})`);
        return null;
      }

      const closes = bars.map((b) => b.close);
      const volumes = bars.map((b) => b.volume);
      const highs = bars.map((b) => b.high);
      const lows = bars.map((b) => b.low);

      const close = last(closes);
      const ema20 = ema(closes, 20);
      const ema50 = ema(closes, 50);
      const rsi14 = rsi(closes, 14);
      const atr14 = atr(highs, lows, closes, 14);
      const high20 = Math.max(...highs.slice(-20));
      const adv20 = averageTradedValue(closes.slice(-20), volumes.slice(-20));
      const volumeRatio = sma(volumes.slice(-20)) / sma(volumes.slice(-50));
      const stockRet60 = pctChange(closes[closes.length - 61], close);
      const rsScore60d = stockRet60 - benchmark;

      return {
        symbol,
        close,
        ema20,
        ema50,
        rsi14,
        atr14,
        rsScore60d,
        adv20,
        volumeRatio,
        high20
      };
    });

    const results = computed.filter((r): r is ScreenerResult => r !== null);

    return results.sort((a, b) => b.rsScore60d - a.rsScore60d);
  }

  private async getTopLiquidUniverse(
    instruments: Map<
      string,
      {
        instrumentToken: string;
        tradingsymbol: string;
        exchange: string;
        segment: string;
        instrumentType: string;
      }
    >
  ): Promise<string[]> {
    const maxSymbols = Number(process.env.SCREENER_MAX_SYMBOLS ?? "30");
    const minPrice = Number(process.env.SCREENER_MIN_PRICE ?? "50");
    const maxPrice = Number(process.env.SCREENER_MAX_PRICE ?? "10000");

    const seeds = LIQUID_SYMBOL_SEED.filter((symbol) => {
      const inst = instruments.get(symbol);
      return inst && inst.exchange === "NSE" && inst.segment === "NSE" && inst.instrumentType === "EQ";
    });
    const { from, to } = lookbackWindow(45);

    const concurrency = Number(process.env.SCREENER_CONCURRENCY ?? "6");
    const ranked = await asyncPool(seeds, concurrency, async (symbol) => {
      const inst = instruments.get(symbol);
      if (!inst) {
        return null;
      }
      const bars = await this.historicalProvider!.getHistoricalDayBars(
        inst.instrumentToken,
        from,
        to
      );
      if (bars.length < 20) {
        return null;
      }
      const closes = bars.map((b) => b.close);
      const volumes = bars.map((b) => b.volume);
      const adv20 = averageTradedValue(closes.slice(-20), volumes.slice(-20));
      const lastPrice = closes[closes.length - 1];
      return { symbol, tradedValue: adv20, lastPrice };
    });

    return ranked
      .filter((item): item is { symbol: string; tradedValue: number; lastPrice: number } => item !== null)
      .filter((item) => item.lastPrice >= minPrice && item.lastPrice <= maxPrice)
      .sort((a, b) => b.tradedValue - a.tradedValue)
      .slice(0, maxSymbols)
      .map((r) => r.symbol);
  }

  private async loadNiftyReturn(
    instruments: Map<string, { instrumentToken: string }>
  ): Promise<number> {
    const nifty = instruments.get("NIFTY 50");
    if (!nifty) {
      return 0;
    }

    const { from, to } = lookbackWindow(90);
    const bars = await this.historicalProvider!.getHistoricalDayBars(
      nifty.instrumentToken,
      from,
      to
    );

    if (bars.length < 61) {
      return 0;
    }

    const closes = bars.map((b) => b.close);
    return pctChange(closes[closes.length - 61], closes[closes.length - 1]);
  }
}

function lookbackWindow(days: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - days);
  return {
    from: formatDate(from),
    to: formatDate(now)
  };
}

function formatDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function averageTradedValue(closes: number[], volumes: number[]): number {
  const values = closes.map((close, i) => close * volumes[i]);
  return sma(values);
}

function last(values: number[]): number {
  return values[values.length - 1];
}

const LIQUID_SYMBOL_SEED = [
  "RELIANCE",
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "SBIN",
  "LT",
  "AXISBANK",
  "KOTAKBANK",
  "ITC",
  "HINDUNILVR",
  "BAJFINANCE",
  "MARUTI",
  "TATAMOTORS",
  "M&M",
  "WIPRO",
  "ASIANPAINT",
  "SUNPHARMA",
  "TITAN",
  "ULTRACEMCO",
  "NTPC",
  "POWERGRID",
  "ONGC",
  "BHARTIARTL",
  "ADANIENT",
  "ADANIPORTS",
  "HCLTECH",
  "JSWSTEEL",
  "TATASTEEL",
  "INDUSINDBK",
  "TECHM",
  "BAJAJFINSV",
  "BAJAJ-AUTO",
  "EICHERMOT",
  "COALINDIA",
  "NESTLEIND",
  "GRASIM",
  "HEROMOTOCO",
  "CIPLA",
  "DRREDDY",
  "HDFCLIFE",
  "SBILIFE",
  "DIVISLAB",
  "BPCL",
  "HINDALCO",
  "APOLLOHOSP",
  "BRITANNIA",
  "PIDILITIND",
  "SHRIRAMFIN",
  "SIEMENS",
  "TRENT",
  "BEL",
  "DLF",
  "LODHA",
  "GODREJCP",
  "INDIGO",
  "ZOMATO",
  "IRCTC",
  "PFC",
  "RECLTD"
];
