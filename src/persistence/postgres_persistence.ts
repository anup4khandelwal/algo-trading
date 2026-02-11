import { Pool } from "pg";
import { Fill, Order, Position } from "../types.js";
import {
  ClosedTradeLot,
  DailySnapshot,
  ManagedPositionRecord,
  Persistence
} from "./persistence.js";

export class PostgresPersistence implements Persistence {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty INTEGER NOT NULL,
        order_type TEXT NOT NULL,
        state TEXT NOT NULL,
        filled_qty INTEGER NOT NULL,
        avg_fill_price DOUBLE PRECISION,
        idempotency_key TEXT NOT NULL,
        signal_reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fills (
        id BIGSERIAL PRIMARY KEY,
        order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty INTEGER NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        fill_time TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        symbol TEXT PRIMARY KEY,
        qty INTEGER NOT NULL,
        avg_price DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS managed_positions (
        symbol TEXT PRIMARY KEY,
        qty INTEGER NOT NULL,
        atr14 DOUBLE PRECISION NOT NULL,
        stop_price DOUBLE PRECISION NOT NULL,
        highest_price DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trade_lots (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        qty_total INTEGER NOT NULL,
        qty_open INTEGER NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        stop_price DOUBLE PRECISION NOT NULL,
        exit_price DOUBLE PRECISION,
        opened_at TIMESTAMPTZ NOT NULL,
        closed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS daily_snapshots (
        trade_date DATE PRIMARY KEY,
        equity DOUBLE PRECISION NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL,
        unrealized_pnl DOUBLE PRECISION NOT NULL,
        open_positions INTEGER NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async upsertOrder(order: Order): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO orders (
        order_id, symbol, side, qty, order_type, state, filled_qty, avg_fill_price,
        idempotency_key, signal_reason, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (order_id)
      DO UPDATE SET
        state = EXCLUDED.state,
        filled_qty = EXCLUDED.filled_qty,
        avg_fill_price = EXCLUDED.avg_fill_price,
        updated_at = EXCLUDED.updated_at
      `,
      [
        order.orderId,
        order.intent.symbol,
        order.intent.side,
        order.intent.qty,
        order.intent.type,
        order.state,
        order.filledQty,
        order.avgFillPrice ?? null,
        order.intent.idempotencyKey,
        order.intent.signalReason,
        order.createdAt,
        order.updatedAt
      ]
    );
  }

  async insertFill(fill: Fill): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO fills (order_id, symbol, side, qty, price, fill_time)
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [fill.orderId, fill.symbol, fill.side, fill.qty, fill.price, fill.time]
    );
  }

  async upsertPosition(position: Position): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO positions (symbol, qty, avg_price, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (symbol)
      DO UPDATE SET
        qty = EXCLUDED.qty,
        avg_price = EXCLUDED.avg_price,
        updated_at = EXCLUDED.updated_at
      `,
      [position.symbol, position.qty, position.avgPrice]
    );
  }

  async deletePosition(symbol: string): Promise<void> {
    await this.pool.query(`DELETE FROM positions WHERE symbol = $1`, [symbol]);
  }

  async upsertManagedPosition(position: ManagedPositionRecord): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO managed_positions (symbol, qty, atr14, stop_price, highest_price, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (symbol)
      DO UPDATE SET
        qty = EXCLUDED.qty,
        atr14 = EXCLUDED.atr14,
        stop_price = EXCLUDED.stop_price,
        highest_price = EXCLUDED.highest_price,
        updated_at = EXCLUDED.updated_at
      `,
      [
        position.symbol,
        position.qty,
        position.atr14,
        position.stopPrice,
        position.highestPrice
      ]
    );
  }

  async deleteManagedPosition(symbol: string): Promise<void> {
    await this.pool.query(`DELETE FROM managed_positions WHERE symbol = $1`, [symbol]);
  }

  async loadPositions(): Promise<Position[]> {
    const { rows } = await this.pool.query(
      `SELECT symbol, qty, avg_price FROM positions ORDER BY symbol`
    );
    return rows.map((row) => ({
      symbol: row.symbol,
      qty: Number(row.qty),
      avgPrice: Number(row.avg_price)
    }));
  }

  async loadManagedPositions(): Promise<ManagedPositionRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT symbol, qty, atr14, stop_price, highest_price FROM managed_positions ORDER BY symbol`
    );
    return rows.map((row) => ({
      symbol: row.symbol,
      qty: Number(row.qty),
      atr14: Number(row.atr14),
      stopPrice: Number(row.stop_price),
      highestPrice: Number(row.highest_price)
    }));
  }

  async recordTradeEntryLot(
    symbol: string,
    qty: number,
    entryPrice: number,
    stopPrice: number,
    openedAt: string
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO trade_lots (symbol, qty_total, qty_open, entry_price, stop_price, opened_at)
      VALUES ($1,$2,$2,$3,$4,$5)
      `,
      [symbol, qty, entryPrice, stopPrice, openedAt]
    );
  }

  async closeTradeEntryLots(
    symbol: string,
    qty: number,
    exitPrice: number,
    closedAt: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let remaining = qty;
      const { rows } = await client.query(
        `
        SELECT id, qty_open
        FROM trade_lots
        WHERE symbol = $1 AND qty_open > 0
        ORDER BY opened_at ASC, id ASC
        FOR UPDATE
        `,
        [symbol]
      );

      for (const row of rows) {
        if (remaining <= 0) {
          break;
        }
        const openQty = Number(row.qty_open);
        const closeQty = Math.min(openQty, remaining);
        const newQtyOpen = openQty - closeQty;
        if (newQtyOpen === 0) {
          await client.query(
            `
            UPDATE trade_lots
            SET qty_open = 0, exit_price = $2, closed_at = $3
            WHERE id = $1
            `,
            [row.id, exitPrice, closedAt]
          );
        } else {
          await client.query(
            `
            UPDATE trade_lots
            SET qty_open = $2
            WHERE id = $1
            `,
            [row.id, newQtyOpen]
          );
        }
        remaining -= closeQty;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async loadClosedTradeLots(limit: number): Promise<ClosedTradeLot[]> {
    const { rows } = await this.pool.query(
      `
      SELECT id, symbol, qty_total, entry_price, stop_price, exit_price, opened_at, closed_at
      FROM trade_lots
      WHERE qty_open = 0 AND closed_at IS NOT NULL AND exit_price IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return rows.map((row) => ({
      id: Number(row.id),
      symbol: row.symbol,
      qty: Number(row.qty_total),
      entryPrice: Number(row.entry_price),
      stopPrice: Number(row.stop_price),
      exitPrice: Number(row.exit_price),
      openedAt: new Date(row.opened_at).toISOString(),
      closedAt: new Date(row.closed_at).toISOString()
    }));
  }

  async upsertDailySnapshot(snapshot: DailySnapshot): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO daily_snapshots (
        trade_date, equity, realized_pnl, unrealized_pnl, open_positions, note, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (trade_date)
      DO UPDATE SET
        equity = EXCLUDED.equity,
        realized_pnl = EXCLUDED.realized_pnl,
        unrealized_pnl = EXCLUDED.unrealized_pnl,
        open_positions = EXCLUDED.open_positions,
        note = EXCLUDED.note,
        created_at = EXCLUDED.created_at
      `,
      [
        snapshot.tradeDate,
        snapshot.equity,
        snapshot.realizedPnl,
        snapshot.unrealizedPnl,
        snapshot.openPositions,
        snapshot.note ?? null,
        snapshot.createdAt
      ]
    );
  }

  async loadDailySnapshots(limit: number): Promise<DailySnapshot[]> {
    const { rows } = await this.pool.query(
      `
      SELECT trade_date, equity, realized_pnl, unrealized_pnl, open_positions, note, created_at
      FROM daily_snapshots
      ORDER BY trade_date DESC
      LIMIT $1
      `,
      [limit]
    );
    return rows.map((row) => ({
      tradeDate: formatDate(row.trade_date),
      equity: Number(row.equity),
      realizedPnl: Number(row.realized_pnl),
      unrealizedPnl: Number(row.unrealized_pnl),
      openPositions: Number(row.open_positions),
      note: row.note ?? undefined,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async upsertSystemState(key: string, value: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO system_state (key, value, updated_at)
      VALUES ($1,$2,NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
      `,
      [key, value]
    );
  }

  async loadSystemState(key: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT value FROM system_state WHERE key = $1`,
      [key]
    );
    if (rows.length === 0) {
      return null;
    }
    return rows[0].value;
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
