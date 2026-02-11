import http from "node:http";
import dotenv from "dotenv";
import { Pool } from "pg";
import { runMonitorPass, runMorningWorkflow } from "../pipeline.js";
import { PostgresPersistence } from "../persistence/postgres_persistence.js";

dotenv.config();

const PORT = Number(process.env.UI_PORT ?? "3000");
let runningJob: "morning" | "monitor" | null = null;
let lastDbErrorLogAt = 0;

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
      json(res, 200, {
        runningJob,
        liveMode: process.env.LIVE_ORDER_MODE === "1"
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

    if (method === "POST" && url.pathname === "/api/run/morning") {
      if (runningJob) {
        json(res, 409, { error: `Job already running: ${runningJob}` });
        return;
      }
      runningJob = "morning";
      void runMorningWorkflow()
        .catch((err) => console.error("MORNING_JOB_FAIL", err))
        .finally(() => {
          runningJob = null;
        });
      json(res, 202, { accepted: true, job: "morning" });
      return;
    }

    if (method === "POST" && url.pathname === "/api/run/monitor") {
      if (runningJob) {
        json(res, 409, { error: `Job already running: ${runningJob}` });
        return;
      }
      runningJob = "monitor";
      void runMonitorPass()
        .catch((err) => console.error("MONITOR_JOB_FAIL", err))
        .finally(() => {
          runningJob = null;
        });
      json(res, 202, { accepted: true, job: "monitor" });
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
});

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function getDbReport() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      dbEnabled: false,
      orders: [],
      fills: [],
      positions: [],
      managedPositions: []
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
    const lastSync =
      systemStateTable.rows[0]?.exists
        ? await pool.query<{ value: string }>(
            `SELECT value FROM system_state WHERE key = 'last_broker_sync_at'`
          )
        : { rows: [] as Array<{ value: string }> };
    return {
      dbEnabled: true,
      orders: orders.rows,
      fills: fills.rows,
      positions: positions.rows,
      managedPositions: managed.rows,
      lastBrokerSyncAt: lastSync.rows[0]?.value ?? null
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
      lastBrokerSyncAt: null
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
        <button id="refreshBtn" class="btn-soft">Refresh</button>
      </div>
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
    </div>
  </div>
  <script>
    const statusEl = document.getElementById("status");
    const morningBtn = document.getElementById("morningBtn");
    const monitorBtn = document.getElementById("monitorBtn");
    const refreshBtn = document.getElementById("refreshBtn");
    const heroSub = document.querySelector(".hero-sub");
    const kpiPositions = document.getElementById("kpiPositions");
    const kpiStops = document.getElementById("kpiStops");
    const kpiOrders = document.getElementById("kpiOrders");
    const kpiFills = document.getElementById("kpiFills");
    const strategySummary = document.getElementById("strategySummary");
    const strategyBySymbol = document.getElementById("strategyBySymbol");

    morningBtn.onclick = () => trigger("/api/run/morning");
    monitorBtn.onclick = () => trigger("/api/run/monitor");
    refreshBtn.onclick = () => load();

    async function trigger(path) {
      const res = await fetch(path, { method: "POST" });
      const body = await res.json();
      statusEl.textContent = res.ok ? ("Started: " + body.job) : (body.error || "Failed");
      await load();
    }

    async function load() {
      const [statusRes, reportRes, strategyRes] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/report"),
        fetch("/api/strategy")
      ]);
      const status = await statusRes.json();
      const report = await reportRes.json();
      const strategy = await strategyRes.json();

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
        heroSub.textContent = modeText + ' | ' + syncText;
      }
      morningBtn.disabled = !!status.runningJob;
      monitorBtn.disabled = !!status.runningJob;

      kpiPositions.textContent = String((report.positions || []).length);
      kpiStops.textContent = String((report.managedPositions || []).length);
      kpiOrders.textContent = String((report.orders || []).length);
      kpiFills.textContent = String((report.fills || []).length);

      render("positions", report.positions, ["symbol", "qty", "avg_price", "updated_at"]);
      render("managed", report.managedPositions, ["symbol", "qty", "atr14", "stop_price", "highest_price", "updated_at"]);
      render("orders", report.orders, ["order_id", "symbol", "side", "qty", "state", "avg_fill_price", "updated_at"]);
      render("fills", report.fills, ["order_id", "symbol", "side", "qty", "price", "fill_time"]);
      renderStrategy(strategy);
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

    function pct(v) {
      return (Number(v || 0) * 100).toFixed(2) + '%';
    }

    function inr(v) {
      return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(v || 0));
    }

    load();
    setInterval(load, 10000);
  </script>
</body>
</html>`;
}
