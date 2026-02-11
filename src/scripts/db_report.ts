import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DB_REPORT_FAIL: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");

    const orders = await pool.query(
      `
      SELECT order_id, symbol, side, qty, state, avg_fill_price, updated_at
      FROM orders
      ORDER BY updated_at DESC
      LIMIT 10
      `
    );

    const fills = await pool.query(
      `
      SELECT order_id, symbol, side, qty, price, fill_time
      FROM fills
      ORDER BY fill_time DESC
      LIMIT 10
      `
    );

    const positions = await pool.query(
      `
      SELECT symbol, qty, avg_price, updated_at
      FROM positions
      ORDER BY symbol
      `
    );

    const managed = await pool.query(
      `
      SELECT symbol, qty, atr14, stop_price, highest_price, updated_at
      FROM managed_positions
      ORDER BY symbol
      `
    );

    const snapshotTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.daily_snapshots') AS exists`
    );
    const snapshots =
      snapshotTable.rows[0]?.exists
        ? await pool.query(
            `
            SELECT trade_date, equity, realized_pnl, unrealized_pnl, open_positions, note, created_at
            FROM daily_snapshots
            ORDER BY trade_date DESC
            LIMIT 10
            `
          )
        : { rowCount: 0, rows: [] as any[] };

    const systemStateTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.system_state') AS exists`
    );
    const systemState =
      systemStateTable.rows[0]?.exists
        ? await pool.query(`SELECT key, value, updated_at FROM system_state ORDER BY key`)
        : { rowCount: 0, rows: [] as any[] };

    const alertTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.alert_events') AS exists`
    );
    const alerts =
      alertTable.rows[0]?.exists
        ? await pool.query(
            `
            SELECT id, severity, type, message, created_at
            FROM alert_events
            ORDER BY created_at DESC
            LIMIT 10
            `
          )
        : { rowCount: 0, rows: [] as any[] };

    const reconcileTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.reconcile_audit') AS exists`
    );
    const reconcile =
      reconcileTable.rows[0]?.exists
        ? await pool.query(
            `
            SELECT id, run_id, drift_count, details_json, created_at
            FROM reconcile_audit
            ORDER BY created_at DESC
            LIMIT 10
            `
          )
        : { rowCount: 0, rows: [] as any[] };

    const backtestTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.backtest_runs') AS exists`
    );
    const backtests =
      backtestTable.rows[0]?.exists
        ? await pool.query(
            `
            SELECT run_id, from_date, to_date, symbols_csv, trades, total_pnl, max_drawdown_abs, cagr_pct, created_at
            FROM backtest_runs
            ORDER BY created_at DESC
            LIMIT 5
            `
          )
        : { rowCount: 0, rows: [] as any[] };

    console.log("=== DB REPORT ===");
    console.log(`orders(last10): ${orders.rowCount ?? 0}`);
    for (const row of orders.rows) {
      console.log(
        `  ${row.updated_at.toISOString()} | ${row.order_id} | ${row.symbol} | ${row.side} ${row.qty} | ${row.state} | avg=${row.avg_fill_price ?? "NA"}`
      );
    }

    console.log(`fills(last10): ${fills.rowCount ?? 0}`);
    for (const row of fills.rows) {
      console.log(
        `  ${row.fill_time.toISOString()} | ${row.order_id} | ${row.symbol} | ${row.side} ${row.qty} @ ${row.price}`
      );
    }

    console.log(`positions: ${positions.rowCount ?? 0}`);
    for (const row of positions.rows) {
      console.log(
        `  ${row.symbol} | qty=${row.qty} | avg=${row.avg_price} | updated=${row.updated_at.toISOString()}`
      );
    }

    console.log(`managed_positions: ${managed.rowCount ?? 0}`);
    for (const row of managed.rows) {
      console.log(
        `  ${row.symbol} | qty=${row.qty} | atr14=${row.atr14} | stop=${row.stop_price} | high=${row.highest_price} | updated=${row.updated_at.toISOString()}`
      );
    }

    console.log(`daily_snapshots(last10): ${snapshots.rowCount ?? 0}`);
    for (const row of snapshots.rows) {
      console.log(
        `  ${formatDate(row.trade_date)} | equity=${row.equity} | realized=${row.realized_pnl} | unrealized=${row.unrealized_pnl} | open=${row.open_positions} | note=${row.note ?? ""} | created=${row.created_at.toISOString()}`
      );
    }

    console.log(`system_state: ${systemState.rowCount ?? 0}`);
    for (const row of systemState.rows) {
      console.log(`  ${row.key}=${row.value} | updated=${row.updated_at.toISOString()}`);
    }

    console.log(`alert_events(last10): ${alerts.rowCount ?? 0}`);
    for (const row of alerts.rows) {
      console.log(
        `  ${row.created_at.toISOString()} | ${row.severity} | ${row.type} | ${row.message}`
      );
    }

    console.log(`reconcile_audit(last10): ${reconcile.rowCount ?? 0}`);
    for (const row of reconcile.rows) {
      console.log(
        `  ${row.created_at.toISOString()} | ${row.run_id} | drift=${row.drift_count} | details=${row.details_json ?? ""}`
      );
    }

    console.log(`backtest_runs(last5): ${backtests.rowCount ?? 0}`);
    for (const row of backtests.rows) {
      console.log(
        `  ${row.created_at.toISOString()} | ${row.run_id} | ${formatDate(row.from_date)}->${formatDate(row.to_date)} | trades=${row.trades} | pnl=${row.total_pnl} | dd=${row.max_drawdown_abs} | cagr=${row.cagr_pct}% | symbols=${row.symbols_csv}`
      );
    }
  } catch (err) {
    console.error("DB_REPORT_FAIL: Unable to query database");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
