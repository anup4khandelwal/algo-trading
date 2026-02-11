import fs from "node:fs/promises";
import { KiteHistoricalProvider } from "../market_data/kite_historical_provider.js";
import { PostgresPersistence } from "../persistence/postgres_persistence.js";
import { runBacktest } from "./engine.js";

export async function runConfiguredBacktest() {
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (!apiKey || !accessToken) {
    throw new Error("KITE_API_KEY and KITE_ACCESS_TOKEN are required for backtest");
  }

  const symbols = parseCsv(process.env.BACKTEST_SYMBOLS);
  const result = await runBacktest(
    new KiteHistoricalProvider({ apiKey, accessToken }),
    {
      from: process.env.BACKTEST_FROM,
      to: process.env.BACKTEST_TO,
      symbols: symbols.length > 0 ? symbols : undefined,
      initialCapital: toNumber(process.env.BACKTEST_INITIAL_CAPITAL),
      maxHoldDays: toNumber(process.env.BACKTEST_MAX_HOLD_DAYS),
      slippageBps: toNumber(process.env.BACKTEST_SLIPPAGE_BPS),
      feeBps: toNumber(process.env.BACKTEST_FEE_BPS),
      maxOpenPositions: toNumber(process.env.BACKTEST_MAX_OPEN_POSITIONS),
      minRsi: toNumber(process.env.STRATEGY_MIN_RSI),
      breakoutBufferPct: toNumber(process.env.STRATEGY_BREAKOUT_BUFFER_PCT),
      atrStopMultiple: toNumber(process.env.ATR_STOP_MULTIPLE),
      riskPerTrade: toNumber(process.env.RISK_PER_TRADE),
      minAdv20: toNumber(process.env.STRATEGY_MIN_ADV20),
      minVolumeRatio: toNumber(process.env.STRATEGY_MIN_VOLUME_RATIO),
      maxSignals: toNumber(process.env.STRATEGY_MAX_SIGNALS)
    }
  );

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const persistence = new PostgresPersistence(databaseUrl);
    await persistence.init();
    await persistence.insertBacktestRun({
      runId: result.runId,
      fromDate: result.from,
      toDate: result.to,
      symbolsCsv: result.symbols.join(","),
      initialCapital: result.initialCapital,
      finalCapital: result.finalCapital,
      totalPnl: result.totalPnl,
      trades: result.trades,
      winRate: result.winRate,
      avgR: result.avgR,
      expectancy: result.expectancy,
      maxDrawdownAbs: result.maxDrawdownAbs,
      maxDrawdownPct: result.maxDrawdownPct,
      cagrPct: result.cagrPct,
      sharpeProxy: result.sharpeProxy,
      metaJson: JSON.stringify({
        bySymbol: result.bySymbol,
        equityCurve: result.equityCurve,
        notes: result.notes
      })
    });
  }

  const outPath = process.env.BACKTEST_EXPORT_PATH ?? "exports/backtest-latest.json";
  await fs.mkdir(outPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");

  return { result, outPath };
}

function parseCsv(value: string | undefined) {
  if (!value || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x.length > 0);
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
