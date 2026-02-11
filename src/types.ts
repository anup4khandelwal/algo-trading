export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL";
export type OrderState = "NEW" | "OPEN" | "PARTIAL" | "FILLED" | "REJECTED" | "CANCELED";

export interface ScreenerResult {
  symbol: string;
  close: number;
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  rsScore60d: number;
  adv20: number; // average daily traded value (INR)
  volumeRatio: number; // avgVol20 / avgVol50
  high20: number; // 20-day high
}

export interface Signal {
  symbol: string;
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number;
  qty: number;
  reason: string;
  rankScore: number;
  atr14: number;
}

export interface OrderIntent {
  idempotencyKey: string;
  symbol: string;
  side: Side;
  qty: number;
  type: OrderType;
  price?: number;
  stopPrice?: number;
  timeInForce: "DAY" | "IOC";
  createdAt: string;
  signalReason: string;
}

export interface Order {
  orderId: string;
  intent: OrderIntent;
  state: OrderState;
  filledQty: number;
  avgFillPrice?: number;
  brokerOrderId?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  time: string;
}

export interface Position {
  symbol: string;
  qty: number;
  avgPrice: number;
}

export interface PortfolioSnapshot {
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  positions: Position[];
}

export interface MarketBar {
  symbol: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RiskLimits {
  maxDailyLoss: number; // INR
  maxOpenPositions: number;
  maxOrdersPerDay: number;
  maxExposurePerSymbol: number; // INR
  riskPerTrade: number; // % of equity, e.g. 0.015
}

export interface RiskCheckResult {
  ok: boolean;
  reason?: string;
}
