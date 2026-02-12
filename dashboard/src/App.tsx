import { useEffect, useMemo, useState } from "react";

type PageKey = "overview" | "trading" | "analytics" | "config" | "billing";

type StatusPayload = {
  runningJob: string | null;
  liveMode: boolean;
  lastPreflight?: string | null;
  safeMode?: { enabled: boolean; reason?: string; updatedAt?: string };
  scheduler?: {
    enabled?: boolean;
    premarketAt?: string;
    monitorIntervalSeconds?: number;
    eodAt?: string;
    backtestAt?: string;
    backtestWeekday?: string;
    strategyLabAt?: string;
    strategyLabWeekday?: string;
  };
};

type ReportPayload = {
  positions?: Array<{ symbol: string; qty: number; avg_price: number; updated_at?: string }>;
  managedPositions?: Array<{
    symbol: string;
    qty: number;
    stop_price: number;
    atr14: number;
    highest_price?: number;
    updated_at?: string;
  }>;
  dailySnapshots?: Array<{
    trade_date: string;
    equity: number;
    realized_pnl: number;
    unrealized_pnl: number;
    open_positions?: number;
  }>;
  funds?: {
    availableCash: number;
    usableEquity: number;
    fundUsagePct: number;
    source: string;
    updatedAt: string;
  } | null;
  fundsHistory?: Array<{ ts: string; availableCash: number; usableEquity: number; source: string }>;
  rejectGuard?: {
    tradeDate: string;
    rejectCounts: Record<string, number>;
    blockedSymbols: Record<string, { blockedAt: string; reason: string; count: number }>;
  };
  latestAlerts?: Array<{ id: number; severity: string; type: string; message: string; created_at: string }>;
  latestReconcile?: Array<{ id: number; run_id: string; drift_count: number; created_at: string }>;
};

type HealthPayload = {
  db?: { status?: string; latencyMs?: number | null };
  broker?: { status?: string; latencyMs?: number | null };
  token?: { known?: boolean; timeLeftHuman?: string; message?: string; expiresAt?: string };
};

type BrokerPayload = {
  enabled?: boolean;
  message?: string;
  stats?: { filtered?: number; total?: number; rejected?: number; cancelled?: number; open?: number; complete?: number };
  orders?: Array<{
    updatedAt?: string;
    orderId?: string;
    symbol?: string;
    side?: string;
    qty?: number;
    status?: string;
    reason?: string;
    hintText?: string;
    severity?: string;
  }>;
};

type StrategyPayload = {
  enabled?: boolean;
  closedLots?: number;
  winRate?: number;
  avgR?: number;
  totalPnl?: number;
  maxDrawdown?: number;
  bySymbol?: Array<{ symbol: string; trades: number; winRate: number; avgR: number; pnl: number }>;
};

type BacktestPayload = {
  enabled?: boolean;
  latest?: {
    runId: string;
    trades: number;
    winRate: number;
    totalPnl: number;
    maxDrawdownAbs: number;
    cagrPct: number;
    sharpeProxy: number;
    bySymbol?: Array<{ symbol: string; trades: number; winRate: number; avgR: number; pnl: number }>;
  } | null;
};

type StrategyLabPayload = {
  enabled?: boolean;
  latestRun?: { runId: string; createdAt?: string; status?: string; datasetWindow?: string } | null;
  recommendation?: { candidateId: string; approvedForApply: boolean; reasons: string[] } | null;
  candidates?: Array<{
    candidateId: string;
    params: {
      minRsi: number;
      breakoutBufferPct: number;
      atrStopMultiple: number;
      riskPerTrade: number;
      minVolumeRatio: number;
      maxSignals: number;
    };
    trades: number;
    winRate: number;
    avgR: number;
    expectancy: number;
    maxDrawdownPct: number;
    cagrPct: number;
    sharpeProxy: number;
    stabilityScore: number;
    robustnessScore: number;
    guardrailPass: boolean;
    guardrailReasons: string[];
  }>;
};

type DriftPayload = {
  enabled?: boolean;
  message?: string;
  summary?: {
    liveTrades: number;
    btTrades: number;
    deltaWinRate: number;
    deltaAvgR: number;
    deltaExpectancy: number;
    alerts: number;
  } | null;
  rows?: Array<{
    symbol: string;
    liveTrades: number;
    btTrades: number;
    deltaWinRate: number;
    deltaAvgR: number;
    deltaExpectancy: number;
    alert: boolean;
  }>;
};

type JournalPayload = {
  enabled?: boolean;
  entries?: Array<{
    lotId: number;
    symbol: string;
    setupTag: string;
    confidence: number;
    mistakeTag?: string;
    updatedAt: string;
  }>;
  closedLots?: Array<{ id: number; symbol: string; closedAt: string }>;
  analytics?: {
    bySetup?: Array<{ setupTag: string; trades: number; winRate: number; expectancy: number }>;
    avgHoldDays?: number;
  };
};

type ProfileStatusPayload = {
  activeProfile: "phase1" | "phase2" | "phase3" | "custom";
  availableProfiles: Array<"phase1" | "phase2" | "phase3">;
  controls: Record<string, string>;
};

type ProfileRecommendationPayload = {
  activeProfile: "phase1" | "phase2" | "phase3" | "custom";
  recommendedProfile: "phase1" | "phase2" | "phase3";
  score: number;
  reasons: string[];
  blockers: string[];
  autoSwitchAllowed: boolean;
  generatedAt: string;
};

type EnvConfigPayload = {
  updatedAt: string;
  items: Array<{
    key: string;
    value: string;
    sensitive: boolean;
    category: string;
    description: string;
  }>;
};

type PreopenPayload = {
  ok: boolean;
  checkedAt: string;
  checks: Array<{ key: string; ok: boolean; message: string }>;
};

type EodSummaryPayload = {
  available: boolean;
  summary: {
    generatedAt: string;
    text: string;
    fields?: Record<string, unknown>;
  } | null;
};

type MorningPreviewPayload = {
  generatedAt: string;
  liveMode: boolean;
  preflight?: { ok?: boolean; message?: string };
  funds?: { usableEquity: number };
  summary?: { totalSignals: number; eligible: number; skipped: number };
  rows: Array<{
    symbol: string;
    side: string;
    qty: number;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number | null;
    notional: number;
    rankScore: number;
    status: "eligible" | "skip";
    reason: string;
  }>;
};

type PnlAttributionPayload = {
  enabled: boolean;
  rows: Array<{
    symbol: string;
    setupTag: string;
    pnl: number;
    tradeCount: number;
    winRate: number;
    avgPnl: number;
  }>;
  bySymbol: Array<{ key: string; pnl: number; tradeCount: number; winRate: number; avgPnl: number }>;
  bySetup: Array<{ key: string; pnl: number; tradeCount: number; winRate: number; avgPnl: number }>;
};

type GttPayload = {
  enabled: boolean;
  rows: Array<{
    symbol: string;
    qty: number;
    entryPrice: number;
    targetPrice: number;
    stopPrice: number;
    gttId: string;
    status: string;
    brokerStatus?: string | null;
    updatedAt: string;
    lastError?: string;
  }>;
};

type BillingConfigPayload = {
  provider: string;
  enabled: boolean;
  publishableKey?: string;
  checkoutUrl?: string;
  plans: Array<{
    id: string;
    name: string;
    amountInr: number;
    interval: string;
    features: string[];
    recommended?: boolean;
  }>;
};

const fallbackStatus: StatusPayload = {
  runningJob: null,
  liveMode: false,
  safeMode: { enabled: false },
  scheduler: { enabled: false }
};
const fallbackReport: ReportPayload = {
  positions: [],
  managedPositions: [],
  dailySnapshots: [],
  funds: null,
  fundsHistory: [],
  rejectGuard: { tradeDate: "", rejectCounts: {}, blockedSymbols: {} },
  latestAlerts: [],
  latestReconcile: []
};
const fallbackHealth: HealthPayload = {
  db: { status: "unknown", latencyMs: null },
  broker: { status: "unknown", latencyMs: null }
};
const fallbackBroker: BrokerPayload = {
  enabled: false,
  message: "No data",
  stats: { filtered: 0, total: 0, rejected: 0, cancelled: 0, open: 0, complete: 0 },
  orders: []
};
const fallbackStrategy: StrategyPayload = { enabled: false, bySymbol: [] };
const fallbackBacktest: BacktestPayload = { enabled: false, latest: null };
const fallbackStrategyLab: StrategyLabPayload = { enabled: false, latestRun: null, recommendation: null, candidates: [] };
const fallbackDrift: DriftPayload = { enabled: false, summary: null, rows: [], message: "" };
const fallbackJournal: JournalPayload = { enabled: false, entries: [], closedLots: [], analytics: { bySetup: [], avgHoldDays: 0 } };
const fallbackProfileStatus: ProfileStatusPayload = { activeProfile: "custom", availableProfiles: ["phase1", "phase2", "phase3"], controls: {} };
const fallbackProfileRec: ProfileRecommendationPayload = {
  activeProfile: "custom",
  recommendedProfile: "phase1",
  score: 0,
  reasons: [],
  blockers: [],
  autoSwitchAllowed: false,
  generatedAt: new Date(0).toISOString()
};
const fallbackEnvConfig: EnvConfigPayload = { updatedAt: new Date(0).toISOString(), items: [] };
const fallbackPreopen: PreopenPayload = { ok: false, checkedAt: new Date(0).toISOString(), checks: [] };
const fallbackEodSummary: EodSummaryPayload = { available: false, summary: null };
const fallbackMorningPreview: MorningPreviewPayload = {
  generatedAt: "",
  liveMode: false,
  preflight: { ok: false, message: "" },
  funds: { usableEquity: 0 },
  summary: { totalSignals: 0, eligible: 0, skipped: 0 },
  rows: []
};
const fallbackPnlAttribution: PnlAttributionPayload = { enabled: false, rows: [], bySymbol: [], bySetup: [] };
const fallbackGtt: GttPayload = { enabled: false, rows: [] };
const fallbackBilling: BillingConfigPayload = { provider: "none", enabled: false, plans: [] };

export default function App() {
  const [page, setPage] = useState<PageKey>("overview");
  const [status, setStatus] = useState<StatusPayload>(fallbackStatus);
  const [report, setReport] = useState<ReportPayload>(fallbackReport);
  const [health, setHealth] = useState<HealthPayload>(fallbackHealth);
  const [broker, setBroker] = useState<BrokerPayload>(fallbackBroker);
  const [strategy, setStrategy] = useState<StrategyPayload>(fallbackStrategy);
  const [backtest, setBacktest] = useState<BacktestPayload>(fallbackBacktest);
  const [strategyLab, setStrategyLab] = useState<StrategyLabPayload>(fallbackStrategyLab);
  const [drift, setDrift] = useState<DriftPayload>(fallbackDrift);
  const [journal, setJournal] = useState<JournalPayload>(fallbackJournal);
  const [profileStatus, setProfileStatus] = useState<ProfileStatusPayload>(fallbackProfileStatus);
  const [profileRec, setProfileRec] = useState<ProfileRecommendationPayload>(fallbackProfileRec);
  const [envConfig, setEnvConfig] = useState<EnvConfigPayload>(fallbackEnvConfig);
  const [preopen, setPreopen] = useState<PreopenPayload>(fallbackPreopen);
  const [eodSummary, setEodSummary] = useState<EodSummaryPayload>(fallbackEodSummary);
  const [pnlAttrib, setPnlAttrib] = useState<PnlAttributionPayload>(fallbackPnlAttribution);
  const [gtt, setGtt] = useState<GttPayload>(fallbackGtt);
  const [billing, setBilling] = useState<BillingConfigPayload>(fallbackBilling);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [morningPreview, setMorningPreview] = useState<MorningPreviewPayload>(fallbackMorningPreview);

  const [busy, setBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [searchFilter, setSearchFilter] = useState("");

  const [exitSymbol, setExitSymbol] = useState("");
  const [exitPercent, setExitPercent] = useState(50);
  const [stopPrice, setStopPrice] = useState(0);
  const [exitMsg, setExitMsg] = useState("");

  const [journalLot, setJournalLot] = useState("");
  const [journalSetup, setJournalSetup] = useState("");
  const [journalConfidence, setJournalConfidence] = useState(3);
  const [journalMistake, setJournalMistake] = useState("");
  const [journalNotes, setJournalNotes] = useState("");
  const [journalScreenshot, setJournalScreenshot] = useState("");
  const [journalMsg, setJournalMsg] = useState("");
  const [strategyLabMsg, setStrategyLabMsg] = useState("");

  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [envFilter, setEnvFilter] = useState("");
  const [envMsg, setEnvMsg] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [billingMsg, setBillingMsg] = useState("");

  const safeModeOn = status.safeMode?.enabled === true;

  async function fetchJson<T>(url: string, fallback: T): Promise<T> {
    try {
      const res = await fetch(url);
      if (!res.ok) return fallback;
      return (await res.json()) as T;
    } catch {
      return fallback;
    }
  }

  function brokerQuery() {
    const q = new URLSearchParams();
    q.set("status", statusFilter);
    q.set("severity", severityFilter);
    if (searchFilter.trim()) q.set("search", searchFilter.trim());
    return q.toString();
  }

  async function load() {
    const [s, r, h, b, st, bt, sl, dr, jr, pa, gttRows, ps, pr, env, po, eod, bill] = await Promise.all([
      fetchJson<StatusPayload>("/api/status", fallbackStatus),
      fetchJson<ReportPayload>("/api/report", fallbackReport),
      fetchJson<HealthPayload>("/api/health", fallbackHealth),
      fetchJson<BrokerPayload>(`/api/broker/orders?${brokerQuery()}`, fallbackBroker),
      fetchJson<StrategyPayload>("/api/strategy", fallbackStrategy),
      fetchJson<BacktestPayload>("/api/backtest", fallbackBacktest),
      fetchJson<StrategyLabPayload>("/api/strategy-lab/latest", fallbackStrategyLab),
      fetchJson<DriftPayload>("/api/drift", fallbackDrift),
      fetchJson<JournalPayload>("/api/journal", fallbackJournal),
      fetchJson<PnlAttributionPayload>("/api/pnl-attribution", fallbackPnlAttribution),
      fetchJson<GttPayload>("/api/gtt/status", fallbackGtt),
      fetchJson<ProfileStatusPayload>("/api/profile/status", fallbackProfileStatus),
      fetchJson<ProfileRecommendationPayload>("/api/profile/recommendation", fallbackProfileRec),
      fetchJson<EnvConfigPayload>("/api/env/config", fallbackEnvConfig),
      fetchJson<PreopenPayload>("/api/preopen-check", fallbackPreopen),
      fetchJson<EodSummaryPayload>("/api/eod-summary", fallbackEodSummary),
      fetchJson<BillingConfigPayload>("/api/billing/config", fallbackBilling)
    ]);

    setStatus(s);
    setReport(r);
    setHealth(h);
    setBroker(b);
    setStrategy(st);
    setBacktest(bt);
    setStrategyLab(sl);
    setDrift(dr);
    setJournal(jr);
    setPnlAttrib(pa);
    setGtt(gttRows);
    setProfileStatus(ps);
    setProfileRec(pr);
    setEnvConfig(env);
    setPreopen(po);
    setEodSummary(eod);
    setBilling(bill);
    setLastRefresh(new Date().toLocaleString("en-IN"));
    if (!exitSymbol && (r.positions?.length ?? 0) > 0) {
      setExitSymbol(r.positions?.[0]?.symbol ?? "");
    }
    setEnvDraft((prev) => {
      if (Object.keys(prev).length > 0) {
        return prev;
      }
      const next: Record<string, string> = {};
      for (const item of env.items ?? []) {
        next[item.key] = item.value;
      }
      return next;
    });
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 12000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void load();
  }, [statusFilter, severityFilter, searchFilter]);

  async function postAction(path: string, body?: unknown) {
    setBusy(true);
    try {
      await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function openMorningPreview() {
    setPreviewOpen(true);
    setPreviewBusy(true);
    try {
      const preview = await fetchJson<MorningPreviewPayload>("/api/morning/preview", fallbackMorningPreview);
      setMorningPreview(preview);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function confirmMorningRun() {
    setPreviewBusy(true);
    try {
      await fetch("/api/run/morning", { method: "POST" });
      setPreviewOpen(false);
      await load();
    } finally {
      setPreviewBusy(false);
    }
  }

  async function checkoutPlan(planId: string) {
    setBillingMsg("");
    setBusy(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId })
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; url?: string; message?: string };
      if (!res.ok || body.ok !== true || !body.url) {
        setBillingMsg(body.error ?? body.message ?? "Checkout unavailable. Configure payment env keys.");
        return;
      }
      window.open(body.url, "_blank");
      setBillingMsg("Checkout opened in a new tab.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelGtt(symbol: string) {
    if (!window.confirm(`Cancel broker protection for ${symbol}?`)) return;
    setBusy(true);
    try {
      await fetch("/api/gtt/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol })
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function manualExit(full: boolean) {
    if (!exitSymbol) {
      setExitMsg("Select a symbol first");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/position/exit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: exitSymbol,
          percent: full ? 100 : Math.max(1, Math.min(100, Number(exitPercent || 1))),
          reason: full ? "UI full exit" : "UI partial exit"
        })
      });
      const body = (await res.json()) as { error?: string; result?: { exitedQty?: number; remainingQty?: number; symbol?: string } };
      if (!res.ok) {
        setExitMsg(body.error ?? "Exit failed");
      } else {
        setExitMsg(`Exited ${body.result?.exitedQty ?? 0} of ${body.result?.symbol ?? exitSymbol}. Remaining ${body.result?.remainingQty ?? 0}`);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function updateStop() {
    if (!exitSymbol || !Number.isFinite(stopPrice) || Number(stopPrice) <= 0) {
      setExitMsg("Select symbol and valid stop");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/position/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: exitSymbol, stopPrice: Number(stopPrice) })
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setExitMsg(body.error ?? "Stop update failed");
      } else {
        setExitMsg(`Stop updated for ${exitSymbol} to ${Number(stopPrice).toFixed(2)}`);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveJournal() {
    const [lotIdRaw, symbolRaw] = journalLot.split("|");
    const lotId = Number(lotIdRaw || 0);
    if (!lotId || !symbolRaw || !journalSetup.trim()) {
      setJournalMsg("lot/setup required");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lotId,
          symbol: symbolRaw,
          setupTag: journalSetup.trim(),
          confidence: Math.max(1, Math.min(5, Number(journalConfidence || 3))),
          mistakeTag: journalMistake.trim(),
          notes: journalNotes.trim(),
          screenshotUrl: journalScreenshot.trim()
        })
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setJournalMsg(body.error ?? "Save failed");
      } else {
        setJournalMsg("Journal saved");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function switchProfile(profile: "phase1" | "phase2" | "phase3") {
    const ok = window.confirm(`Switch to ${profile}? Scheduler will stop and Safe Mode will be enabled.`);
    if (!ok) return;
    setBusy(true);
    try {
      await fetch("/api/profile/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, reason: "UI profile switch" })
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function applyStrategyCandidate(candidateId: string) {
    const ok = window.confirm(`Apply ${candidateId}? Strategy params in .env will update, scheduler will stop, Safe Mode will be enabled.`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/strategy-lab/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId })
      });
      const body = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok || body.ok !== true) {
        setStrategyLabMsg(body.error ?? "Apply failed");
      } else {
        setStrategyLabMsg(`Applied ${candidateId}. Safe Mode enabled.`);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function reloadEnvEditor() {
    const latest = await fetchJson<EnvConfigPayload>("/api/env/config", fallbackEnvConfig);
    setEnvConfig(latest);
    const next: Record<string, string> = {};
    for (const item of latest.items ?? []) {
      next[item.key] = item.value;
    }
    setEnvDraft(next);
    setEnvMsg(`Reloaded ${latest.items.length} keys.`);
  }

  async function saveEnvChanges() {
    const updates: Record<string, string> = {};
    for (const item of envConfig.items ?? []) {
      const nextValue = envDraft[item.key] ?? "";
      if (nextValue !== item.value) {
        updates[item.key] = nextValue;
      }
    }
    const keys = Object.keys(updates);
    if (keys.length === 0) {
      setEnvMsg("No changes to save.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/env/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates })
      });
      const body = (await res.json()) as { error?: string; ok?: boolean; restartRequired?: boolean };
      if (!res.ok || body.ok !== true) {
        setEnvMsg(body.error ?? "Save failed");
        return;
      }
      await reloadEnvEditor();
      setEnvMsg(`Saved ${keys.length} keys.${body.restartRequired ? " Restart UI process to apply scheduler/port changes." : ""}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const eqPoints = useMemo(() => {
    const rows = [...(report.dailySnapshots ?? [])].reverse();
    if (rows.length < 2) return "";
    const values = rows.map((x) => Number(x.equity ?? 0));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    return values
      .map((v, i) => {
        const x = 24 + (952 * i) / (values.length - 1);
        const y = 200 - ((v - min) / span) * 170;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }, [report.dailySnapshots]);

  const fundsPoints = useMemo(() => {
    const rows = report.fundsHistory ?? [];
    if (rows.length < 2) return { available: "", usable: "" };
    const availableVals = rows.map((x) => Number(x.availableCash ?? 0));
    const usableVals = rows.map((x) => Number(x.usableEquity ?? 0));
    const min = Math.min(...availableVals, ...usableVals);
    const max = Math.max(...availableVals, ...usableVals);
    const span = Math.max(1, max - min);
    const toPath = (vals: number[]) =>
      vals
        .map((v, i) => {
          const x = 24 + (952 * i) / (vals.length - 1);
          const y = 200 - ((v - min) / span) * 170;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(" ");
    return { available: toPath(availableVals), usable: toPath(usableVals) };
  }, [report.fundsHistory]);

  const blockedSymbols = Object.entries(report.rejectGuard?.blockedSymbols ?? {});
  const envFilteredItems = useMemo(() => {
    const query = envFilter.trim().toLowerCase();
    if (!query) return envConfig.items ?? [];
    return (envConfig.items ?? []).filter((item) => {
      return (
        item.key.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query)
      );
    });
  }, [envConfig.items, envFilter]);

  const envChangedCount = useMemo(() => {
    let count = 0;
    for (const item of envConfig.items ?? []) {
      if ((envDraft[item.key] ?? "") !== item.value) count += 1;
    }
    return count;
  }, [envConfig.items, envDraft]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-mark">ST</div>
          <div>
            <h2>SwingTrader</h2>
            <p>Algo SaaS Console</p>
          </div>
        </div>
        <nav className="nav">
          <NavBtn page={page} target="overview" label="Overview" onClick={setPage} />
          <NavBtn page={page} target="trading" label="Trading" onClick={setPage} />
          <NavBtn page={page} target="analytics" label="Analytics" onClick={setPage} />
          <NavBtn page={page} target="config" label="Config" onClick={setPage} />
          <NavBtn page={page} target="billing" label="Billing" onClick={setPage} />
        </nav>
        <div className="side-meta">
          <div className={`badge ${status.liveMode ? "live" : "paper"}`}>{status.liveMode ? "LIVE" : "PAPER"}</div>
          <div className={`badge ${safeModeOn ? "danger" : "ok"}`}>{safeModeOn ? "SAFE MODE ON" : "SAFE MODE OFF"}</div>
          <div className="muted">Updated: {lastRefresh || "-"}</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{pageTitle(page)}</h1>
            <p>{pageSubtitle(page, status.runningJob)}</p>
          </div>
          <div className="top-actions">
            <button disabled={busy} onClick={() => void load()} className="btn">Refresh</button>
            <button disabled={busy || safeModeOn || !preopen.ok} onClick={() => void openMorningPreview()} className="btn btn-primary">Morning Run</button>
          </div>
        </header>

        {(page === "overview" || page === "trading") ? (
          <section className="kpis">
            <Kpi label={`Usable Funds (${report.funds?.source ?? "n/a"})`} value={report.funds ? inr(report.funds.usableEquity) : "n/a"} />
            <Kpi label="Available Cash" value={report.funds ? inr(report.funds.availableCash) : "n/a"} />
            <Kpi label="Open Positions" value={String(report.positions?.length ?? 0)} />
            <Kpi label="Managed Stops" value={String(report.managedPositions?.length ?? 0)} />
            <Kpi label="Open Broker Orders" value={String(broker.stats?.open ?? 0)} />
          </section>
        ) : null}

        {page === "overview" ? (
          <section className="grid">
            <Card title="System Health" subtitle={`Scheduler: ${status.scheduler?.enabled ? "ON" : "OFF"}`}>
              <div className="stack">
                <Row label="DB" value={`${health.db?.status ?? "n/a"} (${health.db?.latencyMs ?? "n/a"}ms)`} />
                <Row label="Broker" value={`${health.broker?.status ?? "n/a"} (${health.broker?.latencyMs ?? "n/a"}ms)`} />
                <Row label="Token" value={health.token?.known ? `${health.token?.timeLeftHuman ?? ""}` : health.token?.message ?? "unknown"} />
                <Row label="Funds Source" value={report.funds?.source ?? "n/a"} />
                <Row label="Funds Updated" value={report.funds?.updatedAt ? new Date(report.funds.updatedAt).toLocaleString("en-IN") : "n/a"} />
              </div>
            </Card>
            <Card title="Pre-Open Checklist" subtitle={`Checked: ${new Date(preopen.checkedAt).toLocaleString("en-IN")}`}>
              <div className="meta">Morning gate: {preopen.ok ? "PASS" : "BLOCKED"}</div>
              <SimpleTable columns={["check", "status", "message"]} rows={(preopen.checks ?? []).map((x) => [x.key, x.ok ? "OK" : "FAIL", x.message])} />
            </Card>
            <Card title="Daily Equity Curve" span="wide">
              <svg viewBox="0 0 1000 220" className="chart" preserveAspectRatio="none">
                <rect x="0" y="0" width="1000" height="220" fill="#ffffff" />
                {eqPoints ? <path d={eqPoints} fill="none" stroke="#15b67d" strokeWidth="2.4" /> : null}
              </svg>
            </Card>
            <Card title="Funds Trend" span="wide">
              <svg viewBox="0 0 1000 220" className="chart" preserveAspectRatio="none">
                <rect x="0" y="0" width="1000" height="220" fill="#ffffff" />
                {fundsPoints.available ? <path d={fundsPoints.available} fill="none" stroke="#3f7cff" strokeWidth="2.1" /> : null}
                {fundsPoints.usable ? <path d={fundsPoints.usable} fill="none" stroke="#15b67d" strokeWidth="2.1" /> : null}
              </svg>
            </Card>
            <Card title="Ops Events" span="wide">
              <SimpleTable columns={["time", "severity", "type", "message"]} rows={(report.latestAlerts ?? []).map((x) => [new Date(x.created_at).toLocaleString("en-IN"), x.severity, x.type, x.message])} />
              <SimpleTable columns={["time", "run", "drift"]} rows={(report.latestReconcile ?? []).map((x) => [new Date(x.created_at).toLocaleString("en-IN"), x.run_id, String(x.drift_count)])} />
            </Card>
            <Card title="Last EOD Summary" span="wide">
              {!eodSummary.available || !eodSummary.summary ? (
                <div className="empty">No EOD summary generated yet</div>
              ) : (
                <>
                  <div className="meta">Generated: {new Date(eodSummary.summary.generatedAt).toLocaleString("en-IN")}</div>
                  <div className="row"><span>Summary</span><strong>{eodSummary.summary.text}</strong></div>
                </>
              )}
            </Card>
          </section>
        ) : null}

        {page === "trading" ? (
          <section className="grid">
            <Card title="Trading Actions" span="wide">
              <div className="actions">
                <button disabled={busy} onClick={() => void postAction("/api/run/monitor")} className="btn">Monitor</button>
                <button disabled={busy} onClick={() => void postAction("/api/run/preflight")} className="btn">Preflight</button>
                <button disabled={busy} onClick={() => void postAction("/api/run/eod")} className="btn">EOD Close</button>
                <button disabled={busy} onClick={() => void postAction("/api/funds/recompute")} className="btn">Recompute Funds</button>
                <button disabled={busy} onClick={() => void postAction("/api/gtt/sync")} className="btn">Sync GTT</button>
                <button disabled={busy} className="btn" onClick={async () => {
                  if (!window.confirm("Clear reject guard for today?")) return;
                  await postAction("/api/reject-guard/clear");
                }}>Clear Reject Guard</button>
              </div>
            </Card>
            <Card title="Position Exit Console">
              <div className="form-grid">
                <select value={exitSymbol} onChange={(e) => setExitSymbol(e.target.value)}>
                  <option value="">Select symbol</option>
                  {(report.positions ?? []).map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol} (qty {p.qty})</option>)}
                </select>
                <input type="number" min={1} max={100} value={exitPercent} onChange={(e) => setExitPercent(Number(e.target.value || 1))} placeholder="Exit %" />
                <input type="number" min={0.01} step={0.01} value={stopPrice || ""} onChange={(e) => setStopPrice(Number(e.target.value || 0))} placeholder="New stop" />
                <div className="actions">
                  <button className="btn btn-primary" disabled={busy} onClick={() => void manualExit(false)}>Exit %</button>
                  <button className="btn" disabled={busy} onClick={() => void manualExit(true)}>Exit Full</button>
                  <button className="btn" disabled={busy} onClick={() => void updateStop()}>Update Stop</button>
                </div>
                <div className="meta">{exitMsg || ""}</div>
              </div>
            </Card>
            <Card title="Positions">
              <SimpleTable columns={["symbol", "qty", "avg", "updated"]} rows={(report.positions ?? []).map((x) => [x.symbol, String(x.qty), Number(x.avg_price).toFixed(2), x.updated_at ? new Date(x.updated_at).toLocaleString("en-IN") : ""])} />
            </Card>
            <Card title="Managed Stops">
              <SimpleTable columns={["symbol", "qty", "stop", "atr", "high"]} rows={(report.managedPositions ?? []).map((x) => [x.symbol, String(x.qty), Number(x.stop_price).toFixed(2), Number(x.atr14).toFixed(2), Number(x.highest_price ?? 0).toFixed(2)])} />
            </Card>
            <Card title="Broker Orderbook" span="wide" subtitle={broker.message ?? ""}>
              <div className="filters">
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="all">All</option>
                  <option value="failed">Failed</option>
                  <option value="open">Open</option>
                  <option value="complete">Complete</option>
                  <option value="rejected">Rejected</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                  <option value="all">Severity: all</option>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
                <input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} placeholder="Search symbol/order/reason" />
                <button className="btn" onClick={() => window.open(`/api/broker/orders.csv?${brokerQuery()}`, "_blank")}>Export CSV</button>
              </div>
              <SimpleTable columns={["time", "orderId", "symbol", "side", "qty", "status", "severity", "reason", "hint"]} rows={(broker.orders ?? []).slice(0, 50).map((x) => [x.updatedAt ? new Date(x.updatedAt).toLocaleString("en-IN") : "", x.orderId ?? "", x.symbol ?? "", x.side ?? "", String(x.qty ?? ""), x.status ?? "", x.severity ?? "", x.reason ?? "", x.hintText ?? ""])} />
            </Card>
            <Card title="Broker Protections (GTT)" span="wide" subtitle={gtt.enabled ? "Broker-native OCO protections" : "Disabled"}>
              <SimpleTable columns={["symbol", "qty", "entry", "target", "stop", "gttId", "status", "broker", "updated"]} rows={(gtt.rows ?? []).slice(0, 40).map((x) => [x.symbol, String(x.qty), num(x.entryPrice, 2), num(x.targetPrice, 2), num(x.stopPrice, 2), x.gttId, x.status, x.brokerStatus ?? "", new Date(x.updatedAt).toLocaleString("en-IN")])} />
              <div className="actions" style={{ marginTop: 8 }}>
                {(gtt.rows ?? []).filter((x) => x.status === "active").slice(0, 8).map((x) => <button key={x.symbol} className="btn" disabled={busy} onClick={() => void cancelGtt(x.symbol)}>Cancel {x.symbol}</button>)}
              </div>
            </Card>
          </section>
        ) : null}

        {page === "analytics" ? (
          <section className="grid">
            <Card title="Analytics Actions" span="wide">
              <div className="actions">
                <button disabled={busy} onClick={() => void postAction("/api/run/backtest")} className="btn">Run Backtest</button>
                <button disabled={busy} onClick={() => void postAction("/api/strategy-lab/run")} className="btn">Run Strategy Lab</button>
                <button disabled={busy} onClick={() => window.open("/api/reports/weekly.pdf", "_blank")} className="btn">Weekly PDF</button>
              </div>
            </Card>
            <Card title="Strategy Analytics" span="wide">
              <div className="meta">Closed Lots: {strategy.closedLots ?? 0} | Win Rate: {pct(strategy.winRate ?? 0)} | Avg R: {num(strategy.avgR ?? 0, 3)} | PnL: {inr(strategy.totalPnl ?? 0)}</div>
              <SimpleTable columns={["symbol", "trades", "winRate", "avgR", "pnl"]} rows={(strategy.bySymbol ?? []).map((x) => [x.symbol, String(x.trades), pct(x.winRate), num(x.avgR, 3), inr(x.pnl)])} />
            </Card>
            <Card title="Backtest Analytics" span="wide">
              {!backtest.latest ? (
                <div className="empty">No backtest run yet</div>
              ) : (
                <>
                  <div className="meta">Run: {backtest.latest.runId} | Trades: {backtest.latest.trades} | Win Rate: {pct(backtest.latest.winRate)} | PnL: {inr(backtest.latest.totalPnl)} | Max DD: {inr(backtest.latest.maxDrawdownAbs)} | CAGR: {num(backtest.latest.cagrPct, 2)}%</div>
                  <SimpleTable columns={["symbol", "trades", "winRate", "avgR", "pnl"]} rows={(backtest.latest.bySymbol ?? []).map((x) => [x.symbol, String(x.trades), pct(x.winRate), num(x.avgR, 3), inr(x.pnl)])} />
                </>
              )}
            </Card>
            <Card title="Strategy Lab" span="wide">
              <div className="meta">Recommendation: {strategyLab.recommendation?.candidateId ?? "n/a"} | {strategyLab.recommendation?.approvedForApply ? "Approved" : "Review"}</div>
              <div className="meta">{strategyLabMsg}</div>
              <SimpleTable columns={["id", "robust", "stability", "trades", "winRate", "avgR", "maxDD%", "cagr%", "sharpe"]} rows={(strategyLab.candidates ?? []).slice(0, 10).map((x) => [x.candidateId, num(x.robustnessScore, 2), num(x.stabilityScore, 2), String(x.trades), pct(x.winRate), num(x.avgR, 3), num(x.maxDrawdownPct * 100, 2), num(x.cagrPct, 2), num(x.sharpeProxy, 3)])} />
              <div className="actions" style={{ marginTop: 8 }}>
                {(strategyLab.candidates ?? []).slice(0, 5).map((x) => <button key={x.candidateId} className="btn" disabled={busy} onClick={() => void applyStrategyCandidate(x.candidateId)}>Apply {x.candidateId}</button>)}
              </div>
            </Card>
            <Card title="Live vs Backtest Drift" span="wide" subtitle={drift.message ?? ""}>
              {!drift.summary ? <div className="empty">No drift summary yet</div> : <SimpleTable columns={["symbol", "live", "bt", "winRateΔ", "avgRΔ", "expΔ", "alert"]} rows={(drift.rows ?? []).map((x) => [x.symbol, String(x.liveTrades), String(x.btTrades), signedPct(x.deltaWinRate), signedNum(x.deltaAvgR, 3), signedInr(x.deltaExpectancy), x.alert ? "YES" : ""])} />}
            </Card>
            <Card title="Trade Journal" span="wide">
              <div className="form-grid two-col">
                <select value={journalLot} onChange={(e) => setJournalLot(e.target.value)}>
                  <option value="">Select closed lot</option>
                  {(journal.closedLots ?? []).slice(0, 120).map((x) => <option key={x.id} value={`${x.id}|${x.symbol}`}>#{x.id} {x.symbol} ({new Date(x.closedAt).toLocaleDateString("en-IN")})</option>)}
                </select>
                <input value={journalSetup} onChange={(e) => setJournalSetup(e.target.value)} placeholder="setup tag" />
                <input type="number" min={1} max={5} value={journalConfidence} onChange={(e) => setJournalConfidence(Number(e.target.value || 3))} placeholder="confidence" />
                <input value={journalMistake} onChange={(e) => setJournalMistake(e.target.value)} placeholder="mistake tag" />
                <input value={journalScreenshot} onChange={(e) => setJournalScreenshot(e.target.value)} placeholder="screenshot url" />
                <input value={journalNotes} onChange={(e) => setJournalNotes(e.target.value)} placeholder="notes" />
                <button className="btn btn-primary" disabled={busy} onClick={() => void saveJournal()}>Save Journal</button>
                <div className="meta">{journalMsg || ""}</div>
              </div>
              <SimpleTable columns={["setup", "trades", "winRate", "expectancy"]} rows={(journal.analytics?.bySetup ?? []).slice(0, 10).map((x) => [x.setupTag, String(x.trades), pct(x.winRate), inr(x.expectancy)])} />
            </Card>
            <Card title="PnL Attribution" span="wide">
              <SimpleTable columns={["symbol", "setupTag", "trades", "winRate", "avgPnl", "totalPnl"]} rows={(pnlAttrib.rows ?? []).slice(0, 20).map((x) => [x.symbol, x.setupTag, String(x.tradeCount), pct(x.winRate), inr(x.avgPnl), inr(x.pnl)])} />
            </Card>
          </section>
        ) : null}

        {page === "config" ? (
          <section className="grid">
            <Card title="Runtime Controls" span="wide">
              <div className="actions">
                <button disabled={busy || safeModeOn} onClick={() => void postAction("/api/scheduler/start")} className="btn">Start Scheduler</button>
                <button disabled={busy} onClick={() => void postAction("/api/scheduler/stop")} className="btn">Stop Scheduler</button>
                <button disabled={busy || safeModeOn} onClick={() => void postAction("/api/safe-mode/enable", { reason: "UI toggle" })} className="btn btn-danger">Enable Safe Mode</button>
                <button disabled={busy || !safeModeOn} onClick={() => void postAction("/api/safe-mode/disable", { reason: "UI toggle" })} className="btn">Disable Safe Mode</button>
              </div>
            </Card>
            <Card title="Risk Profile Automation" subtitle={`Active: ${profileStatus.activeProfile} | Recommended: ${profileRec.recommendedProfile}`}>
              <div className="meta">Score: {profileRec.score} | Auto-switch: {profileRec.autoSwitchAllowed ? "YES" : "NO"} | Updated: {new Date(profileRec.generatedAt).toLocaleString("en-IN")}</div>
              <div className="actions" style={{ marginBottom: 8 }}>
                <button className="btn" disabled={busy} onClick={() => void switchProfile("phase1")}>Apply Phase 1</button>
                <button className="btn" disabled={busy} onClick={() => void switchProfile("phase2")}>Apply Phase 2</button>
                <button className="btn" disabled={busy} onClick={() => void switchProfile("phase3")}>Apply Phase 3</button>
              </div>
              <SimpleTable columns={["control", "value"]} rows={Object.entries(profileStatus.controls ?? {}).map(([k, v]) => [k, v])} />
            </Card>
            <Card title=".env Config Editor" span="wide" subtitle={`Keys: ${envConfig.items.length} | Updated: ${new Date(envConfig.updatedAt).toLocaleString("en-IN")}`}>
              <div className="filters env-filters">
                <input value={envFilter} onChange={(e) => setEnvFilter(e.target.value)} placeholder="Search key/category/description" />
                <button className="btn" disabled={busy} onClick={() => void reloadEnvEditor()}>Reload .env</button>
                <button className="btn" disabled={busy} onClick={() => setShowSecrets((v) => !v)}>{showSecrets ? "Hide Secrets" : "Show Secrets"}</button>
                <button className="btn btn-primary" disabled={busy || envChangedCount === 0} onClick={() => void saveEnvChanges()}>Save Changes ({envChangedCount})</button>
              </div>
              <div className="meta">{envMsg || "Edit values and click Save Changes."}</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>key</th><th>value</th><th>category</th><th>description</th></tr>
                  </thead>
                  <tbody>
                    {envFilteredItems.slice(0, 300).map((item) => (
                      <tr key={item.key}>
                        <td>{item.key}</td>
                        <td>
                          <input
                            className="env-input"
                            type={item.sensitive && !showSecrets ? "password" : "text"}
                            value={envDraft[item.key] ?? ""}
                            onChange={(e) => {
                              const next = e.target.value;
                              setEnvDraft((prev) => ({ ...prev, [item.key]: next }));
                            }}
                          />
                        </td>
                        <td>{item.category}</td>
                        <td>{item.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>
        ) : null}

        {page === "billing" ? (
          <section className="grid">
            <Card title="Monetization Setup" span="wide" subtitle={`Provider: ${billing.provider.toUpperCase()} | ${billing.enabled ? "Enabled" : "Disabled"}`}>
              <div className="meta">Configure `PAYMENT_PROVIDER`, `PAYMENT_CHECKOUT_BASE_URL`, and optional `PAYMENT_SUCCESS_URL`/`PAYMENT_CANCEL_URL` in `.env`.</div>
              <div className="meta">{billingMsg || "Choose a plan to test the checkout flow."}</div>
            </Card>
            {(billing.plans ?? []).map((plan) => (
              <Card key={plan.id} title={plan.name} subtitle={plan.recommended ? "Most Popular" : ""}>
                <div className="price">{inr(plan.amountInr)} <small>/ {plan.interval}</small></div>
                <ul className="plan-list">
                  {(plan.features ?? []).map((f) => <li key={f}>{f}</li>)}
                </ul>
                <button className="btn btn-primary" disabled={busy || !billing.enabled} onClick={() => void checkoutPlan(plan.id)}>Start Checkout</button>
              </Card>
            ))}
          </section>
        ) : null}
      </main>

      {previewOpen ? (
        <div className="modal-backdrop" onClick={() => !previewBusy && setPreviewOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>Order Preview Before Morning Run</h2>
              <div className="card-sub">Generated: {morningPreview.generatedAt ? new Date(morningPreview.generatedAt).toLocaleString("en-IN") : "n/a"}</div>
            </div>
            <div className="meta">Preflight: {morningPreview.preflight?.ok ? "PASS" : "FAIL"} | Eligible: {morningPreview.summary?.eligible ?? 0} | Skipped: {morningPreview.summary?.skipped ?? 0} | Usable Funds: {inr(morningPreview.funds?.usableEquity ?? 0)}</div>
            {previewBusy ? (
              <div className="empty">Loading preview...</div>
            ) : (
              <SimpleTable columns={["symbol", "qty", "entry", "stop", "notional", "rank", "status", "reason"]} rows={(morningPreview.rows ?? []).slice(0, 25).map((x) => [x.symbol, String(x.qty), num(x.entryPrice, 2), num(x.stopPrice, 2), inr(x.notional), num(x.rankScore, 2), x.status.toUpperCase(), x.reason])} />
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn" disabled={previewBusy} onClick={() => void openMorningPreview()}>Refresh Preview</button>
              <button className="btn" disabled={previewBusy} onClick={() => setPreviewOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={previewBusy || !(morningPreview.preflight?.ok) || (morningPreview.summary?.eligible ?? 0) === 0} onClick={() => void confirmMorningRun()}>Confirm Morning Run</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function pageTitle(page: PageKey) {
  if (page === "overview") return "Command Center";
  if (page === "trading") return "Trading Operations";
  if (page === "analytics") return "Performance Intelligence";
  if (page === "config") return "System Configuration";
  return "Billing & Plans";
}

function pageSubtitle(page: PageKey, runningJob: string | null) {
  const run = runningJob ? `Running: ${runningJob}` : "System idle";
  if (page === "overview") return `Operational snapshot and readiness. ${run}`;
  if (page === "trading") return `Execution, protections, and broker orderflow. ${run}`;
  if (page === "analytics") return `Strategy quality, drift, and attribution. ${run}`;
  if (page === "config") return `Profile automation and full env management. ${run}`;
  return `Subscription plans and checkout integration. ${run}`;
}

function NavBtn({ page, target, label, onClick }: { page: PageKey; target: PageKey; label: string; onClick: (p: PageKey) => void }) {
  return <button className={`nav-btn ${page === target ? "active" : ""}`} onClick={() => onClick(target)}>{label}</button>;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

function Card({ title, subtitle, children, span }: { title: string; subtitle?: string; children: React.ReactNode; span?: "wide" }) {
  return (
    <article className={`card ${span === "wide" ? "card-wide" : ""}`}>
      <div className="card-head">
        <h2>{title}</h2>
        {subtitle ? <span className="card-sub">{subtitle}</span> : null}
      </div>
      {children}
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SimpleTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  if (rows.length === 0) return <div className="empty">No data</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx}>{r.map((c, i) => <td key={`${idx}-${i}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function inr(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(Number(value ?? 0));
}

function pct(value: number) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function num(value: number, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function signedNum(value: number, digits = 2) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function signedPct(value: number) {
  const n = Number(value || 0) * 100;
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function signedInr(value: number) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${inr(n)}`;
}
