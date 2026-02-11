import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  runEodClosePass,
  runManualPositionExit,
  runManualStopUpdate,
  runMonitorPass,
  runMorningWorkflow,
  runPreflightPass
} from "../pipeline.js";
import { PostgresPersistence } from "../persistence/postgres_persistence.js";
import { NoopPersistence } from "../persistence/persistence.js";
import { runConfiguredBacktest } from "../backtest/service.js";
import { runStrategyLabSweep } from "../strategy_lab/service.js";
import { TradingScheduler } from "../ops/scheduler.js";
import { ZerodhaAdapter } from "../execution/zerodha_adapter.js";
import { MapLtpProvider } from "../market_data/ltp_provider.js";
import { buildAlerter } from "../ops/alerter.js";
import {
  applyEnvOverrides,
  applyProfile,
  getProfileSnapshot,
  type ProfileName
} from "../config/profile_manager.js";

dotenv.config();

const PORT = Number(process.env.UI_PORT ?? "3000");
const REACT_DIST_DIR = path.resolve(process.cwd(), "dashboard", "dist");
const HAS_REACT_BUILD = existsSync(path.join(REACT_DIST_DIR, "index.html"));
type UiJob =
  | "morning"
  | "monitor"
  | "preflight"
  | "backtest"
  | "eod_close"
  | "strategy_lab";
type BrokerOrdersReport = {
  enabled: boolean;
  stale: boolean;
  fetchedAt: string;
  message: string;
  stats: {
    total: number;
    complete: number;
    open: number;
    rejected: number;
    cancelled: number;
    filtered: number;
  };
  orders: Array<Record<string, unknown>>;
};
type SafeModeState = {
  enabled: boolean;
  reason: string;
  updatedAt: string;
  source: string;
};
type BrokerOrderFilter = {
  status: "all" | "failed" | "open" | "complete" | "cancelled" | "rejected";
  severity: "all" | "critical" | "warning" | "info";
  search: string;
};
type PreopenChecklist = {
  ok: boolean;
  checkedAt: string;
  checks: Array<{ key: string; ok: boolean; message: string }>;
};
let runningJob: UiJob | null = null;
let lastDbErrorLogAt = 0;
let lastTokenRiskAlertAt = 0;
const runtimeErrors: Array<{ time: string; source: string; message: string }> = [];
let safeModeState: SafeModeState = {
  enabled: process.env.HALT_TRADING === "1",
  reason: process.env.HALT_TRADING === "1" ? "set from env" : "",
  updatedAt: new Date().toISOString(),
  source: "env"
};
let brokerOrdersCache:
  | {
      fetchedAtMs: number;
      data: BrokerOrdersReport;
    }
  | null = null;
const scheduler = new TradingScheduler(
  {
    runMorning: () => runUiJob("morning", "SCHED_MORNING", () => runMorningWorkflow()),
    runMonitor: () => runUiJob("monitor", "SCHED_MONITOR", () => runMonitorPass()),
    runEodClose: () => runUiJob("eod_close", "SCHED_EOD", () => runEodClosePass()),
    runBacktest: () => runUiJob("backtest", "SCHED_BACKTEST", () => runConfiguredBacktest()),
    runStrategyLab: () => runUiJob("strategy_lab", "SCHED_STRATEGY_LAB", () => runStrategyLabAndPersist()),
    canRun: () => runningJob === null
  },
  {
    tickSeconds: Number(process.env.SCHEDULER_TICK_SECONDS ?? "20"),
    monitorIntervalSeconds: Number(process.env.SCHEDULER_MONITOR_INTERVAL_SECONDS ?? "300"),
    premarketAt: process.env.SCHEDULER_PREMARKET_AT ?? "08:55",
    eodAt: process.env.SCHEDULER_EOD_AT ?? "15:31",
    backtestAt: process.env.SCHEDULER_BACKTEST_AT ?? "10:30",
    backtestWeekday: process.env.SCHEDULER_BACKTEST_WEEKDAY ?? "Sat",
    strategyLabAt: process.env.SCHEDULER_STRATLAB_AT ?? "11:00",
    strategyLabWeekday: process.env.SCHEDULER_STRATLAB_WEEKDAY ?? "Sat"
  }
);
if (process.env.SCHEDULER_ENABLED === "1") {
  scheduler.start();
}
void hydrateSafeModeFromDb();

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (method === "GET" && !url.pathname.startsWith("/api")) {
      const served = await tryServeReactApp(url.pathname, res);
      if (served) {
        return;
      }
    }

    if (method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage());
      return;
    }

    if (method === "GET" && url.pathname === "/api/status") {
      const report = await getDbReport();
      json(res, 200, {
        runningJob,
        liveMode: process.env.LIVE_ORDER_MODE === "1",
        lastPreflight: report.lastPreflight ?? null,
        safeMode: getSafeModeState(),
        scheduler: scheduler.getState()
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/scheduler") {
      json(res, 200, {
        runningJob,
        scheduler: scheduler.getState()
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/report") {
      const report = await getDbReport();
      json(res, 200, report);
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      const health = await getHealthReport();
      json(res, 200, health);
      return;
    }

    if (method === "GET" && url.pathname === "/api/preopen-check") {
      const preopen = await getPreopenChecklist();
      json(res, 200, preopen);
      return;
    }

    if (method === "GET" && url.pathname === "/api/broker/orders") {
      const refresh = url.searchParams.get("refresh") === "1";
      const brokerOrders = await getBrokerOrdersReport(refresh, parseBrokerOrderFilter(url));
      json(res, 200, brokerOrders);
      return;
    }

    if (method === "GET" && url.pathname === "/api/broker/orders.csv") {
      const refresh = url.searchParams.get("refresh") === "1";
      const brokerOrders = await getBrokerOrdersReport(refresh, parseBrokerOrderFilter(url));
      const csv = toCsv(
        brokerOrders.orders,
        [
          "updatedAt",
          "orderId",
          "symbol",
          "side",
          "qty",
          "filledQty",
          "cancelledQty",
          "status",
          "product",
          "exchange",
          "validity",
          "averagePrice",
          "severity",
          "hintCode",
          "hintText",
          "reason"
        ]
      );
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="broker-orders-${new Date().toISOString().slice(0, 10)}.csv"`
      });
      res.end(csv);
      return;
    }

    if (method === "GET" && url.pathname === "/api/strategy") {
      const strategy = await getStrategyReport();
      json(res, 200, strategy);
      return;
    }

    if (method === "GET" && url.pathname === "/api/backtest") {
      const backtest = await getBacktestReport();
      json(res, 200, backtest);
      return;
    }

    if (method === "GET" && url.pathname === "/api/strategy-lab/latest") {
      const data = await getStrategyLabReport();
      json(res, 200, data);
      return;
    }

    if (method === "GET" && url.pathname === "/api/drift") {
      const drift = await getDriftReport();
      json(res, 200, drift);
      return;
    }

    if (method === "GET" && url.pathname === "/api/journal") {
      const journal = await getJournalReport();
      json(res, 200, journal);
      return;
    }

    if (method === "POST" && url.pathname === "/api/run/morning") {
      if (!launchJob(res, "morning", "MORNING_JOB", () => runMorningWorkflow())) {
        return;
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/run/monitor") {
      if (!launchJob(res, "monitor", "MONITOR_JOB", () => runMonitorPass())) {
        return;
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/run/preflight") {
      if (!launchJob(res, "preflight", "PREFLIGHT_JOB", () => runPreflightPass())) {
        return;
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/run/backtest") {
      if (!launchJob(res, "backtest", "BACKTEST_JOB", () => runConfiguredBacktest())) {
        return;
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/strategy-lab/run") {
      if (!launchJob(res, "strategy_lab", "STRATLAB_JOB", () => runStrategyLabAndPersist())) {
        return;
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/strategy-lab/apply") {
      const body = await readJsonBody(req);
      const candidateId = String(body?.candidateId ?? "").trim();
      if (!candidateId) {
        json(res, 400, { error: "candidateId is required" });
        return;
      }
      const applied = await applyStrategyLabCandidate(candidateId);
      if (!applied.ok) {
        json(res, 400, applied);
        return;
      }
      json(res, 200, applied);
      return;
    }

    if (method === "POST" && url.pathname === "/api/run/eod") {
      if (!launchJob(res, "eod_close", "EOD_JOB", () => runEodClosePass())) {
        return;
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/scheduler/start") {
      if (getSafeModeState().enabled) {
        json(res, 409, { error: "Safe Mode is enabled. Disable it before starting scheduler." });
        return;
      }
      scheduler.start();
      json(res, 200, { ok: true, scheduler: scheduler.getState() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/scheduler/stop") {
      scheduler.stop();
      json(res, 200, { ok: true, scheduler: scheduler.getState() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/safe-mode") {
      json(res, 200, { safeMode: getSafeModeState(), scheduler: scheduler.getState() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/safe-mode/enable") {
      const body = await readJsonBody(req);
      const reason = String(body?.reason ?? "manual ui toggle").trim();
      await setSafeMode(true, reason || "manual ui toggle", "ui");
      json(res, 200, { ok: true, safeMode: getSafeModeState(), scheduler: scheduler.getState() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/safe-mode/disable") {
      const body = await readJsonBody(req);
      const reason = String(body?.reason ?? "manual ui toggle").trim();
      await setSafeMode(false, reason || "manual ui toggle", "ui");
      json(res, 200, { ok: true, safeMode: getSafeModeState(), scheduler: scheduler.getState() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/profile/status") {
      const profile = await getProfileSnapshot();
      json(res, 200, profile);
      return;
    }

    if (method === "GET" && url.pathname === "/api/profile/recommendation") {
      const recommendation = await getProfileRecommendation();
      json(res, 200, recommendation);
      return;
    }

    if (method === "GET" && url.pathname === "/api/eod-summary") {
      const summary = await getLastEodSummary();
      json(res, 200, summary);
      return;
    }

    if (method === "POST" && url.pathname === "/api/profile/switch") {
      const body = await readJsonBody(req);
      const profile = String(body?.profile ?? "").trim().toLowerCase() as ProfileName;
      const reason = String(body?.reason ?? "manual profile switch").trim();
      if (!["phase1", "phase2", "phase3"].includes(profile)) {
        json(res, 400, { error: "profile must be one of phase1, phase2, phase3" });
        return;
      }
      const applied = await applyProfile(profile);
      scheduler.stop();
      await setSafeMode(true, `Profile switched to ${profile}: ${reason}`, "profile_switch");
      await notifyOpsAlert("warning", "profile_switched", `Profile switched to ${profile}`, {
        reason,
        profile,
        appliedAt: applied.updatedAt
      });
      json(res, 200, {
        ok: true,
        applied,
        safeMode: getSafeModeState(),
        scheduler: scheduler.getState()
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/journal") {
      const body = await readJsonBody(req);
      const lotId = Number(body?.lotId);
      const symbol = String(body?.symbol ?? "").toUpperCase();
      const setupTag = String(body?.setupTag ?? "").trim();
      const confidence = Number(body?.confidence ?? 0);
      const mistakeTag = String(body?.mistakeTag ?? "").trim();
      const notes = String(body?.notes ?? "").trim();
      const screenshotUrl = String(body?.screenshotUrl ?? "").trim();
      if (!Number.isFinite(lotId) || lotId <= 0 || !symbol || !setupTag) {
        json(res, 400, { error: "lotId, symbol, setupTag are required" });
        return;
      }
      if (!Number.isFinite(confidence) || confidence < 1 || confidence > 5) {
        json(res, 400, { error: "confidence must be between 1 and 5" });
        return;
      }
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        json(res, 400, { error: "DATABASE_URL is not set" });
        return;
      }
      const persistence = new PostgresPersistence(databaseUrl);
      await persistence.init();
      await persistence.upsertTradeJournalEntry({
        lotId,
        symbol,
        setupTag,
        confidence,
        mistakeTag: mistakeTag || undefined,
        notes: notes || undefined,
        screenshotUrl: screenshotUrl || undefined
      });
      json(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/position/exit") {
      const body = await readJsonBody(req);
      const symbol = String(body?.symbol ?? "").trim().toUpperCase();
      const percent = Number(body?.percent ?? 100);
      const reason = String(body?.reason ?? "Manual UI exit");
      if (!symbol) {
        json(res, 400, { error: "symbol is required" });
        return;
      }
      const result = await runManualPositionExit(symbol, percent, reason);
      json(res, 200, { ok: true, result });
      return;
    }

    if (method === "POST" && url.pathname === "/api/position/stop") {
      const body = await readJsonBody(req);
      const symbol = String(body?.symbol ?? "").trim().toUpperCase();
      const stopPrice = Number(body?.stopPrice);
      if (!symbol || !Number.isFinite(stopPrice) || stopPrice <= 0) {
        json(res, 400, { error: "symbol and positive stopPrice are required" });
        return;
      }
      const result = await runManualStopUpdate(symbol, stopPrice);
      json(res, 200, { ok: true, result });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`UI server running at http://127.0.0.1:${PORT}`);
  if (scheduler.isRunning()) {
    console.log("SCHEDULER_ENABLED: started");
  }
  if (HAS_REACT_BUILD) {
    console.log("Serving React dashboard from dashboard/dist");
  }
});

async function tryServeReactApp(pathname: string, res: http.ServerResponse) {
  if (!HAS_REACT_BUILD) {
    return false;
  }
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const candidate = path.resolve(REACT_DIST_DIR, `.${safePath}`);
  if (!candidate.startsWith(REACT_DIST_DIR)) {
    return false;
  }

  if (existsSync(candidate) && !candidate.endsWith(path.sep)) {
    const body = await readFile(candidate);
    res.writeHead(200, { "Content-Type": contentTypeForPath(candidate) });
    res.end(body);
    return true;
  }

  if (!path.basename(pathname).includes(".")) {
    const indexPath = path.join(REACT_DIST_DIR, "index.html");
    if (existsSync(indexPath)) {
      const body = await readFile(indexPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
      return true;
    }
  }
  return false;
}

function contentTypeForPath(filePath: string) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function hydrateSafeModeFromDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.env.HALT_TRADING = safeModeState.enabled ? "1" : "0";
    return;
  }
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    const raw = await persistence.loadSystemState("safe_mode");
    if (!raw) {
      process.env.HALT_TRADING = safeModeState.enabled ? "1" : "0";
      return;
    }
    const parsed = JSON.parse(raw) as Partial<SafeModeState>;
    safeModeState = {
      enabled: parsed.enabled === true,
      reason: String(parsed.reason ?? ""),
      updatedAt: String(parsed.updatedAt ?? new Date().toISOString()),
      source: String(parsed.source ?? "db")
    };
    process.env.HALT_TRADING = safeModeState.enabled ? "1" : "0";
  } catch (err) {
    pushRuntimeError("SAFE_MODE_HYDRATE", err);
  }
}

function getSafeModeState(): SafeModeState {
  return { ...safeModeState };
}

async function setSafeMode(enabled: boolean, reason: string, source: string) {
  safeModeState = {
    enabled,
    reason,
    updatedAt: new Date().toISOString(),
    source
  };
  process.env.HALT_TRADING = enabled ? "1" : "0";
  if (enabled) {
    scheduler.stop();
  }
  await persistSafeModeState(safeModeState);
  await notifySafeModeChange(safeModeState);
}

async function persistSafeModeState(state: SafeModeState) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return;
  }
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    await persistence.upsertSystemState("safe_mode", JSON.stringify(state));
  } catch (err) {
    pushRuntimeError("SAFE_MODE_PERSIST", err);
  }
}

async function notifySafeModeChange(state: SafeModeState) {
  const databaseUrl = process.env.DATABASE_URL;
  let persistence: PostgresPersistence | NoopPersistence = new NoopPersistence();
  if (databaseUrl) {
    const pg = new PostgresPersistence(databaseUrl);
    try {
      await pg.init();
      persistence = pg;
    } catch {
      persistence = new NoopPersistence();
    }
  }
  try {
    const alerter = buildAlerter(persistence);
    await alerter.notify(
      state.enabled ? "warning" : "info",
      "safe_mode_toggled",
      state.enabled ? "Safe Mode enabled" : "Safe Mode disabled",
      {
        reason: state.reason,
        source: state.source,
        updatedAt: state.updatedAt
      }
    );
  } catch (err) {
    pushRuntimeError("SAFE_MODE_ALERT", err);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function launchJob(
  res: http.ServerResponse,
  job: UiJob,
  logTag: string,
  runner: () => Promise<unknown>
) {
  if (runningJob) {
    json(res, 409, { error: `Job already running: ${runningJob}` });
    return false;
  }
  if (job === "morning" && getSafeModeState().enabled) {
    json(res, 409, { error: "Safe Mode is enabled. Disable it before running Morning job." });
    return false;
  }
  void runUiJob(job, logTag, runner).catch(() => {
    // Swallow here: runUiJob already logs and stores runtime error.
  });
  json(res, 202, { accepted: true, job });
  return true;
}

async function runUiJob(job: UiJob, logTag: string, runner: () => Promise<unknown>) {
  if (runningJob) {
    throw new Error(`Job already running: ${runningJob}`);
  }
  if (job === "morning") {
    const preopen = await getPreopenChecklist();
    if (!preopen.ok) {
      const reason = preopen.checks
        .filter((x) => !x.ok)
        .map((x) => `${x.key}: ${x.message}`)
        .join(" | ");
      throw new Error(`Pre-open checklist failed: ${reason}`);
    }
  }
  runningJob = job;
  try {
    await runner();
    if (job === "eod_close") {
      await generateAndNotifyEodSummary();
    }
  } catch (err) {
    console.error(`${logTag}_FAIL`, err);
    pushRuntimeError(logTag, err);
    await notifyOpsAlert("critical", "ui_job_failed", `${logTag} failed`, {
      job,
      error: err instanceof Error ? err.message : String(err)
    });
    throw err;
  } finally {
    runningJob = null;
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function getDbReport() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      dbEnabled: false,
      orders: [],
      fills: [],
      positions: [],
      managedPositions: [],
      dailySnapshots: [],
      rejectGuard: { tradeDate: getIstTradeDate(), rejectCounts: {}, blockedSymbols: {} },
      funds: null,
      fundsHistory: [],
      lastBrokerSyncAt: null,
      lastPreflight: null,
      latestAlerts: [],
      latestReconcile: []
    };
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const [orders, fills, positions, managed, dailySnapshots] = await Promise.all([
      pool.query(
        `
        SELECT order_id, symbol, side, qty, state, avg_fill_price, updated_at
        FROM orders
        ORDER BY updated_at DESC
        LIMIT 20
        `
      ),
      pool.query(
        `
        SELECT order_id, symbol, side, qty, price, fill_time
        FROM fills
        ORDER BY fill_time DESC
        LIMIT 20
        `
      ),
      pool.query(
        `
        SELECT symbol, qty, avg_price, updated_at
        FROM positions
        ORDER BY symbol
        `
      ),
      pool.query(
        `
        SELECT symbol, qty, atr14, stop_price, highest_price, updated_at
        FROM managed_positions
        ORDER BY symbol
        `
      ),
      pool.query(
        `
        SELECT trade_date, equity, realized_pnl, unrealized_pnl, open_positions, note, created_at
        FROM daily_snapshots
        ORDER BY trade_date DESC
        LIMIT 120
        `
      )
    ]);

    const systemStateTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.system_state') AS exists`
    );
    const stateRows =
      systemStateTable.rows[0]?.exists
        ? await pool.query<{ key: string; value: string }>(
            `SELECT key, value FROM system_state WHERE key IN ('last_broker_sync_at', 'last_preflight', 'last_available_funds', 'funds_history', $1)`,
            [`reject_guard_${getIstTradeDate()}`]
          )
        : { rows: [] as Array<{ key: string; value: string }> };
    const stateMap = new Map(stateRows.rows.map((r) => [r.key, r.value]));
    const fundsRaw = stateMap.get("last_available_funds");
    let funds: {
      availableCash: number;
      usableEquity: number;
      fundUsagePct: number;
      source: string;
      updatedAt: string;
    } | null = null;
    if (fundsRaw) {
      try {
        const parsed = JSON.parse(fundsRaw) as Partial<{
          availableCash: number;
          usableEquity: number;
          fundUsagePct: number;
          source: string;
          updatedAt: string;
        }>;
        funds = {
          availableCash: Number(parsed.availableCash ?? 0),
          usableEquity: Number(parsed.usableEquity ?? 0),
          fundUsagePct: Number(parsed.fundUsagePct ?? 0),
          source: String(parsed.source ?? "unknown"),
          updatedAt: String(parsed.updatedAt ?? "")
        };
      } catch {
        funds = null;
      }
    }
    const fundsHistoryRaw = stateMap.get("funds_history");
    let fundsHistory: Array<{
      ts: string;
      availableCash: number;
      usableEquity: number;
      source: string;
    }> = [];
    if (fundsHistoryRaw) {
      try {
        const parsed = JSON.parse(fundsHistoryRaw) as Array<{
          ts?: string;
          availableCash?: number;
          usableEquity?: number;
          source?: string;
        }>;
        fundsHistory = Array.isArray(parsed)
          ? parsed
              .map((x) => ({
                ts: String(x.ts ?? ""),
                availableCash: Number(x.availableCash ?? 0),
                usableEquity: Number(x.usableEquity ?? 0),
                source: String(x.source ?? "unknown")
              }))
              .filter((x) => x.ts.length > 0)
              .slice(-200)
          : [];
      } catch {
        fundsHistory = [];
      }
    }
    const rejectGuardRaw = stateMap.get(`reject_guard_${getIstTradeDate()}`);
    let rejectGuard: {
      tradeDate: string;
      rejectCounts: Record<string, number>;
      blockedSymbols: Record<string, { blockedAt: string; reason: string; count: number }>;
    } = { tradeDate: getIstTradeDate(), rejectCounts: {}, blockedSymbols: {} };
    if (rejectGuardRaw) {
      try {
        const parsed = JSON.parse(rejectGuardRaw) as Partial<typeof rejectGuard>;
        rejectGuard = {
          tradeDate: parsed.tradeDate ?? getIstTradeDate(),
          rejectCounts: parsed.rejectCounts ?? {},
          blockedSymbols: parsed.blockedSymbols ?? {}
        };
      } catch {
        rejectGuard = { tradeDate: getIstTradeDate(), rejectCounts: {}, blockedSymbols: {} };
      }
    }

    const alertsTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.alert_events') AS exists`
    );
    const latestAlerts =
      alertsTable.rows[0]?.exists
        ? await pool.query(
            `
            SELECT id, severity, type, message, created_at
            FROM alert_events
            ORDER BY created_at DESC
            LIMIT 10
            `
          )
        : { rows: [] as any[] };

    const reconcileTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.reconcile_audit') AS exists`
    );
    const latestReconcile =
      reconcileTable.rows[0]?.exists
        ? await pool.query(
            `
            SELECT id, run_id, drift_count, created_at
            FROM reconcile_audit
            ORDER BY created_at DESC
            LIMIT 10
            `
          )
        : { rows: [] as any[] };
    return {
      dbEnabled: true,
      orders: orders.rows,
      fills: fills.rows,
      positions: positions.rows,
      managedPositions: managed.rows,
      dailySnapshots: dailySnapshots.rows,
      rejectGuard,
      funds,
      fundsHistory,
      lastBrokerSyncAt: stateMap.get("last_broker_sync_at") ?? null,
      lastPreflight: stateMap.get("last_preflight") ?? null,
      latestAlerts: latestAlerts.rows,
      latestReconcile: latestReconcile.rows
    };
  } catch (err) {
    maybeLogDbError(err);
    return {
      dbEnabled: false,
      dbError: "Database connection failed",
      orders: [],
      fills: [],
      positions: [],
      managedPositions: [],
      dailySnapshots: [],
      rejectGuard: { tradeDate: getIstTradeDate(), rejectCounts: {}, blockedSymbols: {} },
      funds: null,
      fundsHistory: [],
      lastBrokerSyncAt: null,
      lastPreflight: null,
      latestAlerts: [],
      latestReconcile: []
    };
  } finally {
    await pool.end();
  }
}

async function getStrategyReport() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      enabled: false,
      closedLots: 0,
      winRate: 0,
      avgR: 0,
      totalPnl: 0,
      maxDrawdown: 0,
      bySymbol: []
    };
  }

  const lookback = Number(process.env.STRATEGY_REPORT_LOOKBACK ?? "200");
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    const lots = await persistence.loadClosedTradeLots(lookback);
    if (lots.length === 0) {
      return {
        enabled: true,
        closedLots: 0,
        winRate: 0,
        avgR: 0,
        totalPnl: 0,
        maxDrawdown: 0,
        bySymbol: []
      };
    }

    const rows = lots.map((lot) => {
      const pnl = (lot.exitPrice - lot.entryPrice) * lot.qty;
      const riskPerShare = Math.max(lot.entryPrice - lot.stopPrice, 0.01);
      const rMultiple = (lot.exitPrice - lot.entryPrice) / riskPerShare;
      return { symbol: lot.symbol, pnl, rMultiple };
    });

    const wins = rows.filter((r) => r.pnl > 0).length;
    const winRate = wins / rows.length;
    const avgR = avg(rows.map((r) => r.rMultiple));
    const totalPnl = sum(rows.map((r) => r.pnl));
    const maxDrawdown = maxDrawdownFromPnL(rows.map((r) => r.pnl));
    const bySymbol = summarizeBySymbol(rows);

    return {
      enabled: true,
      closedLots: rows.length,
      winRate,
      avgR,
      totalPnl,
      maxDrawdown,
      bySymbol
    };
  } catch (err) {
    maybeLogDbError(err);
    return {
      enabled: false,
      closedLots: 0,
      winRate: 0,
      avgR: 0,
      totalPnl: 0,
      maxDrawdown: 0,
      bySymbol: []
    };
  }
}

async function getBacktestReport() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { enabled: false, latest: null };
  }
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    const latest = await persistence.loadLatestBacktestRun();
    if (!latest) {
      return { enabled: true, latest: null };
    }
    let meta: {
      bySymbol?: Array<{ symbol: string; trades: number; winRate: number; pnl: number; avgR: number }>;
      notes?: string[];
    } | null = null;
    try {
      meta = latest.metaJson ? JSON.parse(latest.metaJson) : null;
    } catch {
      meta = null;
    }
    return {
      enabled: true,
      latest: {
        ...latest,
        bySymbol: meta?.bySymbol ?? [],
        notes: meta?.notes ?? []
      }
    };
  } catch (err) {
    maybeLogDbError(err);
    return { enabled: false, latest: null };
  }
}

async function runStrategyLabAndPersist() {
  const output = await runStrategyLabSweep();
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const persistence = new PostgresPersistence(databaseUrl);
    await persistence.init();
    await persistence.insertStrategyLabRun({
      runId: output.runId,
      label: output.label,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
      status: "completed",
      datasetWindow: output.datasetWindow,
      notesJson: JSON.stringify({ candidateCount: output.candidates.length })
    });
    for (const candidate of output.candidates) {
      await persistence.insertStrategyLabCandidate({
        runId: output.runId,
        candidateId: candidate.candidateId,
        paramsJson: JSON.stringify(candidate.params),
        trades: candidate.trades,
        winRate: candidate.winRate,
        avgR: candidate.avgR,
        expectancy: candidate.expectancy,
        maxDrawdownPct: candidate.maxDrawdownPct,
        cagrPct: candidate.cagrPct,
        sharpeProxy: candidate.sharpeProxy,
        stabilityScore: candidate.stabilityScore,
        robustnessScore: candidate.robustnessScore,
        guardrailPass: candidate.guardrailPass,
        guardrailReasonsJson: JSON.stringify(candidate.guardrailReasons)
      });
    }
    await persistence.upsertStrategyLabRecommendation({
      runId: output.runId,
      candidateId: output.recommendation.candidateId,
      approvedForApply: output.recommendation.approvedForApply,
      reasonJson: JSON.stringify(output.recommendation.reasons)
    });
    await persistence.upsertSystemState("last_strategy_lab_run", output.runId);
  }
  await notifyOpsAlert("info", "strategy_lab_run_completed", "Strategy Lab run completed", {
    runId: output.runId,
    candidates: output.candidates.length,
    recommendation: output.recommendation
  });
  return output;
}

async function getStrategyLabReport() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      enabled: false,
      latestRun: null,
      recommendation: null,
      candidates: []
    };
  }
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    const latestRun = await persistence.loadLatestStrategyLabRun();
    if (!latestRun) {
      return {
        enabled: true,
        latestRun: null,
        recommendation: null,
        candidates: []
      };
    }
    const [candidates, recommendation] = await Promise.all([
      persistence.loadStrategyLabCandidates(latestRun.runId),
      persistence.loadStrategyLabRecommendation(latestRun.runId)
    ]);
    return {
      enabled: true,
      latestRun,
      recommendation: recommendation
        ? {
            candidateId: recommendation.candidateId,
            approvedForApply: recommendation.approvedForApply,
            reasons: parseJsonArray(recommendation.reasonJson)
          }
        : null,
      candidates: candidates.map((x) => ({
        candidateId: x.candidateId,
        params: parseCandidateParams(x.paramsJson),
        trades: x.trades,
        winRate: x.winRate,
        avgR: x.avgR,
        expectancy: x.expectancy,
        maxDrawdownPct: x.maxDrawdownPct,
        cagrPct: x.cagrPct,
        sharpeProxy: x.sharpeProxy,
        stabilityScore: x.stabilityScore,
        robustnessScore: x.robustnessScore,
        guardrailPass: x.guardrailPass,
        guardrailReasons: parseJsonArray(x.guardrailReasonsJson)
      }))
    };
  } catch (err) {
    maybeLogDbError(err);
    return {
      enabled: false,
      latestRun: null,
      recommendation: null,
      candidates: []
    };
  }
}

async function applyStrategyLabCandidate(candidateId: string) {
  const report = await getStrategyLabReport();
  if (!report.enabled) {
    return { ok: false, error: "Strategy Lab data not available" };
  }
  const selected = (report.candidates ?? []).find((x) => x.candidateId === candidateId);
  if (!selected) {
    return { ok: false, error: `Candidate ${candidateId} not found in latest Strategy Lab run` };
  }

  const updates: Record<string, string> = {
    STRATEGY_MIN_RSI: String(Math.round(selected.params.minRsi)),
    STRATEGY_BREAKOUT_BUFFER_PCT: roundToStr(selected.params.breakoutBufferPct, 4),
    ATR_STOP_MULTIPLE: roundToStr(selected.params.atrStopMultiple, 2),
    RISK_PER_TRADE: roundToStr(selected.params.riskPerTrade, 4),
    STRATEGY_MIN_VOLUME_RATIO: roundToStr(selected.params.minVolumeRatio, 2),
    STRATEGY_MAX_SIGNALS: String(Math.round(selected.params.maxSignals))
  };
  const applied = await applyEnvOverrides(updates);
  scheduler.stop();
  await setSafeMode(true, `Strategy Lab candidate ${candidateId} applied`, "strategy_lab_apply");
  await notifyOpsAlert("warning", "strategy_lab_applied", `Applied Strategy Lab candidate ${candidateId}`, {
    candidateId,
    params: selected.params,
    approvedForApply: report.recommendation?.approvedForApply ?? false
  });
  return {
    ok: true,
    candidateId,
    params: selected.params,
    applied,
    safeMode: getSafeModeState(),
    scheduler: scheduler.getState()
  };
}

async function getJournalReport() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { enabled: false, entries: [], closedLots: [], analytics: emptyJournalAnalytics() };
  }
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    const lookback = Number(process.env.STRATEGY_REPORT_LOOKBACK ?? "200");
    const [entries, closedLots] = await Promise.all([
      persistence.loadTradeJournalEntries(200),
      persistence.loadClosedTradeLots(lookback)
    ]);
    const analytics = journalAnalytics(entries, closedLots);
    return { enabled: true, entries, closedLots, analytics };
  } catch (err) {
    maybeLogDbError(err);
    return { enabled: false, entries: [], closedLots: [], analytics: emptyJournalAnalytics() };
  }
}

async function getDriftReport() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { enabled: false, summary: null, rows: [], message: "DATABASE_URL is not set" };
  }
  const persistence = new PostgresPersistence(databaseUrl);
  const lookback = Number(process.env.STRATEGY_REPORT_LOOKBACK ?? "200");
  const winRateAlertPct = Number(process.env.DRIFT_WINRATE_ALERT_PCT ?? "12");
  const avgRAlert = Number(process.env.DRIFT_AVGR_ALERT ?? "0.5");
  try {
    await persistence.init();
    const [lots, latestBacktest] = await Promise.all([
      persistence.loadClosedTradeLots(lookback),
      persistence.loadLatestBacktestRun()
    ]);
    if (!latestBacktest) {
      return {
        enabled: true,
        summary: null,
        rows: [],
        message: "No backtest baseline found. Run backtest first."
      };
    }

    let backtestBySymbol: Array<{
      symbol: string;
      trades: number;
      winRate: number;
      pnl: number;
      avgR: number;
    }> = [];
    try {
      const meta = latestBacktest.metaJson ? JSON.parse(latestBacktest.metaJson) : null;
      backtestBySymbol = Array.isArray(meta?.bySymbol) ? meta.bySymbol : [];
    } catch {
      backtestBySymbol = [];
    }

    const liveRows = lots.map((lot) => {
      const pnl = (lot.exitPrice - lot.entryPrice) * lot.qty;
      const riskPerShare = Math.max(lot.entryPrice - lot.stopPrice, 0.01);
      const rMultiple = (lot.exitPrice - lot.entryPrice) / riskPerShare;
      return { symbol: lot.symbol, pnl, rMultiple };
    });
    const liveBySymbol = summarizeBySymbol(liveRows).map((x) => ({
      symbol: x.symbol,
      trades: x.trades,
      winRate: x.winRate,
      avgR: x.avgR,
      pnl: x.pnl,
      expectancy: x.trades > 0 ? x.pnl / x.trades : 0
    }));
    const btBySymbolMap = new Map(
      backtestBySymbol.map((x) => [
        x.symbol,
        {
          symbol: x.symbol,
          trades: Number(x.trades ?? 0),
          winRate: Number(x.winRate ?? 0),
          avgR: Number(x.avgR ?? 0),
          pnl: Number(x.pnl ?? 0),
          expectancy: Number(x.trades ?? 0) > 0 ? Number(x.pnl ?? 0) / Number(x.trades ?? 1) : 0
        }
      ])
    );
    const liveBySymbolMap = new Map(liveBySymbol.map((x) => [x.symbol, x]));
    const symbols = Array.from(new Set([...liveBySymbolMap.keys(), ...btBySymbolMap.keys()]));
    const rows = symbols
      .map((symbol) => {
        const live = liveBySymbolMap.get(symbol) ?? {
          symbol,
          trades: 0,
          winRate: 0,
          avgR: 0,
          pnl: 0,
          expectancy: 0
        };
        const bt = btBySymbolMap.get(symbol) ?? {
          symbol,
          trades: 0,
          winRate: 0,
          avgR: 0,
          pnl: 0,
          expectancy: 0
        };
        const deltaWinRate = live.winRate - bt.winRate;
        const deltaAvgR = live.avgR - bt.avgR;
        const deltaExpectancy = live.expectancy - bt.expectancy;
        const alert =
          Math.abs(deltaWinRate * 100) >= winRateAlertPct || Math.abs(deltaAvgR) >= avgRAlert;
        const driftScore = Math.abs(deltaWinRate) + Math.abs(deltaAvgR) * 0.2;
        return {
          symbol,
          liveTrades: live.trades,
          btTrades: bt.trades,
          liveWinRate: live.winRate,
          btWinRate: bt.winRate,
          deltaWinRate,
          liveAvgR: live.avgR,
          btAvgR: bt.avgR,
          deltaAvgR,
          liveExpectancy: live.expectancy,
          btExpectancy: bt.expectancy,
          deltaExpectancy,
          driftScore,
          alert
        };
      })
      .sort((a, b) => b.driftScore - a.driftScore)
      .slice(0, 15);

    const liveSummary = {
      trades: liveRows.length,
      winRate: liveRows.length === 0 ? 0 : liveRows.filter((x) => x.pnl > 0).length / liveRows.length,
      avgR: liveRows.length === 0 ? 0 : avg(liveRows.map((x) => x.rMultiple)),
      totalPnl: sum(liveRows.map((x) => x.pnl)),
      expectancy: liveRows.length === 0 ? 0 : sum(liveRows.map((x) => x.pnl)) / liveRows.length
    };
    const summary = {
      liveTrades: liveSummary.trades,
      btTrades: latestBacktest.trades,
      liveWinRate: liveSummary.winRate,
      btWinRate: latestBacktest.winRate,
      deltaWinRate: liveSummary.winRate - latestBacktest.winRate,
      liveAvgR: liveSummary.avgR,
      btAvgR: latestBacktest.avgR,
      deltaAvgR: liveSummary.avgR - latestBacktest.avgR,
      liveExpectancy: liveSummary.expectancy,
      btExpectancy: latestBacktest.expectancy,
      deltaExpectancy: liveSummary.expectancy - latestBacktest.expectancy,
      alerts: rows.filter((r) => r.alert).length
    };
    return {
      enabled: true,
      summary,
      rows,
      message:
        liveSummary.trades < 20
          ? "Live sample is small (<20 trades). Drift confidence is low."
          : ""
    };
  } catch (err) {
    maybeLogDbError(err);
    return { enabled: false, summary: null, rows: [], message: "Unable to compute drift report" };
  }
}

async function getHealthReport() {
  const databaseUrl = process.env.DATABASE_URL;
  const startedAt = Date.now();

  const db = await checkDbHealth(databaseUrl);
  const broker = await checkBrokerHealth();
  const schedulerState = scheduler.getState();
  const token = getTokenLifetimeEstimate();
  const funds = await loadFundsState(databaseUrl);
  const preopen = await getPreopenChecklist();

  await maybeSendTokenRiskAlert(token);

  let latestAlertErrors: Array<{ time: string; type: string; message: string }> = [];
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const alertTable = await pool.query<{ exists: string | null }>(
        `SELECT to_regclass('public.alert_events') AS exists`
      );
      if (alertTable.rows[0]?.exists) {
        const rows = await pool.query(
          `
          SELECT created_at, type, message
          FROM alert_events
          WHERE severity = 'critical'
          ORDER BY created_at DESC
          LIMIT 10
          `
        );
        latestAlertErrors = rows.rows.map((r) => ({
          time: new Date(r.created_at).toISOString(),
          type: r.type,
          message: r.message
        }));
      }
    } catch (err) {
      pushRuntimeError("HEALTH_DB_ALERTS", err);
    } finally {
      await pool.end();
    }
  }

  const errors = [
    ...runtimeErrors,
    ...Object.entries(schedulerState.lastErrors ?? {})
      .filter(([, msg]) => Boolean(msg))
      .map(([source, message]) => ({
        time: new Date().toISOString(),
        source: `scheduler:${source}`,
        message: String(message)
      })),
    ...latestAlertErrors.map((x) => ({
      time: x.time,
      source: `alert:${x.type}`,
      message: x.message
    }))
  ]
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 20);

  return {
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    db,
    broker,
    token,
    funds,
    preopen,
    safeMode: getSafeModeState(),
    scheduler: {
      enabled: schedulerState.enabled,
      lastRuns: schedulerState.lastRuns
    },
    errors
  };
}

async function getProfileRecommendation() {
  const [profile, strategy, drift, health, report] = await Promise.all([
    getProfileSnapshot(),
    getStrategyReport(),
    getDriftReport(),
    getHealthReport(),
    getDbReport()
  ]);

  const reasons: string[] = [];
  const blockers: string[] = [];
  let score = 0;

  if (health.db?.status === "ok") {
    score += 15;
    reasons.push("DB health is stable");
  } else {
    blockers.push("DB health is not OK");
  }

  if (health.broker?.status === "ok" || health.broker?.status === "paper") {
    score += 15;
    reasons.push("Broker connectivity is healthy");
  } else {
    blockers.push("Broker health is down");
  }

  const closedLots = Number(strategy.closedLots ?? 0);
  if (closedLots >= 40) {
    score += 20;
    reasons.push("Sufficient trade sample (>=40)");
  } else if (closedLots >= 20) {
    score += 12;
    reasons.push("Moderate trade sample (>=20)");
  } else {
    blockers.push("Not enough closed trades (<20)");
  }

  const winRate = Number(strategy.winRate ?? 0);
  if (winRate >= 0.52) {
    score += 12;
    reasons.push("Win rate is strong");
  } else if (winRate >= 0.45) {
    score += 7;
    reasons.push("Win rate is acceptable");
  } else {
    score -= 10;
    reasons.push("Win rate is weak");
  }

  const avgR = Number(strategy.avgR ?? 0);
  if (avgR >= 0.6) {
    score += 12;
    reasons.push("Avg R is strong");
  } else if (avgR >= 0.2) {
    score += 7;
    reasons.push("Avg R is acceptable");
  } else {
    score -= 10;
    reasons.push("Avg R is weak");
  }

  const driftAlerts = Number(drift.summary?.alerts ?? 0);
  if (drift.enabled && driftAlerts === 0) {
    score += 12;
    reasons.push("No drift alerts");
  } else if (driftAlerts > 0) {
    score -= Math.min(12, driftAlerts * 2);
    reasons.push(`Drift alerts present (${driftAlerts})`);
  }

  const blocked = Object.keys(report.rejectGuard?.blockedSymbols ?? {}).length;
  if (blocked === 0) {
    score += 8;
    reasons.push("No reject-guard blocks today");
  } else {
    score -= Math.min(10, blocked * 2);
    reasons.push(`Reject-guard blocked symbols (${blocked})`);
  }

  const safeMode = getSafeModeState();
  if (safeMode.enabled) {
    reasons.push("Safe Mode is currently ON");
  }

  let recommended: ProfileName = "phase1";
  if (blockers.length > 0 || score < 45) {
    recommended = "phase1";
  } else if (score < 72) {
    recommended = "phase2";
  } else {
    recommended = "phase3";
  }

  return {
    activeProfile: profile.activeProfile,
    recommendedProfile: recommended,
    score,
    reasons,
    blockers,
    autoSwitchAllowed: blockers.length === 0,
    generatedAt: new Date().toISOString()
  };
}

async function getPreopenChecklist(): Promise<PreopenChecklist> {
  const checks: PreopenChecklist["checks"] = [];
  const liveMode = process.env.LIVE_ORDER_MODE === "1";
  const db = await checkDbHealth(process.env.DATABASE_URL);
  checks.push({
    key: "db",
    ok: db.status === "ok",
    message: db.message
  });

  const broker = await checkBrokerHealth();
  checks.push({
    key: "broker",
    ok: broker.status === "ok" || (!liveMode && broker.status === "paper"),
    message: broker.message
  });

  const token = getTokenLifetimeEstimate();
  const tokenAlertMinutes = Number(process.env.TOKEN_EXPIRY_ALERT_MINUTES ?? "120");
  const tokenOk =
    !liveMode ||
    (token.known === true &&
      Number(token.timeLeftMs ?? 0) > Math.max(5, tokenAlertMinutes) * 60_000);
  checks.push({
    key: "token",
    ok: tokenOk,
    message:
      token.known === true
        ? `Token left: ${token.timeLeftHuman}`
        : (token.message ?? "token unavailable")
  });

  const funds = await loadFundsState(process.env.DATABASE_URL);
  const fundsOk =
    !liveMode ||
    (funds !== null &&
      Number(funds.availableCash) > 0 &&
      Number(funds.usableEquity) > 0);
  checks.push({
    key: "funds",
    ok: fundsOk,
    message:
      funds !== null
        ? `Available ${inrNum(funds.availableCash)} | Usable ${inrNum(funds.usableEquity)}`
        : "funds snapshot missing"
  });

  const ok = checks.every((x) => x.ok);
  return {
    ok,
    checkedAt: new Date().toISOString(),
    checks
  };
}

async function maybeSendTokenRiskAlert(token: ReturnType<typeof getTokenLifetimeEstimate>) {
  const liveMode = process.env.LIVE_ORDER_MODE === "1";
  if (!liveMode || !token.known) {
    return;
  }
  const tokenAlertMinutes = Number(process.env.TOKEN_EXPIRY_ALERT_MINUTES ?? "120");
  const thresholdMs = Math.max(5, tokenAlertMinutes) * 60_000;
  if (Number(token.timeLeftMs ?? 0) > thresholdMs) {
    return;
  }
  const now = Date.now();
  if (now - lastTokenRiskAlertAt < 15 * 60_000) {
    return;
  }
  lastTokenRiskAlertAt = now;
  await notifyOpsAlert("warning", "token_expiry_risk", "Kite access token near expiry", {
    timeLeft: token.timeLeftHuman,
    expiresAt: token.expiresAt
  });
}

async function generateAndNotifyEodSummary() {
  const summary = await buildEodSummary();
  await persistEodSummary(summary);
  await notifyOpsAlert("info", "eod_summary", summary.text, {
    generatedAt: summary.generatedAt,
    fields: summary.fields
  });
}

async function buildEodSummary() {
  const [report, drift, recommendation] = await Promise.all([
    getDbReport(),
    getDriftReport(),
    getProfileRecommendation()
  ]);
  const snapshots = report.dailySnapshots ?? [];
  const latestSnapshot =
    snapshots.length > 0
      ? snapshots.reduce((a: any, b: any) => (String(a.trade_date) > String(b.trade_date) ? a : b))
      : null;
  const today = getIstTradeDate();
  const todayOrders = (report.orders ?? []).filter((o: any) => toIstDate(String(o.updated_at ?? "")) === today);
  const todayFills = (report.fills ?? []).filter((f: any) => toIstDate(String(f.fill_time ?? "")) === today);
  const blocked = Object.keys(report.rejectGuard?.blockedSymbols ?? {}).length;
  const text =
    `EOD Summary ${today} | orders=${todayOrders.length} fills=${todayFills.length}` +
    ` | realized=${inrNum(Number(latestSnapshot?.realized_pnl ?? 0))}` +
    ` | unrealized=${inrNum(Number(latestSnapshot?.unrealized_pnl ?? 0))}` +
    ` | rejectBlocks=${blocked}` +
    ` | driftAlerts=${Number(drift.summary?.alerts ?? 0)}` +
    ` | recommendedProfile=${recommendation.recommendedProfile}` +
    ` (score=${recommendation.score})`;
  return {
    generatedAt: new Date().toISOString(),
    text,
    fields: {
      tradeDate: today,
      orders: todayOrders.length,
      fills: todayFills.length,
      realizedPnl: Number(latestSnapshot?.realized_pnl ?? 0),
      unrealizedPnl: Number(latestSnapshot?.unrealized_pnl ?? 0),
      rejectBlocks: blocked,
      driftAlerts: Number(drift.summary?.alerts ?? 0),
      recommendedProfile: recommendation.recommendedProfile,
      recommendationScore: recommendation.score
    }
  };
}

async function persistEodSummary(summary: { generatedAt: string; text: string; fields: Record<string, unknown> }) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return;
  }
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    await persistence.upsertSystemState("last_eod_summary", JSON.stringify(summary));
  } catch (err) {
    pushRuntimeError("EOD_SUMMARY_PERSIST", err);
  }
}

async function getLastEodSummary() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { available: false, summary: null };
  }
  const persistence = new PostgresPersistence(databaseUrl);
  try {
    await persistence.init();
    const raw = await persistence.loadSystemState("last_eod_summary");
    if (!raw) {
      return { available: false, summary: null };
    }
    return { available: true, summary: JSON.parse(raw) };
  } catch {
    return { available: false, summary: null };
  }
}

async function loadFundsState(databaseUrl: string | undefined) {
  if (!databaseUrl) {
    return null;
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const state = await pool.query<{ value: string }>(
      `SELECT value FROM system_state WHERE key = 'last_available_funds' LIMIT 1`
    );
    const raw = state.rows[0]?.value;
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<{
      availableCash: number;
      usableEquity: number;
      fundUsagePct: number;
      source: string;
      updatedAt: string;
    }>;
    return {
      availableCash: Number(parsed.availableCash ?? 0),
      usableEquity: Number(parsed.usableEquity ?? 0),
      fundUsagePct: Number(parsed.fundUsagePct ?? 0),
      source: String(parsed.source ?? "unknown"),
      updatedAt: String(parsed.updatedAt ?? "")
    };
  } catch {
    return null;
  } finally {
    await pool.end();
  }
}

async function notifyOpsAlert(
  severity: "info" | "warning" | "critical",
  type: string,
  message: string,
  context?: unknown
) {
  const databaseUrl = process.env.DATABASE_URL;
  let persistence: PostgresPersistence | NoopPersistence = new NoopPersistence();
  if (databaseUrl) {
    const pg = new PostgresPersistence(databaseUrl);
    try {
      await pg.init();
      persistence = pg;
    } catch {
      persistence = new NoopPersistence();
    }
  }
  try {
    const alerter = buildAlerter(persistence);
    await alerter.notify(severity, type, message, context);
  } catch (err) {
    pushRuntimeError("OPS_ALERT_NOTIFY", err);
  }
}

function inrNum(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(Number(value ?? 0));
}

async function getBrokerOrdersReport(
  forceRefresh = false,
  filter: BrokerOrderFilter = { status: "all", severity: "all", search: "" }
): Promise<BrokerOrdersReport> {
  const ttlMs = Number(process.env.BROKER_ORDERS_CACHE_MS ?? "30000");
  if (!forceRefresh && brokerOrdersCache && Date.now() - brokerOrdersCache.fetchedAtMs < ttlMs) {
    return withBrokerOrderFilter(brokerOrdersCache.data, filter);
  }

  if (process.env.LIVE_ORDER_MODE !== "1") {
    const data = {
      enabled: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      message: "Broker orders are available only in live mode.",
      stats: { total: 0, complete: 0, open: 0, rejected: 0, cancelled: 0, filtered: 0 },
      orders: [] as Array<Record<string, unknown>>
    };
    brokerOrdersCache = { fetchedAtMs: Date.now(), data };
    return withBrokerOrderFilter(data, filter);
  }

  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (!apiKey || !accessToken) {
    const data = {
      enabled: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      message: "KITE_API_KEY or KITE_ACCESS_TOKEN is missing.",
      stats: { total: 0, complete: 0, open: 0, rejected: 0, cancelled: 0, filtered: 0 },
      orders: [] as Array<Record<string, unknown>>
    };
    brokerOrdersCache = { fetchedAtMs: Date.now(), data };
    return withBrokerOrderFilter(data, filter);
  }

  try {
    const exec = new ZerodhaAdapter(new MapLtpProvider(new Map([["NIFTYBEES", 1]])), {
      mode: "live",
      apiKey,
      accessToken,
      exchange: process.env.KITE_EXCHANGE ?? "NSE",
      product: process.env.KITE_PRODUCT ?? "CNC",
      orderVariety: (process.env.KITE_ORDER_VARIETY as "regular" | "amo" | undefined) ?? "regular"
    });
    const rows = await exec.fetchBrokerOrders();
    const today = getIstTradeDate();
    const orders = rows
      .filter((o) => !o.updatedAt || toIstDate(o.updatedAt) === today)
      .map((o) => {
        const reason =
          o.rejectedReason ?? o.statusMessageRaw ?? o.statusMessage ?? "";
        const diag = diagnoseBrokerOrder(reason, o.status);
        return {
          orderId: o.orderId,
          symbol: o.symbol,
          status: o.status,
          side: o.side ?? "",
          qty: o.qty ?? 0,
          filledQty: o.filledQty ?? 0,
          cancelledQty: o.cancelledQty ?? 0,
          product: o.product ?? "",
          exchange: o.exchange ?? "",
          validity: o.validity ?? "",
          averagePrice: o.averagePrice,
          updatedAt: o.updatedAt ?? "",
          reason,
          hintCode: diag.hintCode,
          hintText: diag.hintText,
          severity: diag.severity
        };
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const stats = {
      total: orders.length,
      complete: orders.filter((o) => o.status === "COMPLETE").length,
      open: orders.filter((o) => ["OPEN", "TRIGGER PENDING", "MODIFY VALIDATION PENDING"].includes(o.status)).length,
      rejected: orders.filter((o) => o.status === "REJECTED").length,
      cancelled: orders.filter((o) => o.status === "CANCELLED").length,
      filtered: orders.length
    };
    const data = {
      enabled: true,
      stale: false,
      fetchedAt: new Date().toISOString(),
      message: "",
      stats,
      orders
    };
    brokerOrdersCache = { fetchedAtMs: Date.now(), data };
    return withBrokerOrderFilter(data, filter);
  } catch (err) {
    pushRuntimeError("BROKER_ORDERS", err);
    if (brokerOrdersCache) {
      const cached = {
        ...brokerOrdersCache.data,
        stale: true,
        message: `Broker API unavailable. Showing cached data. ${err instanceof Error ? err.message : String(err)}`
      };
      return withBrokerOrderFilter(cached, filter);
    }
    return {
      enabled: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
      stats: { total: 0, complete: 0, open: 0, rejected: 0, cancelled: 0, filtered: 0 },
      orders: [] as Array<Record<string, unknown>>
    };
  }
}

async function checkDbHealth(databaseUrl: string | undefined) {
  if (!databaseUrl) {
    return { status: "off", latencyMs: null, message: "DATABASE_URL is not set" };
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const started = Date.now();
  try {
    await pool.query("SELECT 1");
    return { status: "ok", latencyMs: Date.now() - started, message: "DB reachable" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "down", latencyMs: Date.now() - started, message };
  } finally {
    await pool.end();
  }
}

async function checkBrokerHealth() {
  if (process.env.LIVE_ORDER_MODE !== "1") {
    return { status: "paper", latencyMs: null, message: "Paper mode" };
  }
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (!apiKey || !accessToken) {
    return { status: "down", latencyMs: null, message: "Kite credentials missing" };
  }
  const started = Date.now();
  try {
    const adapter = new ZerodhaAdapter(new MapLtpProvider(new Map([["NIFTYBEES", 1]])), {
      mode: "live",
      apiKey,
      accessToken,
      exchange: process.env.KITE_EXCHANGE ?? "NSE",
      product: process.env.KITE_PRODUCT ?? "CNC"
    });
    const preflight = await adapter.preflightCheck();
    if (!preflight.ok) {
      return { status: "down", latencyMs: Date.now() - started, message: preflight.message };
    }
    return {
      status: "ok",
      latencyMs: Date.now() - started,
      message: preflight.accountUserId
        ? `Authenticated as ${preflight.accountUserId}`
        : "Broker session valid"
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "down", latencyMs: Date.now() - started, message };
  }
}

function getTokenLifetimeEstimate() {
  const createdAtRaw = process.env.KITE_ACCESS_TOKEN_CREATED_AT;
  const resetHour = Number(process.env.KITE_TOKEN_RESET_HOUR_IST ?? "6");
  const resetMinute = Number(process.env.KITE_TOKEN_RESET_MINUTE_IST ?? "0");
  if (!createdAtRaw) {
    return {
      known: false,
      message: "Token creation time unknown. Regenerate via npm run auth for countdown."
    };
  }
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) {
    return {
      known: false,
      message: "Invalid KITE_ACCESS_TOKEN_CREATED_AT format."
    };
  }
  const expiresAt = nextIstReset(createdAt, resetHour, resetMinute);
  const leftMs = Math.max(0, expiresAt.getTime() - Date.now());
  return {
    known: true,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    timeLeftMs: leftMs,
    timeLeftHuman: humanDuration(leftMs),
    estimate: true
  };
}

function nextIstReset(from: Date, hour: number, minute: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(from);
  const year = Number(parts.find((p) => p.type === "year")?.value ?? "1970");
  const month = Number(parts.find((p) => p.type === "month")?.value ?? "1");
  const day = Number(parts.find((p) => p.type === "day")?.value ?? "1");
  const ih = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const im = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const resetPassed = ih > hour || (ih === hour && im >= minute);
  const y = new Date(Date.UTC(year, month - 1, day + (resetPassed ? 1 : 0), hour - 5, minute - 30));
  return y;
}

function humanDuration(ms: number) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function parseJsonArray(value?: string) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x));
  } catch {
    return [];
  }
}

function parseCandidateParams(value: string) {
  try {
    const parsed = JSON.parse(value) as Partial<{
      minRsi: number;
      breakoutBufferPct: number;
      atrStopMultiple: number;
      riskPerTrade: number;
      minVolumeRatio: number;
      maxSignals: number;
    }>;
    return {
      minRsi: Number(parsed.minRsi ?? 55),
      breakoutBufferPct: Number(parsed.breakoutBufferPct ?? 0.02),
      atrStopMultiple: Number(parsed.atrStopMultiple ?? 2),
      riskPerTrade: Number(parsed.riskPerTrade ?? 0.015),
      minVolumeRatio: Number(parsed.minVolumeRatio ?? 1.2),
      maxSignals: Number(parsed.maxSignals ?? 5)
    };
  } catch {
    return {
      minRsi: 55,
      breakoutBufferPct: 0.02,
      atrStopMultiple: 2,
      riskPerTrade: 0.015,
      minVolumeRatio: 1.2,
      maxSignals: 5
    };
  }
}

function roundToStr(value: number, decimals: number) {
  const n = Number(value ?? 0);
  const p = 10 ** decimals;
  const rounded = Math.round(n * p) / p;
  return rounded.toFixed(decimals).replace(/\.?0+$/, "");
}

function diagnoseBrokerOrder(reasonRaw: string, status: string) {
  const reason = reasonRaw.toLowerCase();
  if (status === "COMPLETE") {
    return { hintCode: "ok", hintText: "", severity: "info" };
  }
  if (reason.includes("switch_to_amo") || reason.includes("after market order")) {
    return {
      hintCode: "switch_to_amo",
      hintText: "Broker wants AMO. Use KITE_ENABLE_AMO_FALLBACK=1 or place during market hours.",
      severity: "warning"
    };
  }
  if (
    reason.includes("insufficient") ||
    reason.includes("margin") ||
    reason.includes("funds")
  ) {
    return {
      hintCode: "insufficient_margin",
      hintText: "Insufficient margin/funds. Reduce quantity or add funds.",
      severity: "critical"
    };
  }
  if (reason.includes("freeze") && reason.includes("quantity")) {
    return {
      hintCode: "freeze_quantity",
      hintText: "Quantity exceeds exchange freeze limit. Split order into smaller chunks.",
      severity: "warning"
    };
  }
  if (reason.includes("product")) {
    return {
      hintCode: "product_mismatch",
      hintText: "Product mismatch. Check KITE_PRODUCT and instrument segment.",
      severity: "warning"
    };
  }
  if (
    reason.includes("tokenexception") ||
    reason.includes("incorrect `api_key`") ||
    reason.includes("access_token")
  ) {
    return {
      hintCode: "auth_error",
      hintText: "Auth/token issue. Regenerate access token via npm run auth.",
      severity: "critical"
    };
  }
  if (status === "REJECTED" || status === "CANCELLED") {
    return {
      hintCode: "generic_reject",
      hintText: "See broker reason and RMS rules; retry only after root cause is fixed.",
      severity: "warning"
    };
  }
  return { hintCode: "n/a", hintText: "", severity: "info" };
}

function getIstTradeDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function toIstDate(input: string) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return getIstTradeDate(date);
}

function parseBrokerOrderFilter(url: URL): BrokerOrderFilter {
  const statusRaw = String(url.searchParams.get("status") ?? "all").toLowerCase();
  const severityRaw = String(url.searchParams.get("severity") ?? "all").toLowerCase();
  const search = String(url.searchParams.get("search") ?? "").trim().toLowerCase();
  const statusAllowed = new Set(["all", "failed", "open", "complete", "cancelled", "rejected"]);
  const severityAllowed = new Set(["all", "critical", "warning", "info"]);
  return {
    status: statusAllowed.has(statusRaw) ? (statusRaw as BrokerOrderFilter["status"]) : "all",
    severity: severityAllowed.has(severityRaw)
      ? (severityRaw as BrokerOrderFilter["severity"])
      : "all",
    search
  };
}

function withBrokerOrderFilter(report: BrokerOrdersReport, filter: BrokerOrderFilter): BrokerOrdersReport {
  const rows = report.orders.filter((row) => matchBrokerOrder(row, filter));
  return {
    ...report,
    stats: {
      ...report.stats,
      filtered: rows.length
    },
    orders: rows
  };
}

function matchBrokerOrder(row: Record<string, unknown>, filter: BrokerOrderFilter): boolean {
  const status = String(row.status ?? "").toUpperCase();
  const severity = String(row.severity ?? "info").toLowerCase();
  if (filter.status === "failed" && !["REJECTED", "CANCELLED"].includes(status)) {
    return false;
  }
  if (filter.status === "open" && !["OPEN", "TRIGGER PENDING", "MODIFY VALIDATION PENDING"].includes(status)) {
    return false;
  }
  if (filter.status === "complete" && status !== "COMPLETE") {
    return false;
  }
  if (filter.status === "cancelled" && status !== "CANCELLED") {
    return false;
  }
  if (filter.status === "rejected" && status !== "REJECTED") {
    return false;
  }
  if (filter.severity !== "all" && severity !== filter.severity) {
    return false;
  }
  if (filter.search.length > 0) {
    const hay = [
      row.orderId,
      row.symbol,
      row.status,
      row.side,
      row.reason,
      row.hintText,
      row.hintCode
    ]
      .map((x) => String(x ?? "").toLowerCase())
      .join(" ");
    if (!hay.includes(filter.search)) {
      return false;
    }
  }
  return true;
}

function toCsv(rows: Array<Record<string, unknown>>, columns: string[]) {
  const head = columns.join(",");
  const body = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

function csvEscape(value: unknown) {
  const raw = String(value ?? "");
  if (!raw.includes(",") && !raw.includes('"') && !raw.includes("\n")) {
    return raw;
  }
  return `"${raw.replaceAll('"', '""')}"`;
}

function summarizeBySymbol(rows: { symbol: string; pnl: number; rMultiple: number }[]) {
  const map = new Map<
    string,
    { symbol: string; trades: number; wins: number; pnl: number; r: number }
  >();
  for (const row of rows) {
    const cur = map.get(row.symbol) ?? {
      symbol: row.symbol,
      trades: 0,
      wins: 0,
      pnl: 0,
      r: 0
    };
    cur.trades += 1;
    if (row.pnl > 0) {
      cur.wins += 1;
    }
    cur.pnl += row.pnl;
    cur.r += row.rMultiple;
    map.set(row.symbol, cur);
  }
  return Array.from(map.values())
    .map((x) => ({
      symbol: x.symbol,
      trades: x.trades,
      winRate: x.wins / x.trades,
      avgR: x.r / x.trades,
      pnl: x.pnl
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 12);
}

function sum(values: number[]) {
  return values.reduce((acc, v) => acc + v, 0);
}

function avg(values: number[]) {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function maxDrawdownFromPnL(pnlSeries: number[]) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const pnl of pnlSeries) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function maybeLogDbError(err: unknown) {
  const now = Date.now();
  if (now - lastDbErrorLogAt > 60_000) {
    console.error("UI_DB_ERROR", err);
    lastDbErrorLogAt = now;
  }
  pushRuntimeError("UI_DB_ERROR", err);
}

function pushRuntimeError(source: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  runtimeErrors.unshift({
    time: new Date().toISOString(),
    source,
    message
  });
  if (runtimeErrors.length > 40) {
    runtimeErrors.length = 40;
  }
}

function emptyJournalAnalytics() {
  return {
    bySetup: [] as Array<{ setupTag: string; trades: number; winRate: number; expectancy: number }>,
    byWeekday: [] as Array<{ weekday: string; trades: number; winRate: number }>,
    avgHoldDays: 0,
    topMistakes: [] as Array<{ mistakeTag: string; count: number }>
  };
}

function journalAnalytics(
  entries: Array<{
    lotId: number;
    setupTag: string;
    mistakeTag?: string;
  }>,
  closedLots: Array<{
    id: number;
    entryPrice: number;
    exitPrice: number;
    qty: number;
    openedAt: string;
    closedAt: string;
  }>
) {
  const lotMap = new Map(closedLots.map((lot) => [lot.id, lot]));

  const setupMap = new Map<string, { trades: number; wins: number; pnl: number }>();
  const weekdayMap = new Map<string, { trades: number; wins: number }>();
  const mistakeMap = new Map<string, number>();
  let holdDaysSum = 0;
  let holdDaysCount = 0;

  for (const entry of entries) {
    const lot = lotMap.get(entry.lotId);
    if (!lot) {
      continue;
    }
    const pnl = (lot.exitPrice - lot.entryPrice) * lot.qty;
    const win = pnl > 0 ? 1 : 0;
    const setup = setupMap.get(entry.setupTag) ?? { trades: 0, wins: 0, pnl: 0 };
    setup.trades += 1;
    setup.wins += win;
    setup.pnl += pnl;
    setupMap.set(entry.setupTag, setup);

    const weekday = new Date(lot.closedAt).toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "Asia/Kolkata"
    });
    const day = weekdayMap.get(weekday) ?? { trades: 0, wins: 0 };
    day.trades += 1;
    day.wins += win;
    weekdayMap.set(weekday, day);

    const holdDays = Math.max(
      1,
      Math.round(
        (new Date(lot.closedAt).getTime() - new Date(lot.openedAt).getTime()) /
          (24 * 3600 * 1000)
      )
    );
    holdDaysSum += holdDays;
    holdDaysCount += 1;

    if (entry.mistakeTag && entry.mistakeTag.trim().length > 0) {
      const key = entry.mistakeTag.trim();
      mistakeMap.set(key, (mistakeMap.get(key) ?? 0) + 1);
    }
  }

  return {
    bySetup: Array.from(setupMap.entries())
      .map(([setupTag, x]) => ({
        setupTag,
        trades: x.trades,
        winRate: x.trades === 0 ? 0 : x.wins / x.trades,
        expectancy: x.trades === 0 ? 0 : x.pnl / x.trades
      }))
      .sort((a, b) => b.expectancy - a.expectancy),
    byWeekday: Array.from(weekdayMap.entries())
      .map(([weekday, x]) => ({
        weekday,
        trades: x.trades,
        winRate: x.trades === 0 ? 0 : x.wins / x.trades
      }))
      .sort((a, b) => b.trades - a.trades),
    avgHoldDays: holdDaysCount === 0 ? 0 : holdDaysSum / holdDaysCount,
    topMistakes: Array.from(mistakeMap.entries())
      .map(([mistakeTag, count]) => ({ mistakeTag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  };
}

function htmlPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SwingTrader Dashboard</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
    :root {
      --bg0: #f2f7f7;
      --bg1: #e8f0f4;
      --ink: #0f1e2f;
      --muted: #5b697c;
      --card: rgba(255, 255, 255, 0.92);
      --line: #d5dfeb;
      --brand: #0e7f57;
      --brand-ink: #e8fff4;
      --warn: #a86400;
      --good: #0e7f57;
      --danger: #b42318;
      --shadow: 0 8px 24px rgba(14, 30, 47, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", "Trebuchet MS", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(860px 420px at 90% -10%, #dff3ff 0%, transparent 60%),
        radial-gradient(620px 360px at -5% 25%, #e7fff1 0%, transparent 58%),
        linear-gradient(135deg, var(--bg0), var(--bg1));
      min-height: 100vh;
    }
    .wrap { max-width: 1360px; margin: 0 auto; padding: 24px 18px 46px; }
    .hero {
      background:
        radial-gradient(380px 160px at 18% -10%, rgba(255,255,255,0.2), transparent 64%),
        linear-gradient(135deg, #0f5f88, #0e7f57);
      color: #eef7ff;
      border-radius: 22px;
      padding: 20px;
      display: grid;
      gap: 14px;
      box-shadow: 0 18px 34px rgba(13, 62, 92, 0.25);
      animation: rise 380ms ease-out;
    }
    .hero-top { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; flex-wrap: wrap; }
    .hero-title { margin: 0; font-size: 30px; letter-spacing: 0.1px; }
    .hero-sub { margin: 4px 0 0; color: #d7f0ff; font-size: 13px; }
    .hero-meta { margin-top: 4px; color: #cde8ff; font-size: 12px; }
    .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    button {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 9px 13px;
      cursor: pointer;
      font-weight: 700;
      letter-spacing: 0.15px;
      font-family: "Space Grotesk", "Trebuchet MS", sans-serif;
      transition: transform 140ms ease, opacity 140ms ease, box-shadow 140ms ease, background 140ms ease;
    }
    button:active { transform: translateY(1px); }
    button[disabled] { opacity: 0.55; cursor: not-allowed; transform: none; }
    button:hover { box-shadow: 0 4px 12px rgba(10, 25, 45, 0.12); }
    .btn-main { background: var(--brand); color: #fff; border-color: var(--brand); }
    .btn-soft { background: #f3f6fa; color: #1e2d3d; border-color: #d8e2ed; }
    .hero .btn-soft { background: rgba(255,255,255,0.1); color: #e9f6ff; border-color: rgba(255,255,255,0.22); }
    .hero .btn-main { background: #f3fff9; color: #0f5339; border-color: #f3fff9; }
    .pill {
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 700;
      background: rgba(255,255,255,0.14);
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #caf4ff;
      display: inline-block;
      box-shadow: 0 0 0 0 rgba(202,244,255,0.8);
      animation: pulse 1.8s infinite;
    }
    .grid4 {
      display: grid;
      grid-template-columns: repeat(5, minmax(0,1fr));
      gap: 12px;
    }
    .kpi {
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      padding: 12px;
      min-height: 72px;
    }
    .kpi-label { font-size: 12px; color: #d1ebff; margin: 0 0 6px; }
    .kpi-value { margin: 0; font-size: 24px; line-height: 1; font-weight: 700; }
    .cards {
      margin-top: 16px;
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(12, minmax(0,1fr));
    }
    .card {
      grid-column: span 6;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      backdrop-filter: blur(8px);
      box-shadow: var(--shadow);
      animation: rise 320ms ease-out;
      min-height: 140px;
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 15px;
      letter-spacing: 0.18px;
      color: #1a3148;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .wide { grid-column: 1 / -1; }
    .meta { font-family: "IBM Plex Mono", monospace; font-size: 12px; color: var(--muted); }
    .empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
    .chart {
      width: 100%;
      height: 220px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
    }
    .bar-grid {
      display: grid;
      gap: 6px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 90px 1fr 90px;
      gap: 8px;
      align-items: center;
      font-size: 12px;
    }
    .bar-track {
      background: #edf5ef;
      border: 1px solid #d5e5d8;
      border-radius: 999px;
      height: 12px;
      overflow: hidden;
    }
    .bar-fill {
      background: linear-gradient(90deg, #0d8b58, #13a66a);
      height: 100%;
    }
    .warn-banner {
      display: none;
      border: 1px solid #ffd7ac;
      background: #fff4e6;
      color: #8a4805;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 700;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      font-size: 11px;
      letter-spacing: 0.35px;
      color: #51637a;
      text-transform: uppercase;
      border-bottom: 1px solid var(--line);
      padding: 9px 7px;
    }
    td {
      font-size: 13px;
      border-bottom: 1px dashed #e0e8f1;
      padding: 8px 7px;
      white-space: nowrap;
    }
    .wrap-cell {
      white-space: normal;
      word-break: break-word;
      line-height: 1.3;
      max-width: 420px;
    }
    .buy { color: var(--good); font-weight: 700; }
    .sell { color: var(--danger); font-weight: 700; }
    .state-filled { color: var(--good); font-weight: 700; }
    .state-open { color: var(--warn); font-weight: 700; }
    .mono { font-family: "IBM Plex Mono", monospace; }
    @media (max-width: 1180px) {
      .card { grid-column: span 12; }
    }
    @media (max-width: 940px) {
      .wrap { padding: 18px 12px 34px; }
      .grid4 { grid-template-columns: repeat(2, minmax(0,1fr)); }
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(202,244,255,0.55); }
      70% { box-shadow: 0 0 0 8px rgba(202,244,255,0); }
      100% { box-shadow: 0 0 0 0 rgba(212,255,228,0); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1 class="hero-title">Swing Control Center</h1>
          <p class="hero-sub">India equities swing engine: entry, risk, trailing stops, and persisted trade history.</p>
        </div>
        <div id="status" class="pill"><span class="dot"></span>Loading</div>
      </div>
      <div class="toolbar">
        <button id="morningBtn" class="btn-main">Run Morning</button>
        <button id="monitorBtn" class="btn-soft">Run Monitor</button>
        <button id="preflightBtn" class="btn-soft">Run Preflight</button>
        <button id="eodBtn" class="btn-soft">Run EOD Close</button>
        <button id="backtestBtn" class="btn-soft">Run Backtest</button>
        <button id="schedulerStartBtn" class="btn-soft">Start Scheduler</button>
        <button id="schedulerStopBtn" class="btn-soft">Stop Scheduler</button>
        <button id="safeModeEnableBtn" class="btn-soft">Enable Safe Mode</button>
        <button id="safeModeDisableBtn" class="btn-soft">Disable Safe Mode</button>
        <button id="refreshBtn" class="btn-soft">Refresh</button>
      </div>
      <div id="safeModeBanner" class="warn-banner"></div>
      <div id="schedulerMeta" class="hero-meta">Scheduler: loading...</div>
      <div class="grid4">
        <div class="kpi">
          <p class="kpi-label">Usable Funds</p>
          <p id="kpiFunds" class="kpi-value">-</p>
        </div>
        <div class="kpi">
          <p class="kpi-label">Open Positions</p>
          <p id="kpiPositions" class="kpi-value">0</p>
        </div>
        <div class="kpi">
          <p class="kpi-label">Managed Stops</p>
          <p id="kpiStops" class="kpi-value">0</p>
        </div>
        <div class="kpi">
          <p class="kpi-label">Orders (20)</p>
          <p id="kpiOrders" class="kpi-value">0</p>
        </div>
        <div class="kpi">
          <p class="kpi-label">Fills (20)</p>
          <p id="kpiFills" class="kpi-value">0</p>
        </div>
      </div>
    </section>
    <div class="cards">
      <section class="card">
        <h2>Positions</h2>
        <div id="positions"></div>
      </section>
      <section class="card">
        <h2>Managed Trailing Stops</h2>
        <div id="managed"></div>
      </section>
      <section class="card">
        <h2>Position Exit Console</h2>
        <div style="display:grid; gap:8px;">
          <select id="exitSymbol" style="padding:8px; border-radius:8px; border:1px solid var(--line);"></select>
          <input id="exitPercent" type="number" min="1" max="100" value="50" placeholder="Exit %" style="padding:8px; border-radius:8px; border:1px solid var(--line);" />
          <input id="stopPriceInput" type="number" min="0" step="0.01" placeholder="New stop price" style="padding:8px; border-radius:8px; border:1px solid var(--line);" />
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button id="exitPercentBtn" class="btn-main">Exit %</button>
            <button id="exitFullBtn" class="btn-soft">Exit Full</button>
            <button id="updateStopBtn" class="btn-soft">Update Stop</button>
          </div>
          <div id="exitStatus" class="meta"></div>
        </div>
      </section>
      <section class="card wide">
        <h2>Recent Orders</h2>
        <div id="orders"></div>
      </section>
      <section class="card wide">
        <h2>Recent Fills</h2>
        <div id="fills"></div>
      </section>
      <section class="card wide">
        <h2>Broker Orderbook</h2>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <select id="brokerStatusFilter" style="padding:8px; border-radius:8px; border:1px solid var(--line);">
            <option value="all">All</option>
            <option value="failed">Failed only</option>
            <option value="open">Open</option>
            <option value="complete">Complete</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select id="brokerSeverityFilter" style="padding:8px; border-radius:8px; border:1px solid var(--line);">
            <option value="all">Severity: all</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
          <input id="brokerSearch" placeholder="Search symbol/order/reason" style="padding:8px; border-radius:8px; border:1px solid var(--line); min-width: 260px;" />
          <button id="brokerRefreshBtn" class="btn-soft">Refresh Broker Orders</button>
          <button id="brokerExportBtn" class="btn-soft">Export CSV</button>
        </div>
        <div id="brokerSummary" class="meta" style="margin-top:8px;">Loading...</div>
        <div id="brokerOrders" style="margin-top:8px;"></div>
      </section>
      <section class="card wide">
        <h2>Strategy Analytics</h2>
        <div id="strategySummary" class="meta">Loading...</div>
        <div id="strategyBySymbol" style="margin-top:8px;"></div>
      </section>
      <section class="card wide">
        <h2>Backtest Analytics</h2>
        <div id="backtestSummary" class="meta">Loading...</div>
        <div id="backtestBySymbol" style="margin-top:8px;"></div>
      </section>
      <section class="card wide">
        <h2>Live vs Backtest Drift</h2>
        <div id="driftSummary" class="meta">Loading...</div>
        <div id="driftTable" style="margin-top:8px;"></div>
      </section>
      <section class="card wide">
        <h2>Trade Journal</h2>
        <div class="meta">Tag closed trades with setup quality and mistakes.</div>
        <div style="display:grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap:8px; margin-top:10px;">
          <select id="journalLot" style="padding:8px; border-radius:8px; border:1px solid var(--line);"></select>
          <input id="journalSetup" placeholder="setup tag" style="padding:8px; border-radius:8px; border:1px solid var(--line);" />
          <input id="journalConfidence" type="number" min="1" max="5" value="3" placeholder="confidence 1-5" style="padding:8px; border-radius:8px; border:1px solid var(--line);" />
          <input id="journalMistake" placeholder="mistake tag" style="padding:8px; border-radius:8px; border:1px solid var(--line);" />
          <input id="journalScreenshot" placeholder="screenshot url" style="padding:8px; border-radius:8px; border:1px solid var(--line);" />
          <button id="journalSaveBtn" class="btn-main">Save Entry</button>
        </div>
        <textarea id="journalNotes" rows="2" placeholder="notes" style="width:100%; margin-top:8px; padding:8px; border-radius:8px; border:1px solid var(--line);"></textarea>
        <div id="journalStatus" class="meta" style="margin-top:8px;"></div>
        <div id="journalAnalytics" style="margin-top:8px;"></div>
        <div id="journalEntries" style="margin-top:8px;"></div>
      </section>
      <section class="card wide">
        <h2>Live Health</h2>
        <div id="healthSummary" class="meta">Loading...</div>
        <div id="healthErrors" style="margin-top:8px;"></div>
      </section>
      <section class="card wide">
        <h2>Daily PnL + Exposure</h2>
        <div id="pnlSummary" class="meta">Loading...</div>
        <svg id="pnlChart" class="chart" viewBox="0 0 1000 220" preserveAspectRatio="none"></svg>
        <div id="exposureBars" class="bar-grid" style="margin-top:10px;"></div>
      </section>
      <section class="card wide">
        <h2>Rejection Guard</h2>
        <div id="rejectGuardSummary" class="meta">Loading...</div>
        <div id="rejectGuardTable" style="margin-top:8px;"></div>
      </section>
      <section class="card wide">
        <h2>Ops Events</h2>
        <div id="opsEvents"></div>
      </section>
    </div>
  </div>
  <script>
    const statusEl = document.getElementById("status");
    const morningBtn = document.getElementById("morningBtn");
    const monitorBtn = document.getElementById("monitorBtn");
    const preflightBtn = document.getElementById("preflightBtn");
    const eodBtn = document.getElementById("eodBtn");
    const backtestBtn = document.getElementById("backtestBtn");
    const schedulerStartBtn = document.getElementById("schedulerStartBtn");
    const schedulerStopBtn = document.getElementById("schedulerStopBtn");
    const safeModeEnableBtn = document.getElementById("safeModeEnableBtn");
    const safeModeDisableBtn = document.getElementById("safeModeDisableBtn");
    const safeModeBanner = document.getElementById("safeModeBanner");
    const schedulerMeta = document.getElementById("schedulerMeta");
    const refreshBtn = document.getElementById("refreshBtn");
    const heroSub = document.querySelector(".hero-sub");
    const kpiFunds = document.getElementById("kpiFunds");
    const kpiPositions = document.getElementById("kpiPositions");
    const kpiStops = document.getElementById("kpiStops");
    const kpiOrders = document.getElementById("kpiOrders");
    const kpiFills = document.getElementById("kpiFills");
    const exitSymbol = document.getElementById("exitSymbol");
    const exitPercent = document.getElementById("exitPercent");
    const stopPriceInput = document.getElementById("stopPriceInput");
    const exitPercentBtn = document.getElementById("exitPercentBtn");
    const exitFullBtn = document.getElementById("exitFullBtn");
    const updateStopBtn = document.getElementById("updateStopBtn");
    const exitStatus = document.getElementById("exitStatus");
    const brokerStatusFilter = document.getElementById("brokerStatusFilter");
    const brokerSeverityFilter = document.getElementById("brokerSeverityFilter");
    const brokerSearch = document.getElementById("brokerSearch");
    const brokerRefreshBtn = document.getElementById("brokerRefreshBtn");
    const brokerExportBtn = document.getElementById("brokerExportBtn");
    const brokerSummary = document.getElementById("brokerSummary");
    const brokerOrders = document.getElementById("brokerOrders");
    const strategySummary = document.getElementById("strategySummary");
    const strategyBySymbol = document.getElementById("strategyBySymbol");
    const backtestSummary = document.getElementById("backtestSummary");
    const backtestBySymbol = document.getElementById("backtestBySymbol");
    const driftSummary = document.getElementById("driftSummary");
    const driftTable = document.getElementById("driftTable");
    const journalLot = document.getElementById("journalLot");
    const journalSetup = document.getElementById("journalSetup");
    const journalConfidence = document.getElementById("journalConfidence");
    const journalMistake = document.getElementById("journalMistake");
    const journalScreenshot = document.getElementById("journalScreenshot");
    const journalNotes = document.getElementById("journalNotes");
    const journalSaveBtn = document.getElementById("journalSaveBtn");
    const journalStatus = document.getElementById("journalStatus");
    const journalAnalytics = document.getElementById("journalAnalytics");
    const journalEntries = document.getElementById("journalEntries");
    const healthSummary = document.getElementById("healthSummary");
    const healthErrors = document.getElementById("healthErrors");
    const pnlSummary = document.getElementById("pnlSummary");
    const pnlChart = document.getElementById("pnlChart");
    const exposureBars = document.getElementById("exposureBars");
    const rejectGuardSummary = document.getElementById("rejectGuardSummary");
    const rejectGuardTable = document.getElementById("rejectGuardTable");
    const opsEvents = document.getElementById("opsEvents");
    let brokerPayload = { enabled: false, stale: false, fetchedAt: '', message: '', stats: { total: 0, complete: 0, open: 0, rejected: 0, cancelled: 0, filtered: 0 }, orders: [] };

    morningBtn.onclick = () => trigger("/api/run/morning");
    monitorBtn.onclick = () => trigger("/api/run/monitor");
    preflightBtn.onclick = () => trigger("/api/run/preflight");
    eodBtn.onclick = () => trigger("/api/run/eod");
    backtestBtn.onclick = () => trigger("/api/run/backtest");
    schedulerStartBtn.onclick = () => trigger("/api/scheduler/start");
    schedulerStopBtn.onclick = () => trigger("/api/scheduler/stop");
    safeModeEnableBtn.onclick = () => setSafeMode(true);
    safeModeDisableBtn.onclick = () => setSafeMode(false);
    refreshBtn.onclick = () => load();
    journalSaveBtn.onclick = () => saveJournalEntry();
    exitPercentBtn.onclick = () => manualExit(false);
    exitFullBtn.onclick = () => manualExit(true);
    updateStopBtn.onclick = () => updateStop();
    brokerRefreshBtn.onclick = () => refreshBrokerOrders();
    brokerStatusFilter.onchange = () => refreshBrokerOrders();
    brokerSeverityFilter.onchange = () => refreshBrokerOrders();
    brokerSearch.onchange = () => refreshBrokerOrders();
    brokerSearch.onkeyup = (e) => { if (e.key === "Enter") refreshBrokerOrders(); };
    brokerExportBtn.onclick = () => {
      window.open("/api/broker/orders.csv?" + currentBrokerFilterQuery(), "_blank");
    };

    async function trigger(path) {
      const res = await fetch(path, { method: "POST" });
      const body = await res.json();
      if (res.ok) {
        const action = body.job ? ('Started: ' + body.job) : (body.ok ? 'Done' : 'Success');
        statusEl.textContent = action;
      } else {
        statusEl.textContent = body.error || "Failed";
      }
      await load();
    }

    async function load() {
      const [status, report, broker, strategy, backtest, drift, journal, health, safeModeRes] = await Promise.all([
        fetchJsonSafe("/api/status", { runningJob: null, liveMode: false, lastPreflight: null, safeMode: { enabled: false, reason: "", updatedAt: "", source: "default" }, scheduler: { enabled: false, lastRuns: {} } }),
        fetchJsonSafe("/api/report", {
          positions: [],
          managedPositions: [],
          orders: [],
          fills: [],
          dailySnapshots: [],
          rejectGuard: { tradeDate: "", rejectCounts: {}, blockedSymbols: {} },
          funds: null,
          lastBrokerSyncAt: null,
          latestAlerts: [],
          latestReconcile: []
        }),
        fetchJsonSafe("/api/broker/orders?" + currentBrokerFilterQuery(), { enabled: false, stale: false, fetchedAt: new Date().toISOString(), message: "", stats: { total: 0, complete: 0, open: 0, rejected: 0, cancelled: 0, filtered: 0 }, orders: [] }),
        fetchJsonSafe("/api/strategy", { enabled: false, bySymbol: [] }),
        fetchJsonSafe("/api/backtest", { enabled: false, latest: null }),
        fetchJsonSafe("/api/drift", { enabled: false, summary: null, rows: [], message: "" }),
        fetchJsonSafe("/api/journal", { enabled: false, entries: [], closedLots: [], analytics: { bySetup: [], byWeekday: [], avgHoldDays: 0, topMistakes: [] } }),
        fetchJsonSafe("/api/health", { checkedAt: new Date().toISOString(), db: { status: "unknown", latencyMs: null }, broker: { status: "unknown", latencyMs: null }, funds: null, safeMode: { enabled: false }, scheduler: { enabled: false, lastRuns: {} }, errors: [] }),
        fetchJsonSafe("/api/safe-mode", { safeMode: { enabled: false, reason: "", updatedAt: "", source: "default" } })
      ]);
      const safeMode = (safeModeRes && safeModeRes.safeMode) ? safeModeRes.safeMode : (status.safeMode || { enabled: false, reason: "", updatedAt: "", source: "fallback" });

      if (status.runningJob) {
        statusEl.innerHTML = '<span class="dot"></span>Running ' + status.runningJob;
      } else if (safeMode.enabled) {
        statusEl.innerHTML = '<span class="dot"></span>SAFE MODE';
      } else {
        statusEl.innerHTML = '<span class="dot"></span>Idle';
      }
      if (heroSub) {
        const modeText = status.liveMode ? 'LIVE ORDERS' : 'PAPER MODE';
        const syncText = report.lastBrokerSyncAt
          ? ('Last broker sync: ' + new Date(report.lastBrokerSyncAt).toLocaleString('en-IN'))
          : 'Last broker sync: n/a';
        const preflightText = status.lastPreflight ? 'Preflight: OK' : 'Preflight: n/a';
        const schedulerText = status.scheduler && status.scheduler.enabled ? 'Scheduler: ON' : 'Scheduler: OFF';
        const fundsText = report.funds ? ('Funds: ' + inr(report.funds.usableEquity) + ' usable') : 'Funds: n/a';
        const safeText = safeMode.enabled ? 'SAFE MODE: ON' : 'SAFE MODE: OFF';
        heroSub.textContent = modeText + ' | ' + syncText + ' | ' + preflightText + ' | ' + schedulerText + ' | ' + fundsText + ' | ' + safeText;
      }
      morningBtn.disabled = !!status.runningJob || !!safeMode.enabled;
      monitorBtn.disabled = !!status.runningJob;
      preflightBtn.disabled = !!status.runningJob;
      eodBtn.disabled = !!status.runningJob;
      backtestBtn.disabled = !!status.runningJob;
      schedulerStartBtn.disabled = !!status.runningJob || !!safeMode.enabled || (status.scheduler && status.scheduler.enabled);
      schedulerStopBtn.disabled = !!status.runningJob || !(status.scheduler && status.scheduler.enabled);
      safeModeEnableBtn.disabled = !!status.runningJob || !!safeMode.enabled;
      safeModeDisableBtn.disabled = !!status.runningJob || !safeMode.enabled;

      if (status.scheduler && schedulerMeta) {
        const s = status.scheduler;
        const last = s.lastRuns || {};
        schedulerMeta.textContent =
          'Scheduler: ' + (s.enabled ? 'running' : 'stopped') +
          ' | premarket=' + s.premarketAt +
          ' | monitor=' + s.monitorIntervalSeconds + 's' +
          ' | eod=' + s.eodAt +
          ' | backtest=' + s.backtestWeekday + ' ' + s.backtestAt +
          ' | safe=' + (safeMode.enabled ? 'ON' : 'OFF') +
          ' | last morning=' + (last.morning ? new Date(last.morning).toLocaleString('en-IN') : 'n/a');
      }
      if (safeModeBanner) {
        if (safeMode.enabled) {
          safeModeBanner.style.display = 'block';
          const reason = safeMode.reason ? safeMode.reason : 'No reason provided';
          safeModeBanner.textContent =
            'Safe Mode is ON. New morning entries and scheduler start are blocked. Reason: ' +
            reason +
            ' | Updated: ' + new Date(safeMode.updatedAt || Date.now()).toLocaleString('en-IN');
        } else {
          safeModeBanner.style.display = 'none';
          safeModeBanner.textContent = '';
        }
      }

      if (kpiFunds) {
        kpiFunds.textContent = report.funds ? inr(report.funds.usableEquity) : 'n/a';
      }
      kpiPositions.textContent = String((report.positions || []).length);
      kpiStops.textContent = String((report.managedPositions || []).length);
      kpiOrders.textContent = String((report.orders || []).length);
      kpiFills.textContent = String((report.fills || []).length);

      render("positions", report.positions, ["symbol", "qty", "avg_price", "updated_at"]);
      render("managed", report.managedPositions, ["symbol", "qty", "atr14", "stop_price", "highest_price", "updated_at"]);
      render("orders", report.orders, ["order_id", "symbol", "side", "qty", "state", "avg_fill_price", "updated_at"]);
      render("fills", report.fills, ["order_id", "symbol", "side", "qty", "price", "fill_time"]);
      brokerPayload = broker;
      renderBrokerOrders(brokerPayload);
      renderStrategy(strategy);
      renderBacktest(backtest);
      renderDrift(drift);
      renderJournal(journal);
      renderHealth(health);
      renderPnlExposure(report);
      renderRejectGuard(report);
      renderOps(report);
      hydrateExitControls(report);
    }

    async function fetchJsonSafe(path, fallback) {
      try {
        const res = await fetch(path);
        const body = await res.json();
        if (!res.ok) {
          return fallback;
        }
        return body;
      } catch {
        return fallback;
      }
    }

    async function saveJournalEntry() {
      const selected = String(journalLot.value || "");
      if (!selected) {
        journalStatus.textContent = "Select a closed lot.";
        return;
      }
      const [lotId, symbol] = selected.split("|");
      const payload = {
        lotId: Number(lotId),
        symbol: symbol || "",
        setupTag: String(journalSetup.value || "").trim(),
        confidence: Number(journalConfidence.value || 0),
        mistakeTag: String(journalMistake.value || "").trim(),
        notes: String(journalNotes.value || "").trim(),
        screenshotUrl: String(journalScreenshot.value || "").trim()
      };
      const res = await fetch("/api/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await res.json();
      if (!res.ok) {
        journalStatus.textContent = body.error || "Failed to save journal entry";
        return;
      }
      journalStatus.textContent = "Journal saved.";
      await load();
    }

    async function refreshBrokerOrders() {
      const fresh = await fetchJsonSafe("/api/broker/orders?refresh=1&" + currentBrokerFilterQuery(), brokerPayload);
      brokerPayload = fresh;
      renderBrokerOrders(brokerPayload);
    }

    function hydrateExitControls(report) {
      const positions = report.positions || [];
      const current = String(exitSymbol.value || "");
      exitSymbol.innerHTML = '<option value="">Select symbol</option>' + positions.map(p =>
        '<option value="' + p.symbol + '">' + p.symbol + ' (qty ' + p.qty + ')</option>'
      ).join('');
      if (current && positions.some(p => p.symbol === current)) {
        exitSymbol.value = current;
      }
    }

    async function manualExit(full) {
      const symbol = String(exitSymbol.value || "").trim().toUpperCase();
      if (!symbol) {
        exitStatus.textContent = "Select a symbol first.";
        return;
      }
      const percent = full ? 100 : Number(exitPercent.value || 0);
      const payload = { symbol, percent, reason: full ? "Manual full exit from UI" : "Manual partial exit from UI" };
      const res = await fetch("/api/position/exit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await res.json();
      if (!res.ok) {
        exitStatus.textContent = body.error || "Exit failed";
        return;
      }
      exitStatus.textContent =
        "Exited " + body.result.exitedQty + " of " + body.result.symbol +
        " at " + Number(body.result.exitPrice || 0).toFixed(2) +
        " | Remaining: " + body.result.remainingQty;
      await load();
    }

    async function updateStop() {
      const symbol = String(exitSymbol.value || "").trim().toUpperCase();
      const stopPrice = Number(stopPriceInput.value || 0);
      if (!symbol || !stopPrice || stopPrice <= 0) {
        exitStatus.textContent = "Select symbol and valid stop price.";
        return;
      }
      const res = await fetch("/api/position/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, stopPrice })
      });
      const body = await res.json();
      if (!res.ok) {
        exitStatus.textContent = body.error || "Stop update failed";
        return;
      }
      exitStatus.textContent =
        "Stop updated for " + body.result.symbol + " to " + Number(body.result.stopPrice).toFixed(2);
      await load();
    }

    async function setSafeMode(enabled) {
      const reason = window.prompt(enabled ? "Enter Safe Mode reason" : "Enter reason to disable Safe Mode", enabled ? "manual risk pause" : "resume trading") || "";
      const res = await fetch(enabled ? "/api/safe-mode/enable" : "/api/safe-mode/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason })
      });
      const body = await res.json();
      if (!res.ok) {
        statusEl.textContent = body.error || "Safe mode action failed";
        return;
      }
      statusEl.textContent = enabled ? "Safe Mode enabled" : "Safe Mode disabled";
      await load();
    }

    function currentBrokerFilterQuery() {
      const q = new URLSearchParams();
      q.set("status", String(brokerStatusFilter.value || "all"));
      q.set("severity", String(brokerSeverityFilter.value || "all"));
      const search = String(brokerSearch.value || "").trim();
      if (search) {
        q.set("search", search);
      }
      return q.toString();
    }

    function render(id, rows, columns) {
      const el = document.getElementById(id);
      if (!rows || rows.length === 0) {
        el.innerHTML = '<div class="empty">No data</div>';
        return;
      }
      const head = '<tr>' + columns.map(c => '<th>' + c + '</th>').join('') + '</tr>';
      const body = rows.map(r => '<tr>' + columns.map(c => '<td class="' + cellClass(c, r[c]) + '">' + formatCell(c, r[c]) + '</td>').join('') + '</tr>').join('');
      el.innerHTML = '<table>' + head + body + '</table>';
    }

    function formatCell(key, value) {
      if (value === null || value === undefined) return '';
      if (key.indexOf('updated_at') >= 0 || key.indexOf('fill_time') >= 0) {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d.toLocaleString('en-IN');
      }
      if (typeof value === 'number' && (key.indexOf('price') >= 0 || key.indexOf('atr') >= 0 || key.indexOf('stop') >= 0 || key.indexOf('high') >= 0)) {
        return Number(value).toFixed(2);
      }
      return String(value);
    }

    function cellClass(key, value) {
      if (key === 'side') {
        if (String(value).toUpperCase() === 'BUY') return 'buy mono';
        if (String(value).toUpperCase() === 'SELL') return 'sell mono';
      }
      if (key === 'state') {
        const v = String(value).toLowerCase();
        if (v === 'filled') return 'state-filled mono';
        if (v === 'open') return 'state-open mono';
        return 'mono';
      }
      if (key.indexOf('order_id') >= 0 || key.indexOf('symbol') >= 0) return 'mono';
      return '';
    }

    function renderStrategy(strategy) {
      if (!strategy || !strategy.enabled) {
        strategySummary.textContent = "No database configured for strategy analytics.";
        strategyBySymbol.innerHTML = '<div class="empty">No data</div>';
        return;
      }
      strategySummary.textContent =
        'Closed Lots: ' + strategy.closedLots +
        ' | Win Rate: ' + pct(strategy.winRate) +
        ' | Avg R: ' + Number(strategy.avgR || 0).toFixed(3) +
        ' | Total PnL: ' + inr(strategy.totalPnl) +
        ' | Max DD: ' + inr(strategy.maxDrawdown);

      const rows = strategy.bySymbol || [];
      if (rows.length === 0) {
        strategyBySymbol.innerHTML = '<div class="empty">No closed lots yet</div>';
        return;
      }
      const head = '<tr><th>symbol</th><th>trades</th><th>winRate</th><th>avgR</th><th>pnl</th></tr>';
      const body = rows.map(r =>
        '<tr><td class="mono">' + r.symbol + '</td><td>' + r.trades + '</td><td>' + pct(r.winRate) + '</td><td>' + Number(r.avgR).toFixed(3) + '</td><td>' + inr(r.pnl) + '</td></tr>'
      ).join('');
      strategyBySymbol.innerHTML = '<table>' + head + body + '</table>';
    }

    function renderBrokerOrders(payload) {
      if (!payload || !payload.enabled) {
        brokerSummary.textContent = payload && payload.message ? payload.message : 'Broker orders unavailable.';
        brokerOrders.innerHTML = '<div class="empty">No data</div>';
        return;
      }
      const s = payload.stats || {};
      const staleText = payload.stale ? ' | STALE CACHE' : '';
      brokerSummary.textContent =
        'Shown: ' + (s.filtered || 0) +
        ' | Total: ' + (s.total || 0) +
        ' | Open: ' + (s.open || 0) +
        ' | Complete: ' + (s.complete || 0) +
        ' | Rejected: ' + (s.rejected || 0) +
        ' | Cancelled: ' + (s.cancelled || 0) +
        (payload.message ? (' | ' + payload.message) : '') +
        staleText +
        (payload.fetchedAt ? (' | Fetched: ' + new Date(payload.fetchedAt).toLocaleString('en-IN')) : '');

      const rows = payload.orders || [];
      if (rows.length === 0) {
        brokerOrders.innerHTML = '<div class="empty">No broker orders for selected filter</div>';
        return;
      }
      const head = '<tr><th>time</th><th>orderId</th><th>symbol</th><th>side</th><th>qty</th><th>status</th><th>avg</th><th>reason</th><th>hint</th></tr>';
      const body = rows.map(r =>
        '<tr>' +
        '<td>' + (r.updatedAt ? new Date(r.updatedAt).toLocaleString('en-IN') : '') + '</td>' +
        '<td class="mono">' + (r.orderId || '') + '</td>' +
        '<td class="mono">' + (r.symbol || '') + '</td>' +
        '<td class="' + (String(r.side || '').toUpperCase() === 'BUY' ? 'buy mono' : (String(r.side || '').toUpperCase() === 'SELL' ? 'sell mono' : 'mono')) + '">' + (r.side || '') + '</td>' +
        '<td>' + (r.qty ?? '') + '</td>' +
        '<td class="mono">' + (r.status || '') + '</td>' +
        '<td>' + (r.averagePrice !== undefined ? Number(r.averagePrice).toFixed(2) : '') + '</td>' +
        '<td class="wrap-cell">' + (r.reason || '') + '</td>' +
        '<td class="wrap-cell">' + (r.hintText || '') + '</td>' +
        '</tr>'
      ).join('');
      brokerOrders.innerHTML = '<table>' + head + body + '</table>';
    }

    function renderBacktest(backtest) {
      if (!backtest || !backtest.enabled) {
        backtestSummary.textContent = "Run npm run backtest or start from UI after DB is configured.";
        backtestBySymbol.innerHTML = '<div class="empty">No data</div>';
        return;
      }
      if (!backtest.latest) {
        backtestSummary.textContent = "No backtest runs yet. Click Run Backtest.";
        backtestBySymbol.innerHTML = '<div class="empty">No data</div>';
        return;
      }
      const latest = backtest.latest;
      backtestSummary.textContent =
        'Run: ' + latest.runId +
        ' | Trades: ' + latest.trades +
        ' | Win Rate: ' + pct(latest.winRate) +
        ' | PnL: ' + inr(latest.totalPnl) +
        ' | Max DD: ' + inr(latest.maxDrawdownAbs) +
        ' | CAGR: ' + Number(latest.cagrPct || 0).toFixed(2) + '%' +
        ' | Sharpe*: ' + Number(latest.sharpeProxy || 0).toFixed(3);

      const rows = latest.bySymbol || [];
      if (rows.length === 0) {
        backtestBySymbol.innerHTML = '<div class="empty">No symbol stats</div>';
        return;
      }
      const head = '<tr><th>symbol</th><th>trades</th><th>winRate</th><th>avgR</th><th>pnl</th></tr>';
      const body = rows.map(r =>
        '<tr><td class="mono">' + r.symbol + '</td><td>' + r.trades + '</td><td>' + pct(r.winRate) + '</td><td>' + Number(r.avgR).toFixed(3) + '</td><td>' + inr(r.pnl) + '</td></tr>'
      ).join('');
      backtestBySymbol.innerHTML = '<table>' + head + body + '</table>';
    }

    function renderDrift(drift) {
      if (!drift || !drift.enabled) {
        driftSummary.textContent = drift && drift.message ? drift.message : 'Drift report unavailable.';
        driftTable.innerHTML = '<div class="empty">No data</div>';
        return;
      }
      const s = drift.summary;
      if (!s) {
        driftSummary.textContent = drift.message || 'No drift baseline available yet.';
        driftTable.innerHTML = '<div class="empty">No data</div>';
        return;
      }
      driftSummary.textContent =
        'Live Trades: ' + s.liveTrades +
        ' | Backtest Trades: ' + s.btTrades +
        ' | WinRate Drift: ' + signedPct(s.deltaWinRate) +
        ' | AvgR Drift: ' + signedNum(s.deltaAvgR, 3) +
        ' | Expectancy Drift: ' + signedInr(s.deltaExpectancy) +
        ' | Alerts: ' + s.alerts +
        (drift.message ? (' | Note: ' + drift.message) : '');

      const rows = drift.rows || [];
      if (rows.length === 0) {
        driftTable.innerHTML = '<div class="empty">No symbol drift rows</div>';
        return;
      }
      const head =
        '<tr><th>symbol</th><th>liveTrades</th><th>btTrades</th><th>winRateΔ</th><th>avgRΔ</th><th>expectancyΔ</th><th>alert</th></tr>';
      const body = rows.map(r =>
        '<tr>' +
        '<td class="mono">' + r.symbol + '</td>' +
        '<td>' + r.liveTrades + '</td>' +
        '<td>' + r.btTrades + '</td>' +
        '<td>' + signedPct(r.deltaWinRate) + '</td>' +
        '<td>' + signedNum(r.deltaAvgR, 3) + '</td>' +
        '<td>' + signedInr(r.deltaExpectancy) + '</td>' +
        '<td>' + (r.alert ? 'YES' : '') + '</td>' +
        '</tr>'
      ).join('');
      driftTable.innerHTML = '<table>' + head + body + '</table>';
    }

    function renderJournal(journal) {
      if (!journal || !journal.enabled) {
        journalStatus.textContent = "Journal unavailable (DB not configured).";
        journalLot.innerHTML = '<option value="">No closed lots</option>';
        journalAnalytics.innerHTML = '<div class="empty">No analytics</div>';
        journalEntries.innerHTML = '<div class="empty">No entries</div>';
        return;
      }
      const lots = journal.closedLots || [];
      journalLot.innerHTML = '<option value="">Select closed lot</option>' + lots.slice(0, 80).map(l =>
        '<option value="' + l.id + '|' + l.symbol + '">' +
          '#' + l.id + ' ' + l.symbol + ' (' + new Date(l.closedAt).toLocaleDateString('en-IN') + ')' +
        '</option>'
      ).join('');

      const a = journal.analytics || {};
      const bySetup = (a.bySetup || []).slice(0, 10);
      const byWeekday = (a.byWeekday || []).slice(0, 7);
      const mistakes = (a.topMistakes || []).slice(0, 8);
      const setupTable = bySetup.length === 0
        ? '<div class="empty">No setup analytics</div>'
        : '<table><tr><th>setup</th><th>trades</th><th>winRate</th><th>expectancy</th></tr>' +
          bySetup.map(r => '<tr><td>' + r.setupTag + '</td><td>' + r.trades + '</td><td>' + pct(r.winRate) + '</td><td>' + inr(r.expectancy) + '</td></tr>').join('') +
          '</table>';
      const weekdayTable = byWeekday.length === 0
        ? ''
        : '<table style="margin-top:8px;"><tr><th>weekday</th><th>trades</th><th>winRate</th></tr>' +
          byWeekday.map(r => '<tr><td>' + r.weekday + '</td><td>' + r.trades + '</td><td>' + pct(r.winRate) + '</td></tr>').join('') +
          '</table>';
      const mistakesTable = mistakes.length === 0
        ? ''
        : '<table style="margin-top:8px;"><tr><th>mistake</th><th>count</th></tr>' +
          mistakes.map(r => '<tr><td>' + r.mistakeTag + '</td><td>' + r.count + '</td></tr>').join('') +
          '</table>';
      journalAnalytics.innerHTML =
        '<div class="meta">Avg Hold Days: ' + Number(a.avgHoldDays || 0).toFixed(2) + '</div>' +
        setupTable + weekdayTable + mistakesTable;

      const rows = journal.entries || [];
      if (rows.length === 0) {
        journalEntries.innerHTML = '<div class="empty">No journal entries yet</div>';
      } else {
        const head = '<tr><th>lot</th><th>symbol</th><th>setup</th><th>conf</th><th>mistake</th><th>updated</th></tr>';
        const body = rows.map(r =>
          '<tr><td class="mono">' + r.lotId + '</td><td class="mono">' + r.symbol + '</td><td>' + r.setupTag + '</td><td>' + r.confidence + '</td><td>' + (r.mistakeTag || '') + '</td><td>' + new Date(r.updatedAt).toLocaleString('en-IN') + '</td></tr>'
        ).join('');
        journalEntries.innerHTML = '<table>' + head + body + '</table>';
      }
    }

    function renderHealth(health) {
      if (!health) {
        healthSummary.textContent = 'Health data unavailable';
        healthErrors.innerHTML = '<div class="empty">No errors</div>';
        return;
      }
      const dbStatus = health.db && health.db.status ? health.db.status.toUpperCase() : 'N/A';
      const brokerStatus = health.broker && health.broker.status ? health.broker.status.toUpperCase() : 'N/A';
      const dbLatency = health.db && health.db.latencyMs !== null ? (health.db.latencyMs + 'ms') : 'n/a';
      const brokerLatency = health.broker && health.broker.latencyMs !== null ? (health.broker.latencyMs + 'ms') : 'n/a';
      const tokenText = health.token && health.token.known
        ? ('Token Left (est): ' + health.token.timeLeftHuman + ' | Expires: ' + new Date(health.token.expiresAt).toLocaleString('en-IN'))
        : ('Token Left (est): ' + ((health.token && health.token.message) ? health.token.message : 'unknown'));
      const fundsText = health.funds
        ? ('Usable Funds: ' + inr(health.funds.usableEquity) + ' (' + String(Math.round(Number(health.funds.fundUsagePct || 0) * 100)) + '% of available)')
        : 'Usable Funds: n/a';
      healthSummary.textContent =
        'DB: ' + dbStatus + ' (' + dbLatency + ')' +
        ' | Broker: ' + brokerStatus + ' (' + brokerLatency + ')' +
        ' | Safe Mode: ' + ((health.safeMode && health.safeMode.enabled) ? 'ON' : 'OFF') +
        ' | Scheduler: ' + ((health.scheduler && health.scheduler.enabled) ? 'ON' : 'OFF') +
        ' | ' + fundsText +
        ' | ' + tokenText +
        ' | Checked: ' + new Date(health.checkedAt).toLocaleString('en-IN');

      const rows = health.errors || [];
      if (rows.length === 0) {
        healthErrors.innerHTML = '<div class="empty">No recent errors</div>';
        return;
      }
      const head = '<tr><th>time</th><th>source</th><th>message</th></tr>';
      const body = rows.map(r =>
        '<tr><td>' + new Date(r.time).toLocaleString('en-IN') + '</td><td class="mono">' + r.source + '</td><td>' + r.message + '</td></tr>'
      ).join('');
      healthErrors.innerHTML = '<table>' + head + body + '</table>';
    }

    function renderPnlExposure(report) {
      const snaps = (report.dailySnapshots || []).slice().reverse();
      if (snaps.length === 0) {
        pnlSummary.textContent = "No daily snapshots yet.";
        pnlChart.innerHTML = "";
      } else {
        const latest = snaps[snaps.length - 1];
        pnlSummary.textContent =
          "Snapshots: " + snaps.length +
          " | Latest equity: " + inr(latest.equity) +
          " | Realized: " + inr(latest.realized_pnl) +
          " | Unrealized: " + inr(latest.unrealized_pnl) +
          " | Open positions: " + latest.open_positions;
        const pointsEq = toChartPoints(snaps.map(s => Number(s.equity || 0)));
        const pointsR = toChartPoints(snaps.map(s => Number(s.realized_pnl || 0)));
        const pointsU = toChartPoints(snaps.map(s => Number(s.unrealized_pnl || 0)));
        pnlChart.innerHTML =
          '<rect x="0" y="0" width="1000" height="220" fill="#ffffff"/>' +
          '<path d="' + pointsEq + '" fill="none" stroke="#0a7a4e" stroke-width="2.2"/>' +
          '<path d="' + pointsR + '" fill="none" stroke="#9f4f00" stroke-width="1.8"/>' +
          '<path d="' + pointsU + '" fill="none" stroke="#335b9f" stroke-width="1.8"/>' +
          '<text x="10" y="16" fill="#0a7a4e" font-size="11">Equity</text>' +
          '<text x="80" y="16" fill="#9f4f00" font-size="11">Realized</text>' +
          '<text x="165" y="16" fill="#335b9f" font-size="11">Unrealized</text>';
      }

      const positions = report.positions || [];
      if (positions.length === 0) {
        exposureBars.innerHTML = '<div class="empty">No open positions</div>';
        return;
      }
      const rows = positions.map(p => ({
        symbol: p.symbol,
        exposure: Number(p.qty || 0) * Number(p.avg_price || 0)
      })).sort((a, b) => b.exposure - a.exposure).slice(0, 10);
      const maxExp = Math.max(...rows.map(r => r.exposure), 1);
      exposureBars.innerHTML = rows.map(r =>
        '<div class="bar-row">' +
          '<div class="mono">' + r.symbol + '</div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + ((r.exposure / maxExp) * 100).toFixed(1) + '%"></div></div>' +
          '<div style="text-align:right;">' + inr(r.exposure) + '</div>' +
        '</div>'
      ).join('');
    }

    function renderRejectGuard(report) {
      const guard = report.rejectGuard || { tradeDate: "", rejectCounts: {}, blockedSymbols: {} };
      const blocked = guard.blockedSymbols || {};
      const symbols = Object.keys(blocked).sort();
      rejectGuardSummary.textContent =
        "Trade date: " + (guard.tradeDate || "n/a") +
        " | Blocked symbols: " + symbols.length;
      if (symbols.length === 0) {
        rejectGuardTable.innerHTML = '<div class="empty">No blocked symbols for today</div>';
        return;
      }
      const head = '<tr><th>symbol</th><th>count</th><th>blockedAt</th><th>reason</th></tr>';
      const body = symbols.map(sym => {
        const row = blocked[sym] || {};
        return '<tr>' +
          '<td class="mono">' + sym + '</td>' +
          '<td>' + Number(row.count || 0) + '</td>' +
          '<td>' + (row.blockedAt ? new Date(row.blockedAt).toLocaleString("en-IN") : "") + '</td>' +
          '<td class="wrap-cell">' + String(row.reason || "") + '</td>' +
          '</tr>';
      }).join('');
      rejectGuardTable.innerHTML = '<table>' + head + body + '</table>';
    }

    function toChartPoints(series) {
      if (!series || series.length === 0) {
        return "";
      }
      const min = Math.min(...series);
      const max = Math.max(...series);
      const span = Math.max(1e-9, max - min);
      return series.map((v, i) => {
        const x = series.length === 1 ? 20 : 20 + (960 * i) / (series.length - 1);
        const y = 200 - ((v - min) / span) * 170;
        return (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
      }).join(" ");
    }

    function pct(v) {
      return (Number(v || 0) * 100).toFixed(2) + '%';
    }

    function inr(v) {
      return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(v || 0));
    }

    function signedNum(v, d) {
      const n = Number(v || 0);
      return (n >= 0 ? '+' : '') + n.toFixed(d);
    }

    function signedPct(v) {
      const n = Number(v || 0) * 100;
      return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    }

    function signedInr(v) {
      const n = Number(v || 0);
      return (n >= 0 ? '+' : '') + inr(n);
    }

    function renderOps(report) {
      const alerts = report.latestAlerts || [];
      const reconcile = report.latestReconcile || [];
      const alertRows = alerts.map(a => '<tr><td>' + new Date(a.created_at).toLocaleString('en-IN') + '</td><td>' + a.severity + '</td><td>' + a.type + '</td><td>' + a.message + '</td></tr>').join('');
      const recRows = reconcile.map(r => '<tr><td>' + new Date(r.created_at).toLocaleString('en-IN') + '</td><td>' + r.run_id + '</td><td>' + r.drift_count + '</td></tr>').join('');
      opsEvents.innerHTML =
        '<div class=\"meta\" style=\"margin-bottom:8px;\">Latest alerts and reconcile audits</div>' +
        '<table><tr><th>time</th><th>severity</th><th>type</th><th>message</th></tr>' + (alertRows || '<tr><td colspan=\"4\" class=\"empty\">No alerts</td></tr>') + '</table>' +
        '<div style=\"height:10px;\"></div>' +
        '<table><tr><th>time</th><th>run</th><th>drift</th></tr>' + (recRows || '<tr><td colspan=\"3\" class=\"empty\">No reconcile audits</td></tr>') + '</table>';
    }

    load();
    setInterval(load, 10000);
  </script>
</body>
</html>`;
}
