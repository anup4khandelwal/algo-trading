from __future__ import annotations

from psycopg import connect
from psycopg.rows import dict_row

from algo_trading_py.persistence.base import ManagedPosition, Persistence
from algo_trading_py.types import Fill, Order, Position


class PostgresPersistence(Persistence):
  def __init__(self, database_url: str) -> None:
    self.database_url = database_url

  def init(self) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute(
        """
        CREATE TABLE IF NOT EXISTS orders (
          order_id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          qty INTEGER NOT NULL,
          state TEXT NOT NULL,
          avg_fill_price DOUBLE PRECISION NOT NULL,
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
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS managed_positions (
          symbol TEXT PRIMARY KEY,
          qty INTEGER NOT NULL,
          atr14 DOUBLE PRECISION NOT NULL,
          stop_price DOUBLE PRECISION NOT NULL,
          highest_price DOUBLE PRECISION NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS daily_snapshots (
          id BIGSERIAL PRIMARY KEY,
          trade_date DATE NOT NULL,
          equity DOUBLE PRECISION NOT NULL,
          realized_pnl DOUBLE PRECISION NOT NULL,
          unrealized_pnl DOUBLE PRECISION NOT NULL,
          open_positions INTEGER NOT NULL,
          note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (trade_date, note)
        );
        CREATE TABLE IF NOT EXISTS system_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
      )

  def upsert_order(self, order: Order) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO orders (order_id, symbol, side, qty, state, avg_fill_price, created_at, updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (order_id) DO UPDATE
          SET state=excluded.state, avg_fill_price=excluded.avg_fill_price, updated_at=excluded.updated_at
        """,
        (
          order.order_id,
          order.symbol,
          order.side,
          order.qty,
          order.state,
          order.avg_fill_price,
          order.created_at,
          order.updated_at,
        ),
      )

  def insert_fill(self, fill: Fill) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO fills (order_id, symbol, side, qty, price, fill_time)
        VALUES (%s,%s,%s,%s,%s,%s)
        """,
        (fill.order_id, fill.symbol, fill.side, fill.qty, fill.price, fill.time),
      )

  def upsert_position(self, position: Position) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO positions (symbol, qty, avg_price, updated_at)
        VALUES (%s,%s,%s,now())
        ON CONFLICT (symbol) DO UPDATE
          SET qty=excluded.qty, avg_price=excluded.avg_price, updated_at=now()
        """,
        (position.symbol, position.qty, position.avg_price),
      )

  def delete_position(self, symbol: str) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute("DELETE FROM positions WHERE symbol=%s", (symbol,))

  def load_positions(self) -> list[Position]:
    with connect(self.database_url, row_factory=dict_row) as conn, conn.cursor() as cur:
      cur.execute("SELECT symbol, qty, avg_price FROM positions ORDER BY symbol")
      rows = cur.fetchall()
    return [Position(symbol=r["symbol"], qty=int(r["qty"]), avg_price=float(r["avg_price"])) for r in rows]

  def upsert_managed_position(self, position: ManagedPosition) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO managed_positions (symbol, qty, atr14, stop_price, highest_price, updated_at)
        VALUES (%s,%s,%s,%s,%s,now())
        ON CONFLICT (symbol) DO UPDATE
          SET qty=excluded.qty,
              atr14=excluded.atr14,
              stop_price=excluded.stop_price,
              highest_price=excluded.highest_price,
              updated_at=now()
        """,
        (position.symbol, position.qty, position.atr14, position.stop_price, position.highest_price),
      )

  def delete_managed_position(self, symbol: str) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute("DELETE FROM managed_positions WHERE symbol=%s", (symbol,))

  def load_managed_positions(self) -> list[ManagedPosition]:
    with connect(self.database_url, row_factory=dict_row) as conn, conn.cursor() as cur:
      cur.execute("SELECT symbol, qty, atr14, stop_price, highest_price FROM managed_positions")
      rows = cur.fetchall()
    return [
      ManagedPosition(
        symbol=r["symbol"],
        qty=int(r["qty"]),
        atr14=float(r["atr14"]),
        stop_price=float(r["stop_price"]),
        highest_price=float(r["highest_price"]),
      )
      for r in rows
    ]

  def upsert_daily_snapshot(
    self,
    trade_date: str,
    equity: float,
    realized_pnl: float,
    unrealized_pnl: float,
    open_positions: int,
    note: str,
  ) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO daily_snapshots (trade_date, equity, realized_pnl, unrealized_pnl, open_positions, note)
        VALUES (%s,%s,%s,%s,%s,%s)
        ON CONFLICT (trade_date, note) DO UPDATE
          SET equity=excluded.equity,
              realized_pnl=excluded.realized_pnl,
              unrealized_pnl=excluded.unrealized_pnl,
              open_positions=excluded.open_positions
        """,
        (trade_date, equity, realized_pnl, unrealized_pnl, open_positions, note),
      )

  def upsert_system_state(self, key: str, value: str) -> None:
    with connect(self.database_url, autocommit=True) as conn, conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO system_state (key, value, updated_at)
        VALUES (%s,%s,now())
        ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=now()
        """,
        (key, value),
      )

  def load_system_state(self, key: str) -> str | None:
    with connect(self.database_url, row_factory=dict_row) as conn, conn.cursor() as cur:
      cur.execute("SELECT value FROM system_state WHERE key=%s", (key,))
      row = cur.fetchone()
    return None if row is None else str(row["value"])
