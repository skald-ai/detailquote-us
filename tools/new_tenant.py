"""Create a branded DetailQuote-US tenant config, optionally push live to Cloudflare D1, and print outreach messages."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

import httpx

ROOT_DIR = Path(__file__).resolve().parent.parent
TENANTS_DIR = ROOT_DIR / "tenants"
TEMPLATE_PATH = TENANTS_DIR / "template.json"


def load_local_env() -> dict[str, str]:
    values: dict[str, str] = {}
    env_file = ROOT_DIR / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            values[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in os.environ.items():
        values.setdefault(k, v)
    return values


def default_base_url() -> str:
    env = load_local_env()
    return env.get("DETAILQUOTE_LIVE_URL") or "https://detailquote-us.pages.dev"


def slugify(text: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return cleaned or "demo-shop"


def create_tenant_config(
    *,
    name: str,
    city: str,
    state: str,
    phone: str = "+1 (512) 555-0199",
    instagram: str = "",
    website: str = "",
    accent: str = "#e59934",
    interior: int | None = None,
    exterior: int | None = None,
    full: int | None = None,
    ceramic: int | None = None,
    promo: int | None = None,
    pin: str = "2026",
    slug: str | None = None,
    output_dir: Path | None = None,
) -> dict:
    data = json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))
    final_slug = slugify(slug or f"{name}-{city}")
    data["slug"] = final_slug
    data["shop_name"] = name.strip()
    data["city"] = city.strip()
    data["state"] = state.strip().upper()
    data["tagline"] = f"Instant estimates & driveway booking across {city.strip()}, {state.strip().upper()}"
    data["service_radius"] = f"25 mi around {city.strip()}, {state.strip().upper()}"
    data["phone"] = phone.strip()
    digits = re.sub(r"[^\d+]", "", phone)
    if digits and not digits.startswith("+"):
        digits = f"+1{digits}" if len(digits) == 10 else f"+{digits}"
    data["sms_phone"] = digits or "+15125550199"
    data["instagram"] = instagram.strip()
    data["website"] = website.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", accent.strip()):
        data["accent_color"] = accent.strip()
    data["owner_pin"] = str(pin).strip() or "2026"
    if promo is not None:
        data["promo_credit"] = int(promo)

    price_overrides = {
        "interior_reset": interior,
        "exterior_gloss": exterior,
        "full_detail": full,
        "ceramic_prep": ceramic,
    }
    for pkg in data.get("packages", []):
        override = price_overrides.get(pkg["id"])
        if override is not None:
            pkg["base_price"] = int(override)

    dest_dir = output_dir or TENANTS_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / f"{final_slug}.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    return data


def push_tenant_live(tenant: dict, base_url: str, admin_key: str | None = None) -> dict:
    env = load_local_env()
    key = (admin_key or env.get("DETAILQUOTE_ADMIN_KEY") or "").strip()
    if not key:
        raise RuntimeError("DETAILQUOTE_ADMIN_KEY is not set in environment or .env")
    proxy = env.get("HTTPS_PROXY") or env.get("HTTP_PROXY") or None
    endpoint = f"{base_url.rstrip('/')}/api/admin/tenants"
    with httpx.Client(timeout=15.0, proxy=proxy, follow_redirects=True) as client:
        resp = client.post(endpoint, headers={"X-Admin-Key": key}, json=tenant)
    if resp.status_code >= 400:
        raise RuntimeError(f"Push live failed ({resp.status_code}): {resp.text[:300]}")
    return resp.json()


def build_pitches(tenant: dict, base_url: str, gap_note: str | None = None) -> dict[str, str]:
    base = base_url.rstrip("/")
    demo_url = f"{base}/s/{tenant['slug']}"
    owner_url = f"{base}/s/{tenant['slug']}/owner"
    name = tenant["shop_name"]
    city = tenant["city"]
    gap_text = gap_note.strip() if gap_note else "car owners still have to call or message for a ballpark price"
    return {
        "instagram_dm": (
            f"Hey {name} team — saw your mobile detailing work in {city}. "
            f"Checked your site and noticed {gap_text.lower()}. "
            f"I mocked up a 60-second instant quote + photo booking page with {name}'s name and area here: {demo_url} "
            f"(owner cabinet: {owner_url}, PIN {tenant['owner_pin']}). Worth a 20-second look?"
        ),
        "sms": (
            f"Hi {name}, quick idea: checked your site and saw {gap_text.lower()}. "
            f"I built a live instant-quote & photo upload link tailored for your {city} mobile jobs ({demo_url}) "
            f"so customers send car photos + address before you call back. Happy to set it up on your domain if you like it."
        ),
        "cold_email": (
            f"Subject: Instant photo-quote page I built for {name}\n\n"
            f"Hi {name} team,\n\n"
            f"While checking {city} mobile detailers, I reviewed your website and noticed {gap_text.lower()} — meaning leads have to call or message back-and-forth just to share stain photos and get a range.\n\n"
            f"I put together a working mobile web app under {name}'s name here:\n"
            f"- Customer quote page: {demo_url}\n"
            f"- Owner dispatch cabinet (PIN {tenant['owner_pin']}): {owner_url}\n\n"
            f"Clients pick vehicle size, package, condition, attach up to 4 photos, and send you a clean work order you can confirm in 1 tap via SMS.\n"
            f"If you want it live with your exact prices and custom link, setup is $399 one-time + $49/mo hosting & updates. Should I customize the rates for you?"
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Create a new DetailQuote-US shop tenant and print outreach scripts.")
    ap.add_argument("--name", required=True, help="Business name, e.g. 'Lone Star Mobile Detail'")
    ap.add_argument("--city", required=True, help="City, e.g. 'Austin'")
    ap.add_argument("--state", required=True, help="2-letter state code, e.g. 'TX'")
    ap.add_argument("--phone", default="+1 (512) 555-0199")
    ap.add_argument("--instagram", default="")
    ap.add_argument("--website", default="")
    ap.add_argument("--accent", default="#e59934")
    ap.add_argument("--interior", type=int, default=None)
    ap.add_argument("--exterior", type=int, default=None)
    ap.add_argument("--full", type=int, default=None)
    ap.add_argument("--ceramic", type=int, default=None)
    ap.add_argument("--promo", type=int, default=None)
    ap.add_argument("--pin", default="2026")
    ap.add_argument("--slug", default=None)
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--push-live", action="store_true", help="Publish tenant directly to live Cloudflare D1 via /api/admin/tenants")
    args = ap.parse_args()

    base_url = (args.base_url or default_base_url()).rstrip("/")
    tenant = create_tenant_config(
        name=args.name,
        city=args.city,
        state=args.state,
        phone=args.phone,
        instagram=args.instagram,
        website=args.website,
        accent=args.accent,
        interior=args.interior,
        exterior=args.exterior,
        full=args.full,
        ceramic=args.ceramic,
        promo=args.promo,
        pin=args.pin,
        slug=args.slug,
    )
    if args.push_live:
        res = push_tenant_live(tenant, base_url)
        print(f"Pushed live:    {res.get('customer_url')}")

    pitches = build_pitches(tenant, base_url)
    print(f"Created tenant: {TENANTS_DIR / (tenant['slug'] + '.json')}")
    print(f"Customer PWA:   {base_url}/s/{tenant['slug']}")
    print(f"Owner Cabinet:  {base_url}/s/{tenant['slug']}/owner (PIN: {tenant['owner_pin']})")
    print("\n--- Instagram DM ---")
    print(pitches["instagram_dm"])
    print("\n--- SMS ---")
    print(pitches["sms"])
    print("\n--- Cold Email ---")
    print(pitches["cold_email"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
