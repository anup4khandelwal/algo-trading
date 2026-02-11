import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export type ProfileName = "phase1" | "phase2" | "phase3";

const PROFILE_NAMES: ProfileName[] = ["phase1", "phase2", "phase3"];

function envPath() {
  return path.resolve(process.cwd(), ".env");
}

function profilePath(name: ProfileName) {
  return path.resolve(process.cwd(), "profiles", `${name}.env`);
}

function parseEnv(raw: string) {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function dumpEnv(map: Record<string, string>) {
  return Object.keys(map)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${map[k]}`)
    .join("\n") + "\n";
}

export async function loadCurrentEnvMap() {
  const p = envPath();
  if (!existsSync(p)) {
    return {} as Record<string, string>;
  }
  const raw = await readFile(p, "utf-8");
  return parseEnv(raw);
}

export async function loadProfileMap(name: ProfileName) {
  const p = profilePath(name);
  if (!existsSync(p)) {
    throw new Error(`Profile file missing: ${p}`);
  }
  const raw = await readFile(p, "utf-8");
  return parseEnv(raw);
}

export async function applyProfile(name: ProfileName) {
  const current = await loadCurrentEnvMap();
  const profile = await loadProfileMap(name);
  const next = { ...current, ...profile };
  await writeFile(envPath(), dumpEnv(next), "utf-8");

  for (const [k, v] of Object.entries(profile)) {
    process.env[k] = v;
  }

  return {
    profile: name,
    appliedKeys: Object.keys(profile).length,
    updatedAt: new Date().toISOString(),
    envPath: envPath()
  };
}

export function listProfiles() {
  return PROFILE_NAMES;
}

export function readActiveProfileFromProcess(): ProfileName | "custom" {
  const active = String(process.env.ACTIVE_PROFILE ?? "").toLowerCase();
  if (PROFILE_NAMES.includes(active as ProfileName)) {
    return active as ProfileName;
  }
  return "custom";
}

export async function getProfileSnapshot() {
  const current = await loadCurrentEnvMap();
  return {
    activeProfile: readActiveProfileFromProcess(),
    availableProfiles: listProfiles(),
    controls: {
      LIVE_ORDER_MODE: current.LIVE_ORDER_MODE ?? "0",
      FUND_USAGE_PCT: current.FUND_USAGE_PCT ?? "0.95",
      RISK_PER_TRADE: current.RISK_PER_TRADE ?? "0.015",
      MAX_DAILY_LOSS: current.MAX_DAILY_LOSS ?? "50000",
      MAX_OPEN_POSITIONS: current.MAX_OPEN_POSITIONS ?? "5",
      MAX_ORDERS_PER_DAY: current.MAX_ORDERS_PER_DAY ?? "10",
      MAX_EXPOSURE_PER_SYMBOL: current.MAX_EXPOSURE_PER_SYMBOL ?? "300000",
      MAX_NOTIONAL_PER_ORDER: current.MAX_NOTIONAL_PER_ORDER ?? "500000",
      REJECT_GUARD_THRESHOLD: current.REJECT_GUARD_THRESHOLD ?? "2",
      ALLOWED_SYMBOLS: current.ALLOWED_SYMBOLS ?? ""
    }
  };
}
