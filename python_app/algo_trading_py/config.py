from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


@dataclass(slots=True)
class KiteConfig:
  api_key: str
  access_token: str
  base_url: str = "https://api.kite.trade"


def kite_config_from_env() -> KiteConfig:
  api_key = os.getenv("KITE_API_KEY", "").strip()
  access_token = os.getenv("KITE_ACCESS_TOKEN", "").strip()
  base_url = os.getenv("KITE_BASE_URL", "https://api.kite.trade").strip()
  if not api_key or not access_token:
    raise RuntimeError("KITE_API_KEY and KITE_ACCESS_TOKEN are required")
  return KiteConfig(api_key=api_key, access_token=access_token, base_url=base_url)
