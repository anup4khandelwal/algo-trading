import { KiteHistoricalProvider } from "../market_data/kite_historical_provider.js";
import { SignalBuilder } from "../signal/signal_builder.js";
import { MarketBar, ScreenerResult } from "../types.js";
import { atr, ema, pctChange, rsi, sma } from "../utils/indicators.js";

type OpenTrade = {
  symbol: string;
  entryTime: string;
  entryPrice: number;
  entryStop: number;
  targetPrice: number;
  qty: number;
  daysHeld: number;
};

type ClosedTrade = {
  symbol: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  rMultiple: number;
  reason: string;
};

export type BacktestConfig = {
  from: string;
  to: string;
  symbols: string[];
  initialCapital: number;
  maxHoldDays: number;
  slippageBps: number;
  feeBps: number;
  maxOpenPositions: number;
  minRsi: number;
  breakoutBufferPct: number;
  atrStopMultiple: number;
  riskPerTrade: number;
  minAdv20: number;
  minVolumeRatio: number;
  maxSignals: number;
};

export type BacktestRunResult = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  from: string;
  to: string;
  symbols: string[];
  initialCapital: number;
  finalCapital: number;
  totalPnl: number;
  trades: number;
  winRate: number;
  avgR: number;
  expectancy: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
  cagrPct: number;
  sharpeProxy: number;
  bySymbol: Array<{
    symbol: string;
    trades: number;
    winRate: number;
    pnl: number;
    avgR: number;
  }>;
  equityCurve: Array<{
    date: string;
    equity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    openPositions: number;
  }>;
  notes: string[];
};

const DEFAULT_SYMBOLS = [
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
  "TATAMOTORS",
  "TATASTEEL"
];

export async function runBacktest(
  provider: KiteHistoricalProvider,
  cfg: Partial<BacktestConfig>
): Promise<BacktestRunResult> {
  const startedAt = new Date().toISOString();
  const runId = `bt-${Date.now()}`;
  const config = resolveConfig(cfg);

  const barsBySymbol = await loadBars(provider, config.symbols, config.from, config.to);
  const usableSymbols = Array.from(barsBySymbol.keys());
  const notes: string[] = [];
  if (usableSymbols.length === 0) {
    throw new Error("No symbols have enough historical bars for selected range");
  }
  if (usableSymbols.length < config.symbols.length) {
    notes.push(
      `Skipped ${config.symbols.length - usableSymbols.length} symbols due to missing/short history.`
    );
  }

  const tradingDays = buildTradingCalendar(barsBySymbol);
  const signalBuilder = new SignalBuilder({
    minRsi: config.minRsi,
    breakoutBufferPct: config.breakoutBufferPct,
    atrStopMultiple: config.atrStopMultiple,
    riskPerTrade: config.riskPerTrade,
    minAdv20: config.minAdv20,
    minVolumeRatio: config.minVolumeRatio,
    maxSignals: config.maxSignals
  });

  let realizedPnl = 0;
  const openTrades = new Map<string, OpenTrade>();
  const closedTrades: ClosedTrade[] = [];
  const equityCurve: BacktestRunResult["equityCurve"] = [];

  for (const day of tradingDays) {
    const bySymbol = buildDayBarMap(barsBySymbol, day);

    // Exit checks run before fresh entries to avoid same-day re-entry churn.
    for (const trade of Array.from(openTrades.values())) {
      const bar = bySymbol.get(trade.symbol);
      if (!bar) {
        trade.daysHeld += 1;
        continue;
      }
      trade.daysHeld += 1;
      const exit = resolveExit(bar, trade, config.maxHoldDays);
      if (!exit) {
        continue;
      }

      const exitPrice = applySlippage(exit.price, "SELL", config.slippageBps);
      const turnover = trade.entryPrice * trade.qty + exitPrice * trade.qty;
      const fees = turnover * (config.feeBps / 10_000);
      const pnl = (exitPrice - trade.entryPrice) * trade.qty - fees;
      realizedPnl += pnl;
      const riskPerShare = Math.max(trade.entryPrice - trade.entryStop, 0.01);
      const rMultiple = (exitPrice - trade.entryPrice) / riskPerShare;

      closedTrades.push({
        symbol: trade.symbol,
        entryTime: trade.entryTime,
        exitTime: bar.time,
        entryPrice: trade.entryPrice,
        exitPrice,
        qty: trade.qty,
        pnl,
        rMultiple,
        reason: exit.reason
      });
      openTrades.delete(trade.symbol);
    }

    const currentEquity = config.initialCapital + realizedPnl;
    const candidates = buildCandidatesForDay(barsBySymbol, day);
    const signals = signalBuilder.buildSignals(candidates, currentEquity);
    for (const signal of signals) {
      if (openTrades.size >= config.maxOpenPositions) {
        break;
      }
      if (openTrades.has(signal.symbol) || signal.qty <= 0) {
        continue;
      }
      const bar = bySymbol.get(signal.symbol);
      if (!bar) {
        continue;
      }
      const entryPrice = applySlippage(signal.entryPrice, "BUY", config.slippageBps);
      openTrades.set(signal.symbol, {
        symbol: signal.symbol,
        entryTime: bar.time,
        entryPrice,
        entryStop: signal.stopPrice,
        targetPrice: signal.targetPrice ?? signal.entryPrice * 1.04,
        qty: signal.qty,
        daysHeld: 0
      });
    }

    const unrealizedPnl = computeUnrealizedPnl(openTrades, bySymbol);
    const equity = config.initialCapital + realizedPnl + unrealizedPnl;
    equityCurve.push({
      date: day,
      equity,
      realizedPnl,
      unrealizedPnl,
      openPositions: openTrades.size
    });
  }

  const finalMap = buildDayBarMap(barsBySymbol, tradingDays[tradingDays.length - 1] ?? config.to);
  for (const trade of Array.from(openTrades.values())) {
    const bar = finalMap.get(trade.symbol);
    if (!bar) {
      continue;
    }
    const exitPrice = applySlippage(bar.close, "SELL", config.slippageBps);
    const turnover = trade.entryPrice * trade.qty + exitPrice * trade.qty;
    const fees = turnover * (config.feeBps / 10_000);
    const pnl = (exitPrice - trade.entryPrice) * trade.qty - fees;
    realizedPnl += pnl;
    const riskPerShare = Math.max(trade.entryPrice - trade.entryStop, 0.01);
    const rMultiple = (exitPrice - trade.entryPrice) / riskPerShare;
    closedTrades.push({
      symbol: trade.symbol,
      entryTime: trade.entryTime,
      exitTime: bar.time,
      entryPrice: trade.entryPrice,
      exitPrice,
      qty: trade.qty,
      pnl,
      rMultiple,
      reason: "forced_eod"
    });
    openTrades.delete(trade.symbol);
  }

  const finalCapital = config.initialCapital + realizedPnl;
  const metrics = computeMetrics(config.initialCapital, finalCapital, closedTrades, equityCurve);
  const finishedAt = new Date().toISOString();

  return {
    runId,
    startedAt,
    finishedAt,
    from: config.from,
    to: config.to,
    symbols: usableSymbols,
    initialCapital: config.initialCapital,
    finalCapital,
    totalPnl: realizedPnl,
    trades: closedTrades.length,
    winRate: metrics.winRate,
    avgR: metrics.avgR,
    expectancy: metrics.expectancy,
    maxDrawdownAbs: metrics.maxDrawdownAbs,
    maxDrawdownPct: metrics.maxDrawdownPct,
    cagrPct: metrics.cagrPct,
    sharpeProxy: metrics.sharpeProxy,
    bySymbol: summarizeBySymbol(closedTrades),
    equityCurve,
    notes
  };
}

async function loadBars(
  provider: KiteHistoricalProvider,
  symbols: string[],
  from: string,
  to: string
): Promise<Map<string, MarketBar[]>> {
  const instruments = await provider.getInstruments("NSE");
  const out = new Map<string, MarketBar[]>();
  for (const symbol of symbols) {
    const inst = instruments.get(symbol);
    if (!inst) {
      continue;
    }
    try {
      const bars = await provider.getHistoricalDayBars(inst.instrumentToken, from, to);
      const normalized = bars
        .map((b) => ({ ...b, symbol }))
        .filter((b) => Number.isFinite(b.close) && Number.isFinite(b.volume))
        .sort((a, b) => a.time.localeCompare(b.time));
      if (normalized.length >= 80) {
        out.set(symbol, normalized);
      }
    } catch {
      // Skip symbols that fail due to temporary API/instrument issues.
    }
  }
  return out;
}

function buildTradingCalendar(barsBySymbol: Map<string, MarketBar[]>) {
  const dates = new Set<string>();
  for (const bars of barsBySymbol.values()) {
    for (const bar of bars) {
      dates.add(bar.time.slice(0, 10));
    }
  }
  return Array.from(dates).sort();
}

function buildDayBarMap(barsBySymbol: Map<string, MarketBar[]>, day: string) {
  const out = new Map<string, MarketBar>();
  for (const [symbol, bars] of barsBySymbol.entries()) {
    const bar = bars.find((x) => x.time.slice(0, 10) === day);
    if (bar) {
      out.set(symbol, bar);
    }
  }
  return out;
}

function buildCandidatesForDay(
  barsBySymbol: Map<string, MarketBar[]>,
  day: string
): ScreenerResult[] {
  const out: ScreenerResult[] = [];
  for (const [symbol, bars] of barsBySymbol.entries()) {
    const idx = bars.findIndex((b) => b.time.slice(0, 10) === day);
    if (idx < 61) {
      continue;
    }
    const slice = bars.slice(0, idx + 1);
    if (slice.length < 80) {
      continue;
    }
    const closes = slice.map((b) => b.close);
    const volumes = slice.map((b) => b.volume);
    const highs = slice.map((b) => b.high);
    const lows = slice.map((b) => b.low);
    try {
      const close = closes[closes.length - 1];
      const ema20 = ema(closes, 20);
      const ema50 = ema(closes, 50);
      const rsi14 = rsi(closes, 14);
      const atr14 = atr(highs, lows, closes, 14);
      const high20 = Math.max(...highs.slice(-20));
      const adv20 = averageTradedValue(closes.slice(-20), volumes.slice(-20));
      const volumeRatio = sma(volumes.slice(-20)) / sma(volumes.slice(-50));
      const rsScore60d = pctChange(closes[closes.length - 61], close);
      out.push({
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
      });
    } catch {
      // Ignore symbol on malformed series.
    }
  }
  return out.sort((a, b) => b.rsScore60d - a.rsScore60d);
}

function averageTradedValue(closes: number[], volumes: number[]) {
  return sma(closes.map((close, i) => close * volumes[i]));
}

function resolveExit(
  bar: MarketBar,
  trade: OpenTrade,
  maxHoldDays: number
): { price: number; reason: string } | null {
  if (bar.low <= trade.entryStop) {
    return { price: trade.entryStop, reason: "stop_loss" };
  }
  if (bar.high >= trade.targetPrice) {
    return { price: trade.targetPrice, reason: "target_hit" };
  }
  if (trade.daysHeld >= maxHoldDays) {
    return { price: bar.close, reason: "max_hold" };
  }
  return null;
}

function applySlippage(price: number, side: "BUY" | "SELL", slippageBps: number) {
  const factor = slippageBps / 10_000;
  return side === "BUY" ? price * (1 + factor) : price * (1 - factor);
}

function computeUnrealizedPnl(openTrades: Map<string, OpenTrade>, dayBars: Map<string, MarketBar>) {
  let total = 0;
  for (const trade of openTrades.values()) {
    const bar = dayBars.get(trade.symbol);
    if (!bar) {
      continue;
    }
    total += (bar.close - trade.entryPrice) * trade.qty;
  }
  return total;
}

function computeMetrics(
  initialCapital: number,
  finalCapital: number,
  trades: ClosedTrade[],
  equityCurve: BacktestRunResult["equityCurve"]
) {
  const wins = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length === 0 ? 0 : wins / trades.length;
  const avgR = avg(trades.map((t) => t.rMultiple));
  const expectancy = avg(trades.map((t) => t.pnl));
  const maxDrawdownAbs = maxDrawdownAbsFromEquity(equityCurve.map((x) => x.equity));
  const maxDrawdownPct = maxDrawdownPctFromEquity(equityCurve.map((x) => x.equity));
  const cagrPct = calcCagr(equityCurve, initialCapital, finalCapital);
  const sharpeProxy = calcSharpeProxy(equityCurve);
  return { winRate, avgR, expectancy, maxDrawdownAbs, maxDrawdownPct, cagrPct, sharpeProxy };
}

function summarizeBySymbol(trades: ClosedTrade[]) {
  const map = new Map<string, { trades: number; wins: number; pnl: number; r: number }>();
  for (const trade of trades) {
    const current = map.get(trade.symbol) ?? { trades: 0, wins: 0, pnl: 0, r: 0 };
    current.trades += 1;
    if (trade.pnl > 0) {
      current.wins += 1;
    }
    current.pnl += trade.pnl;
    current.r += trade.rMultiple;
    map.set(trade.symbol, current);
  }
  return Array.from(map.entries())
    .map(([symbol, x]) => ({
      symbol,
      trades: x.trades,
      winRate: x.trades === 0 ? 0 : x.wins / x.trades,
      pnl: x.pnl,
      avgR: x.trades === 0 ? 0 : x.r / x.trades
    }))
    .sort((a, b) => b.pnl - a.pnl);
}

function resolveConfig(cfg: Partial<BacktestConfig>): BacktestConfig {
  return {
    from: cfg.from ?? process.env.BACKTEST_FROM ?? dateOffset(365),
    to: cfg.to ?? process.env.BACKTEST_TO ?? todayDate(),
    symbols: cfg.symbols ?? parseCsv(process.env.BACKTEST_SYMBOLS, DEFAULT_SYMBOLS),
    initialCapital: cfg.initialCapital ?? Number(process.env.BACKTEST_INITIAL_CAPITAL ?? "1000000"),
    maxHoldDays: cfg.maxHoldDays ?? Number(process.env.BACKTEST_MAX_HOLD_DAYS ?? "15"),
    slippageBps: cfg.slippageBps ?? Number(process.env.BACKTEST_SLIPPAGE_BPS ?? "5"),
    feeBps: cfg.feeBps ?? Number(process.env.BACKTEST_FEE_BPS ?? "12"),
    maxOpenPositions: cfg.maxOpenPositions ?? Number(process.env.BACKTEST_MAX_OPEN_POSITIONS ?? "5"),
    minRsi: cfg.minRsi ?? Number(process.env.STRATEGY_MIN_RSI ?? "55"),
    breakoutBufferPct: cfg.breakoutBufferPct ?? Number(process.env.STRATEGY_BREAKOUT_BUFFER_PCT ?? "0.02"),
    atrStopMultiple: cfg.atrStopMultiple ?? Number(process.env.ATR_STOP_MULTIPLE ?? "2"),
    riskPerTrade: cfg.riskPerTrade ?? Number(process.env.RISK_PER_TRADE ?? "0.015"),
    minAdv20: cfg.minAdv20 ?? Number(process.env.STRATEGY_MIN_ADV20 ?? "100000000"),
    minVolumeRatio: cfg.minVolumeRatio ?? Number(process.env.STRATEGY_MIN_VOLUME_RATIO ?? "1.2"),
    maxSignals: cfg.maxSignals ?? Number(process.env.STRATEGY_MAX_SIGNALS ?? "5")
  };
}

function parseCsv(value: string | undefined, fallback: string[]) {
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  return value
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x.length > 0);
}

function maxDrawdownAbsFromEquity(series: number[]) {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDd = 0;
  for (const v of series) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, peak - v);
  }
  return maxDd;
}

function maxDrawdownPctFromEquity(series: number[]) {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDd = 0;
  for (const v of series) {
    peak = Math.max(peak, v);
    if (peak > 0) {
      maxDd = Math.max(maxDd, (peak - v) / peak);
    }
  }
  return maxDd;
}

function calcCagr(
  equityCurve: BacktestRunResult["equityCurve"],
  initialCapital: number,
  finalCapital: number
) {
  if (equityCurve.length < 2 || initialCapital <= 0 || finalCapital <= 0) {
    return 0;
  }
  const start = new Date(`${equityCurve[0].date}T00:00:00.000Z`).getTime();
  const end = new Date(`${equityCurve[equityCurve.length - 1].date}T00:00:00.000Z`).getTime();
  const years = Math.max((end - start) / (365.25 * 24 * 3600 * 1000), 1 / 252);
  return (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100;
}

function calcSharpeProxy(equityCurve: BacktestRunResult["equityCurve"]) {
  if (equityCurve.length < 3) {
    return 0;
  }
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1].equity;
    const curr = equityCurve[i].equity;
    if (prev > 0) {
      returns.push((curr - prev) / prev);
    }
  }
  const mu = avg(returns);
  const sigma = std(returns);
  if (sigma === 0) {
    return 0;
  }
  return (mu / sigma) * Math.sqrt(252);
}

function avg(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function std(values: number[]) {
  if (values.length < 2) {
    return 0;
  }
  const mu = avg(values);
  const variance = avg(values.map((v) => (v - mu) ** 2));
  return Math.sqrt(variance);
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function dateOffset(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
