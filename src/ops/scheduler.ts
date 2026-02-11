export type SchedulerJobName =
  | "morning"
  | "monitor"
  | "eod_close"
  | "backtest"
  | "strategy_lab";

type SchedulerState = {
  enabled: boolean;
  tickSeconds: number;
  monitorIntervalSeconds: number;
  premarketAt: string;
  eodAt: string;
  backtestAt: string;
  backtestWeekday: string;
  strategyLabAt: string;
  strategyLabWeekday: string;
  lastRuns: Partial<Record<SchedulerJobName, string>>;
  lastErrors: Partial<Record<SchedulerJobName, string>>;
};

type SchedulerHandlers = {
  runMorning: () => Promise<void>;
  runMonitor: () => Promise<void>;
  runEodClose: () => Promise<void>;
  runBacktest: () => Promise<void>;
  runStrategyLab: () => Promise<void>;
  canRun: () => boolean;
};

export class TradingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastTickBucket = "";
  private seenKeys = new Set<string>();
  private lastRuns: SchedulerState["lastRuns"] = {};
  private lastErrors: SchedulerState["lastErrors"] = {};

  constructor(
    private handlers: SchedulerHandlers,
    private cfg: {
      tickSeconds: number;
      monitorIntervalSeconds: number;
      premarketAt: string;
      eodAt: string;
      backtestAt: string;
      backtestWeekday: string;
      strategyLabAt: string;
      strategyLabWeekday: string;
    }
  ) {}

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, Math.max(5, this.cfg.tickSeconds) * 1000);
    void this.tick();
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning() {
    return Boolean(this.timer);
  }

  getState(): SchedulerState {
    return {
      enabled: this.isRunning(),
      tickSeconds: this.cfg.tickSeconds,
      monitorIntervalSeconds: this.cfg.monitorIntervalSeconds,
      premarketAt: this.cfg.premarketAt,
      eodAt: this.cfg.eodAt,
      backtestAt: this.cfg.backtestAt,
      backtestWeekday: this.cfg.backtestWeekday,
      strategyLabAt: this.cfg.strategyLabAt,
      strategyLabWeekday: this.cfg.strategyLabWeekday,
      lastRuns: this.lastRuns,
      lastErrors: this.lastErrors
    };
  }

  private async tick() {
    const now = new Date();
    const p = partsIST(now);
    const minuteKey = `${p.date} ${p.hour}:${p.minute}`;
    if (minuteKey === this.lastTickBucket) {
      return;
    }
    this.lastTickBucket = minuteKey;

    const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(p.weekday);
    if (isWeekday && atTime(p, this.cfg.premarketAt)) {
      await this.tryRun("morning", `morning:${p.date}`, this.handlers.runMorning);
    }

    if (isWeekday && inMonitorWindow(p)) {
      const bucket = Math.floor(now.getTime() / (this.cfg.monitorIntervalSeconds * 1000));
      await this.tryRun("monitor", `monitor:${bucket}`, this.handlers.runMonitor);
    }

    if (isWeekday && atTime(p, this.cfg.eodAt)) {
      await this.tryRun("eod_close", `eod:${p.date}`, this.handlers.runEodClose);
    }

    if (p.weekday === this.cfg.backtestWeekday && atTime(p, this.cfg.backtestAt)) {
      await this.tryRun("backtest", `backtest:${p.date}`, this.handlers.runBacktest);
    }

    if (p.weekday === this.cfg.strategyLabWeekday && atTime(p, this.cfg.strategyLabAt)) {
      await this.tryRun("strategy_lab", `strategy-lab:${p.date}`, this.handlers.runStrategyLab);
    }
  }

  private async tryRun(job: SchedulerJobName, dedupeKey: string, fn: () => Promise<void>) {
    if (this.seenKeys.has(dedupeKey)) {
      return;
    }
    if (!this.handlers.canRun()) {
      return;
    }
    this.seenKeys.add(dedupeKey);
    try {
      await fn();
      this.lastRuns[job] = new Date().toISOString();
      delete this.lastErrors[job];
    } catch (err) {
      this.lastErrors[job] = err instanceof Error ? err.message : String(err);
    }
  }
}

function inMonitorWindow(p: {
  weekday: string;
  hour: string;
  minute: string;
}) {
  const totalMinutes = Number(p.hour) * 60 + Number(p.minute);
  return totalMinutes >= 9 * 60 + 20 && totalMinutes <= 15 * 60 + 25;
}

function atTime(
  p: {
    hour: string;
    minute: string;
  },
  hhmm: string
) {
  const [h, m] = hhmm.split(":").map((x) => x.trim());
  return p.hour === h?.padStart(2, "0") && p.minute === m?.padStart(2, "0");
}

function partsIST(now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(now);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    date: `${get("year")}-${get("month")}-${get("day")}`
  };
}
