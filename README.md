<div align="center">

# ✦ DetailQuote-US

### Multi-tenant mobile detailing instant quote PWA, owner cabinet & US outreach engine

[![Stars](https://img.shields.io/github/stars/skald-ai/detailquote-us?style=for-the-badge&color=c4b5fd&labelColor=19152e)](https://github.com/skald-ai/detailquote-us/stargazers)
[![Forks](https://img.shields.io/github/forks/skald-ai/detailquote-us?style=for-the-badge&color=a5b4fc&labelColor=19152e)](https://github.com/skald-ai/detailquote-us/forks)
[![Issues](https://img.shields.io/github/issues/skald-ai/detailquote-us?style=for-the-badge&color=f0abfc&labelColor=19152e)](https://github.com/skald-ai/detailquote-us/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/skald-ai/detailquote-us?style=for-the-badge&color=c4b5fd&labelColor=19152e)](https://github.com/skald-ai/detailquote-us/pulls)

[Live Demo](https://detailquote-us.pages.dev/demos) · [Quick Start](#-quick-start) · [Stack](#-architecture--stack) · [Playbook](docs/PLAYBOOK.md) · [Issues](https://github.com/skald-ai/detailquote-us/issues)

</div>

---

## ✧ Overview

**DetailQuote-US** replaces slow "call or DM for a quote" back-and-forth for US mobile car detailers with a mobile-first PWA work-order builder. Car owners choose vehicle class, package, condition, and up to 4 photos, receive a live price range, and track their appointment on a real-time status page with a tactile wipe-to-reveal booking credit.

- **Agency Demo Hub:** [detailquote-us.pages.dev/demos](https://detailquote-us.pages.dev/demos)
- **Customer Quote PWA (Austin):** [detailquote-us.pages.dev/s/apex-austin](https://detailquote-us.pages.dev/s/apex-austin)
- **Customer Quote PWA (Miami):** [detailquote-us.pages.dev/s/harbor-miami](https://detailquote-us.pages.dev/s/harbor-miami)
- **Owner Dispatch Cabinet (Demo PIN `2026`):** [detailquote-us.pages.dev/s/apex-austin/owner](https://detailquote-us.pages.dev/s/apex-austin/owner)

---

## ✧ Architecture & Stack

| Layer | Implementation | Purpose |
| :--- | :--- | :--- |
| ◇ **Edge Production** | Cloudflare Pages `_worker.js` + Cloudflare D1 | Multi-tenant `/s/:slug` routing, photo storage & instant live demos |
| ◇ **Local Dev Parity** | Python FastAPI + SQLite (`app.py`) | Zero-dependency local debugging & offline testing |
| ◇ **Customer PWA** | Vanilla JS + CSS + SVG Vehicle Inspector + `<canvas>` | Sub-second load, 4-photo resize upload, wipe-to-reveal booking credit |
| ◇ **Owner Cabinet** | PIN + HMAC-SHA256 session token | Inspect photos, confirm exact price & slot, 1-tap `sms:` link & live tariffs |
| ◇ **Outreach Engine** | `tools/new_tenant.py` + `tools/prospect_audit.py` | Detect missing quote flows on prospect sites and push branded demos live |

---

## ✦ Quick Start

### 1 · Clone a branded live demo in 10 seconds

```powershell
python -X utf8 tools/new_tenant.py `
  --name "Lone Star Mobile Detail" `
  --city "Dallas" `
  --state "TX" `
  --phone "+1 (214) 555-0177" `
  --instagram "@lonestardetail" `
  --push-live
```

### 2 · Run locally (FastAPI + SQLite)

```powershell
pip install -r requirements.txt
python -X utf8 app.py
```

Open `http://127.0.0.1:8787/demos` to inspect all local tenant demos and the Owner Cabinet.

### 3 · Deploy updates to Cloudflare Pages + D1

```powershell
python -X utf8 deploy_cf.py
```

> [!NOTE]
> Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in your environment before running `deploy_cf.py`. Generated `DETAILQUOTE_SECRET` and `DETAILQUOTE_ADMIN_KEY` values stay in the gitignored `.env` file and are uploaded as encrypted Cloudflare Pages secrets.

---

## ✧ Outreach & Prospect Audit CLI

<details>
<summary>Audit US detailing websites and auto-publish personalized demos</summary>

```powershell
# Audit from a CSV (name,url,city,state,phone,instagram) and push demos >= 50 score live
python -X utf8 tools/prospect_audit.py --input prospects.csv --build-demos --push-live

# Audit explicit URLs
python -X utf8 tools/prospect_audit.py --urls https://example-detailer.com --build-demos --push-live
```

Generated reports are written to `outreach/audit_report.csv` and `outreach/outreach_pack.md`.

</details>

---

## ✧ Documentation

- [Operations, US Outreach & USD Payment Playbook (RU)](docs/PLAYBOOK.md)
