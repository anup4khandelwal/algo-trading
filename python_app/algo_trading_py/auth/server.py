from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, PlainTextResponse

app = FastAPI(title="Kite Auth Callback", version="0.1.0")


def kite_login_url() -> str:
  api_key = os.getenv("KITE_API_KEY", "").strip()
  if not api_key:
    raise RuntimeError("KITE_API_KEY is required")
  return f"https://kite.zerodha.com/connect/login?v=3&{urlencode({'api_key': api_key})}"


def _checksum(api_key: str, request_token: str, api_secret: str) -> str:
  return hashlib.sha256(f"{api_key}{request_token}{api_secret}".encode("utf-8")).hexdigest()


def exchange_token(request_token: str) -> str:
  api_key = os.getenv("KITE_API_KEY", "").strip()
  api_secret = os.getenv("KITE_API_SECRET", "").strip()
  if not api_key or not api_secret:
    raise RuntimeError("KITE_API_KEY and KITE_API_SECRET are required")
  form = {
    "api_key": api_key,
    "request_token": request_token,
    "checksum": _checksum(api_key, request_token, api_secret),
  }
  with httpx.Client(timeout=30) as client:
    res = client.post(
      "https://api.kite.trade/session/token",
      data=form,
      headers={"X-Kite-Version": "3"},
    )
    data = res.json()
  if res.status_code >= 400 or data.get("status") != "success":
    raise RuntimeError(f"Token exchange failed: {res.status_code} {data.get('message', '')}")
  token = ((data.get("data") or {}).get("access_token") or "").strip()
  if not token:
    raise RuntimeError("Token exchange did not return access_token")
  return token


def update_env_with_token(access_token: str, env_path: str = ".env") -> None:
  p = Path(env_path)
  content = p.read_text() if p.exists() else ""
  lines = [x for x in content.splitlines() if x and not x.startswith("KITE_ACCESS_TOKEN=") and not x.startswith("KITE_ACCESS_TOKEN_CREATED_AT=")]
  lines.append(f"KITE_ACCESS_TOKEN={access_token}")
  lines.append(f"KITE_ACCESS_TOKEN_CREATED_AT={datetime.now(UTC).isoformat()}")
  p.write_text("\n".join(lines) + "\n")


@app.get("/", response_class=PlainTextResponse)
def root() -> str:
  return "OK"


@app.get("/kite/login", response_class=PlainTextResponse)
def login() -> str:
  return kite_login_url()


@app.get("/kite/callback", response_class=HTMLResponse)
def callback(request_token: str = Query("", alias="request_token")) -> str:
  if not request_token:
    raise HTTPException(status_code=400, detail="Missing request_token")
  token = exchange_token(request_token)
  update_env_with_token(token)
  return "<h3>Access token generated</h3><p>Token saved in .env.</p>"
