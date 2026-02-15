from __future__ import annotations

import time
from datetime import datetime
from zoneinfo import ZoneInfo

from algo_trading_py.pipeline import run_entry, run_monitor


def run_live_loop(interval_seconds: int = 120, run_entry_on_start: bool = True) -> dict[str, object]:
  runs = 0
  if run_entry_on_start:
    run_entry()
  while _is_within_trading_window_ist():
    run_monitor()
    runs += 1
    time.sleep(max(15, interval_seconds))
  return {"ok": True, "monitorRuns": runs}


def _is_within_trading_window_ist() -> bool:
  now = datetime.now(ZoneInfo("Asia/Kolkata"))
  if now.strftime("%a") not in {"Mon", "Tue", "Wed", "Thu", "Fri"}:
    return False
  mins = now.hour * 60 + now.minute
  return (9 * 60 + 15) <= mins <= (15 * 60 + 30)
