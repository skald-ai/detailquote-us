(() => {
  const slug = document.body.dataset.slug;
  const TOKEN_KEY = `dq_owner_token_${slug}`;
  const $ = (id) => document.getElementById(id);

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || "",
    shop: null,
    leads: [],
    selectedCode: null,
  };

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function authHeaders() {
    return {
      "Content-Type": "application/json",
      "X-Owner-Token": state.token,
    };
  }

  function showPinScreen(msg = "") {
    $("pinCard").classList.remove("hidden");
    $("cabinetMain").classList.add("hidden");
    if (msg) {
      $("pinError").textContent = msg;
      $("pinError").classList.remove("hidden");
    } else {
      $("pinError").classList.add("hidden");
    }
  }

  function renderStats(stats) {
    const cur = state.shop?.currency || "$";
    $("statNew").textContent = String(stats.new_count || 0);
    $("statPipeline").textContent = `${cur}${Number(stats.pipeline_value || 0).toLocaleString("en-US")}`;
    $("statRevenue").textContent = `${cur}${Number(stats.confirmed_revenue || 0).toLocaleString("en-US")}`;
  }

  function renderLeadsList() {
    const filter = $("statusFilter").value;
    const filtered = state.leads.filter((l) => filter === "all" || l.status === filter);
    const list = $("leadsList");
    if (!filtered.length) {
      list.innerHTML = `<div class="section-meta">No leads match this filter yet</div>`;
      return;
    }
    const cur = state.shop?.currency || "$";
    list.innerHTML = filtered
      .map((l) => {
        const active = l.order_code === state.selectedCode ? "is-active" : "";
        const price = l.confirmed_price !== null && l.confirmed_price !== undefined
          ? `${cur}${l.confirmed_price}`
          : `${cur}${l.estimated_min}–${cur}${l.estimated_max}`;
        return `
          <button type="button" class="lead-item ${active}" data-code="${escapeHtml(l.order_code)}">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; width:100%;">
              <span class="option-title">${escapeHtml(l.customer_name)}</span>
              <span class="badge status-${escapeHtml(l.status)} tabular">${escapeHtml(l.status)}</span>
            </div>
            <div class="option-sub">${escapeHtml(l.vehicle_model || l.vehicle_label)} · ${escapeHtml(l.package_name)}</div>
            <div style="display:flex; justify-content:space-between; width:100%; font-size:12px; color:var(--text-secondary);">
              <span class="tabular">${escapeHtml(l.order_code)}</span>
              <span class="tabular">${escapeHtml(price)}</span>
            </div>
          </button>
        `;
      })
      .join("");

    list.querySelectorAll("[data-code]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedCode = btn.dataset.code;
        renderLeadsList();
        renderLeadDetail();
      });
    });
  }

  function renderLeadDetail() {
    const card = $("leadDetailCard");
    const lead = state.leads.find((l) => l.order_code === state.selectedCode);
    if (!lead) {
      card.innerHTML = `<div class="section-meta">Select a lead on the left to inspect photos, confirm exact price, and text the customer tracking link</div>`;
      return;
    }

    const cur = state.shop?.currency || "$";
    const origin = window.location.origin;
    const statusUrl = `${origin}/order/${lead.order_code}`;
    const defaultPrice = lead.confirmed_price !== null && lead.confirmed_price !== undefined
      ? lead.confirmed_price
      : Math.round((lead.estimated_min + lead.estimated_max) / 2);

    const addonsText = lead.addons && lead.addons.length
      ? lead.addons.map((a) => `${a.name} (+${cur}${a.price})`).join(", ")
      : "None";

    const photosHtml = lead.photos && lead.photos.length
      ? `<div class="photo-thumbs">${lead.photos.map((p, i) => `<a href="${escapeHtml(p)}" target="_blank" class="thumb-wrap"><img src="${escapeHtml(p)}" alt="Customer upload ${i + 1}"></a>`).join("")}</div>`
      : `<div class="section-meta">No photos attached by customer</div>`;

    const phoneClean = String(lead.customer_phone || "").replace(/[^\d+]/g, "");
    const creditNote = lead.promo_unlocked ? ` (with ${cur}${lead.promo_credit} booking credit)` : "";
    const smsText = encodeURIComponent(
      `Hi ${lead.customer_name}, ${state.shop.shop_name} reviewed your ${lead.vehicle_model || lead.vehicle_label}. Exact quote: ${cur}${defaultPrice}${creditNote}. View status and confirm slot here: ${statusUrl}`
    );

    card.innerHTML = `
      <div class="section-head">
        <div>
          <div class="section-meta tabular">${escapeHtml(lead.order_code)} · ${escapeHtml(lead.created_at.slice(0, 10))}</div>
          <h2 class="section-title" style="font-size: 18px; margin-top: 4px;">${escapeHtml(lead.customer_name)}</h2>
        </div>
        <span class="badge status-${escapeHtml(lead.status)} tabular">${escapeHtml(lead.status)}</span>
      </div>

      <div class="summary-rows" style="margin-top: 0; border-top: none; padding-top: 0; margin-bottom: 16px;">
        <div class="summary-row"><span>Phone</span><span class="tabular">${escapeHtml(lead.customer_phone)}</span></div>
        <div class="summary-row"><span>Vehicle</span><span>${escapeHtml(lead.vehicle_label)}${lead.vehicle_model ? " · " + escapeHtml(lead.vehicle_model) : ""}</span></div>
        <div class="summary-row"><span>Package</span><span>${escapeHtml(lead.package_name)} (${escapeHtml(lead.condition_label)})</span></div>
        <div class="summary-row"><span>Add-ons</span><span>${escapeHtml(addonsText)}</span></div>
        <div class="summary-row"><span>Address</span><span>${escapeHtml(lead.service_address)}</span></div>
        <div class="summary-row"><span>Preferred time</span><span>${escapeHtml(lead.preferred_date || "Flexible")} · ${escapeHtml(lead.preferred_window || "")}</span></div>
        <div class="summary-row"><span>Estimate</span><span class="tabular">${cur}${lead.estimated_min} – ${cur}${lead.estimated_max}</span></div>
        <div class="summary-row"><span>Booking credit</span><span>${lead.promo_unlocked ? `Unlocked (-${cur}${lead.promo_credit})` : "Not unlocked yet"}</span></div>
      </div>

      ${lead.notes ? `<div class="card-deep" style="padding: 12px; margin-bottom: 16px;"><div class="section-meta" style="margin-bottom: 4px;">Customer notes</div><div style="font-size: 13px;">${escapeHtml(lead.notes)}</div></div>` : ""}

      <div style="margin-bottom: 16px;">
        <div class="field-label" style="margin-bottom: 8px;">Customer photos</div>
        ${photosHtml}
      </div>

      <div class="field-grid" style="margin-bottom: 12px;">
        <div class="field">
          <label class="field-label" for="detailConfirmedPrice">Confirmed price (${escapeHtml(cur)})</label>
          <input class="input tabular" id="detailConfirmedPrice" type="number" value="${defaultPrice}">
        </div>
        <div class="field">
          <label class="field-label" for="detailSlot">Scheduled slot</label>
          <input class="input" id="detailSlot" type="text" value="${escapeHtml(lead.scheduled_slot || "")}" placeholder="Thu Nov 20 · 10:00 AM">
        </div>
        <div class="field full">
          <label class="field-label" for="detailOwnerNote">Note shown on customer tracking link</label>
          <input class="input" id="detailOwnerNote" type="text" value="${escapeHtml(lead.owner_note || "")}" placeholder="Need driveway access and outdoor spigot">
        </div>
      </div>

      <div class="success-banner hidden" id="leadSavedBanner" style="margin-bottom: 12px;">Work order updated</div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
        <button type="button" class="btn btn-primary btn-sm" data-set-status="quoted">Send confirmed quote</button>
        <button type="button" class="btn btn-secondary btn-sm" data-set-status="confirmed">Mark scheduled</button>
        <button type="button" class="btn btn-secondary btn-sm" data-set-status="completed">Mark completed</button>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        <a class="btn btn-accent btn-sm" href="sms:${escapeHtml(phoneClean)}?&body=${smsText}">Text customer status link</a>
        <button type="button" class="btn btn-secondary btn-sm" id="copyStatusLinkBtn">Copy status link</button>
        <a class="btn btn-secondary btn-sm" href="/order/${escapeHtml(lead.order_code)}" target="_blank">Open tracking page</a>
      </div>
    `;

    card.querySelectorAll("[data-set-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const nextStatus = btn.dataset.setStatus;
        const confirmedPrice = Number($("detailConfirmedPrice").value || 0);
        const scheduledSlot = $("detailSlot").value.trim();
        const ownerNote = $("detailOwnerNote").value.trim();

        const res = await fetch(`/api/tenants/${encodeURIComponent(slug)}/owner/leads/${encodeURIComponent(lead.order_code)}`, {
          method: "PATCH",
          headers: await authHeaders(),
          body: JSON.stringify({
            status: nextStatus,
            confirmed_price: confirmedPrice,
            scheduled_slot: scheduledSlot,
            owner_note: ownerNote,
          }),
        });
        if (res.status === 401) {
          sessionStorage.removeItem(TOKEN_KEY);
          showPinScreen("Session expired, sign in again");
          return;
        }
        if (res.ok) {
          await loadCabinetData();
          const banner = $("leadSavedBanner");
          if (banner) banner.classList.remove("hidden");
        }
      });
    });

    $("copyStatusLinkBtn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(statusUrl).catch(() => null);
      $("copyStatusLinkBtn").textContent = "Copied";
      setTimeout(() => {
        $("copyStatusLinkBtn").textContent = "Copy status link";
      }, 1600);
    });
  }

  function renderPricingForm() {
    const t = state.shop;
    if (!t) return;
    $("shareLinkInput").value = `${window.location.origin}/s/${t.slug}`;
    $("editPromoCredit").value = Number(t.promo_credit || 0);
    $("editNextSlot").value = t.next_slot_label || "";

    $("pkgPricesGrid").innerHTML = t.packages
      .map(
        (p) => `
        <div class="field">
          <label class="field-label" for="pkgPrice_${escapeHtml(p.id)}">${escapeHtml(p.name)} ($)</label>
          <input class="input tabular" id="pkgPrice_${escapeHtml(p.id)}" data-pkg-price="${escapeHtml(p.id)}" type="number" value="${p.base_price}">
        </div>
      `
      )
      .join("");

    $("addonPricesGrid").innerHTML = t.addons
      .map(
        (a) => `
        <div class="field">
          <label class="field-label" for="addonPrice_${escapeHtml(a.id)}">${escapeHtml(a.name)} ($)</label>
          <input class="input tabular" id="addonPrice_${escapeHtml(a.id)}" data-addon-price="${escapeHtml(a.id)}" type="number" value="${a.price}">
        </div>
      `
      )
      .join("");
  }

  async function loadCabinetData() {
    const res = await fetch(`/api/tenants/${encodeURIComponent(slug)}/owner/leads`, {
      headers: { "X-Owner-Token": state.token },
    });
    if (res.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      state.token = "";
      showPinScreen();
      return false;
    }
    const data = await res.json();
    state.shop = data.shop;
    state.leads = data.leads || [];
    if (!state.selectedCode && state.leads.length) {
      state.selectedCode = state.leads[0].order_code;
    }
    $("pinCard").classList.add("hidden");
    $("cabinetMain").classList.remove("hidden");
    $("shopName").textContent = data.shop.shop_name;
    document.documentElement.style.setProperty("--accent", data.shop.accent_color || "#e59934");
    renderStats(data.stats || {});
    renderLeadsList();
    renderLeadDetail();
    renderPricingForm();
    return true;
  }

  async function signIn() {
    const pin = $("pinInput").value.trim();
    if (!pin) return;
    $("pinError").classList.add("hidden");
    const res = await fetch(`/api/tenants/${encodeURIComponent(slug)}/owner/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) {
      showPinScreen(data.detail || "Incorrect PIN");
      return;
    }
    state.token = data.token;
    sessionStorage.setItem(TOKEN_KEY, state.token);
    await loadCabinetData();
  }

  async function savePricing() {
    $("pricingSavedBanner").classList.add("hidden");
    $("pricingErrorBanner").classList.add("hidden");
    const packages = {};
    document.querySelectorAll("[data-pkg-price]").forEach((inp) => {
      packages[inp.dataset.pkgPrice] = Number(inp.value || 0);
    });
    const addons = {};
    document.querySelectorAll("[data-addon-price]").forEach((inp) => {
      addons[inp.dataset.addonPrice] = Number(inp.value || 0);
    });

    const res = await fetch(`/api/tenants/${encodeURIComponent(slug)}/owner/pricing`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({
        promo_credit: Number($("editPromoCredit").value || 0),
        next_slot_label: $("editNextSlot").value.trim(),
        packages,
        addons,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      $("pricingErrorBanner").textContent = data.detail || "Could not save pricing";
      $("pricingErrorBanner").classList.remove("hidden");
      return;
    }
    state.shop = data.shop;
    renderPricingForm();
    $("pricingSavedBanner").classList.remove("hidden");
  }

  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("is-active", b === btn));
      $("tabLeads").classList.toggle("hidden", target !== "leads");
      $("tabPricing").classList.toggle("hidden", target !== "pricing");
    });
  });

  $("pinSubmitBtn").addEventListener("click", signIn);
  $("pinInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") signIn();
  });
  $("statusFilter").addEventListener("change", renderLeadsList);
  $("refreshLeadsBtn").addEventListener("click", loadCabinetData);
  $("savePricingBtn").addEventListener("click", savePricing);
  $("copyShareBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("shareLinkInput").value).catch(() => null);
    $("copyShareBtn").textContent = "Copied";
    setTimeout(() => {
      $("copyShareBtn").textContent = "Copy";
    }, 1500);
  });
  $("signOutBtn").addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    state.token = "";
    showPinScreen();
  });

  async function init() {
    const publicRes = await fetch(`/api/tenants/${encodeURIComponent(slug)}`);
    if (publicRes.ok) {
      const shop = await publicRes.json();
      if (shop.is_demo_pin) {
        $("pinHint").textContent = "Demo PIN: 2026";
      }
    }
    if (state.token) {
      await loadCabinetData();
    } else {
      showPinScreen();
    }
  }

  init();
})();
