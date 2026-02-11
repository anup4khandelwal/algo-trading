import dotenv from "dotenv";
import { runConfiguredBacktest } from "../backtest/service.js";

dotenv.config();

async function main() {
  try {
    const { result, outPath } = await runConfiguredBacktest();
    console.log("=== BACKTEST RESULT ===");
    console.log(`run_id: ${result.runId}`);
    console.log(`period: ${result.from} -> ${result.to}`);
    console.log(`symbols: ${result.symbols.length}`);
    console.log(`trades: ${result.trades}`);
    console.log(`win_rate: ${(result.winRate * 100).toFixed(2)}%`);
    console.log(`total_pnl_inr: ${result.totalPnl.toFixed(2)}`);
    console.log(`final_capital_inr: ${result.finalCapital.toFixed(2)}`);
    console.log(`max_drawdown_inr: ${result.maxDrawdownAbs.toFixed(2)}`);
    console.log(`max_drawdown_pct: ${(result.maxDrawdownPct * 100).toFixed(2)}%`);
    console.log(`cagr_pct: ${result.cagrPct.toFixed(2)}%`);
    console.log(`sharpe_proxy: ${result.sharpeProxy.toFixed(3)}`);
    console.log(`export: ${outPath}`);
  } catch (err) {
    console.error("BACKTEST_FAIL", err);
    process.exitCode = 1;
  }
}

await main();
