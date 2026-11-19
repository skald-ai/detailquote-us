from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
TENANTS_DIR = BASE_DIR / "tenants"
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = BASE_DIR / "uploads"
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"
DB_PATH = DATA_DIR / "detailquote.db"
SECRET_PATH = DATA_DIR / ".secret"

SLUG_RE = re.compile(r"^[a-z0-9-]+$")
ORDER_RE = re.compile(r"^DQ-[A-Z0-9]{6,12}$")
UPLOAD_FILE_RE = re.compile(r"^DQ-[A-Z0-9]{6,12}_[0-3]\.(jpg|png|webp)$")
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
ALLOWED_STATUSES = {"new", "quoted", "confirmed", "completed", "declined"}
PRIVATE_TENANT_KEYS = {"owner_pin", "telegram_bot_token", "telegram_chat_id", "webhook_url"}
MAX_PHOTOS = 4
MAX_PHOTO_BYTES = 1_500_000
TOKEN_TTL_SECONDS = 86_400

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("detailquote")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _get_signing_secret() -> bytes:
    env_secret = os.environ.get("DETAILQUOTE_SECRET", "").strip()
    if env_secret:
        return env_secret.encode("utf-8")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if SECRET_PATH.exists():
        raw = SECRET_PATH.read_text(encoding="utf-8").strip()
        if raw:
            return raw.encode("utf-8")
    generated = secrets.token_hex(32)
    SECRET_PATH.write_text(generated, encoding="utf-8")
    return generated.encode("utf-8")


def _db_connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    with _db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS leads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_code TEXT NOT NULL UNIQUE,
                tenant_slug TEXT NOT NULL,
                vehicle_id TEXT NOT NULL,
                vehicle_label TEXT NOT NULL,
                vehicle_model TEXT NOT NULL DEFAULT '',
                package_id TEXT NOT NULL,
                package_name TEXT NOT NULL,
                condition_id TEXT NOT NULL,
                condition_label TEXT NOT NULL,
                addons_json TEXT NOT NULL DEFAULT '[]',
                estimated_min INTEGER NOT NULL,
                estimated_max INTEGER NOT NULL,
                confirmed_price INTEGER,
                promo_unlocked INTEGER NOT NULL DEFAULT 0,
                promo_credit INTEGER NOT NULL DEFAULT 0,
                customer_name TEXT NOT NULL,
                customer_phone TEXT NOT NULL,
                service_address TEXT NOT NULL,
                preferred_date TEXT NOT NULL DEFAULT '',
                preferred_window TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                photos_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'new',
                scheduled_slot TEXT NOT NULL DEFAULT '',
                owner_note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_slug, created_at DESC)")
        count = conn.execute("SELECT COUNT(*) AS c FROM leads").fetchone()["c"]
        if count == 0:
            now = _utc_now_iso()
            seed_rows = [
                (
                    "DQ-7482AT",
                    "apex-austin",
                    "suv",
                    "SUV / Crossover",
                    "2022 Ford Bronco Wildtrak",
                    "full_detail",
                    "Full Interior & Exterior",
                    "heavy",
                    "Heavy soil / pet",
                    json.dumps([{"id": "pet_hair", "name": "Pet Hair Removal", "price": 55}]),
                    455,
                    515,
                    None,
                    0,
                    25,
                    "Marcus Vance",
                    "+1 (512) 555-0139",
                    "2410 Barton Hills Dr, Austin, TX 78704",
                    "2026-11-21",
                    "Morning (9:00 AM - 12:00 PM)",
                    "Golden retriever hair on rear cargo carpet, driveway has power & water.",
                    "[]",
                    "new",
                    "",
                    "",
                    now,
                    now,
                ),
                (
                    "DQ-6194SY",
                    "apex-austin",
                    "sedan",
                    "Sedan",
                    "2023 Tesla Model Y",
                    "ceramic_prep",
                    "1-Step Polish & Ceramic",
                    "moderate",
                    "Daily driver",
                    json.dumps([{"id": "ozone", "name": "Ozone Odor Treatment", "price": 65}]),
                    740,
                    840,
                    760,
                    1,
                    25,
                    "Sarah Chen",
                    "+1 (512) 555-0184",
                    "408 W 2nd St, Austin, TX 78701",
                    "2026-11-22",
                    "Afternoon (1:00 PM - 4:00 PM)",
                    "White seats need conditioning; covered garage bay available.",
                    "[]",
                    "confirmed",
                    "Sun Nov 22 · 1:00 PM",
                    "Includes $25 mobile booking credit applied at arrival.",
                    now,
                    now,
                ),
            ]
            conn.executemany(
                """
                INSERT INTO leads (
                    order_code, tenant_slug, vehicle_id, vehicle_label, vehicle_model,
                    package_id, package_name, condition_id, condition_label, addons_json,
                    estimated_min, estimated_max, confirmed_price, promo_unlocked, promo_credit,
                    customer_name, customer_phone, service_address, preferred_date, preferred_window,
                    notes, photos_json, status, scheduled_slot, owner_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                seed_rows,
            )
        conn.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="DetailQuote-US", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def validate_slug(slug: str) -> str:
    if not SLUG_RE.fullmatch(slug):
        raise HTTPException(status_code=400, detail="Invalid shop identifier")
    return slug


def load_tenant(slug: str) -> dict[str, Any]:
    validate_slug(slug)
    path = (TENANTS_DIR / f"{slug}.json").resolve()
    if path.parent != TENANTS_DIR.resolve() or not path.is_file():
        raise HTTPException(status_code=404, detail="Shop not found")
    return json.loads(path.read_text(encoding="utf-8"))


def save_tenant(slug: str, data: dict[str, Any]) -> None:
    validate_slug(slug)
    path = (TENANTS_DIR / f"{slug}.json").resolve()
    if path.parent != TENANTS_DIR.resolve():
        raise HTTPException(status_code=400, detail="Invalid shop path")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def sanitize_public_tenant(tenant: dict[str, Any]) -> dict[str, Any]:
    clean = {k: v for k, v in tenant.items() if k not in PRIVATE_TENANT_KEYS}
    clean["is_demo_pin"] = str(tenant.get("owner_pin", "")) == "2026"
    return clean


def calculate_quote(
    tenant: dict[str, Any],
    vehicle_id: str,
    package_id: str,
    condition_id: str,
    addon_ids: list[str],
) -> dict[str, Any]:
    vehicles = {v["id"]: v for v in tenant.get("vehicles", [])}
    packages = {p["id"]: p for p in tenant.get("packages", [])}
    conditions = {c["id"]: c for c in tenant.get("conditions", [])}
    addons_map = {a["id"]: a for a in tenant.get("addons", [])}

    vehicle = vehicles.get(vehicle_id)
    package = packages.get(package_id)
    condition = conditions.get(condition_id)
    if not vehicle or not package or not condition:
        raise HTTPException(status_code=400, detail="Invalid vehicle, package, or condition selection")

    chosen_addons: list[dict[str, Any]] = []
    seen_addons: set[str] = set()
    for aid in addon_ids:
        if aid in addons_map and aid not in seen_addons:
            seen_addons.add(aid)
            item = addons_map[aid]
            chosen_addons.append({"id": item["id"], "name": item["name"], "price": int(item["price"])})

    addons_total = sum(a["price"] for a in chosen_addons)
    base = round(float(package["base_price"]) * float(vehicle["multiplier"]) * float(condition["multiplier"])) + addons_total
    estimated_min = max(50, int(round((base * 0.95) / 5) * 5))
    estimated_max = max(estimated_min + 15, int(round((base * 1.08) / 5) * 5))

    return {
        "vehicle": vehicle,
        "package": package,
        "condition": condition,
        "addons": chosen_addons,
        "estimated_min": estimated_min,
        "estimated_max": estimated_max,
    }


def _detect_image_ext(raw: bytes) -> str | None:
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def save_photos(order_code: str, photos_b64: list[str]) -> list[str]:
    if len(photos_b64) > MAX_PHOTOS:
        raise HTTPException(status_code=400, detail=f"Up to {MAX_PHOTOS} photos are allowed")
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    saved_urls: list[str] = []
    for idx, payload in enumerate(photos_b64):
        if not isinstance(payload, str) or not payload.strip():
            continue
        encoded = payload.strip()
        if encoded.startswith("data:"):
            if "," not in encoded:
                raise HTTPException(status_code=400, detail="Malformed image data URL")
            encoded = encoded.split(",", 1)[1]
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid base64 image payload") from exc
        if len(raw) > MAX_PHOTO_BYTES:
            raise HTTPException(status_code=400, detail="Each photo must be under 1.5 MB")
        ext = _detect_image_ext(raw)
        if not ext:
            raise HTTPException(status_code=400, detail="Only JPEG, PNG, and WebP photos are supported")
        filename = f"{order_code}_{idx}.{ext}"
        target = (UPLOADS_DIR / filename).resolve()
        if target.parent != UPLOADS_DIR.resolve():
            raise HTTPException(status_code=400, detail="Invalid upload path")
        target.write_bytes(raw)
        saved_urls.append(f"/uploads/{filename}")
    return saved_urls


def _sign_owner_token(slug: str) -> str:
    expiry = int(time.time()) + TOKEN_TTL_SECONDS
    payload = f"{slug}:{expiry}"
    sig = hmac.new(_get_signing_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def verify_owner_token(slug: str, token: str | None) -> None:
    if not token:
        raise HTTPException(status_code=401, detail="Owner authorization required")
    parts = token.strip().split(":")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail="Invalid owner token")
    tok_slug, exp_str, tok_sig = parts
    if tok_slug != slug:
        raise HTTPException(status_code=403, detail="Token does not match this shop")
    try:
        expiry = int(exp_str)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Malformed owner token") from exc
    if expiry < int(time.time()):
        raise HTTPException(status_code=401, detail="Session expired, sign in again")
    expected_sig = hmac.new(_get_signing_secret(), f"{tok_slug}:{exp_str}".encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(tok_sig, expected_sig):
        raise HTTPException(status_code=401, detail="Invalid owner token signature")


def _row_to_lead(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "order_code": row["order_code"],
        "tenant_slug": row["tenant_slug"],
        "vehicle_id": row["vehicle_id"],
        "vehicle_label": row["vehicle_label"],
        "vehicle_model": row["vehicle_model"],
        "package_id": row["package_id"],
        "package_name": row["package_name"],
        "condition_id": row["condition_id"],
        "condition_label": row["condition_label"],
        "addons": json.loads(row["addons_json"] or "[]"),
        "estimated_min": row["estimated_min"],
        "estimated_max": row["estimated_max"],
        "confirmed_price": row["confirmed_price"],
        "promo_unlocked": bool(row["promo_unlocked"]),
        "promo_credit": row["promo_credit"],
        "customer_name": row["customer_name"],
        "customer_phone": row["customer_phone"],
        "service_address": row["service_address"],
        "preferred_date": row["preferred_date"],
        "preferred_window": row["preferred_window"],
        "notes": row["notes"],
        "photos": json.loads(row["photos_json"] or "[]"),
        "status": row["status"],
        "scheduled_slot": row["scheduled_slot"],
        "owner_note": row["owner_note"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def notify_owner(tenant: dict[str, Any], lead: dict[str, Any], base_url: str) -> None:
    bot_token = str(tenant.get("telegram_bot_token") or os.environ.get("DETAILQUOTE_TG_BOT_TOKEN") or "").strip()
    chat_id = str(tenant.get("telegram_chat_id") or os.environ.get("DETAILQUOTE_TG_CHAT_ID") or "").strip()
    webhook_url = str(tenant.get("webhook_url") or os.environ.get("DETAILQUOTE_WEBHOOK_URL") or "").strip()
    owner_url = f"{base_url.rstrip('/')}/s/{tenant['slug']}/owner"
    status_url = f"{base_url.rstrip('/')}/order/{lead['order_code']}"

    if bot_token and chat_id:
        lines = [
            f"New quote request · {tenant['shop_name']}",
            f"Order: {lead['order_code']}",
            f"Customer: {lead['customer_name']} ({lead['customer_phone']})",
            f"Vehicle: {lead['vehicle_label']} {lead['vehicle_model']}".strip(),
            f"Package: {lead['package_name']} ({lead['condition_label']})",
            f"Estimate: ${lead['estimated_min']} - ${lead['estimated_max']}",
            f"Address: {lead['service_address']}",
            f"Photos attached: {len(lead['photos'])}",
            f"Owner cabinet: {owner_url}",
            f"Customer link: {status_url}",
        ]
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    json={"chat_id": chat_id, "text": "\n".join(lines), "disable_web_page_preview": True},
                )
        except Exception as exc:
            logger.warning("Telegram notification failed for %s: %s", lead["order_code"], exc)

    if webhook_url:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(
                    webhook_url,
                    json={
                        "event": "lead.created",
                        "shop": tenant["slug"],
                        "lead": lead,
                        "owner_url": owner_url,
                        "status_url": status_url,
                    },
                )
        except Exception as exc:
            logger.warning("Webhook notification failed for %s: %s", lead["order_code"], exc)


def _render_template(filename: str, replacements: dict[str, str]) -> HTMLResponse:
    path = TEMPLATES_DIR / filename
    content = path.read_text(encoding="utf-8")
    for key, val in replacements.items():
        content = content.replace(key, val)
    return HTMLResponse(content)


def _safe_accent(raw: Any) -> str:
    val = str(raw or "").strip()
    return val if HEX_COLOR_RE.fullmatch(val) else "#e59934"


class LeadCreateIn(BaseModel):
    vehicle_id: str = Field(min_length=1, max_length=40)
    vehicle_model: str = Field(default="", max_length=120)
    package_id: str = Field(min_length=1, max_length=60)
    condition_id: str = Field(min_length=1, max_length=40)
    addon_ids: list[str] = Field(default_factory=list)
    customer_name: str = Field(min_length=2, max_length=100)
    customer_phone: str = Field(min_length=6, max_length=40)
    service_address: str = Field(min_length=4, max_length=200)
    preferred_date: str = Field(default="", max_length=40)
    preferred_window: str = Field(default="", max_length=60)
    notes: str = Field(default="", max_length=800)
    photos: list[str] = Field(default_factory=list)


class OwnerAuthIn(BaseModel):
    pin: str = Field(min_length=1, max_length=64)


class LeadPatchIn(BaseModel):
    status: str | None = None
    confirmed_price: int | None = Field(default=None, ge=0, le=50000)
    scheduled_slot: str | None = Field(default=None, max_length=120)
    owner_note: str | None = Field(default=None, max_length=600)


class PricingUpdateIn(BaseModel):
    promo_credit: int | None = Field(default=None, ge=0, le=1000)
    next_slot_label: str | None = Field(default=None, max_length=80)
    packages: dict[str, int] = Field(default_factory=dict)
    addons: dict[str, int] = Field(default_factory=dict)


@app.get("/")
def root(shop: str | None = None):
    if shop and SLUG_RE.fullmatch(shop) and (TENANTS_DIR / f"{shop}.json").is_file():
        return RedirectResponse(url=f"/s/{shop}", status_code=302)
    return RedirectResponse(url="/s/apex-austin", status_code=302)


@app.get("/demos", response_class=HTMLResponse)
def demos_page():
    return _render_template("directory.html", {})


@app.get("/s/{slug}", response_class=HTMLResponse)
def shop_pwa(slug: str):
    tenant = load_tenant(slug)
    return _render_template(
        "index.html",
        {
            "__TENANT_SLUG__": html.escape(tenant["slug"]),
            "__SHOP_NAME__": html.escape(tenant["shop_name"]),
            "__SHOP_TAGLINE__": html.escape(tenant.get("tagline", "")),
            "__ACCENT_COLOR__": _safe_accent(tenant.get("accent_color")),
        },
    )


@app.get("/s/{slug}/owner", response_class=HTMLResponse)
def owner_cabinet_page(slug: str):
    tenant = load_tenant(slug)
    return _render_template(
        "owner.html",
        {
            "__TENANT_SLUG__": html.escape(tenant["slug"]),
            "__SHOP_NAME__": html.escape(tenant["shop_name"]),
            "__ACCENT_COLOR__": _safe_accent(tenant.get("accent_color")),
        },
    )


@app.get("/order/{order_code}", response_class=HTMLResponse)
def order_status_page(order_code: str):
    code = order_code.strip().upper()
    if not ORDER_RE.fullmatch(code):
        raise HTTPException(status_code=404, detail="Order not found")
    with _db_connect() as conn:
        row = conn.execute("SELECT tenant_slug FROM leads WHERE order_code = ?", (code,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Order not found")
    tenant = load_tenant(row["tenant_slug"])
    return _render_template(
        "status.html",
        {
            "__ORDER_CODE__": html.escape(code),
            "__TENANT_SLUG__": html.escape(tenant["slug"]),
            "__SHOP_NAME__": html.escape(tenant["shop_name"]),
            "__ACCENT_COLOR__": _safe_accent(tenant.get("accent_color")),
        },
    )


@app.get("/s/{slug}/manifest.webmanifest")
def shop_manifest(slug: str):
    tenant = load_tenant(slug)
    manifest = {
        "name": f"{tenant['shop_name']} · Instant Quote",
        "short_name": tenant["shop_name"][:18],
        "start_url": f"/s/{tenant['slug']}",
        "scope": "/",
        "display": "standalone",
        "background_color": "#141415",
        "theme_color": "#141415",
        "icons": [
            {
                "src": "/static/icon.svg",
                "sizes": "any",
                "type": "image/svg+xml",
                "purpose": "any maskable",
            }
        ],
    }
    return JSONResponse(manifest, media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript")


@app.get("/uploads/{filename}")
def get_upload(filename: str):
    if not UPLOAD_FILE_RE.fullmatch(filename):
        raise HTTPException(status_code=404, detail="File not found")
    target = (UPLOADS_DIR / filename).resolve()
    if target.parent != UPLOADS_DIR.resolve() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(target)


@app.get("/api/tenants")
def list_tenants():
    items = []
    for file in sorted(TENANTS_DIR.glob("*.json")):
        if file.stem == "template":
            continue
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        items.append(
            {
                "slug": data.get("slug", file.stem),
                "shop_name": data.get("shop_name", file.stem),
                "city": data.get("city", ""),
                "state": data.get("state", ""),
                "phone": data.get("phone", ""),
                "instagram": data.get("instagram", ""),
                "website": data.get("website", ""),
                "accent_color": _safe_accent(data.get("accent_color")),
                "promo_credit": int(data.get("promo_credit", 0)),
                "next_slot_label": data.get("next_slot_label", ""),
                "package_count": len(data.get("packages", [])),
            }
        )
    return {"tenants": items}


@app.get("/api/tenants/{slug}")
def get_tenant(slug: str):
    return sanitize_public_tenant(load_tenant(slug))


@app.post("/api/tenants/{slug}/leads")
async def create_lead(slug: str, payload: LeadCreateIn, request: Request, background_tasks: BackgroundTasks):
    tenant = load_tenant(slug)
    quote = calculate_quote(
        tenant,
        payload.vehicle_id.strip(),
        payload.package_id.strip(),
        payload.condition_id.strip(),
        payload.addon_ids,
    )
    order_code = f"DQ-{secrets.token_hex(3).upper()}"
    photos = save_photos(order_code, payload.photos)
    now = _utc_now_iso()
    promo_credit = int(tenant.get("promo_credit", 0))

    with _db_connect() as conn:
        conn.execute(
            """
            INSERT INTO leads (
                order_code, tenant_slug, vehicle_id, vehicle_label, vehicle_model,
                package_id, package_name, condition_id, condition_label, addons_json,
                estimated_min, estimated_max, confirmed_price, promo_unlocked, promo_credit,
                customer_name, customer_phone, service_address, preferred_date, preferred_window,
                notes, photos_json, status, scheduled_slot, owner_note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '', '', ?, ?)
            """,
            (
                order_code,
                tenant["slug"],
                quote["vehicle"]["id"],
                quote["vehicle"]["label"],
                payload.vehicle_model.strip(),
                quote["package"]["id"],
                quote["package"]["name"],
                quote["condition"]["id"],
                quote["condition"]["label"],
                json.dumps(quote["addons"]),
                quote["estimated_min"],
                quote["estimated_max"],
                promo_credit,
                payload.customer_name.strip(),
                payload.customer_phone.strip(),
                payload.service_address.strip(),
                payload.preferred_date.strip(),
                payload.preferred_window.strip(),
                payload.notes.strip(),
                json.dumps(photos),
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM leads WHERE order_code = ?", (order_code,)).fetchone()

    lead_dict = _row_to_lead(row)
    base_url = str(request.base_url).rstrip("/")
    background_tasks.add_task(notify_owner, tenant, lead_dict, base_url)
    return {"order_code": order_code, "status_url": f"/order/{order_code}", "lead": lead_dict}


@app.get("/api/orders/{order_code}")
def get_order(order_code: str):
    code = order_code.strip().upper()
    if not ORDER_RE.fullmatch(code):
        raise HTTPException(status_code=404, detail="Order not found")
    with _db_connect() as conn:
        row = conn.execute("SELECT * FROM leads WHERE order_code = ?", (code,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Order not found")
    lead = _row_to_lead(row)
    tenant = sanitize_public_tenant(load_tenant(lead["tenant_slug"]))
    return {"order": lead, "shop": tenant}


@app.post("/api/orders/{order_code}/unlock-promo")
def unlock_order_promo(order_code: str):
    code = order_code.strip().upper()
    if not ORDER_RE.fullmatch(code):
        raise HTTPException(status_code=404, detail="Order not found")
    now = _utc_now_iso()
    with _db_connect() as conn:
        row = conn.execute("SELECT * FROM leads WHERE order_code = ?", (code,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Order not found")
        if not row["promo_unlocked"]:
            conn.execute(
                "UPDATE leads SET promo_unlocked = 1, updated_at = ? WHERE order_code = ?",
                (now, code),
            )
            conn.commit()
        updated = conn.execute("SELECT * FROM leads WHERE order_code = ?", (code,)).fetchone()
    return {"order": _row_to_lead(updated)}


@app.post("/api/tenants/{slug}/owner/auth")
def owner_auth(slug: str, payload: OwnerAuthIn):
    tenant = load_tenant(slug)
    expected_pin = str(tenant.get("owner_pin", "2026"))
    if not hmac.compare_digest(payload.pin.strip(), expected_pin):
        raise HTTPException(status_code=401, detail="Incorrect owner PIN")
    return {"token": _sign_owner_token(tenant["slug"]), "expires_in": TOKEN_TTL_SECONDS}


@app.get("/api/tenants/{slug}/owner/leads")
def owner_list_leads(slug: str, x_owner_token: str | None = Header(default=None)):
    tenant = load_tenant(slug)
    verify_owner_token(tenant["slug"], x_owner_token)
    with _db_connect() as conn:
        rows = conn.execute(
            "SELECT * FROM leads WHERE tenant_slug = ? ORDER BY created_at DESC, id DESC",
            (tenant["slug"],),
        ).fetchall()
    leads = [_row_to_lead(r) for r in rows]
    new_count = sum(1 for l in leads if l["status"] == "new")
    pipeline_value = sum(
        (l["confirmed_price"] if l["confirmed_price"] is not None else l["estimated_max"])
        for l in leads
        if l["status"] in {"new", "quoted"}
    )
    confirmed_revenue = sum(
        max(0, (l["confirmed_price"] if l["confirmed_price"] is not None else l["estimated_min"]) - (l["promo_credit"] if l["promo_unlocked"] else 0))
        for l in leads
        if l["status"] in {"confirmed", "completed"}
    )
    return {
        "leads": leads,
        "stats": {
            "new_count": new_count,
            "pipeline_value": pipeline_value,
            "confirmed_revenue": confirmed_revenue,
            "total_count": len(leads),
        },
        "shop": sanitize_public_tenant(tenant),
    }


@app.patch("/api/tenants/{slug}/owner/leads/{order_code}")
def owner_update_lead(
    slug: str,
    order_code: str,
    payload: LeadPatchIn,
    x_owner_token: str | None = Header(default=None),
):
    tenant = load_tenant(slug)
    verify_owner_token(tenant["slug"], x_owner_token)
    code = order_code.strip().upper()
    if not ORDER_RE.fullmatch(code):
        raise HTTPException(status_code=404, detail="Order not found")

    updates: list[str] = []
    params: list[Any] = []
    if payload.status is not None:
        st = payload.status.strip().lower()
        if st not in ALLOWED_STATUSES:
            raise HTTPException(status_code=400, detail="Unsupported status")
        updates.append("status = ?")
        params.append(st)
    if payload.confirmed_price is not None:
        updates.append("confirmed_price = ?")
        params.append(int(payload.confirmed_price))
    if payload.scheduled_slot is not None:
        updates.append("scheduled_slot = ?")
        params.append(payload.scheduled_slot.strip())
    if payload.owner_note is not None:
        updates.append("owner_note = ?")
        params.append(payload.owner_note.strip())

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates.append("updated_at = ?")
    params.append(_utc_now_iso())
    params.extend([code, tenant["slug"]])

    with _db_connect() as conn:
        cur = conn.execute(
            f"UPDATE leads SET {', '.join(updates)} WHERE order_code = ? AND tenant_slug = ?",
            params,
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Order not found for this shop")
        conn.commit()
        row = conn.execute("SELECT * FROM leads WHERE order_code = ?", (code,)).fetchone()
    return {"lead": _row_to_lead(row)}


@app.put("/api/tenants/{slug}/owner/pricing")
def owner_update_pricing(
    slug: str,
    payload: PricingUpdateIn,
    x_owner_token: str | None = Header(default=None),
):
    tenant = load_tenant(slug)
    verify_owner_token(tenant["slug"], x_owner_token)

    if payload.promo_credit is not None:
        tenant["promo_credit"] = int(payload.promo_credit)
    if payload.next_slot_label is not None and payload.next_slot_label.strip():
        tenant["next_slot_label"] = payload.next_slot_label.strip()
    for pkg in tenant.get("packages", []):
        if pkg["id"] in payload.packages:
            price = int(payload.packages[pkg["id"]])
            if price < 20 or price > 10000:
                raise HTTPException(status_code=400, detail=f"Invalid price for {pkg['id']}")
            pkg["base_price"] = price
    for addon in tenant.get("addons", []):
        if addon["id"] in payload.addons:
            price = int(payload.addons[addon["id"]])
            if price < 0 or price > 5000:
                raise HTTPException(status_code=400, detail=f"Invalid price for {addon['id']}")
            addon["price"] = price

    save_tenant(tenant["slug"], tenant)
    return {"shop": sanitize_public_tenant(tenant)}


if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8787")), reload=False)
