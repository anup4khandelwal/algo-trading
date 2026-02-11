import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { PostgresPersistence } from "../persistence/postgres_persistence.js";

dotenv.config();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("EXPORT_TRADES_FAIL: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const lookback = Number(process.env.STRATEGY_REPORT_LOOKBACK ?? "200");
  const persistence = new PostgresPersistence(databaseUrl);
  await persistence.init();
  const lots = await persistence.loadClosedTradeLots(lookback);

  await fs.mkdir("exports", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = path.join("exports", `trades-${stamp}.csv`);
  const header =
    "id,symbol,qty,entry_price,stop_price,exit_price,pnl,r_multiple,opened_at,closed_at";
  const rows = lots.map((lot) => {
    const pnl = (lot.exitPrice - lot.entryPrice) * lot.qty;
    const riskPerShare = Math.max(lot.entryPrice - lot.stopPrice, 0.01);
    const rMultiple = (lot.exitPrice - lot.entryPrice) / riskPerShare;
    return [
      lot.id,
      lot.symbol,
      lot.qty,
      lot.entryPrice.toFixed(4),
      lot.stopPrice.toFixed(4),
      lot.exitPrice.toFixed(4),
      pnl.toFixed(2),
      rMultiple.toFixed(4),
      lot.openedAt,
      lot.closedAt
    ].join(",");
  });
  await fs.writeFile(filename, [header, ...rows].join("\n") + "\n", "utf-8");
  console.log(`EXPORT_TRADES_OK: ${filename}`);
}

await main();
