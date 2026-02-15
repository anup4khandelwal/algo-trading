from __future__ import annotations

import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo


class TradingScheduler:
  def __init__(
    self,
    run_morning,
    run_monitor,
    run_eod_close,
    run_backtest,
    run_strategy_lab,
    can_run,
    tick_seconds: int = 20,
    monitor_interval_seconds: int = 300,
    premarket_at: str = "08:55",
    eod_at: str = "15:31",
    backtest_at: str = "10:30",
    backtest_weekday: str = "Sat",
    strategy_lab_at: str = "11:00",
    strategy_lab_weekday: str = "Sat",
  ) -> None:
    self.run_morning = run_morning
    self.run_monitor = run_monitor
    self.run_eod_close = run_eod_close
    self.run_backtest = run_backtest
    self.run_strategy_lab = run_strategy_lab
    self.can_run = can_run
    self.tick_seconds = max(5, int(tick_seconds))
    self.monitor_interval_seconds = max(60, int(monitor_interval_seconds))
    self.premarket_at = premarket_at
    self.eod_at = eod_at
    self.backtest_at = backtest_at
    self.backtest_weekday = backtest_weekday
    self.strategy_lab_at = strategy_lab_at
    self.strategy_lab_weekday = strategy_lab_weekday
    self.last_runs: dict[str, str] = {}
    self.last_errors: dict[str, str] = {}
    self.seen: set[str] = set()
    self._stop = threading.Event()
    self._thread: threading.Thread | None = None

  def start(self) -> None:
    if self._thread and self._thread.is_alive():
      return
    self._stop.clear()
    self._thread = threading.Thread(target=self._loop, daemon=True)
    self._thread.start()

  def stop(self) -> None:
    self._stop.set()

  def is_running(self) -> bool:
    return self._thread is not None and self._thread.is_alive() and not self._stop.is_set()

  def get_state(self) -> dict[str, object]:
    return {
      "enabled": self.is_running(),
      "tickSeconds": self.tick_seconds,
      "monitorIntervalSeconds": self.monitor_interval_seconds,
      "premarketAt": self.premarket_at,
      "eodAt": self.eod_at,
      "backtestAt": self.backtest_at,
      "backtestWeekday": self.backtest_weekday,
      "strategyLabAt": self.strategy_lab_at,
      "strategyLabWeekday": self.strategy_lab_weekday,
      "lastRuns": self.last_runs,
      "lastErrors": self.last_errors,
    }

  def _loop(self) -> None:
    while not self._stop.is_set():
      try:
        self._tick()
      except Exception as err:  # noqa: BLE001
        self.last_errors["tick"] = str(err)
      time.sleep(self.tick_seconds)

  def _tick(self) -> None:
    now = datetime.now(ZoneInfo("Asia/Kolkata"))
    weekday = now.strftime("%a")
    date_str = now.strftime("%Y-%m-%d")
    hhmm = now.strftime("%H:%M")
    is_weekday = weekday in {"Mon", "Tue", "Wed", "Thu", "Fri"}

    if is_weekday and hhmm == self.premarket_at:
      self._try_run("morning", f"morning:{date_str}", self.run_morning)
    if is_weekday and self._in_monitor_window(now):
      bucket = int(time.time() // self.monitor_interval_seconds)
      self._try_run("monitor", f"monitor:{bucket}", self.run_monitor)
    if is_weekday and hhmm == self.eod_at:
      self._try_run("eod_close", f"eod:{date_str}", self.run_eod_close)
    if weekday == self.backtest_weekday and hhmm == self.backtest_at:
      self._try_run("backtest", f"backtest:{date_str}", self.run_backtest)
    if weekday == self.strategy_lab_weekday and hhmm == self.strategy_lab_at:
      self._try_run("strategy_lab", f"strategy_lab:{date_str}", self.run_strategy_lab)

  def _in_monitor_window(self, now: datetime) -> bool:
    mins = now.hour * 60 + now.minute
    return (9 * 60 + 20) <= mins <= (15 * 60 + 25)

  def _try_run(self, job: str, dedupe_key: str, fn) -> None:
    if dedupe_key in self.seen or not self.can_run():
      return
    self.seen.add(dedupe_key)
    try:
      fn()
      self.last_runs[job] = datetime.utcnow().isoformat() + "Z"
      self.last_errors.pop(job, None)
    except Exception as err:  # noqa: BLE001
      self.last_errors[job] = str(err)
