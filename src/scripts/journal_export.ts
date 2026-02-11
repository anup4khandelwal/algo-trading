import fs from "node:fs/promises";
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("JOURNAL_EXPORT_FAIL: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const lookback = Number(process.env.STRATEGY_REPORT_LOOKBACK ?? "200");
  const outPath = process.env.JOURNAL_EXPORT_PATH ?? "exports/trade-journal.csv";
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(
      `
      SELECT
        tl.id AS lot_id,
        tl.symbol,
        tl.qty_total AS qty,
        tl.entry_price,
        tl.exit_price,
        tl.stop_price,
        tl.opened_at,
        tl.closed_at,
        tj.setup_tag,
        tj.confidence,
        tj.mistake_tag,
        tj.notes,
        tj.screenshot_url,
        tj.updated_at
      FROM trade_lots tl
      LEFT JOIN trade_journal tj ON tj.lot_id = tl.id
      WHERE tl.qty_open = 0 AND tl.closed_at IS NOT NULL
      ORDER BY tl.closed_at DESC
      LIMIT $1
      `,
      [lookback]
    );
    const header = [
      "lot_id",
      "symbol",
      "qty",
      "entry_price",
      "exit_price",
      "stop_price",
      "opened_at",
      "closed_at",
      "setup_tag",
      "confidence",
      "mistake_tag",
      "notes",
      "screenshot_url",
      "journal_updated_at"
    ];
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(
        [
          row.lot_id,
          row.symbol,
          row.qty,
          row.entry_price,
          row.exit_price,
          row.stop_price,
          toIso(row.opened_at),
          toIso(row.closed_at),
          csvCell(row.setup_tag),
          row.confidence ?? "",
          csvCell(row.mistake_tag),
          csvCell(row.notes),
          csvCell(row.screenshot_url),
          row.updated_at ? toIso(row.updated_at) : ""
        ].join(",")
      );
    }

    await fs.mkdir(outPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf-8");
    console.log(`JOURNAL_EXPORT_OK: rows=${rows.length} file=${outPath}`);
  } catch (err) {
    console.error("JOURNAL_EXPORT_FAIL", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function toIso(v: Date | string) {
  return new Date(v).toISOString();
}

function csvCell(v: unknown) {
  if (v === null || v === undefined) {
    return "";
  }
  const text = String(v).replace(/"/g, '""');
  return `"${text}"`;
}

await main();
