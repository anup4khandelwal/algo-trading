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
  const maxConsecutiveErrors = Number(process.env.MAX_CONSECUTIVE_ORDER_ERRORS ?? "3");
  const maxNotionalPerOrder = Number(process.env.MAX_NOTIONAL_PER_ORDER ?? "500000");
  const allowedSymbols = parseCsvSet(process.env.ALLOWED_SYMBOLS);
  let consecutiveErrors = 0;
  for (const signal of signals) {
    if (allowedSymbols && !allowedSymbols.has(signal.symbol)) {
      console.log("SKIP", signal.symbol, "Symbol not in ALLOWED_SYMBOLS");
      continue;
    }
    const notional = signal.qty * signal.entryPrice;
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
      console.log("FILLED", fill.symbol, fill.qty, fill.price.toFixed(2));
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.error("ORDER_ERROR", signal.symbol, err);
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
    exchange: process.env.KITE_EXCHANGE ?? "NSE"
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
