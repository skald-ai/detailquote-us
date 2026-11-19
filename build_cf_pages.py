"""Build Cloudflare Pages output directory (dist-cf/) from DetailQuote-US sources."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = ROOT_DIR / "templates"
STATIC_DIR = ROOT_DIR / "static"
TENANTS_DIR = ROOT_DIR / "tenants"
WORKER_TEMPLATE = ROOT_DIR / "cloudflare" / "worker_template.js"
DIST_DIR = ROOT_DIR / "dist-cf"


def build() -> Path:
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    (DIST_DIR / "static").mkdir(parents=True, exist_ok=True)

    for item in STATIC_DIR.iterdir():
        if item.is_file():
            shutil.copy2(item, DIST_DIR / "static" / item.name)
    sw_src = STATIC_DIR / "sw.js"
    if sw_src.is_file():
        shutil.copy2(sw_src, DIST_DIR / "sw.js")

    templates = {}
    for tpl in sorted(TEMPLATES_DIR.glob("*.html")):
        templates[tpl.name] = tpl.read_text(encoding="utf-8")

    seed_tenants = {}
    for jf in sorted(TENANTS_DIR.glob("*.json")):
        if jf.stem == "template":
            continue
        data = json.loads(jf.read_text(encoding="utf-8"))
        seed_tenants[data["slug"]] = data

    worker_src = WORKER_TEMPLATE.read_text(encoding="utf-8")
    worker_src = worker_src.replace("__HTML_TEMPLATES__", json.dumps(templates, ensure_ascii=False))
    worker_src = worker_src.replace("__SEED_TENANTS__", json.dumps(seed_tenants, ensure_ascii=False))
    (DIST_DIR / "_worker.js").write_text(worker_src, encoding="utf-8")
    return DIST_DIR


if __name__ == "__main__":
    out = build()
    print(f"Built Cloudflare Pages bundle at {out} ({len(list(out.rglob('*')))} entries)")
