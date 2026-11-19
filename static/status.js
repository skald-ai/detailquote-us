(() => {
  const orderCode = document.body.dataset.orderCode;
  const $ = (id) => document.getElementById(id);

  let currentData = null;
  let canvasReady = false;
  let unlocking = false;

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderOrder(payload) {
    currentData = payload;
    const { order, shop } = payload;
    const cur = shop.currency || "$";
    document.documentElement.style.setProperty("--accent", shop.accent_color || "#e59934");

    $("shopName").textContent = shop.shop_name;

    const statusTitles = {
      new: "Request received by shop",
      quoted: "Exact quote ready",
      confirmed: "Mobile appointment confirmed",
      completed: "Detail completed",
      declined: "Request closed",
    };
    $("statusHeadline").textContent = statusTitles[order.status] || "Work order status";
    const badge = $("statusBadge");
    badge.textContent = order.status;
    badge.className = `badge status-${order.status} tabular`;

    const orderStages = ["new", "quoted", "confirmed"];
    const activeIdx = order.status === "completed" ? 2 : orderStages.indexOf(order.status);
    $("stepper").querySelectorAll(".step-box").forEach((box, idx) => {
      box.classList.remove("is-done", "is-current");
      if (idx < activeIdx) box.classList.add("is-done");
      else if (idx === activeIdx) box.classList.add("is-current");
    });

    if (order.confirmed_price !== null && order.confirmed_price !== undefined) {
      const credit = order.promo_unlocked ? Number(order.promo_credit || 0) : 0;
      const net = Math.max(0, Number(order.confirmed_price) - credit);
      $("priceLabel").textContent = credit > 0
        ? `Confirmed quote (${cur}${credit} credit applied)`
        : "Confirmed exact quote";
      $("priceDisplay").textContent = `${cur}${net}`;
    } else {
      $("priceLabel").textContent = "Preliminary estimate";
      $("priceDisplay").textContent = `${cur}${order.estimated_min} – ${cur}${order.estimated_max}`;
    }

    if (order.scheduled_slot) {
      $("slotDisplay").textContent = order.scheduled_slot;
    } else if (order.preferred_date || order.preferred_window) {
      $("slotDisplay").textContent = `Requested: ${order.preferred_date || "Flexible"} · ${order.preferred_window || ""}`;
    } else {
      $("slotDisplay").textContent = "Pending shop confirmation";
    }

    const noteBox = $("ownerNoteBox");
    if (order.owner_note) {
      noteBox.textContent = `Detailer note: ${order.owner_note}`;
      noteBox.classList.remove("hidden");
    } else {
      noteBox.classList.add("hidden");
    }

    const promoCard = $("promoCard");
    if (!order.promo_credit) {
      promoCard.classList.add("hidden");
    } else {
      promoCard.classList.remove("hidden");
      $("promoAmount").textContent = `-${cur}${order.promo_credit} booking credit`;
      $("promoSub").textContent = `${shop.promo_label || "First mobile booking credit"} saved to ${order.order_code}`;
      if (order.promo_unlocked) {
        $("promoStateLabel").textContent = "Applied";
        $("promoStateLabel").style.color = "var(--positive)";
        $("wipeCanvas").classList.add("is-cleared");
        $("wipeHint").textContent = "Credit locked in for your appointment";
        $("revealBtn").classList.add("hidden");
      } else if (!canvasReady) {
        initWipeCanvas();
      }
    }

    const addonText = order.addons && order.addons.length
      ? order.addons.map((a) => `${a.name} (+${cur}${a.price})`).join(", ")
      : "None";

    const rows = [
      ["Customer", `${order.customer_name} · ${order.customer_phone}`],
      ["Vehicle", `${order.vehicle_label}${order.vehicle_model ? " · " + order.vehicle_model : ""}`],
      ["Package", order.package_name],
      ["Condition", order.condition_label],
      ["Add-ons", addonText],
      ["Service address", order.service_address],
    ];
    if (order.notes) rows.push(["Notes", order.notes]);

    $("orderDetails").innerHTML = rows
      .map(
        ([k, v]) => `
        <div class="summary-row">
          <span>${escapeHtml(k)}</span>
          <span style="text-align: right;">${escapeHtml(v)}</span>
        </div>
      `
      )
      .join("");

    const photosEl = $("orderPhotos");
    if (order.photos && order.photos.length) {
      photosEl.classList.remove("hidden");
      photosEl.innerHTML = order.photos
        .map((src, i) => `<div class="thumb-wrap"><img src="${escapeHtml(src)}" alt="Uploaded photo ${i + 1}"></div>`)
        .join("");
    } else {
      photosEl.classList.add("hidden");
    }

    const telDigits = String(shop.sms_phone || shop.phone || "").replace(/[^\d+]/g, "");
    $("callShopBtn").href = `tel:${telDigits}`;
    const smsBody = encodeURIComponent(`Hi ${shop.shop_name}, checking on my detailing order ${order.order_code}.`);
    $("smsShopBtn").href = `sms:${telDigits}?&body=${smsBody}`;
  }

  async function unlockPromo() {
    if (unlocking) return;
    unlocking = true;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderCode)}/unlock-promo`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (currentData) {
          currentData.order = data.order;
          renderOrder(currentData);
        }
      }
    } finally {
      unlocking = false;
    }
  }

  function initWipeCanvas() {
    const canvas = $("wipeCanvas");
    const wrap = $("wipeWrap");
    const width = wrap.clientWidth || 560;
    const height = wrap.clientHeight || 148;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, "#27272a");
    grad.addColorStop(1, "#1e1e21");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "rgba(237, 237, 237, 0.1)";
    for (let x = 12; x < width; x += 20) {
      for (let y = 12; y < height; y += 20) {
        ctx.fillRect(x, y, 2, 2);
      }
    }

    ctx.fillStyle = "#ededed";
    ctx.font = '500 15px "IBM Plex Sans", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("Wipe surface to unlock booking credit", width / 2, height / 2 - 4);
    ctx.fillStyle = "#85858b";
    ctx.font = '400 12px "IBM Plex Sans", sans-serif';
    ctx.fillText("Applies directly to your confirmed detail total", width / 2, height / 2 + 18);

    canvasReady = true;
    let drawing = false;

    function checkClearedRatio() {
      const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let clear = 0;
      let total = 0;
      for (let i = 3; i < sample.length; i += 64) {
        total += 1;
        if (sample[i] < 40) clear += 1;
      }
      if (total > 0 && clear / total >= 0.45) {
        unlockPromo();
      }
    }

    function eraseAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      eraseAt(e.clientX, e.clientY);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      eraseAt(e.clientX, e.clientY);
    });

    canvas.addEventListener("pointerup", () => {
      if (!drawing) return;
      drawing = false;
      checkClearedRatio();
    });
  }

  async function loadOrder() {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderCode)}`);
    if (!res.ok) {
      $("statusHeadline").textContent = "Work order not found";
      return;
    }
    const payload = await res.json();
    renderOrder(payload);
  }

  $("refreshBtn").addEventListener("click", loadOrder);
  $("revealBtn").addEventListener("click", unlockPromo);
  $("copyOrderLinkBtn").addEventListener("click", async () => {
    const url = window.location.href;
    await navigator.clipboard.writeText(url).catch(() => null);
    $("copyOrderLinkBtn").textContent = "Link copied";
    setTimeout(() => {
      $("copyOrderLinkBtn").textContent = "Copy tracking link";
    }, 1800);
  });

  loadOrder();
})();
