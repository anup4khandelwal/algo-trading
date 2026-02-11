import dotenv from "dotenv";
import { PostgresPersistence } from "../persistence/postgres_persistence.js";

dotenv.config();

type TradeMetric = {
  symbol: string;
  pnl: number;
  rMultiple: number;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const lookback = Number(process.env.STRATEGY_REPORT_LOOKBACK ?? "200");
  if (!databaseUrl) {
    console.error("STRATEGY_REPORT_FAIL: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const persistence = new PostgresPersistence(databaseUrl);
  await persistence.init();
  const lots = await persistence.loadClosedTradeLots(lookback);

  if (lots.length === 0) {
    console.log("STRATEGY_REPORT: no closed trade lots found");
    return;
  }

  const metrics: TradeMetric[] = lots.map((lot) => {
    const pnl = (lot.exitPrice - lot.entryPrice) * lot.qty;
    const initialRiskPerShare = Math.max(lot.entryPrice - lot.stopPrice, 0.01);
    const rMultiple = (lot.exitPrice - lot.entryPrice) / initialRiskPerShare;
    return {
      symbol: lot.symbol,
      pnl,
      rMultiple
    };
  });

  const wins = metrics.filter((m) => m.pnl > 0).length;
  const winRate = wins / metrics.length;
  const avgR = avg(metrics.map((m) => m.rMultiple));
  const totalPnl = sum(metrics.map((m) => m.pnl));
  const avgPnl = totalPnl / metrics.length;
  const drawdown = maxDrawdown(metrics.map((m) => m.pnl));

  const bySymbol = summarizeBySymbol(metrics);

  console.log("=== STRATEGY REPORT ===");
  console.log(`closed_lots: ${metrics.length}`);
  console.log(`win_rate: ${(winRate * 100).toFixed(2)}%`);
  console.log(`avg_r_multiple: ${avgR.toFixed(3)}`);
  console.log(`total_pnl_inr: ${totalPnl.toFixed(2)}`);
  console.log(`avg_pnl_inr: ${avgPnl.toFixed(2)}`);
  console.log(`max_drawdown_inr: ${drawdown.toFixed(2)}`);
  console.log("by_symbol:");
  for (const row of bySymbol) {
    console.log(
      `  ${row.symbol} | trades=${row.trades} | win_rate=${(row.winRate * 100).toFixed(1)}% | avg_r=${row.avgR.toFixed(3)} | pnl=${row.pnl.toFixed(2)}`
    );
  }
}

function summarizeBySymbol(metrics: TradeMetric[]) {
  const map = new Map<
    string,
    { symbol: string; trades: number; wins: number; pnl: number; r: number }
  >();
  for (const m of metrics) {
    const cur = map.get(m.symbol) ?? {
      symbol: m.symbol,
      trades: 0,
      wins: 0,
      pnl: 0,
      r: 0
    };
    cur.trades += 1;
    if (m.pnl > 0) {
      cur.wins += 1;
    }
    cur.pnl += m.pnl;
    cur.r += m.rMultiple;
    map.set(m.symbol, cur);
  }

  return Array.from(map.values())
    .map((row) => ({
      symbol: row.symbol,
      trades: row.trades,
      winRate: row.wins / row.trades,
      avgR: row.r / row.trades,
      pnl: row.pnl
    }))
    .sort((a, b) => b.pnl - a.pnl);
}

function sum(values: number[]) {
  return values.reduce((acc, v) => acc + v, 0);
}

function avg(values: number[]) {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function maxDrawdown(pnlSeries: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const pnl of pnlSeries) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

await main();
