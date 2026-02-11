import dotenv from "dotenv";
import { Pool } from "pg";
import { ZerodhaAdapter } from "../execution/zerodha_adapter.js";
import { MapLtpProvider } from "../market_data/ltp_provider.js";

dotenv.config();

type CheckStatus = "PASS" | "WARN" | "FAIL";

type CheckResult = {
  name: string;
  status: CheckStatus;
  details: string;
};

const REQUIRED_TABLES = [
  "orders",
  "fills",
  "positions",
  "managed_positions",
  "trade_lots",
  "daily_snapshots",
  "system_state",
  "alert_events",
  "reconcile_audit",
  "backtest_runs",
  "trade_journal"
];

async function main() {
  const results: CheckResult[] = [];
  results.push(checkEnvSafety());
  results.push(await checkDbReadiness());
  results.push(checkMarketHoursPolicy());
  results.push(await checkBrokerPreflight());

  for (const result of results) {
    console.log(`${result.status.padEnd(4)} ${result.name}: ${result.details}`);
  }

  const hasFail = results.some((r) => r.status === "FAIL");
  if (hasFail) {
    console.error("LIVE_CHECK_FAIL: Resolve FAIL items before live trading.");
    process.exitCode = 1;
    return;
  }

  console.log("LIVE_CHECK_OK: Safe to proceed.");
}

function checkEnvSafety(): CheckResult {
  if (process.env.LIVE_ORDER_MODE !== "1") {
    return {
      name: "Env Safety Flags",
      status: "WARN",
      details: "LIVE_ORDER_MODE is not enabled; system is in paper mode."
    };
  }

  const issues: string[] = [];
  if (process.env.CONFIRM_LIVE_ORDERS !== "YES") {
    issues.push("CONFIRM_LIVE_ORDERS must be YES");
  }
  if (!process.env.KITE_API_KEY) {
    issues.push("KITE_API_KEY is missing");
  }
  if (!process.env.KITE_ACCESS_TOKEN) {
    issues.push("KITE_ACCESS_TOKEN is missing");
  }
  if (!process.env.ALLOWED_SYMBOLS || parseCsvSet(process.env.ALLOWED_SYMBOLS).size === 0) {
    issues.push("ALLOWED_SYMBOLS must have at least one symbol");
  }
  const maxNotional = Number(process.env.MAX_NOTIONAL_PER_ORDER ?? "");
  if (!Number.isFinite(maxNotional) || maxNotional <= 0) {
    issues.push("MAX_NOTIONAL_PER_ORDER must be a positive number");
  }
  if (process.env.REQUIRE_DB !== "1") {
    issues.push("REQUIRE_DB should be 1 in live mode");
  }
  if (process.env.HALT_TRADING === "1") {
    issues.push("HALT_TRADING is enabled");
  }

  if (issues.length > 0) {
    return {
      name: "Env Safety Flags",
      status: "FAIL",
      details: issues.join("; ")
    };
  }

  return {
    name: "Env Safety Flags",
    status: "PASS",
    details: "Live safety flags are configured."
  };
}

async function checkDbReadiness(): Promise<CheckResult> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      name: "DB Readiness",
      status: "FAIL",
      details: "DATABASE_URL is missing."
    };
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    const missing: string[] = [];
    for (const table of REQUIRED_TABLES) {
      const result = await pool.query<{ exists: string | null }>(
        "SELECT to_regclass($1) AS exists",
        [`public.${table}`]
      );
      if (!result.rows[0]?.exists) {
        missing.push(table);
      }
    }
    if (missing.length > 0) {
      return {
        name: "DB Readiness",
        status: "FAIL",
        details: `Missing tables: ${missing.join(", ")}`
      };
    }
    return {
      name: "DB Readiness",
      status: "PASS",
      details: "Database is reachable and schema is ready."
    };
  } catch (err) {
    return {
      name: "DB Readiness",
      status: "FAIL",
      details: errorMessage(err)
    };
  } finally {
    await pool.end();
  }
}

function checkMarketHoursPolicy(): CheckResult {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const totalMinutes = hour * 60 + minute;
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  const inWindow = totalMinutes >= 9 * 60 + 15 && totalMinutes <= 15 * 60 + 30;
  const strict = (process.env.LIVE_CHECK_MARKET_POLICY ?? "warn").toLowerCase() === "strict";

  if (isWeekday && inWindow) {
    return {
      name: "Market Hours Policy",
      status: "PASS",
      details: "Current IST time is inside live monitor window (09:15-15:30)."
    };
  }

  const details = `Current IST: ${weekday} ${String(hour).padStart(2, "0")}:${String(
    minute
  ).padStart(2, "0")} (outside 09:15-15:30).`;
  return {
    name: "Market Hours Policy",
    status: strict ? "FAIL" : "WARN",
    details: strict ? `${details} Set LIVE_CHECK_MARKET_POLICY=warn to allow.` : details
  };
}

async function checkBrokerPreflight(): Promise<CheckResult> {
  if (process.env.LIVE_ORDER_MODE !== "1") {
    return {
      name: "Broker Preflight",
      status: "WARN",
      details: "Skipped because LIVE_ORDER_MODE is not 1."
    };
  }

  const adapter = new ZerodhaAdapter(new MapLtpProvider(new Map([["NIFTYBEES", 1]])), {
    mode: "live",
    apiKey: process.env.KITE_API_KEY,
    accessToken: process.env.KITE_ACCESS_TOKEN,
    product: process.env.KITE_PRODUCT ?? "CNC",
    exchange: process.env.KITE_EXCHANGE ?? "NSE"
  });

  try {
    const result = await adapter.preflightCheck();
    if (!result.ok) {
      return {
        name: "Broker Preflight",
        status: "FAIL",
        details: result.message
      };
    }
    return {
      name: "Broker Preflight",
      status: "PASS",
      details: `Live session is valid${result.accountUserId ? ` (${result.accountUserId})` : ""}.`
    };
  } catch (err) {
    return {
      name: "Broker Preflight",
      status: "FAIL",
      details: errorMessage(err)
    };
  }
}

function parseCsvSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x.length > 0)
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

await main();
