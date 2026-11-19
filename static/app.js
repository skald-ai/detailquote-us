(() => {
  const slug = document.body.dataset.slug;
  const state = {
    tenant: null,
    vehicleId: null,
    packageId: null,
    conditionId: null,
    addonIds: new Set(),
    photos: [],
    submitting: false,
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function computeEstimate() {
    const t = state.tenant;
    if (!t) return { min: 0, max: 0, base: 0, duration: "", zones: new Set() };
    const vehicle = t.vehicles.find((v) => v.id === state.vehicleId) || t.vehicles[0];
    const pkg = t.packages.find((p) => p.id === state.packageId) || t.packages[0];
    const cond = t.conditions.find((c) => c.id === state.conditionId) || t.conditions[0];
    let addonsTotal = 0;
    const zones = new Set(pkg.zones || []);
    t.addons.forEach((a) => {
      if (state.addonIds.has(a.id)) {
        addonsTotal += Number(a.price || 0);
        if (a.zone) zones.add(a.zone);
      }
    });
    const raw = Math.round(pkg.base_price * vehicle.multiplier * cond.multiplier) + addonsTotal;
    const min = Math.max(50, Math.round((raw * 0.95) / 5) * 5);
    const max = Math.max(min + 15, Math.round((raw * 1.08) / 5) * 5);
    return { min, max, vehicle, pkg, cond, addonsTotal, zones };
  }

  function buildVehicleSvg(vehicleId, zones) {
    const paintLit = zones.has("exterior") || zones.has("paint");
    const cabinLit = zones.has("interior");
    const wheelLit = zones.has("wheels");
    const paintStroke = paintLit ? "var(--accent)" : "rgba(237,237,237,0.34)";
    const paintFill = paintLit ? "rgba(229, 153, 52, 0.10)" : "rgba(255,255,255,0.02)";
    const cabinFill = cabinLit ? "rgba(76, 195, 138, 0.24)" : "rgba(237,237,237,0.06)";
    const cabinStroke = cabinLit ? "#4cc38a" : "rgba(237,237,237,0.22)";
    const wheelStroke = wheelLit ? "var(--accent)" : "rgba(237,237,237,0.38)";
    const wheelFill = wheelLit ? "rgba(229, 153, 52, 0.22)" : "#141415";

    const bodies = {
      sedan: {
        body: "M24 106 L34 82 L68 78 L98 52 L176 52 L212 76 L262 82 L274 106 Z",
        cabin: "M74 78 L102 56 L172 56 L204 78 Z",
        w1: 72,
        w2: 222,
      },
      coupe: {
        body: "M22 106 L34 84 L74 78 L108 54 L178 56 L222 78 L266 84 L276 106 Z",
        cabin: "M82 78 L112 58 L176 59 L212 78 Z",
        w1: 74,
        w2: 222,
      },
      suv: {
        body: "M26 106 L34 78 L66 74 L92 44 L216 44 L250 72 L272 78 L274 106 Z",
        cabin: "M74 74 L98 48 L210 48 L240 74 Z",
        w1: 74,
        w2: 224,
      },
      truck: {
        body: "M22 106 L28 76 L78 76 L86 44 L168 44 L182 74 L268 74 L274 106 Z",
        cabin: "M86 74 L92 48 L162 48 L174 74 Z",
        w1: 74,
        w2: 226,
      },
    };
    const shape = bodies[vehicleId] || bodies.sedan;
    return `
      <svg viewBox="0 0 296 132" style="display:block; width:100%; height:auto; max-height:136px; margin:0 auto;" role="img" aria-label="Selected vehicle service zones">
        <line x1="16" y1="120" x2="280" y2="120" stroke="rgba(237,237,237,0.12)" stroke-width="1"/>
        <path d="${shape.body}" fill="${paintFill}" stroke="${paintStroke}" stroke-width="2" stroke-linejoin="round"/>
        <path d="${shape.cabin}" fill="${cabinFill}" stroke="${cabinStroke}" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="${shape.w1}" cy="106" r="16" fill="${wheelFill}" stroke="${wheelStroke}" stroke-width="2"/>
        <circle cx="${shape.w1}" cy="106" r="6" fill="none" stroke="${wheelStroke}" stroke-width="1.5"/>
        <circle cx="${shape.w2}" cy="106" r="16" fill="${wheelFill}" stroke="${wheelStroke}" stroke-width="2"/>
        <circle cx="${shape.w2}" cy="106" r="6" fill="none" stroke="${wheelStroke}" stroke-width="1.5"/>
      </svg>
    `;
  }

  function renderVehicles() {
    const grid = $("vehicleGrid");
    grid.innerHTML = state.tenant.vehicles
      .map((v) => {
        const active = v.id === state.vehicleId ? "is-active" : "";
        return `
          <button type="button" class="option-tile ${active}" data-vehicle="${escapeHtml(v.id)}">
            <span class="option-title">${escapeHtml(v.label)}</span>
            <span class="option-sub">${escapeHtml(v.subtitle)}</span>
          </button>
        `;
      })
      .join("");
    grid.querySelectorAll("[data-vehicle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.vehicleId = btn.dataset.vehicle;
        renderAll();
      });
    });
  }

  function renderPackages() {
    const t = state.tenant;
    const vehicle = t.vehicles.find((v) => v.id === state.vehicleId) || t.vehicles[0];
    const grid = $("packageGrid");
    grid.innerHTML = t.packages
      .map((p) => {
        const active = p.id === state.packageId ? "is-active" : "";
        const scaled = Math.round(p.base_price * vehicle.multiplier);
        return `
          <button type="button" class="pkg-card ${active}" data-pkg="${escapeHtml(p.id)}">
            <div>
              <div class="pkg-top">
                <span class="option-title">${escapeHtml(p.name)}</span>
                <span class="pkg-price tabular">${escapeHtml(t.currency)}${scaled}</span>
              </div>
              <div class="pkg-desc" style="margin-top: 8px;">${escapeHtml(p.summary)}</div>
            </div>
            <div class="pkg-foot tabular">${escapeHtml(p.duration)}</div>
          </button>
        `;
      })
      .join("");
    grid.querySelectorAll("[data-pkg]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.packageId = btn.dataset.pkg;
        renderAll();
      });
    });
  }

  function renderConditionsAndAddons() {
    const t = state.tenant;
    $("conditionGrid").innerHTML = t.conditions
      .map((c) => {
        const active = c.id === state.conditionId ? "is-active" : "";
        return `
          <button type="button" class="option-tile ${active}" data-cond="${escapeHtml(c.id)}">
            <span class="option-title">${escapeHtml(c.label)}</span>
            <span class="option-sub">${escapeHtml(c.note)}</span>
          </button>
        `;
      })
      .join("");
    $("conditionGrid").querySelectorAll("[data-cond]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.conditionId = btn.dataset.cond;
        renderAll();
      });
    });

    const checkIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    $("addonsList").innerHTML = t.addons
      .map((a) => {
        const isOn = state.addonIds.has(a.id);
        return `
          <button type="button" class="addon-row ${isOn ? "is-active" : ""}" data-addon="${escapeHtml(a.id)}">
            <span class="addon-left">
              <span class="check-box">${isOn ? checkIcon : ""}</span>
              <span class="option-title" style="font-size: 13px; font-weight: 400;">${escapeHtml(a.name)}</span>
            </span>
            <span class="tabular" style="font-size: 13px; color: var(--text-secondary);">+${escapeHtml(t.currency)}${a.price}</span>
          </button>
        `;
      })
      .join("");
    $("addonsList").querySelectorAll("[data-addon]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.addon;
        if (state.addonIds.has(id)) state.addonIds.delete(id);
        else state.addonIds.add(id);
        renderAll();
      });
    });
  }

  function renderInspector() {
    const t = state.tenant;
    const est = computeEstimate();
    const cur = t.currency || "$";
    $("durationMeta").textContent = est.pkg.duration;
    $("inspectorLabel").textContent = `${est.vehicle.label} scope`;
    $("vehicleSvgWrap").innerHTML = buildVehicleSvg(est.vehicle.id, est.zones);

    const zoneItems = [
      { key: "exterior", label: "Exterior paint" },
      { key: "interior", label: "Interior cabin" },
      { key: "wheels", label: "Wheels & tires" },
    ];
    $("zoneLegend").innerHTML = zoneItems
      .map((z) => {
        const lit = est.zones.has(z.key) || (z.key === "exterior" && est.zones.has("paint"));
        return `<span class="zone-chip ${lit ? "is-lit" : ""}"><span class="zone-dot"></span>${z.label}</span>`;
      })
      .join("");

    const rangeText = `${cur}${est.min} – ${cur}${est.max}`;
    $("estimateDisplay").textContent = rangeText;
    $("mobileEstimateDisplay").textContent = rangeText;
    $("promoNote").textContent = t.promo_credit > 0
      ? `Includes ${cur}${t.promo_credit} wipe-to-reveal booking credit on next screen`
      : "No hidden travel fees inside service area";

    const selectedAddons = t.addons.filter((a) => state.addonIds.has(a.id));
    const rows = [
      `<span>Package</span><span>${escapeHtml(est.pkg.name)}</span>`,
      `<span>Vehicle</span><span>${escapeHtml(est.vehicle.label)}</span>`,
      `<span>Condition</span><span>${escapeHtml(est.cond.label)}</span>`,
    ];
    if (selectedAddons.length) {
      rows.push(`<span>Add-ons (${selectedAddons.length})</span><span class="tabular">+${cur}${est.addonsTotal}</span>`);
    }
    if (state.photos.length) {
      rows.push(`<span>Photos attached</span><span class="tabular">${state.photos.length} of 4</span>`);
    }
    $("summaryRows").innerHTML = rows.map((r) => `<div class="summary-row">${r}</div>`).join("");
  }

  function renderAll() {
    renderVehicles();
    renderPackages();
    renderConditionsAndAddons();
    renderInspector();
  }

  function renderThumbs() {
    const wrap = $("photoThumbs");
    if (!state.photos.length) {
      wrap.classList.add("hidden");
      wrap.innerHTML = "";
      renderInspector();
      return;
    }
    wrap.classList.remove("hidden");
    wrap.innerHTML = state.photos
      .map(
        (src, i) => `
        <div class="thumb-wrap">
          <img src="${src}" alt="Vehicle photo ${i + 1}">
          <button type="button" class="thumb-remove" data-rm="${i}" aria-label="Remove photo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `
      )
      .join("");
    wrap.querySelectorAll("[data-rm]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.photos.splice(Number(btn.dataset.rm), 1);
        renderThumbs();
      });
    });
    renderInspector();
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read image file"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Unsupported image format"));
        img.onload = () => {
          const maxDim = 1280;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(files) {
    const errBox = $("formError");
    errBox.classList.add("hidden");
    for (const file of files) {
      if (state.photos.length >= 4) break;
      try {
        const b64 = await compressImage(file);
        state.photos.push(b64);
      } catch (err) {
        errBox.textContent = err.message || "Could not process photo";
        errBox.classList.remove("hidden");
      }
    }
    renderThumbs();
  }

  async function submitQuote() {
    if (state.submitting) return;
    const errBox = $("formError");
    errBox.classList.add("hidden");

    const customerName = $("customerName").value.trim();
    const customerPhone = $("customerPhone").value.trim();
    const serviceAddress = $("serviceAddress").value.trim();

    if (customerName.length < 2) {
      errBox.textContent = "Enter your name so the detailer knows who to reply to";
      errBox.classList.remove("hidden");
      $("customerName").focus();
      return;
    }
    if (customerPhone.replace(/\D/g, "").length < 7) {
      errBox.textContent = "Enter a valid mobile number to receive your exact quote link";
      errBox.classList.remove("hidden");
      $("customerPhone").focus();
      return;
    }
    if (serviceAddress.length < 4) {
      errBox.textContent = "Enter your driveway address or ZIP code";
      errBox.classList.remove("hidden");
      $("serviceAddress").focus();
      return;
    }

    state.submitting = true;
    const dBtn = $("submitDesktopBtn");
    const mBtn = $("submitMobileBtn");
    dBtn.disabled = true;
    mBtn.disabled = true;
    dBtn.textContent = "Sending work order...";
    mBtn.textContent = "Sending...";

    try {
      const resp = await fetch(`/api/tenants/${encodeURIComponent(slug)}/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicle_id: state.vehicleId,
          vehicle_model: $("vehicleModel").value.trim(),
          package_id: state.packageId,
          condition_id: state.conditionId,
          addon_ids: Array.from(state.addonIds),
          customer_name: customerName,
          customer_phone: customerPhone,
          service_address: serviceAddress,
          preferred_date: $("preferredDate").value,
          preferred_window: $("preferredWindow").value,
          notes: $("notes").value.trim(),
          photos: state.photos,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Could not submit quote request");
      window.location.href = data.status_url;
    } catch (err) {
      errBox.textContent = err.message || "Network error submitting request";
      errBox.classList.remove("hidden");
      state.submitting = false;
      dBtn.disabled = false;
      mBtn.disabled = false;
      dBtn.textContent = "Request exact quote";
      mBtn.textContent = "Request exact quote";
    }
  }

  async function init() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => null);
    }

    const today = new Date();
    today.setDate(today.getDate() + 1);
    $("preferredDate").value = today.toISOString().slice(0, 10);

    const res = await fetch(`/api/tenants/${encodeURIComponent(slug)}`);
    const t = await res.json();
    state.tenant = t;
    document.documentElement.style.setProperty("--accent", t.accent_color || "#e59934");
    state.vehicleId = t.vehicles[0]?.id || "sedan";
    state.packageId = (t.packages.find((p) => p.id === "full_detail") || t.packages[0])?.id;
    state.conditionId = (t.conditions.find((c) => c.id === "moderate") || t.conditions[0])?.id;

    $("shopName").textContent = t.shop_name;
    $("shopMeta").textContent = `${t.city}, ${t.state} · ${t.phone}`;
    $("nextSlotLabel").textContent = t.next_slot_label || "Booking open";
    $("serviceRadiusMeta").textContent = t.service_radius || "Mobile van comes to you";
    $("shopContactLine").textContent = `Direct line: ${t.phone}`;

    $("photoInput").addEventListener("change", (e) => {
      handleFiles(Array.from(e.target.files || []));
      e.target.value = "";
    });
    $("submitDesktopBtn").addEventListener("click", submitQuote);
    $("submitMobileBtn").addEventListener("click", submitQuote);

    renderAll();
  }

  init().catch((err) => {
    const errBox = $("formError");
    if (errBox) {
      errBox.textContent = err.message || "Failed to load quote builder";
      errBox.classList.remove("hidden");
    }
  });
})();
