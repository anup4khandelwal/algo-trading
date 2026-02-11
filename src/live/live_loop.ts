import dotenv from "dotenv";
import { runEntryPass, runMonitorPass } from "../pipeline.js";

dotenv.config();

const INTERVAL_SECONDS = Number(process.env.LIVE_LOOP_INTERVAL_SECONDS ?? "120");
const RUN_ENTRY_ON_START = (process.env.LIVE_ENTRY_ON_START ?? "1") === "1";

async function main() {
  console.log("LIVE_LOOP_START");
  console.log(`interval_seconds=${INTERVAL_SECONDS}`);

  if (RUN_ENTRY_ON_START) {
    console.log("LIVE_LOOP_ENTRY_PASS");
    await runEntryPass();
  }

  while (isWithinTradingWindowIST()) {
    console.log("LIVE_LOOP_MONITOR_PASS", new Date().toISOString());
    await runMonitorPass();
    await sleep(INTERVAL_SECONDS * 1000);
  }

  console.log("LIVE_LOOP_END", new Date().toISOString());
}

function isWithinTradingWindowIST(): boolean {
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
  const marketStart = 9 * 60 + 15;
  const marketEnd = 15 * 60 + 30;
  return isWeekday && totalMinutes >= marketStart && totalMinutes <= marketEnd;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
