"""Audit US mobile detailing websites for instant-quote gaps and optionally clone demos."""
from __future__ import annotations

import argparse
import csv
import re
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from bs4 import BeautifulSoup

from new_tenant import build_pitches, create_tenant_config, default_base_url, load_local_env, push_tenant_live

ROOT_DIR = Path(__file__).resolve().parent.parent

BOOKING_WIDGET_SIGNATURES = {
    "calendly.com": "Calendly",
    "housecallpro.com": "Housecall Pro",
    "getjobber.com": "Jobber",
    "orbisx": "OrbisX",
    "urable.com": "Urable",
    "bookingkoala": "BookingKoala",
    "square.site": "Square Booking",
    "squareup.com/appointments": "Square Appointments",
    "acuityscheduling": "Acuity",
    "setmore.com": "Setmore",
}

FRICTION_PHRASES = [
    "call for quote",
    "call for a quote",
    "call for pricing",
    "text for estimate",
    "text for quote",
    "dm for pricing",
    "dm for quote",
    "contact for pricing",
    "request a free estimate",
    "free estimate",
    "call us today",
]

US_PHONE_RE = re.compile(r"(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PRICE_RE = re.compile(r"\$(\d{2,4})(?:\.\d{2})?")


@dataclass
class ProspectInput:
    name: str
    url: str
    city: str = "Austin"
    state: str = "TX"
    phone: str = ""
    instagram: str = ""


def _guess_name_from_url(url: str) -> str:
    host = urlparse(url).netloc.lower()
    host = re.sub(r"^www\.", "", host)
    stem = host.split(".")[0] if host else "Mobile Detail"
    words = [w.capitalize() for w in re.split(r"[-_]+", stem) if w]
    return " ".join(words) or "Mobile Detail"


def search_duckduckgo_html(query: str, limit: int) -> list[ProspectInput]:
    """Lightweight HTML lookup on DuckDuckGo lite. Stops honestly if anti-bot challenge appears."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
    url = "https://html.duckduckgo.com/html/"
    env = load_local_env()
    proxy = env.get("HTTPS_PROXY") or env.get("HTTP_PROXY") or None
    try:
        with httpx.Client(timeout=15.0, follow_redirects=True, headers=headers, proxy=proxy) as client:
            resp = client.post(url, data={"q": query})
    except Exception as exc:
        print(f"[search] Network error querying DuckDuckGo HTML: {exc}")
        return []

    lower = resp.text.lower()
    if resp.status_code in {403, 429} or "captcha" in lower or "anomaly.js" in lower:
        print(
            "[search] Blocked by search engine anti-bot check / rate limit. "
            "Not bypassing challenges; pass --input <prospects.csv> or --urls <url1> <url2> directly."
        )
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    results: list[ProspectInput] = []
    seen_hosts: set[str] = set()
    skip_domains = {"yelp.com", "facebook.com", "instagram.com", "youtube.com", "tiktok.com", "angi.com", "thumbtack.com", "mapquest.com"}

    for a in soup.select("a.result__a"):
        href = a.get("href", "")
        if "uddg=" in href:
            parsed_q = parse_qs(urlparse(href).query)
            href = unquote(parsed_q.get("uddg", [href])[0])
        if not href.startswith(("http://", "https://")):
            continue
        host = urlparse(href).netloc.lower().lstrip("www.")
        if any(sd in host for sd in skip_domains) or host in seen_hosts:
            continue
        seen_hosts.add(host)
        title = a.get_text(" ", strip=True).split("|")[0].split("-")[0].strip()
        results.append(ProspectInput(name=title[:60] or _guess_name_from_url(href), url=href))
        if len(results) >= limit:
            break
    return results


def load_csv_inputs(csv_path: Path, limit: int) -> list[ProspectInput]:
    items: list[ProspectInput] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            url = (row.get("url") or row.get("website") or "").strip()
            if not url:
                continue
            if not url.startswith(("http://", "https://")):
                url = "https://" + url
            name = (row.get("name") or row.get("shop_name") or "").strip() or _guess_name_from_url(url)
            items.append(
                ProspectInput(
                    name=name,
                    url=url,
                    city=(row.get("city") or "Austin").strip(),
                    state=(row.get("state") or "TX").strip(),
                    phone=(row.get("phone") or "").strip(),
                    instagram=(row.get("instagram") or "").strip(),
                )
            )
            if len(items) >= limit:
                break
    return items


def audit_prospect(item: ProspectInput) -> dict:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
    env = load_local_env()
    proxy = env.get("HTTPS_PROXY") or env.get("HTTP_PROXY") or None
    t0 = time.perf_counter()
    try:
        with httpx.Client(timeout=12.0, follow_redirects=True, headers=headers, proxy=proxy) as client:
            resp = client.get(item.url)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
    except Exception as exc:
        return {
            "name": item.name,
            "url": item.url,
            "city": item.city,
            "state": item.state,
            "http_status": 0,
            "response_ms": 0,
            "has_viewport": False,
            "booking_widget": "unknown",
            "friction_phrases": "",
            "phone": item.phone,
            "email": "",
            "instagram": item.instagram,
            "sample_prices": "",
            "opportunity_score": 0,
            "gaps": f"Fetch failed: {exc}",
        }

    html_text = resp.text
    lower_html = html_text.lower()
    soup = BeautifulSoup(html_text, "html.parser")
    text = soup.get_text(" ", strip=True)
    lower_text = text.lower()

    has_viewport = bool(soup.find("meta", attrs={"name": re.compile(r"^viewport$", re.I)}))

    detected_widgets = [label for sig, label in BOOKING_WIDGET_SIGNATURES.items() if sig in lower_html]
    has_calculator_words = any(k in lower_text for k in ["instant quote", "calculate your price", "build your quote", "select vehicle"])
    booking_widget = ", ".join(detected_widgets) if detected_widgets else ("Custom calculator" if has_calculator_words else "None")

    matched_friction = [p for p in FRICTION_PHRASES if p in lower_text]

    phones = US_PHONE_RE.findall(text)
    phone = item.phone or (phones[0] if phones else "")
    emails = [e for e in EMAIL_RE.findall(text) if not e.lower().endswith((".png", ".jpg", ".webp"))]
    email = emails[0] if emails else ""

    ig = item.instagram
    if not ig:
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if "instagram.com/" in href.lower():
                handle = href.rstrip("/").split("/")[-1].split("?")[0]
                if handle and handle.lower() not in {"p", "reel", "explore"}:
                    ig = f"@{handle.lstrip('@')}"
                    break

    prices = [int(p) for p in PRICE_RE.findall(text) if 50 <= int(p) <= 2500]
    sample_prices = ", ".join(f"${p}" for p in sorted(set(prices))[:5])

    score = 0
    gaps: list[str] = []
    if booking_widget == "None":
        score += 45
        gaps.append("No instant quote or online booking widget detected")
    if matched_friction:
        score += 25
        gaps.append(f"Manual quote friction ({', '.join(matched_friction[:2])})")
    if not has_viewport:
        score += 15
        gaps.append("Missing mobile viewport meta tag")
    if not prices:
        score += 10
        gaps.append("No transparent package prices listed")
    if phone or ig or email:
        score += 5
    else:
        gaps.append("No clear phone/IG contact found")

    if resp.status_code >= 400:
        score = max(0, score - 40)
        gaps.append(f"HTTP {resp.status_code}")

    return {
        "name": item.name,
        "url": str(resp.url),
        "city": item.city,
        "state": item.state,
        "http_status": resp.status_code,
        "response_ms": elapsed_ms,
        "has_viewport": has_viewport,
        "booking_widget": booking_widget,
        "friction_phrases": "; ".join(matched_friction),
        "phone": phone,
        "email": email,
        "instagram": ig,
        "sample_prices": sample_prices,
        "opportunity_score": min(100, score),
        "gaps": "; ".join(gaps) if gaps else "Already has booking flow",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Audit US detailing prospect websites and generate personalized demos.")
    ap.add_argument("--input", type=Path, default=None, help="CSV file with columns: name,url,city,state,phone,instagram")
    ap.add_argument("--urls", nargs="*", default=[], help="One or more prospect website URLs")
    ap.add_argument("--search", default="", help="Optional DuckDuckGo HTML search query (may rate-limit)")
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--build-demos", action="store_true", help="Auto-create tenants/*.json for prospects scoring >= 50")
    ap.add_argument("--push-live", action="store_true", help="Also push built demos live to Cloudflare D1")
    ap.add_argument("--out-dir", type=Path, default=ROOT_DIR / "outreach")
    args = ap.parse_args()

    base_url = (args.base_url or default_base_url()).rstrip("/")
    prospects: list[ProspectInput] = []
    if args.input and args.input.is_file():
        prospects.extend(load_csv_inputs(args.input, args.limit))
    for u in args.urls:
        clean_u = u.strip()
        if not clean_u:
            continue
        if not clean_u.startswith(("http://", "https://")):
            clean_u = "https://" + clean_u
        prospects.append(ProspectInput(name=_guess_name_from_url(clean_u), url=clean_u))
    if args.search and len(prospects) < args.limit:
        prospects.extend(search_duckduckgo_html(args.search, args.limit - len(prospects)))

    prospects = prospects[: args.limit]
    if not prospects:
        print("No prospects to audit. Provide --urls <url...> or --input <file.csv>.")
        return 1

    results = [audit_prospect(p) for p in prospects]
    results.sort(key=lambda r: r["opportunity_score"], reverse=True)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    csv_out = args.out_dir / "audit_report.csv"
    fieldnames = [
        "opportunity_score",
        "name",
        "city",
        "state",
        "url",
        "http_status",
        "response_ms",
        "has_viewport",
        "booking_widget",
        "friction_phrases",
        "phone",
        "email",
        "instagram",
        "sample_prices",
        "gaps",
    ]
    with csv_out.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)

    md_lines = [
        "# DetailQuote-US Prospect Audit & Outreach Pack",
        "",
        f"Audited prospects: **{len(results)}** · Base demo URL: `{base_url}`",
        "",
    ]

    demos_created = 0
    demos_pushed = 0
    for r in results:
        md_lines.append(f"## {r['name']} — Score {r['opportunity_score']}/100")
        md_lines.append(f"- **URL:** {r['url']} (HTTP {r['http_status']}, {r['response_ms']} ms)")
        md_lines.append(f"- **Detected widget:** {r['booking_widget']} · **Mobile viewport:** {r['has_viewport']}")
        md_lines.append(f"- **Contacts:** phone `{r['phone'] or 'n/a'}` · email `{r['email'] or 'n/a'}` · IG `{r['instagram'] or 'n/a'}`")
        md_lines.append(f"- **Gaps:** {r['gaps']}")

        if args.build_demos and r["opportunity_score"] >= 50:
            tenant = create_tenant_config(
                name=r["name"],
                city=r["city"],
                state=r["state"],
                phone=r["phone"] or "+1 (512) 555-0199",
                instagram=r["instagram"],
                website=r["url"],
            )
            demos_created += 1
            if args.push_live:
                push_tenant_live(tenant, base_url)
                demos_pushed += 1
            pitches = build_pitches(tenant, base_url)
            md_lines.append(f"- **Personalized Demo:** `{base_url}/s/{tenant['slug']}` (Owner PIN `{tenant['owner_pin']}`)")
            md_lines.append("")
            md_lines.append("```text")
            md_lines.append(pitches["instagram_dm"])
            md_lines.append("```")
        else:
            md_lines.append("")
            md_lines.append("```text")
            md_lines.append(
                f"Hey {r['name']} team — checked {r['url']} and saw {r['gaps'].lower()}. "
                f"I mocked up a 60-second instant quote + photo booking page where car owners attach photos and get a price range before calling ({base_url}/s/apex-austin). Worth adapting to your pricing?"
            )
            md_lines.append("```")
        md_lines.append("")

    md_out = args.out_dir / "outreach_pack.md"
    md_out.write_text("\n".join(md_lines), encoding="utf-8")

    print(f"Audit CSV:      {csv_out}")
    print(f"Outreach Pack:  {md_out}")
    if args.build_demos:
        print(f"Demos created:  {demos_created}")
    if args.push_live:
        print(f"Demos pushed:   {demos_pushed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
