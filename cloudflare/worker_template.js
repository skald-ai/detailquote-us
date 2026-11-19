const HTML_TEMPLATES = __HTML_TEMPLATES__;
const SEED_TENANTS = __SEED_TENANTS__;

const SLUG_RE = /^[a-z0-9-]+$/;
const ORDER_RE = /^DQ-[A-Z0-9]{6,12}$/;
const UPLOAD_FILE_RE = /^DQ-[A-Z0-9]{6,12}_[0-3]\.(jpg|png|webp)$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_STATUSES = new Set(["new", "quoted", "confirmed", "completed", "declined"]);
const PRIVATE_TENANT_KEYS = new Set(["owner_pin", "telegram_bot_token", "telegram_chat_id", "webhook_url"]);
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 600_000;
const TOKEN_TTL_SECONDS = 86_400;

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

let schemaReady = false;

function utcNowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeAccent(raw) {
  const val = String(raw || "").trim();
  return HEX_COLOR_RE.test(val) ? val : "#e59934";
}

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SEC_HEADERS,
      ...extraHeaders,
    },
  });
}

function htmlResp(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...SEC_HEADERS,
    },
  });
}

function errResp(status, detail) {
  return jsonResp({ detail }, status);
}

function renderTemplate(name, replacements = {}) {
  let out = HTML_TEMPLATES[name] || "";
  for (const [k, v] of Object.entries(replacements)) {
    out = out.replaceAll(k, v);
  }
  return htmlResp(out, 200);
}

function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a || ""));
  const bb = enc.encode(String(b || ""));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

async function hmacHex(secret, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signOwnerToken(secret, slug) {
  const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${slug}:${expiry}`;
  const sig = await hmacHex(secret, payload);
  return `${payload}:${sig}`;
}

async function verifyOwnerToken(secret, slug, token) {
  if (!token) return { ok: false, status: 401, detail: "Owner authorization required" };
  const parts = String(token).trim().split(":");
  if (parts.length !== 3) return { ok: false, status: 401, detail: "Invalid owner token" };
  const [tokSlug, expStr, tokSig] = parts;
  if (tokSlug !== slug) return { ok: false, status: 403, detail: "Token does not match this shop" };
  const expiry = Number.parseInt(expStr, 10);
  if (!Number.isFinite(expiry)) return { ok: false, status: 401, detail: "Malformed owner token" };
  if (expiry < Math.floor(Date.now() / 1000)) return { ok: false, status: 401, detail: "Session expired, sign in again" };
  const expectedSig = await hmacHex(secret, `${tokSlug}:${expStr}`);
  if (!constantTimeEqual(tokSig, expectedSig)) {
    return { ok: false, status: 401, detail: "Invalid owner token signature" };
  }
  return { ok: true };
}

function requireAdmin(request, env) {
  const adminKey = String(env.DETAILQUOTE_ADMIN_KEY || "").trim();
  if (!adminKey) return { ok: false, status: 503, detail: "Admin API key not configured" };
  const provided = request.headers.get("X-Admin-Key") || "";
  if (!constantTimeEqual(provided, adminKey)) {
    return { ok: false, status: 401, detail: "Invalid admin key" };
  }
  return { ok: true };
}

function sanitizePublicTenant(tenant) {
  const clean = {};
  for (const [k, v] of Object.entries(tenant || {})) {
    if (!PRIVATE_TENANT_KEYS.has(k)) clean[k] = v;
  }
  clean.is_demo_pin = String(tenant?.owner_pin || "") === "2026";
  return clean;
}

function rowToLead(row) {
  return {
    order_code: row.order_code,
    tenant_slug: row.tenant_slug,
    vehicle_id: row.vehicle_id,
    vehicle_label: row.vehicle_label,
    vehicle_model: row.vehicle_model || "",
    package_id: row.package_id,
    package_name: row.package_name,
    condition_id: row.condition_id,
    condition_label: row.condition_label,
    addons: JSON.parse(row.addons_json || "[]"),
    estimated_min: Number(row.estimated_min),
    estimated_max: Number(row.estimated_max),
    confirmed_price: row.confirmed_price === null || row.confirmed_price === undefined ? null : Number(row.confirmed_price),
    promo_unlocked: Boolean(row.promo_unlocked),
    promo_credit: Number(row.promo_credit || 0),
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    service_address: row.service_address,
    preferred_date: row.preferred_date || "",
    preferred_window: row.preferred_window || "",
    notes: row.notes || "",
    photos: JSON.parse(row.photos_json || "[]"),
    status: row.status,
    scheduled_slot: row.scheduled_slot || "",
    owner_note: row.owner_note || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS tenants (
        slug TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS leads (
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
      )`
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_slug, created_at DESC)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS lead_photos (
        filename TEXT PRIMARY KEY,
        order_code TEXT NOT NULL,
        content_type TEXT NOT NULL,
        data_b64 TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    ),
  ]);

  const now = utcNowIso();
  const tenantCntRow = await db.prepare("SELECT COUNT(*) AS c FROM tenants").first();
  if (!tenantCntRow || Number(tenantCntRow.c) === 0) {
    const inserts = Object.values(SEED_TENANTS).map((t) =>
      db
        .prepare("INSERT OR IGNORE INTO tenants (slug, config_json, updated_at) VALUES (?, ?, ?)")
        .bind(t.slug, JSON.stringify(t), now)
    );
    if (inserts.length) await db.batch(inserts);
  }

  const leadCntRow = await db.prepare("SELECT COUNT(*) AS c FROM leads").first();
  if (!leadCntRow || Number(leadCntRow.c) === 0) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO leads (
        order_code, tenant_slug, vehicle_id, vehicle_label, vehicle_model,
        package_id, package_name, condition_id, condition_label, addons_json,
        estimated_min, estimated_max, confirmed_price, promo_unlocked, promo_credit,
        customer_name, customer_phone, service_address, preferred_date, preferred_window,
        notes, photos_json, status, scheduled_slot, owner_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await db.batch([
      stmt.bind(
        "DQ-7482AT",
        "apex-austin",
        "suv",
        "SUV / Crossover",
        "2022 Ford Bronco Wildtrak",
        "full_detail",
        "Full Interior & Exterior",
        "heavy",
        "Heavy soil / pet",
        JSON.stringify([{ id: "pet_hair", name: "Pet Hair Removal", price: 55 }]),
        455,
        515,
        null,
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
        now
      ),
      stmt.bind(
        "DQ-6194SY",
        "apex-austin",
        "sedan",
        "Sedan",
        "2023 Tesla Model Y",
        "ceramic_prep",
        "1-Step Polish & Ceramic",
        "moderate",
        "Daily driver",
        JSON.stringify([{ id: "ozone", name: "Ozone Odor Treatment", price: 65 }]),
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
        now
      ),
    ]);
  }
  schemaReady = true;
}

async function loadTenant(db, slug) {
  if (!SLUG_RE.test(slug)) return null;
  const row = await db.prepare("SELECT config_json FROM tenants WHERE slug = ?").bind(slug).first();
  if (!row) return null;
  return JSON.parse(row.config_json);
}

async function saveTenant(db, slug, data) {
  await db
    .prepare(
      `INSERT INTO tenants (slug, config_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
    )
    .bind(slug, JSON.stringify(data), utcNowIso())
    .run();
}

function calculateQuote(tenant, vehicleId, packageId, conditionId, addonIds) {
  const vehicles = new Map((tenant.vehicles || []).map((v) => [v.id, v]));
  const packages = new Map((tenant.packages || []).map((p) => [p.id, p]));
  const conditions = new Map((tenant.conditions || []).map((c) => [c.id, c]));
  const addonsMap = new Map((tenant.addons || []).map((a) => [a.id, a]));

  const vehicle = vehicles.get(vehicleId);
  const pkg = packages.get(packageId);
  const condition = conditions.get(conditionId);
  if (!vehicle || !pkg || !condition) {
    return { error: "Invalid vehicle, package, or condition selection" };
  }

  const chosenAddons = [];
  const seen = new Set();
  for (const aid of Array.isArray(addonIds) ? addonIds : []) {
    if (addonsMap.has(aid) && !seen.has(aid)) {
      seen.add(aid);
      const item = addonsMap.get(aid);
      chosenAddons.push({ id: item.id, name: item.name, price: Number(item.price) });
    }
  }
  const addonsTotal = chosenAddons.reduce((sum, a) => sum + a.price, 0);
  const base = Math.round(Number(pkg.base_price) * Number(vehicle.multiplier) * Number(condition.multiplier)) + addonsTotal;
  const estimated_min = Math.max(50, Math.round((base * 0.95) / 5) * 5);
  const estimated_max = Math.max(estimated_min + 15, Math.round((base * 1.08) / 5) * 5);
  return { vehicle, package: pkg, condition, addons: chosenAddons, estimated_min, estimated_max };
}

function decodeBase64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function detectImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { ext: "png", contentType: "image/png" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}

function generateOrderCode() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `DQ-${hex}`;
}

async function notifyOwner(env, tenant, lead, origin) {
  const botToken = String(tenant.telegram_bot_token || env.DETAILQUOTE_TG_BOT_TOKEN || "").trim();
  const chatId = String(tenant.telegram_chat_id || env.DETAILQUOTE_TG_CHAT_ID || "").trim();
  const webhookUrl = String(tenant.webhook_url || env.DETAILQUOTE_WEBHOOK_URL || "").trim();
  const ownerUrl = `${origin}/s/${tenant.slug}/owner`;
  const statusUrl = `${origin}/order/${lead.order_code}`;

  if (botToken && chatId) {
    const lines = [
      `New quote request · ${tenant.shop_name}`,
      `Order: ${lead.order_code}`,
      `Customer: ${lead.customer_name} (${lead.customer_phone})`,
      `Vehicle: ${lead.vehicle_label} ${lead.vehicle_model}`.trim(),
      `Package: ${lead.package_name} (${lead.condition_label})`,
      `Estimate: $${lead.estimated_min} - $${lead.estimated_max}`,
      `Address: ${lead.service_address}`,
      `Photos attached: ${lead.photos.length}`,
      `Owner cabinet: ${ownerUrl}`,
      `Customer link: ${statusUrl}`,
    ];
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), disable_web_page_preview: true }),
      });
    } catch {
      // Non-blocking notification failure
    }
  }

  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "lead.created",
          shop: tenant.slug,
          lead,
          owner_url: ownerUrl,
          status_url: statusUrl,
        }),
      });
    } catch {
      // Non-blocking notification failure
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const rawPath = url.pathname;
    const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
    const method = request.method.toUpperCase();

    if (path.startsWith("/static/") || path === "/sw.js") {
      if (path === "/sw.js") {
        const assetReq = new Request(new URL("/static/sw.js", url.origin), request);
        const res = await env.ASSETS.fetch(assetReq);
        const headers = new Headers(res.headers);
        headers.set("Service-Worker-Allowed", "/");
        headers.set("Content-Type", "application/javascript; charset=utf-8");
        return new Response(res.body, { status: res.status, headers });
      }
      return env.ASSETS.fetch(request);
    }

    if (!env.DB) {
      return errResp(500, "D1 database binding (DB) is not configured");
    }
    await ensureSchema(env.DB);
    const signingSecret = String(env.DETAILQUOTE_SECRET || "detailquote-fallback-dev-secret");

    if (method === "GET" && path === "/") {
      const shop = url.searchParams.get("shop") || "";
      if (shop && SLUG_RE.test(shop)) {
        const found = await loadTenant(env.DB, shop);
        if (found) return Response.redirect(`${url.origin}/s/${shop}`, 302);
      }
      return Response.redirect(`${url.origin}/s/apex-austin`, 302);
    }

    if (method === "GET" && path === "/demos") {
      return renderTemplate("directory.html");
    }

    let m = path.match(/^\/s\/([a-z0-9-]+)$/);
    if (method === "GET" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      return renderTemplate("index.html", {
        __TENANT_SLUG__: escapeHtml(tenant.slug),
        __SHOP_NAME__: escapeHtml(tenant.shop_name),
        __SHOP_TAGLINE__: escapeHtml(tenant.tagline || ""),
        __ACCENT_COLOR__: safeAccent(tenant.accent_color),
      });
    }

    m = path.match(/^\/s\/([a-z0-9-]+)\/owner$/);
    if (method === "GET" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      return renderTemplate("owner.html", {
        __TENANT_SLUG__: escapeHtml(tenant.slug),
        __SHOP_NAME__: escapeHtml(tenant.shop_name),
        __ACCENT_COLOR__: safeAccent(tenant.accent_color),
      });
    }

    m = path.match(/^\/s\/([a-z0-9-]+)\/manifest\.webmanifest$/);
    if (method === "GET" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      return jsonResp(
        {
          name: `${tenant.shop_name} · Instant Quote`,
          short_name: String(tenant.shop_name || "").slice(0, 18),
          start_url: `/s/${tenant.slug}`,
          scope: "/",
          display: "standalone",
          background_color: "#141415",
          theme_color: "#141415",
          icons: [
            {
              src: "/static/icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any maskable",
            },
          ],
        },
        200,
        { "Content-Type": "application/manifest+json; charset=utf-8" }
      );
    }

    m = path.match(/^\/order\/([a-zA-Z0-9-]+)$/);
    if (method === "GET" && m) {
      const code = m[1].toUpperCase();
      if (!ORDER_RE.test(code)) return errResp(404, "Order not found");
      const leadRow = await env.DB.prepare("SELECT tenant_slug FROM leads WHERE order_code = ?").bind(code).first();
      if (!leadRow) return errResp(404, "Order not found");
      const tenant = await loadTenant(env.DB, leadRow.tenant_slug);
      if (!tenant) return errResp(404, "Shop not found");
      return renderTemplate("status.html", {
        __ORDER_CODE__: escapeHtml(code),
        __TENANT_SLUG__: escapeHtml(tenant.slug),
        __SHOP_NAME__: escapeHtml(tenant.shop_name),
        __ACCENT_COLOR__: safeAccent(tenant.accent_color),
      });
    }

    m = path.match(/^\/uploads\/([A-Za-z0-9_.-]+)$/);
    if (method === "GET" && m) {
      const filename = m[1];
      if (!UPLOAD_FILE_RE.test(filename)) return errResp(404, "File not found");
      const row = await env.DB.prepare("SELECT content_type, data_b64 FROM lead_photos WHERE filename = ?")
        .bind(filename)
        .first();
      if (!row) return errResp(404, "File not found");
      const bytes = decodeBase64ToBytes(row.data_b64);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": row.content_type,
          "Cache-Control": "public, max-age=86400",
          ...SEC_HEADERS,
        },
      });
    }

    if (method === "GET" && path === "/api/tenants") {
      const res = await env.DB.prepare("SELECT config_json FROM tenants ORDER BY slug ASC").all();
      const items = [];
      for (const row of res.results || []) {
        const data = JSON.parse(row.config_json);
        if (data.slug === "template") continue;
        items.push({
          slug: data.slug,
          shop_name: data.shop_name,
          city: data.city || "",
          state: data.state || "",
          phone: data.phone || "",
          instagram: data.instagram || "",
          website: data.website || "",
          accent_color: safeAccent(data.accent_color),
          promo_credit: Number(data.promo_credit || 0),
          next_slot_label: data.next_slot_label || "",
          package_count: (data.packages || []).length,
        });
      }
      return jsonResp({ tenants: items });
    }

    m = path.match(/^\/api\/tenants\/([a-z0-9-]+)$/);
    if (method === "GET" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      return jsonResp(sanitizePublicTenant(tenant));
    }

    m = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/leads$/);
    if (method === "POST" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      let payload;
      try {
        payload = await request.json();
      } catch {
        return errResp(400, "Invalid JSON payload");
      }

      const customerName = String(payload.customer_name || "").trim();
      const customerPhone = String(payload.customer_phone || "").trim();
      const serviceAddress = String(payload.service_address || "").trim();
      if (customerName.length < 2 || customerPhone.length < 6 || serviceAddress.length < 4) {
        return errResp(400, "Customer name, phone, and service address are required");
      }

      const quote = calculateQuote(
        tenant,
        String(payload.vehicle_id || "").trim(),
        String(payload.package_id || "").trim(),
        String(payload.condition_id || "").trim(),
        payload.addon_ids || []
      );
      if (quote.error) return errResp(400, quote.error);

      const photosIn = Array.isArray(payload.photos) ? payload.photos : [];
      if (photosIn.length > MAX_PHOTOS) return errResp(400, `Up to ${MAX_PHOTOS} photos are allowed`);

      const orderCode = generateOrderCode();
      const now = utcNowIso();
      const savedPhotoUrls = [];
      const photoStmts = [];

      for (let idx = 0; idx < photosIn.length; idx += 1) {
        const rawStr = String(photosIn[idx] || "").trim();
        if (!rawStr) continue;
        let encoded = rawStr;
        if (encoded.startsWith("data:")) {
          const comma = encoded.indexOf(",");
          if (comma === -1) return errResp(400, "Malformed image data URL");
          encoded = encoded.slice(comma + 1);
        }
        let bytes;
        try {
          bytes = decodeBase64ToBytes(encoded);
        } catch {
          return errResp(400, "Invalid base64 image payload");
        }
        if (bytes.length > MAX_PHOTO_BYTES) {
          return errResp(400, "Each photo must be under 600 KB");
        }
        const detected = detectImageType(bytes);
        if (!detected) {
          return errResp(400, "Only JPEG, PNG, and WebP photos are supported");
        }
        const filename = `${orderCode}_${idx}.${detected.ext}`;
        savedPhotoUrls.push(`/uploads/${filename}`);
        photoStmts.push(
          env.DB.prepare(
            "INSERT INTO lead_photos (filename, order_code, content_type, data_b64, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(filename, orderCode, detected.contentType, encoded, now)
        );
      }

      const promoCredit = Number(tenant.promo_credit || 0);
      const leadStmt = env.DB.prepare(
        `INSERT INTO leads (
          order_code, tenant_slug, vehicle_id, vehicle_label, vehicle_model,
          package_id, package_name, condition_id, condition_label, addons_json,
          estimated_min, estimated_max, confirmed_price, promo_unlocked, promo_credit,
          customer_name, customer_phone, service_address, preferred_date, preferred_window,
          notes, photos_json, status, scheduled_slot, owner_note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '', '', ?, ?)`
      ).bind(
        orderCode,
        tenant.slug,
        quote.vehicle.id,
        quote.vehicle.label,
        String(payload.vehicle_model || "").trim().slice(0, 120),
        quote.package.id,
        quote.package.name,
        quote.condition.id,
        quote.condition.label,
        JSON.stringify(quote.addons),
        quote.estimated_min,
        quote.estimated_max,
        promoCredit,
        customerName.slice(0, 100),
        customerPhone.slice(0, 40),
        serviceAddress.slice(0, 200),
        String(payload.preferred_date || "").trim().slice(0, 40),
        String(payload.preferred_window || "").trim().slice(0, 60),
        String(payload.notes || "").trim().slice(0, 800),
        JSON.stringify(savedPhotoUrls),
        now,
        now
      );

      await env.DB.batch([...photoStmts, leadStmt]);
      const inserted = await env.DB.prepare("SELECT * FROM leads WHERE order_code = ?").bind(orderCode).first();
      const leadObj = rowToLead(inserted);
      ctx.waitUntil(notifyOwner(env, tenant, leadObj, url.origin));
      return jsonResp({ order_code: orderCode, status_url: `/order/${orderCode}`, lead: leadObj });
    }

    m = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)$/);
    if (method === "GET" && m) {
      const code = m[1].toUpperCase();
      if (!ORDER_RE.test(code)) return errResp(404, "Order not found");
      const row = await env.DB.prepare("SELECT * FROM leads WHERE order_code = ?").bind(code).first();
      if (!row) return errResp(404, "Order not found");
      const lead = rowToLead(row);
      const tenant = await loadTenant(env.DB, lead.tenant_slug);
      if (!tenant) return errResp(404, "Shop not found");
      return jsonResp({ order: lead, shop: sanitizePublicTenant(tenant) });
    }

    m = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/unlock-promo$/);
    if (method === "POST" && m) {
      const code = m[1].toUpperCase();
      if (!ORDER_RE.test(code)) return errResp(404, "Order not found");
      const row = await env.DB.prepare("SELECT * FROM leads WHERE order_code = ?").bind(code).first();
      if (!row) return errResp(404, "Order not found");
      if (!row.promo_unlocked) {
        await env.DB.prepare("UPDATE leads SET promo_unlocked = 1, updated_at = ? WHERE order_code = ?")
          .bind(utcNowIso(), code)
          .run();
      }
      const updated = await env.DB.prepare("SELECT * FROM leads WHERE order_code = ?").bind(code).first();
      return jsonResp({ order: rowToLead(updated) });
    }

    m = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/owner\/auth$/);
    if (method === "POST" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      let payload;
      try {
        payload = await request.json();
      } catch {
        return errResp(400, "Invalid JSON payload");
      }
      const expectedPin = String(tenant.owner_pin || "2026");
      if (!constantTimeEqual(String(payload.pin || "").trim(), expectedPin)) {
        return errResp(401, "Incorrect owner PIN");
      }
      const token = await signOwnerToken(signingSecret, tenant.slug);
      return jsonResp({ token, expires_in: TOKEN_TTL_SECONDS });
    }

    m = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/owner\/leads$/);
    if (method === "GET" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      const auth = await verifyOwnerToken(signingSecret, tenant.slug, request.headers.get("X-Owner-Token"));
      if (!auth.ok) return errResp(auth.status, auth.detail);

      const res = await env.DB.prepare(
        "SELECT * FROM leads WHERE tenant_slug = ? ORDER BY created_at DESC, id DESC"
      )
        .bind(tenant.slug)
        .all();
      const leads = (res.results || []).map(rowToLead);
      const newCount = leads.filter((l) => l.status === "new").length;
      const pipelineValue = leads
        .filter((l) => l.status === "new" || l.status === "quoted")
        .reduce((acc, l) => acc + (l.confirmed_price !== null ? l.confirmed_price : l.estimated_max), 0);
      const confirmedRevenue = leads
        .filter((l) => l.status === "confirmed" || l.status === "completed")
        .reduce((acc, l) => {
          const base = l.confirmed_price !== null ? l.confirmed_price : l.estimated_min;
          const credit = l.promo_unlocked ? l.promo_credit : 0;
          return acc + Math.max(0, base - credit);
        }, 0);

      return jsonResp({
        leads,
        stats: {
          new_count: newCount,
          pipeline_value: pipelineValue,
          confirmed_revenue: confirmedRevenue,
          total_count: leads.length,
        },
        shop: sanitizePublicTenant(tenant),
      });
    }

    m = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/owner\/leads\/([a-zA-Z0-9-]+)$/);
    if (method === "PATCH" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      const auth = await verifyOwnerToken(signingSecret, tenant.slug, request.headers.get("X-Owner-Token"));
      if (!auth.ok) return errResp(auth.status, auth.detail);

      const code = m[2].toUpperCase();
      if (!ORDER_RE.test(code)) return errResp(404, "Order not found");
      let payload;
      try {
        payload = await request.json();
      } catch {
        return errResp(400, "Invalid JSON payload");
      }

      const updates = [];
      const params = [];
      if (payload.status !== undefined && payload.status !== null) {
        const st = String(payload.status).trim().toLowerCase();
        if (!ALLOWED_STATUSES.has(st)) return errResp(400, "Unsupported status");
        updates.push("status = ?");
        params.push(st);
      }
      if (payload.confirmed_price !== undefined && payload.confirmed_price !== null) {
        const cp = Number(payload.confirmed_price);
        if (!Number.isFinite(cp) || cp < 0 || cp > 50000) return errResp(400, "Invalid confirmed price");
        updates.push("confirmed_price = ?");
        params.push(Math.round(cp));
      }
      if (payload.scheduled_slot !== undefined && payload.scheduled_slot !== null) {
        updates.push("scheduled_slot = ?");
        params.push(String(payload.scheduled_slot).trim().slice(0, 120));
      }
      if (payload.owner_note !== undefined && payload.owner_note !== null) {
        updates.push("owner_note = ?");
        params.push(String(payload.owner_note).trim().slice(0, 600));
      }
      if (!updates.length) return errResp(400, "No fields to update");

      updates.push("updated_at = ?");
      params.push(utcNowIso(), code, tenant.slug);
      const updRes = await env.DB.prepare(
        `UPDATE leads SET ${updates.join(", ")} WHERE order_code = ? AND tenant_slug = ?`
      )
        .bind(...params)
        .run();
      if (!updRes.meta || updRes.meta.changes === 0) {
        return errResp(404, "Order not found for this shop");
      }
      const updated = await env.DB.prepare("SELECT * FROM leads WHERE order_code = ?").bind(code).first();
      return jsonResp({ lead: rowToLead(updated) });
    }

    m = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/owner\/pricing$/);
    if (method === "PUT" && m) {
      const tenant = await loadTenant(env.DB, m[1]);
      if (!tenant) return errResp(404, "Shop not found");
      const auth = await verifyOwnerToken(signingSecret, tenant.slug, request.headers.get("X-Owner-Token"));
      if (!auth.ok) return errResp(auth.status, auth.detail);

      let payload;
      try {
        payload = await request.json();
      } catch {
        return errResp(400, "Invalid JSON payload");
      }

      if (payload.promo_credit !== undefined && payload.promo_credit !== null) {
        const pc = Number(payload.promo_credit);
        if (!Number.isFinite(pc) || pc < 0 || pc > 1000) return errResp(400, "Invalid promo credit");
        tenant.promo_credit = Math.round(pc);
      }
      if (payload.next_slot_label && String(payload.next_slot_label).trim()) {
        tenant.next_slot_label = String(payload.next_slot_label).trim().slice(0, 80);
      }
      const pkgUpdates = payload.packages || {};
      for (const pkg of tenant.packages || []) {
        if (Object.prototype.hasOwnProperty.call(pkgUpdates, pkg.id)) {
          const price = Number(pkgUpdates[pkg.id]);
          if (!Number.isFinite(price) || price < 20 || price > 10000) {
            return errResp(400, `Invalid price for ${pkg.id}`);
          }
          pkg.base_price = Math.round(price);
        }
      }
      const addonUpdates = payload.addons || {};
      for (const addon of tenant.addons || []) {
        if (Object.prototype.hasOwnProperty.call(addonUpdates, addon.id)) {
          const price = Number(addonUpdates[addon.id]);
          if (!Number.isFinite(price) || price < 0 || price > 5000) {
            return errResp(400, `Invalid price for ${addon.id}`);
          }
          addon.price = Math.round(price);
        }
      }

      await saveTenant(env.DB, tenant.slug, tenant);
      return jsonResp({ shop: sanitizePublicTenant(tenant) });
    }

    if (method === "POST" && path === "/api/admin/tenants") {
      const adm = requireAdmin(request, env);
      if (!adm.ok) return errResp(adm.status, adm.detail);
      let tenant;
      try {
        tenant = await request.json();
      } catch {
        return errResp(400, "Invalid JSON payload");
      }
      const slug = String(tenant.slug || "").trim();
      if (!SLUG_RE.test(slug) || slug === "template") {
        return errResp(400, "Invalid tenant slug");
      }
      if (!tenant.shop_name || !Array.isArray(tenant.packages) || !Array.isArray(tenant.vehicles)) {
        return errResp(400, "Tenant JSON missing required fields (shop_name, vehicles, packages)");
      }
      await saveTenant(env.DB, slug, tenant);
      return jsonResp({ ok: true, slug, customer_url: `${url.origin}/s/${slug}`, owner_url: `${url.origin}/s/${slug}/owner` });
    }

    m = path.match(/^\/api\/admin\/tenants\/([a-z0-9-]+)$/);
    if (method === "DELETE" && m) {
      const adm = requireAdmin(request, env);
      if (!adm.ok) return errResp(adm.status, adm.detail);
      await env.DB.prepare("DELETE FROM tenants WHERE slug = ?").bind(m[1]).run();
      return jsonResp({ ok: true, deleted_slug: m[1] });
    }

    m = path.match(/^\/api\/admin\/leads\/([a-zA-Z0-9-]+)$/);
    if (method === "DELETE" && m) {
      const adm = requireAdmin(request, env);
      if (!adm.ok) return errResp(adm.status, adm.detail);
      const code = m[1].toUpperCase();
      if (!ORDER_RE.test(code)) return errResp(400, "Invalid order code");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM lead_photos WHERE order_code = ?").bind(code),
        env.DB.prepare("DELETE FROM leads WHERE order_code = ?").bind(code),
      ]);
      return jsonResp({ ok: true, deleted_order: code });
    }

    return errResp(404, "Not found");
  },
};
