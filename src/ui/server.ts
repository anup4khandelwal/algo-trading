import http from "node:http";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  runEodClosePass,
  runMonitorPass,
  runMorningWorkflow,
  runPreflightPass
} from "../pipeline.js";
import { PostgresPersistence } from "../persistence/postgres_persistence.js";
import { runConfiguredBacktest } from "../backtest/service.js";
import { TradingScheduler } from "../ops/scheduler.js";

dotenv.config();

const PORT = Number(process.env.UI_PORT ?? "3000");
type UiJob = "morning" | "monitor" | "preflight" | "backtest" | "eod_close";
let runningJob: UiJob | null = null;
let lastDbErrorLogAt = 0;
const scheduler = new TradingScheduler(
  {
    runMorning: () => runUiJob("morning", "SCHED_MORNING", () => runMorningWorkflow()),
    runMonitor: () => runUiJob("monitor", "SCHED_MONITOR", () => runMonitorPass()),
    runEodClose: () => runUiJob("eod_close", "SCHED_EOD", () => runEodClosePass()),
    runBacktest: () => runUiJob("backtest", "SCHED_BACKTEST", () => runConfiguredBacktest()),
    canRun: () => runningJob === null
  },
  {
    tickSeconds: Number(process.env.SCHEDULER_TICK_SECONDS ?? "20"),
    monitorIntervalSeconds: Number(process.env.SCHEDULER_MONITOR_INTERVAL_SECONDS ?? "300"),
    premarketAt: process.env.SCHEDULER_PREMARKET_AT ?? "08:55",
    eodAt: process.env.SCHEDULER_EOD_AT ?? "15:31",
    backtestAt: process.env.SCHEDULER_BACKTEST_AT ?? "10:30",
    backtestWeekday: process.env.SCHEDULER_BACKTEST_WEEKDAY ?? "Sat"
  }
);
if (process.env.SCHEDULER_ENABLED === "1") {
  scheduler.start();
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

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

    if (method === "POST" && url.pathname === "/api/run/eod") {
      if (!launchJob(res, "eod_close", "EOD_JOB", () => runEodClosePass())) {
        return;
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/scheduler/start") {
      scheduler.start();
      json(res, 200, { ok: true, scheduler: scheduler.getState() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/scheduler/stop") {
      scheduler.stop();
      json(res, 200, { ok: true, scheduler: scheduler.getState() });
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
});

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
  void runUiJob(job, logTag, runner);
  json(res, 202, { accepted: true, job });
  return true;
}

async function runUiJob(job: UiJob, logTag: string, runner: () => Promise<unknown>) {
  if (runningJob) {
    throw new Error(`Job already running: ${runningJob}`);
  }
  runningJob = job;
  try {
    await runner();
  } catch (err) {
    console.error(`${logTag}_FAIL`, err);
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
      lastBrokerSyncAt: null,
      lastPreflight: null,
      latestAlerts: [],
      latestReconcile: []
    };
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const [orders, fills, positions, managed] = await Promise.all([
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
      )
    ]);

    const systemStateTable = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.system_state') AS exists`
    );
    const stateRows =
      systemStateTable.rows[0]?.exists
        ? await pool.query<{ key: string; value: string }>(
            `SELECT key, value FROM system_state WHERE key IN ('last_broker_sync_at', 'last_preflight')`
          )
        : { rows: [] as Array<{ key: string; value: string }> };
    const stateMap = new Map(stateRows.rows.map((r) => [r.key, r.value]));

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
  <title>Swing Control Center</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
    :root {
      --bg0: #f3f9f4;
      --bg1: #e6f3e8;
      --ink: #14201a;
      --muted: #53665b;
      --card: rgba(255,255,255,0.86);
      --line: #c8d8cc;
      --brand: #0a7a4e;
      --brand-ink: #e8fff2;
      --warn: #9f4f00;
      --good: #0a7a4e;
      --danger: #9a1b1b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", "Trebuchet MS", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(800px 420px at 85% -20%, #d5f7e3 0%, transparent 60%),
        radial-gradient(520px 300px at -5% 30%, #dff7e8 0%, transparent 60%),
        linear-gradient(135deg, var(--bg0), var(--bg1));
      min-height: 100vh;
    }
    .wrap { max-width: 1220px; margin: 0 auto; padding: 28px 18px 40px; }
    .hero {
      background: linear-gradient(135deg, #0c5d3f, #108c5a);
      color: #e9fff3;
      border-radius: 18px;
      padding: 18px;
      display: grid;
      gap: 14px;
      box-shadow: 0 12px 30px rgba(9, 73, 48, 0.28);
      animation: rise 420ms ease-out;
    }
    .hero-top { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; flex-wrap: wrap; }
    .hero-title { margin: 0; font-size: 28px; letter-spacing: 0.2px; }
    .hero-sub { margin: 4px 0 0; color: #c8f8dc; font-size: 13px; }
    .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    button {
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 700;
      letter-spacing: 0.15px;
      font-family: "Space Grotesk", "Trebuchet MS", sans-serif;
      transition: transform 140ms ease, opacity 140ms ease;
    }
    button:active { transform: translateY(1px); }
    button[disabled] { opacity: 0.55; cursor: not-allowed; transform: none; }
    .btn-main { background: #dffde9; color: #11402d; border-color: #dffde9; }
    .btn-soft { background: transparent; color: #eafff3; }
    .pill {
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 700;
      background: rgba(255,255,255,0.16);
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #d4ffe4;
      display: inline-block;
      box-shadow: 0 0 0 0 rgba(212,255,228,0.8);
      animation: pulse 1.8s infinite;
    }
    .grid4 {
      display: grid;
      grid-template-columns: repeat(4, minmax(0,1fr));
      gap: 10px;
    }
    .kpi {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      padding: 10px;
      min-height: 72px;
    }
    .kpi-label { font-size: 12px; color: #bfe8d1; margin: 0 0 5px; }
    .kpi-value { margin: 0; font-size: 24px; line-height: 1; font-weight: 700; }
    .cards {
      margin-top: 16px;
      display: grid;
      gap: 12px;
      grid-template-columns: 1.1fr 1.1fr;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      backdrop-filter: blur(6px);
      box-shadow: 0 8px 18px rgba(20, 32, 26, 0.06);
      animation: rise 420ms ease-out;
    }
    .card h2 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0.25px; color: #173126; }
    .wide { grid-column: 1 / -1; }
    .meta { font-family: "IBM Plex Mono", monospace; font-size: 12px; color: var(--muted); }
    .empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      font-size: 11px;
      letter-spacing: 0.35px;
      color: #4f6659;
      text-transform: uppercase;
      border-bottom: 1px solid var(--line);
      padding: 8px 7px;
    }
    td {
      font-size: 13px;
      border-bottom: 1px dashed #d8e5dc;
      padding: 8px 7px;
      white-space: nowrap;
    }
    .buy { color: var(--good); font-weight: 700; }
    .sell { color: var(--danger); font-weight: 700; }
    .state-filled { color: var(--good); font-weight: 700; }
    .state-open { color: var(--warn); font-weight: 700; }
    .mono { font-family: "IBM Plex Mono", monospace; }
    @media (max-width: 940px) {
      .grid4 { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .cards { grid-template-columns: 1fr; }
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(212,255,228,0.55); }
      70% { box-shadow: 0 0 0 8px rgba(212,255,228,0); }
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
        <button id="refreshBtn" class="btn-soft">Refresh</button>
      </div>
      <div id="schedulerMeta" class="meta">Scheduler: loading...</div>
      <div class="grid4">
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
      <section class="card wide">
        <h2>Recent Orders</h2>
        <div id="orders"></div>
      </section>
      <section class="card wide">
        <h2>Recent Fills</h2>
        <div id="fills"></div>
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
    const schedulerMeta = document.getElementById("schedulerMeta");
    const refreshBtn = document.getElementById("refreshBtn");
    const heroSub = document.querySelector(".hero-sub");
    const kpiPositions = document.getElementById("kpiPositions");
    const kpiStops = document.getElementById("kpiStops");
    const kpiOrders = document.getElementById("kpiOrders");
    const kpiFills = document.getElementById("kpiFills");
    const strategySummary = document.getElementById("strategySummary");
    const strategyBySymbol = document.getElementById("strategyBySymbol");
    const backtestSummary = document.getElementById("backtestSummary");
    const backtestBySymbol = document.getElementById("backtestBySymbol");
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
    const opsEvents = document.getElementById("opsEvents");

    morningBtn.onclick = () => trigger("/api/run/morning");
    monitorBtn.onclick = () => trigger("/api/run/monitor");
    preflightBtn.onclick = () => trigger("/api/run/preflight");
    eodBtn.onclick = () => trigger("/api/run/eod");
    backtestBtn.onclick = () => trigger("/api/run/backtest");
    schedulerStartBtn.onclick = () => trigger("/api/scheduler/start");
    schedulerStopBtn.onclick = () => trigger("/api/scheduler/stop");
    refreshBtn.onclick = () => load();
    journalSaveBtn.onclick = () => saveJournalEntry();

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
      const [statusRes, reportRes, strategyRes, backtestRes, journalRes] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/report"),
        fetch("/api/strategy"),
        fetch("/api/backtest"),
        fetch("/api/journal")
      ]);
      const status = await statusRes.json();
      const report = await reportRes.json();
      const strategy = await strategyRes.json();
      const backtest = await backtestRes.json();
      const journal = await journalRes.json();

      if (status.runningJob) {
        statusEl.innerHTML = '<span class="dot"></span>Running ' + status.runningJob;
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
        heroSub.textContent = modeText + ' | ' + syncText + ' | ' + preflightText + ' | ' + schedulerText;
      }
      morningBtn.disabled = !!status.runningJob;
      monitorBtn.disabled = !!status.runningJob;
      preflightBtn.disabled = !!status.runningJob;
      eodBtn.disabled = !!status.runningJob;
      backtestBtn.disabled = !!status.runningJob;
      schedulerStartBtn.disabled = !!status.runningJob || (status.scheduler && status.scheduler.enabled);
      schedulerStopBtn.disabled = !!status.runningJob || !(status.scheduler && status.scheduler.enabled);

      if (status.scheduler && schedulerMeta) {
        const s = status.scheduler;
        const last = s.lastRuns || {};
        schedulerMeta.textContent =
          'Scheduler: ' + (s.enabled ? 'running' : 'stopped') +
          ' | premarket=' + s.premarketAt +
          ' | monitor=' + s.monitorIntervalSeconds + 's' +
          ' | eod=' + s.eodAt +
          ' | backtest=' + s.backtestWeekday + ' ' + s.backtestAt +
          ' | last morning=' + (last.morning ? new Date(last.morning).toLocaleString('en-IN') : 'n/a');
      }

      kpiPositions.textContent = String((report.positions || []).length);
      kpiStops.textContent = String((report.managedPositions || []).length);
      kpiOrders.textContent = String((report.orders || []).length);
      kpiFills.textContent = String((report.fills || []).length);

      render("positions", report.positions, ["symbol", "qty", "avg_price", "updated_at"]);
      render("managed", report.managedPositions, ["symbol", "qty", "atr14", "stop_price", "highest_price", "updated_at"]);
      render("orders", report.orders, ["order_id", "symbol", "side", "qty", "state", "avg_fill_price", "updated_at"]);
      render("fills", report.fills, ["order_id", "symbol", "side", "qty", "price", "fill_time"]);
      renderStrategy(strategy);
      renderBacktest(backtest);
      renderJournal(journal);
      renderOps(report);
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

    function pct(v) {
      return (Number(v || 0) * 100).toFixed(2) + '%';
    }

    function inr(v) {
      return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(v || 0));
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
