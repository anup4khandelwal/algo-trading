import { InMemoryStore } from "./storage/store.js";
import { ScreenerService } from "./screener/screener.js";
import { SignalBuilder } from "./signal/signal_builder.js";
import { RiskEngine } from "./risk/risk_engine.js";
import { OMS } from "./oms/oms.js";
import { ZerodhaAdapter } from "./execution/zerodha_adapter.js";
import { PortfolioService } from "./portfolio/portfolio.js";
import { OrderIntent, RiskLimits, Signal } from "./types.js";
import { MapLtpProvider } from "./market_data/ltp_provider.js";
import { KiteLtpProvider } from "./market_data/kite_ltp_provider.js";
import { KiteHistoricalProvider } from "./market_data/kite_historical_provider.js";
import { PositionMonitor } from "./monitor/position_monitor.js";
import { NoopPersistence } from "./persistence/persistence.js";
import { PostgresPersistence } from "./persistence/postgres_persistence.js";
import { buildAlerter } from "./ops/alerter.js";
import dotenv from "dotenv";

export async function runDailyPipeline() {
  await runMorningWorkflow();
}

export async function runMorningWorkflow() {
  dotenv.config();
  const runtime = await createRuntime();
  const { store, signalBuilder, risk, oms, exec, portfolio, positionMonitor, alerter } = runtime;
  const preflight = await exec.preflightCheck();
  await runtime.persistence.upsertSystemState("last_preflight", JSON.stringify(preflight));
  if (!preflight.ok) {
    await alerter.notify("critical", "preflight_failed", preflight.message, preflight);
    throw new Error(preflight.message);
  }
  if (isTradingHalted()) {
    console.warn("HALT_TRADING=1, skipping entries");
    await runMonitorCycles(positionMonitor);
    await persistDailySnapshot(runtime, "halted_morning");
    console.log("Portfolio", store.getSnapshot());
    return;
  }
  const results = await runtime.screener.getCandidates();
  const signals = signalBuilder.buildSignals(results, store.equity);
  await placeSignals(
    signals,
    store,
    risk,
    oms,
    exec,
    portfolio,
    positionMonitor,
    runtime.persistence,
    alerter
  );
  await runMonitorCycles(positionMonitor);
  await persistDailySnapshot(runtime, "morning");
  console.log("Portfolio", store.getSnapshot());
}

export async function runMonitorPass() {
  dotenv.config();
  const runtime = await createRuntime();
  if (runtime.exec.isLiveMode()) {
    const preflight = await runtime.exec.preflightCheck();
    await runtime.persistence.upsertSystemState("last_preflight", JSON.stringify(preflight));
    if (!preflight.ok) {
      await runtime.alerter.notify("critical", "preflight_failed", preflight.message, preflight);
      throw new Error(preflight.message);
    }
    await runtime.exec.reconcileBrokerPositions(runtime.store, runtime.persistence);
    await runtime.persistence.upsertSystemState("last_broker_sync_at", new Date().toISOString());
  }
  await runtime.positionMonitor.reconcileWithPositions();
  await runtime.positionMonitor.evaluateAndAct();
  await persistDailySnapshot(runtime, "monitor");
  console.log("Portfolio", runtime.store.getSnapshot());
}

export async function runEntryPass() {
  dotenv.config();
  const runtime = await createRuntime();
  const preflight = await runtime.exec.preflightCheck();
  await runtime.persistence.upsertSystemState("last_preflight", JSON.stringify(preflight));
  if (!preflight.ok) {
    await runtime.alerter.notify("critical", "preflight_failed", preflight.message, preflight);
    throw new Error(preflight.message);
  }
  if (isTradingHalted()) {
    console.warn("HALT_TRADING=1, skipping entry pass");
    await persistDailySnapshot(runtime, "halted_entry");
    return;
  }
  const results = await runtime.screener.getCandidates();
  const signals = runtime.signalBuilder.buildSignals(results, runtime.store.equity);
  await placeSignals(
    signals,
    runtime.store,
    runtime.risk,
    runtime.oms,
    runtime.exec,
    runtime.portfolio,
    runtime.positionMonitor,
    runtime.persistence,
    runtime.alerter
  );
  await persistDailySnapshot(runtime, "entry");
  console.log("Portfolio", runtime.store.getSnapshot());
}

export async function runReconcilePass() {
  dotenv.config();
  const runtime = await createRuntime();
  let driftCount = 0;
  if (runtime.exec.isLiveMode()) {
    const preflight = await runtime.exec.preflightCheck();
    await runtime.persistence.upsertSystemState("last_preflight", JSON.stringify(preflight));
    if (!preflight.ok) {
      await runtime.alerter.notify("critical", "preflight_failed", preflight.message, preflight);
      throw new Error(preflight.message);
    }
    const before = runtime.store.positions.size;
    await runtime.exec.reconcileBrokerPositions(runtime.store, runtime.persistence);
    const after = runtime.store.positions.size;
    driftCount = Math.abs(before - after);
    await runtime.persistence.upsertSystemState("last_broker_sync_at", new Date().toISOString());
    await runtime.persistence.insertReconcileAudit({
      runId: `reconcile-${Date.now()}`,
      driftCount,
      detailsJson: JSON.stringify({ before, after })
    });
    if (driftCount > 0) {
      await runtime.alerter.notify(
        "warning",
        "reconcile_drift",
        `Detected broker/local position drift: ${driftCount}`,
        { before, after }
      );
    }
  }
  await runtime.positionMonitor.reconcileWithPositions();
  await persistDailySnapshot(runtime, "reconcile");
  console.log("RECONCILE_OK");
  console.log("Portfolio", runtime.store.getSnapshot());
}

export async function runEodClosePass() {
  dotenv.config();
  const runtime = await createRuntime();
  if (runtime.exec.isLiveMode()) {
    await runtime.exec.reconcileBrokerPositions(runtime.store, runtime.persistence);
    await runtime.persistence.upsertSystemState("last_broker_sync_at", new Date().toISOString());
  }
  await runtime.positionMonitor.reconcileWithPositions();
  await closeAllPositions(runtime);
  await persistDailySnapshot(runtime, "eod_close");
  console.log("Portfolio", runtime.store.getSnapshot());
}

export async function runPreflightPass() {
  dotenv.config();
  const runtime = await createRuntime();
  const preflight = await runtime.exec.preflightCheck();
  await runtime.persistence.upsertSystemState("last_preflight", JSON.stringify(preflight));
  if (!preflight.ok) {
    await runtime.alerter.notify("critical", "preflight_failed", preflight.message, preflight);
    throw new Error(preflight.message);
  }
  console.log("PREFLIGHT_OK", preflight);
}

export async function runManualPositionExit(
  symbolRaw: string,
  percentRaw = 100,
  reason = "Manual UI exit"
) {
  dotenv.config();
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol) {
    throw new Error("symbol is required");
  }
  const runtime = await createRuntime();
  const position = runtime.store.positions.get(symbol);
  if (!position || position.qty <= 0) {
    throw new Error(`No open long position for ${symbol}`);
  }
  const percent = Math.max(1, Math.min(100, Number(percentRaw)));
  const qty = Math.max(1, Math.floor((position.qty * percent) / 100));
  const closeQty = Math.min(position.qty, qty);
  const intent: OrderIntent = {
    idempotencyKey: `MANUAL-EXIT-${symbol}-${Date.now()}`,
    symbol,
    side: "SELL",
    qty: closeQty,
    type: "MARKET",
    timeInForce: "DAY",
    createdAt: new Date().toISOString(),
    signalReason: reason
  };
  const order = await runtime.oms.createOrder(intent);
  await runtime.oms.updateState(order.orderId, "OPEN");
  const fill = await runtime.exec.placeOrder(order);
  await runtime.oms.updateState(order.orderId, "FILLED", {
    filledQty: fill.qty,
    avgFillPrice: fill.price
  });
  await runtime.portfolio.applyFill(fill);
  await runtime.persistence.closeTradeEntryLots(fill.symbol, fill.qty, fill.price, fill.time);

  const after = runtime.store.positions.get(symbol);
  const managed = await runtime.persistence.loadManagedPositions();
  const managedRecord = managed.find((m) => m.symbol === symbol);
  if (managedRecord) {
    if (!after || after.qty <= 0) {
      await runtime.persistence.deleteManagedPosition(symbol);
    } else {
      await runtime.persistence.upsertManagedPosition({
        ...managedRecord,
        qty: after.qty
      });
    }
  }

  await runtime.positionMonitor.reconcileWithPositions();
  await persistDailySnapshot(runtime, "manual_exit");
  return {
    symbol,
    requestedPercent: percent,
    exitedQty: fill.qty,
    exitPrice: fill.price,
    remainingQty: after?.qty ?? 0
  };
}

export async function runManualStopUpdate(symbolRaw: string, stopPriceRaw: number) {
  dotenv.config();
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol) {
    throw new Error("symbol is required");
  }
  const stopPrice = Number(stopPriceRaw);
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    throw new Error("stopPrice must be a positive number");
  }
  const runtime = await createRuntime();
  const position = runtime.store.positions.get(symbol);
  if (!position || position.qty <= 0) {
    throw new Error(`No open long position for ${symbol}`);
  }
  const managed = await runtime.persistence.loadManagedPositions();
  const existing = managed.find((m) => m.symbol === symbol);
  if (!existing) {
    throw new Error(`No managed stop record for ${symbol}`);
  }
  await runtime.persistence.upsertManagedPosition({
    ...existing,
    stopPrice,
    qty: position.qty
  });
  await persistDailySnapshot(runtime, "manual_stop_update");
  return {
    symbol,
    qty: position.qty,
    stopPrice
  };
}

async function placeSignals(
  signals: Signal[],
  store: InMemoryStore,
  risk: RiskEngine,
  oms: OMS,
  exec: ZerodhaAdapter,
  portfolio: PortfolioService,
  positionMonitor: PositionMonitor,
  persistence: Awaited<ReturnType<typeof buildPersistence>>,
  alerter: ReturnType<typeof buildAlerter>
) {
  validateLiveModeSafety(exec);
  const rejectGuardThreshold = Math.max(2, Number(process.env.REJECT_GUARD_THRESHOLD ?? "2"));
  const rejectGuard = await loadRejectGuardState(persistence);
  const maxConsecutiveErrors = Number(process.env.MAX_CONSECUTIVE_ORDER_ERRORS ?? "3");
  const maxNotionalPerOrder = Number(process.env.MAX_NOTIONAL_PER_ORDER ?? "500000");
  const allowedSymbols = parseCsvSet(process.env.ALLOWED_SYMBOLS);
  let remainingFunds = Math.max(0, store.equity);
  let consecutiveErrors = 0;
  for (const signal of signals) {
    if (rejectGuard.blockedSymbols[signal.symbol]) {
      console.log("SKIP", signal.symbol, "Blocked by reject guard for today");
      continue;
    }
    if (allowedSymbols && !allowedSymbols.has(signal.symbol)) {
      console.log("SKIP", signal.symbol, "Symbol not in ALLOWED_SYMBOLS");
      continue;
    }
    const notional = signal.qty * signal.entryPrice;
    if (signal.side === "BUY" && notional > remainingFunds) {
      console.log("SKIP", signal.symbol, "Insufficient remaining usable funds");
      continue;
    }
    if (notional > maxNotionalPerOrder) {
      console.log("SKIP", signal.symbol, "Max notional per order breached");
      continue;
    }
    if (hasDuplicateOrderForToday(store, signal.symbol)) {
      console.log("SKIP", signal.symbol, "Duplicate order guard");
      continue;
    }
    const check = risk.preTradeCheck(signal);
    if (!check.ok) {
      console.log("SKIP", signal.symbol, check.reason);
      continue;
    }

    const intent: OrderIntent = {
      idempotencyKey: `SIG-${signal.symbol}-${new Date().toISOString().slice(0, 10)}`,
      symbol: signal.symbol,
      side: signal.side,
      qty: signal.qty,
      type: "MARKET",
      timeInForce: "DAY",
      createdAt: new Date().toISOString(),
      signalReason: signal.reason
    };

    try {
      risk.registerOrder(intent);
      const order = await oms.createOrder(intent);
      await oms.updateState(order.orderId, "OPEN");

      const fill = await exec.placeOrder(order);
      await oms.updateState(order.orderId, "FILLED", {
        filledQty: fill.qty,
        avgFillPrice: fill.price
      });

      await portfolio.applyFill(fill);
      await positionMonitor.trackEntry(fill, signal);
      if (fill.side === "BUY") {
        remainingFunds = Math.max(0, remainingFunds - fill.qty * fill.price);
      } else {
        remainingFunds += fill.qty * fill.price;
      }
      console.log("FILLED", fill.symbol, fill.qty, fill.price.toFixed(2));
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.error("ORDER_ERROR", signal.symbol, err);
      const message = err instanceof Error ? err.message : String(err);
      if (isBrokerRejectError(message)) {
        const now = new Date().toISOString();
        const next = (rejectGuard.rejectCounts[signal.symbol] ?? 0) + 1;
        rejectGuard.rejectCounts[signal.symbol] = next;
        if (next >= rejectGuardThreshold && !rejectGuard.blockedSymbols[signal.symbol]) {
          rejectGuard.blockedSymbols[signal.symbol] = {
            blockedAt: now,
            reason: message.slice(0, 240),
            count: next
          };
          await alerter.notify(
            "warning",
            "symbol_reject_guard_blocked",
            `Reject guard blocked ${signal.symbol} for the day`,
            {
              symbol: signal.symbol,
              count: next
            }
          );
        }
        await saveRejectGuardState(persistence, rejectGuard);
      }
      await alerter.notify(
        "critical",
        "order_error",
        `Order failed for ${signal.symbol}`,
        { error: String(err) }
      );
      if (consecutiveErrors >= maxConsecutiveErrors) {
        console.error(
          `CIRCUIT_BREAKER_TRIPPED after ${consecutiveErrors} consecutive order errors`
        );
        await persistence.upsertSystemState(
          "last_circuit_breaker_at",
          new Date().toISOString()
        );
        await alerter.notify(
          "critical",
          "circuit_breaker_tripped",
          `Circuit breaker tripped after ${consecutiveErrors} consecutive order errors`
        );
        break;
      }
    }
  }
}

async function runMonitorCycles(positionMonitor: PositionMonitor) {
  const monitorCycles = Number(process.env.MONITOR_CYCLES ?? "1");
  const monitorIntervalMs = Number(process.env.MONITOR_INTERVAL_MS ?? "2000");
  for (let i = 0; i < monitorCycles; i += 1) {
    await positionMonitor.evaluateAndAct();
    if (i < monitorCycles - 1) {
      await sleep(monitorIntervalMs);
    }
  }

}

async function createRuntime() {
  const store = new InMemoryStore();
  store.equity = Number(process.env.STARTING_EQUITY ?? "1000000");
  const persistence = await buildPersistence();
  for (const position of await persistence.loadPositions()) {
    store.positions.set(position.symbol, position);
  }

  const riskLimits: RiskLimits = {
    maxDailyLoss: Number(process.env.MAX_DAILY_LOSS ?? "50000"),
    maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS ?? "5"),
    maxOrdersPerDay: Number(process.env.MAX_ORDERS_PER_DAY ?? "10"),
    maxExposurePerSymbol: Number(process.env.MAX_EXPOSURE_PER_SYMBOL ?? "300000"),
    riskPerTrade: Number(process.env.RISK_PER_TRADE ?? "0.015")
  };

  const signalBuilder = new SignalBuilder({
    minRsi: Number(process.env.STRATEGY_MIN_RSI ?? "55"),
    breakoutBufferPct: Number(process.env.STRATEGY_BREAKOUT_BUFFER_PCT ?? "0.02"),
    atrStopMultiple: Number(process.env.ATR_STOP_MULTIPLE ?? "2"),
    riskPerTrade: riskLimits.riskPerTrade,
    minAdv20: Number(process.env.STRATEGY_MIN_ADV20 ?? "100000000"),
    minVolumeRatio: Number(process.env.STRATEGY_MIN_VOLUME_RATIO ?? "1.2"),
    maxSignals: Number(process.env.STRATEGY_MAX_SIGNALS ?? "5")
  });
  const risk = new RiskEngine(store, riskLimits);
  const oms = new OMS(store, persistence);
  const screener = new ScreenerService(buildHistoricalProvider());
  const ltpProvider = buildLtpProvider(store);
  const exec = new ZerodhaAdapter(ltpProvider, {
    mode: buildExecutionMode(),
    apiKey: process.env.KITE_API_KEY,
    accessToken: process.env.KITE_ACCESS_TOKEN,
    product: process.env.KITE_PRODUCT ?? "CNC",
    exchange: process.env.KITE_EXCHANGE ?? "NSE",
    orderVariety: (process.env.KITE_ORDER_VARIETY as "regular" | "amo" | undefined) ?? "regular"
  });
  const portfolio = new PortfolioService(store, persistence);
  const positionMonitor = new PositionMonitor(
    store,
    oms,
    exec,
    portfolio,
    Number(process.env.ATR_TRAILING_MULTIPLE ?? "2"),
    persistence
  );
  await positionMonitor.hydrate();
  const alerter = buildAlerter(persistence);

  const fundUsagePct = clamp01(Number(process.env.FUND_USAGE_PCT ?? "0.95"));
  let fundSource: "broker" | "paper" = "paper";
  let availableCash = store.equity;
  store.equity = Math.max(0, availableCash * fundUsagePct);
  if (exec.isLiveMode()) {
    try {
      const funds = await exec.fetchAvailableFunds();
      fundSource = funds.source;
      availableCash = Math.max(0, funds.availableCash);
      store.equity = Math.max(0, availableCash * fundUsagePct);
    } catch (err) {
      console.warn("LIVE_FUNDS_FETCH_FAIL", err);
    }
  }
  await persistence.upsertSystemState(
    "last_available_funds",
    JSON.stringify({
      availableCash,
      usableEquity: store.equity,
      fundUsagePct,
      source: fundSource,
      updatedAt: new Date().toISOString()
    })
  );
  await appendFundsHistory(persistence, {
    ts: new Date().toISOString(),
    availableCash,
    usableEquity: store.equity,
    source: fundSource
  });

  if (exec.isLiveMode()) {
    await exec.reconcileBrokerPositions(store, persistence);
    await persistence.upsertSystemState("last_broker_sync_at", new Date().toISOString());
  }

  return {
    store,
    signalBuilder,
    risk,
    oms,
    screener,
    exec,
    portfolio,
    positionMonitor,
    persistence,
    alerter
  };
}

function buildLtpProvider(store: InMemoryStore) {
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (apiKey && accessToken) {
    return new KiteLtpProvider({ apiKey, accessToken });
  }
  const ltpMap = new Map(
    Array.from(store.positions.values()).map((position) => [position.symbol, position.avgPrice])
  );
  return new MapLtpProvider(ltpMap);
}

function buildExecutionMode(): "paper" | "live" {
  return process.env.LIVE_ORDER_MODE === "1" ? "live" : "paper";
}

function buildHistoricalProvider() {
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (!apiKey || !accessToken) {
    throw new Error("KITE_API_KEY and KITE_ACCESS_TOKEN are required for screener");
  }
  return new KiteHistoricalProvider({ apiKey, accessToken });
}

async function buildPersistence() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return new NoopPersistence();
  }
  const requireDb = process.env.REQUIRE_DB === "1";
  const pg = new PostgresPersistence(databaseUrl);
  try {
    await pg.init();
    return pg;
  } catch (err) {
    if (requireDb) {
      throw err;
    }
    console.warn(
      "DB unavailable. Falling back to in-memory persistence. Set REQUIRE_DB=1 to fail hard."
    );
    if (process.env.DEBUG_PERSISTENCE === "1") {
      console.warn(err);
    }
    return new NoopPersistence();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTradingHalted(): boolean {
  return process.env.HALT_TRADING === "1";
}

function validateLiveModeSafety(exec: ZerodhaAdapter) {
  if (!exec.isLiveMode()) {
    return;
  }
  if (process.env.CONFIRM_LIVE_ORDERS !== "YES") {
    throw new Error(
      "LIVE_ORDER_MODE=1 requires CONFIRM_LIVE_ORDERS=YES before placing live orders"
    );
  }
}

function parseCsvSet(value: string | undefined): Set<string> | null {
  if (!value || value.trim().length === 0) {
    return null;
  }
  return new Set(
    value
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x.length > 0)
  );
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0.95;
  }
  return Math.max(0, Math.min(1, value));
}

function isBrokerRejectError(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes("rejected") ||
    msg.includes("inputexception") ||
    msg.includes("rms") ||
    msg.includes("could not be converted") ||
    msg.includes("freeze quantity")
  );
}

type RejectGuardState = {
  tradeDate: string;
  rejectCounts: Record<string, number>;
  blockedSymbols: Record<string, { blockedAt: string; reason: string; count: number }>;
};

async function loadRejectGuardState(
  persistence: Awaited<ReturnType<typeof buildPersistence>>
): Promise<RejectGuardState> {
  const tradeDate = getTradeDateIST();
  const key = `reject_guard_${tradeDate}`;
  const raw = await persistence.loadSystemState(key);
  if (!raw) {
    return { tradeDate, rejectCounts: {}, blockedSymbols: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RejectGuardState>;
    return {
      tradeDate,
      rejectCounts: parsed.rejectCounts ?? {},
      blockedSymbols: parsed.blockedSymbols ?? {}
    };
  } catch {
    return { tradeDate, rejectCounts: {}, blockedSymbols: {} };
  }
}

async function saveRejectGuardState(
  persistence: Awaited<ReturnType<typeof buildPersistence>>,
  state: RejectGuardState
) {
  await persistence.upsertSystemState(`reject_guard_${state.tradeDate}`, JSON.stringify(state));
}

type FundsHistoryPoint = {
  ts: string;
  availableCash: number;
  usableEquity: number;
  source: "broker" | "paper";
};

async function appendFundsHistory(
  persistence: Awaited<ReturnType<typeof buildPersistence>>,
  point: FundsHistoryPoint
) {
  const key = "funds_history";
  const raw = await persistence.loadSystemState(key);
  let rows: FundsHistoryPoint[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as FundsHistoryPoint[];
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {
      rows = [];
    }
  }
  const last = rows[rows.length - 1];
  const changed =
    !last ||
    Math.abs(Number(last.availableCash ?? 0) - point.availableCash) > 1 ||
    Math.abs(Number(last.usableEquity ?? 0) - point.usableEquity) > 1 ||
    last.source !== point.source;
  if (!changed) {
    return;
  }
  rows.push(point);
  if (rows.length > 500) {
    rows = rows.slice(rows.length - 500);
  }
  await persistence.upsertSystemState(key, JSON.stringify(rows));
}

function hasDuplicateOrderForToday(store: InMemoryStore, symbol: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  for (const order of store.orders.values()) {
    if (
      order.intent.symbol === symbol &&
      order.intent.createdAt.slice(0, 10) === today &&
      (order.state === "OPEN" || order.state === "PARTIAL" || order.state === "FILLED")
    ) {
      return true;
    }
  }
  return false;
}

async function closeAllPositions(runtime: Awaited<ReturnType<typeof createRuntime>>) {
  const { store, oms, exec, portfolio, persistence } = runtime;
  for (const position of Array.from(store.positions.values())) {
    if (position.qty <= 0) {
      continue;
    }
    const intent: OrderIntent = {
      idempotencyKey: `EOD-${position.symbol}-${new Date().toISOString().slice(0, 10)}`,
      symbol: position.symbol,
      side: "SELL",
      qty: position.qty,
      type: "MARKET",
      timeInForce: "DAY",
      createdAt: new Date().toISOString(),
      signalReason: "EOD square-off"
    };
    const order = await oms.createOrder(intent);
    await oms.updateState(order.orderId, "OPEN");
    const fill = await exec.placeOrder(order);
    await oms.updateState(order.orderId, "FILLED", {
      filledQty: fill.qty,
      avgFillPrice: fill.price
    });
    await portfolio.applyFill(fill);
    await persistence.closeTradeEntryLots(fill.symbol, fill.qty, fill.price, fill.time);
    await persistence.deleteManagedPosition(fill.symbol);
    console.log("EOD_CLOSE", fill.symbol, fill.qty, fill.price.toFixed(2));
  }
}

async function persistDailySnapshot(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  note: string
) {
  const { store, exec, persistence } = runtime;
  let unrealized = 0;
  for (const position of Array.from(store.positions.values())) {
    try {
      const ltp = await exec.getLtp(position.symbol);
      unrealized += (ltp - position.avgPrice) * position.qty;
    } catch {
      // If LTP fetch fails, keep unrealized for this symbol as 0 for now.
    }
  }
  const snapshot = store.getSnapshot();
  await persistence.upsertDailySnapshot({
    tradeDate: getTradeDateIST(),
    equity: snapshot.equity,
    realizedPnl: snapshot.realizedPnl,
    unrealizedPnl: unrealized,
    openPositions: snapshot.positions.length,
    note,
    createdAt: new Date().toISOString()
  });
}

function getTradeDateIST(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}
