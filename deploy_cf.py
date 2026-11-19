"""Deploy DetailQuote-US to Cloudflare Pages + D1 without leaking credentials."""
from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

import httpx

from build_cf_pages import build

ROOT_DIR = Path(__file__).resolve().parent
LOCAL_ENV_PATH = ROOT_DIR / ".env"
FALLBACK_CF_ENV = Path(r"D:\Valhalla-VPN\.env")
PROJECT_NAME = "detailquote-us"
D1_NAME = "detailquote-us-db"
LIVE_URL = f"https://{PROJECT_NAME}.pages.dev"


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _read_cf_credentials() -> tuple[str, str]:
    local_env = _parse_env_file(LOCAL_ENV_PATH)
    fallback_env = _parse_env_file(FALLBACK_CF_ENV)
    account_id = (
        os.environ.get("CLOUDFLARE_ACCOUNT_ID")
        or local_env.get("CLOUDFLARE_ACCOUNT_ID")
        or fallback_env.get("CLOUDFLARE_ACCOUNT_ID")
        or ""
    ).strip()
    api_token = (
        os.environ.get("CLOUDFLARE_API_TOKEN")
        or local_env.get("CLOUDFLARE_API_TOKEN")
        or fallback_env.get("CLOUDFLARE_API_TOKEN")
        or ""
    ).strip()
    if not account_id or not api_token:
        raise RuntimeError("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN")
    return account_id, api_token


def _ensure_local_secrets() -> tuple[str, str]:
    existing = _parse_env_file(LOCAL_ENV_PATH)
    secret = existing.get("DETAILQUOTE_SECRET") or os.environ.get("DETAILQUOTE_SECRET") or secrets.token_hex(32)
    admin_key = existing.get("DETAILQUOTE_ADMIN_KEY") or os.environ.get("DETAILQUOTE_ADMIN_KEY") or secrets.token_hex(24)

    lines = [
        f"DETAILQUOTE_LIVE_URL={LIVE_URL}",
        f"DETAILQUOTE_SECRET={secret}",
        f"DETAILQUOTE_ADMIN_KEY={admin_key}",
    ]
    for extra in ("DETAILQUOTE_TG_BOT_TOKEN", "DETAILQUOTE_TG_CHAT_ID", "DETAILQUOTE_WEBHOOK_URL"):
        if existing.get(extra):
            lines.append(f"{extra}={existing[extra]}")
    LOCAL_ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return secret, admin_key


def _cf_request(client: httpx.Client, method: str, path: str, json_body: dict | None = None) -> dict:
    resp = client.request(method, f"https://api.cloudflare.com/client/v4{path}", json=json_body)
    try:
        data = resp.json()
    except Exception as exc:
        raise RuntimeError(f"Cloudflare API {method} {path} returned non-JSON HTTP {resp.status_code}") from exc
    if resp.status_code >= 400 or not data.get("success"):
        errs = data.get("errors") or []
        msg = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in errs) or f"HTTP {resp.status_code}"
        raise RuntimeError(f"Cloudflare API {method} {path} failed: {msg}")
    return data


def ensure_d1_database(client: httpx.Client, account_id: str) -> str:
    res = _cf_request(client, "GET", f"/accounts/{account_id}/d1/database")
    for db in res.get("result") or []:
        if db.get("name") == D1_NAME:
            return db["uuid"]
    created = _cf_request(client, "POST", f"/accounts/{account_id}/d1/database", {"name": D1_NAME})
    return created["result"]["uuid"]


def ensure_pages_project(client: httpx.Client, account_id: str) -> dict:
    res = _cf_request(client, "GET", f"/accounts/{account_id}/pages/projects")
    for proj in res.get("result") or []:
        if proj.get("name") == PROJECT_NAME:
            return proj
    created = _cf_request(
        client,
        "POST",
        f"/accounts/{account_id}/pages/projects",
        {"name": PROJECT_NAME, "production_branch": "main"},
    )
    return created["result"]


def configure_pages_bindings(
    client: httpx.Client,
    account_id: str,
    db_uuid: str,
    secret: str,
    admin_key: str,
) -> None:
    cfg = {
        "d1_databases": {"DB": {"id": db_uuid}},
        "env_vars": {
            "DETAILQUOTE_SECRET": {"type": "secret_text", "value": secret},
            "DETAILQUOTE_ADMIN_KEY": {"type": "secret_text", "value": admin_key},
        },
    }
    _cf_request(
        client,
        "PATCH",
        f"/accounts/{account_id}/pages/projects/{PROJECT_NAME}",
        {
            "deployment_configs": {
                "production": cfg,
                "preview": cfg,
            }
        },
    )


def deploy_bundle(dist_dir: Path, account_id: str, api_token: str) -> None:
    npx_cmd = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx_cmd:
        raise RuntimeError("npx not found in PATH")
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = account_id
    env["CLOUDFLARE_API_TOKEN"] = api_token

    cmd = [
        npx_cmd,
        "--yes",
        "wrangler@latest",
        "pages",
        "deploy",
        str(dist_dir),
        "--project-name",
        PROJECT_NAME,
        "--branch",
        "main",
        "--commit-dirty=true",
    ]
    proc = subprocess.run(cmd, cwd=str(ROOT_DIR), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        combined = (proc.stdout + "\n" + proc.stderr).strip()
        raise RuntimeError(f"wrangler deploy failed (code {proc.returncode}):\n{combined[-1500:]}")
    for line in (proc.stdout or "").splitlines():
        if "pages.dev" in line or "Success" in line or "Deployment" in line:
            print(" ", line)


def main() -> int:
    account_id, api_token = _read_cf_credentials()
    secret, admin_key = _ensure_local_secrets()
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or None

    headers = {"Authorization": f"Bearer {api_token}", "Content-Type": "application/json"}
    with httpx.Client(timeout=20.0, headers=headers, proxy=proxy) as client:
        db_uuid = ensure_d1_database(client, account_id)
        print(f"D1 ready:       {D1_NAME} ({db_uuid})")
        ensure_pages_project(client, account_id)
        print(f"Pages project:  {PROJECT_NAME}")
        configure_pages_bindings(client, account_id, db_uuid, secret, admin_key)
        print("Bindings set:   DB + DETAILQUOTE_SECRET + DETAILQUOTE_ADMIN_KEY")

    dist_dir = build()
    print(f"Bundle built:   {dist_dir}")
    deploy_bundle(dist_dir, account_id, api_token)
    print(f"Live URL:       {LIVE_URL}/demos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
