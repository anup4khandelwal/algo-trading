import { Fill, Order, Position } from "../types.js";

export interface ManagedPositionRecord {
  symbol: string;
  qty: number;
  atr14: number;
  stopPrice: number;
  highestPrice: number;
}

export interface ClosedTradeLot {
  id: number;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  exitPrice: number;
  openedAt: string;
  closedAt: string;
}

export interface DailySnapshot {
  tradeDate: string;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openPositions: number;
  note?: string;
  createdAt: string;
}

export interface Persistence {
  init(): Promise<void>;
  upsertOrder(order: Order): Promise<void>;
  insertFill(fill: Fill): Promise<void>;
  upsertPosition(position: Position): Promise<void>;
  deletePosition(symbol: string): Promise<void>;
  upsertManagedPosition(position: ManagedPositionRecord): Promise<void>;
  deleteManagedPosition(symbol: string): Promise<void>;
  loadPositions(): Promise<Position[]>;
  loadManagedPositions(): Promise<ManagedPositionRecord[]>;
  recordTradeEntryLot(
    symbol: string,
    qty: number,
    entryPrice: number,
    stopPrice: number,
    openedAt: string
  ): Promise<void>;
  closeTradeEntryLots(
    symbol: string,
    qty: number,
    exitPrice: number,
    closedAt: string
  ): Promise<void>;
  loadClosedTradeLots(limit: number): Promise<ClosedTradeLot[]>;
  upsertDailySnapshot(snapshot: DailySnapshot): Promise<void>;
  loadDailySnapshots(limit: number): Promise<DailySnapshot[]>;
  upsertSystemState(key: string, value: string): Promise<void>;
  loadSystemState(key: string): Promise<string | null>;
}

export class NoopPersistence implements Persistence {
  async init(): Promise<void> {}
  async upsertOrder(_order: Order): Promise<void> {}
  async insertFill(_fill: Fill): Promise<void> {}
  async upsertPosition(_position: Position): Promise<void> {}
  async deletePosition(_symbol: string): Promise<void> {}
  async upsertManagedPosition(_position: ManagedPositionRecord): Promise<void> {}
  async deleteManagedPosition(_symbol: string): Promise<void> {}
  async loadPositions(): Promise<Position[]> {
    return [];
  }
  async loadManagedPositions(): Promise<ManagedPositionRecord[]> {
    return [];
  }
  async recordTradeEntryLot(
    _symbol: string,
    _qty: number,
    _entryPrice: number,
    _stopPrice: number,
    _openedAt: string
  ): Promise<void> {}
  async closeTradeEntryLots(
    _symbol: string,
    _qty: number,
    _exitPrice: number,
    _closedAt: string
  ): Promise<void> {}
  async loadClosedTradeLots(_limit: number): Promise<ClosedTradeLot[]> {
    return [];
  }
  async upsertDailySnapshot(_snapshot: DailySnapshot): Promise<void> {}
  async loadDailySnapshots(_limit: number): Promise<DailySnapshot[]> {
    return [];
  }
  async upsertSystemState(_key: string, _value: string): Promise<void> {}
  async loadSystemState(_key: string): Promise<string | null> {
    return null;
  }
}
