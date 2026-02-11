import { KiteHistoricalProvider } from "../market_data/kite_historical_provider.js";
import { runBacktest } from "../backtest/engine.js";

export type StrategyLabParams = {
  minRsi: number;
  breakoutBufferPct: number;
  atrStopMultiple: number;
  riskPerTrade: number;
  minVolumeRatio: number;
  maxSignals: number;
};

export type StrategyLabCandidate = {
  candidateId: string;
  params: StrategyLabParams;
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
};

export type StrategyLabRecommendation = {
  candidateId: string;
  approvedForApply: boolean;
  reasons: string[];
};

export type StrategyLabRunOutput = {
  runId: string;
  label?: string;
  startedAt: string;
  finishedAt: string;
  datasetWindow: string;
  candidates: StrategyLabCandidate[];
  recommendation: StrategyLabRecommendation;
};

export async function runStrategyLabSweep(input?: {
  label?: string;
  from?: string;
  to?: string;
  symbols?: string[];
  maxCandidates?: number;
}): Promise<StrategyLabRunOutput> {
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (!apiKey || !accessToken) {
    throw new Error("KITE_API_KEY and KITE_ACCESS_TOKEN are required for strategy lab");
  }

  const startedAt = new Date().toISOString();
  const runId = `sl-${Date.now()}`;
  const base = baseParamsFromEnv();
  const candidateParams = generateCandidates(base, input?.maxCandidates);
  const provider = new KiteHistoricalProvider({ apiKey, accessToken });
  const candidates: StrategyLabCandidate[] = [];

  for (let i = 0; i < candidateParams.length; i += 1) {
    const params = candidateParams[i];
    const bt = await runBacktest(provider, {
      from: input?.from ?? process.env.BACKTEST_FROM ?? undefined,
      to: input?.to ?? process.env.BACKTEST_TO ?? undefined,
      symbols: input?.symbols?.length ? input.symbols : parseCsv(process.env.BACKTEST_SYMBOLS),
      initialCapital: toNumber(process.env.BACKTEST_INITIAL_CAPITAL),
      maxHoldDays: toNumber(process.env.BACKTEST_MAX_HOLD_DAYS),
      slippageBps: toNumber(process.env.BACKTEST_SLIPPAGE_BPS),
      feeBps: toNumber(process.env.BACKTEST_FEE_BPS),
      maxOpenPositions: toInt(process.env.BACKTEST_MAX_OPEN_POSITIONS),
      minAdv20: toNumber(process.env.STRATEGY_MIN_ADV20),
      ...params
    });

    const guardrailReasons = evaluateGuardrails(bt);
    const stabilityScore = calcStabilityScore(bt);
    const robustnessScore = calcRobustnessScore(bt, stabilityScore);
    candidates.push({
      candidateId: `C${String(i + 1).padStart(2, "0")}`,
      params,
      trades: bt.trades,
      winRate: bt.winRate,
      avgR: bt.avgR,
      expectancy: bt.expectancy,
      maxDrawdownPct: bt.maxDrawdownPct,
      cagrPct: bt.cagrPct,
      sharpeProxy: bt.sharpeProxy,
      stabilityScore,
      robustnessScore,
      guardrailPass: guardrailReasons.length === 0,
      guardrailReasons
    });
  }

  candidates.sort((a, b) => b.robustnessScore - a.robustnessScore);
  const recommendation = selectRecommendation(candidates);
  const finishedAt = new Date().toISOString();
  return {
    runId,
    label: input?.label,
    startedAt,
    finishedAt,
    datasetWindow: `${input?.from ?? process.env.BACKTEST_FROM ?? "auto"} -> ${input?.to ?? process.env.BACKTEST_TO ?? "auto"}`,
    candidates,
    recommendation
  };
}

function baseParamsFromEnv(): StrategyLabParams {
  return {
    minRsi: toNumber(process.env.STRATEGY_MIN_RSI) ?? 55,
    breakoutBufferPct: toNumber(process.env.STRATEGY_BREAKOUT_BUFFER_PCT) ?? 0.02,
    atrStopMultiple: toNumber(process.env.ATR_STOP_MULTIPLE) ?? 2,
    riskPerTrade: toNumber(process.env.RISK_PER_TRADE) ?? 0.015,
    minVolumeRatio: toNumber(process.env.STRATEGY_MIN_VOLUME_RATIO) ?? 1.2,
    maxSignals: toInt(process.env.STRATEGY_MAX_SIGNALS) ?? 5
  };
}

function generateCandidates(base: StrategyLabParams, maxRaw?: number): StrategyLabParams[] {
  const maxCandidates = Math.max(3, Math.min(40, maxRaw ?? toInt(process.env.STRATLAB_MAX_CANDIDATES) ?? 15));
  const minRsi = uniqueInts([base.minRsi - 2, base.minRsi, base.minRsi + 2], 45, 75);
  const breakout = uniqueNums(
    [base.breakoutBufferPct - 0.005, base.breakoutBufferPct, base.breakoutBufferPct + 0.005],
    0.005,
    0.08,
    3
  );
  const atr = uniqueNums([base.atrStopMultiple - 0.2, base.atrStopMultiple, base.atrStopMultiple + 0.2], 1.2, 4, 2);
  const risk = uniqueNums([base.riskPerTrade * 0.8, base.riskPerTrade, base.riskPerTrade * 1.15], 0.003, 0.03, 4);
  const volume = uniqueNums([base.minVolumeRatio - 0.1, base.minVolumeRatio, base.minVolumeRatio + 0.1], 1, 2.5, 2);
  const maxSignals = uniqueInts([base.maxSignals - 1, base.maxSignals, base.maxSignals + 1], 2, 12);

  const out: StrategyLabParams[] = [];
  for (const rsi of minRsi) {
    for (const buf of breakout) {
      for (const a of atr) {
        for (const rk of risk) {
          for (const vr of volume) {
            for (const ms of maxSignals) {
              out.push({
                minRsi: rsi,
                breakoutBufferPct: buf,
                atrStopMultiple: a,
                riskPerTrade: rk,
                minVolumeRatio: vr,
                maxSignals: ms
              });
              if (out.length >= maxCandidates) {
                return out;
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function evaluateGuardrails(bt: {
  trades: number;
  winRate: number;
  avgR: number;
  maxDrawdownPct: number;
  sharpeProxy: number;
}) {
  const reasons: string[] = [];
  if (bt.trades < 25) reasons.push("trades<25");
  if (bt.winRate < 0.48) reasons.push("winRate<48%");
  if (bt.avgR < 0.2) reasons.push("avgR<0.20");
  if (bt.maxDrawdownPct > 0.22) reasons.push("maxDD>22%");
  if (bt.sharpeProxy < 0.4) reasons.push("sharpe<0.40");
  return reasons;
}

function calcStabilityScore(bt: { trades: number; maxDrawdownPct: number; sharpeProxy: number }) {
  const tradeScore = clamp(bt.trades / 60, 0, 1);
  const ddScore = clamp((0.25 - bt.maxDrawdownPct) / 0.25, 0, 1);
  const sharpeScore = clamp(bt.sharpeProxy / 1.5, 0, 1);
  return round(0.4 * tradeScore + 0.35 * ddScore + 0.25 * sharpeScore, 4);
}

function calcRobustnessScore(
  bt: { winRate: number; avgR: number; expectancy: number; cagrPct: number; maxDrawdownPct: number },
  stabilityScore: number
) {
  const winRateComp = clamp(bt.winRate, 0, 1) * 35;
  const avgRComp = clamp(bt.avgR / 1.5, -1, 1.5) * 20;
  const expectancyComp = clamp(bt.expectancy / 1200, -1, 1.5) * 10;
  const cagrComp = clamp(bt.cagrPct / 35, -1, 1.5) * 20;
  const ddPenalty = clamp(bt.maxDrawdownPct / 0.2, 0, 2) * 20;
  const stabilityComp = clamp(stabilityScore, 0, 1) * 25;
  return round(winRateComp + avgRComp + expectancyComp + cagrComp + stabilityComp - ddPenalty, 4);
}

function selectRecommendation(candidates: StrategyLabCandidate[]): StrategyLabRecommendation {
  if (candidates.length === 0) {
    return {
      candidateId: "",
      approvedForApply: false,
      reasons: ["no-candidates"]
    };
  }
  const passing = candidates.find((x) => x.guardrailPass);
  if (!passing) {
    const top = candidates[0];
    return {
      candidateId: top.candidateId,
      approvedForApply: false,
      reasons: ["no-guardrail-pass", ...(top.guardrailReasons.length ? top.guardrailReasons : ["insufficient robustness"])]
    };
  }
  return {
    candidateId: passing.candidateId,
    approvedForApply: true,
    reasons: ["best-robustness-under-guardrails"]
  };
}

function parseCsv(value: string | undefined) {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const out = value
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
}

function toNumber(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toInt(value: string | undefined) {
  const n = toNumber(value);
  return typeof n === "number" ? Math.round(n) : undefined;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function round(v: number, decimals: number) {
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}

function uniqueNums(values: number[], min: number, max: number, decimals: number) {
  return Array.from(
    new Set(values.map((x) => round(clamp(x, min, max), decimals)))
  ).sort((a, b) => a - b);
}

function uniqueInts(values: number[], min: number, max: number) {
  return Array.from(new Set(values.map((x) => Math.round(clamp(x, min, max))))).sort((a, b) => a - b);
}
