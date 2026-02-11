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

export interface AlertEvent {
  id: number;
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  contextJson?: string;
  createdAt: string;
}

export interface ReconcileAudit {
  id: number;
  runId: string;
  driftCount: number;
  detailsJson?: string;
  createdAt: string;
}

export interface BacktestRunRecord {
  id: number;
  runId: string;
  fromDate: string;
  toDate: string;
  symbolsCsv: string;
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
  metaJson?: string;
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
  insertAlertEvent(event: Omit<AlertEvent, "id" | "createdAt">): Promise<void>;
  loadLatestAlertEvents(limit: number): Promise<AlertEvent[]>;
  insertReconcileAudit(audit: Omit<ReconcileAudit, "id" | "createdAt">): Promise<void>;
  loadLatestReconcileAudits(limit: number): Promise<ReconcileAudit[]>;
  insertBacktestRun(run: Omit<BacktestRunRecord, "id" | "createdAt">): Promise<void>;
  loadLatestBacktestRun(): Promise<BacktestRunRecord | null>;
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
  async insertAlertEvent(_event: Omit<AlertEvent, "id" | "createdAt">): Promise<void> {}
  async loadLatestAlertEvents(_limit: number): Promise<AlertEvent[]> {
    return [];
  }
  async insertReconcileAudit(
    _audit: Omit<ReconcileAudit, "id" | "createdAt">
  ): Promise<void> {}
  async loadLatestReconcileAudits(_limit: number): Promise<ReconcileAudit[]> {
    return [];
  }
  async insertBacktestRun(_run: Omit<BacktestRunRecord, "id" | "createdAt">): Promise<void> {}
  async loadLatestBacktestRun(): Promise<BacktestRunRecord | null> {
    return null;
  }
}
