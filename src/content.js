// Isolated-world orchestrator. Collects captures from the interceptor, asks
// the adapter for a shipment, requests PS rates from the background worker,
// and renders the panel. Falls back to clipboard-only when the endpoint fails.

(() => {
  const DEBUG = () => window.EPS_DEBUG === true;
  const log = (...a) => DEBUG() && console.log("[EPS]", ...a);

  const captures = [];
  let lastShipmentKey = null;
  let debounceTimer = null;

  // collect network payloads from the MAIN-world interceptor
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "EPS_NET") return;
    captures.push({ url: d.url, payload: d.payload });
    if (captures.length > 40) captures.shift();
    log("capture", d.url, d.payload);
    schedule();
  });

  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(tryCompare, 400);
  }

  function shipmentKey(s) {
    return [
      s.weightOz, s.len, s.wid, s.hei, s.toZip, s.fromZip, s.service,
      s.deliveryConfirmation, s.insuredValue,
    ].join("|");
  }

  async function tryCompare() {
    const shipment = EPS.extractFromCaptures(captures) || EPS.extractFromDom() || {};

    // The label form on the page is the source of truth for what's being
    // shipped; eBay's background rate calls can carry stale or placeholder
    // values (a max weight, the buyer's street number as a ZIP). Override with
    // DOM-read fields whenever the form provides them.
    const o = EPS.originFromDom();
    if (o.zip) {
      shipment.fromZip = o.zip;
      shipment.originRegionCode = o.region || shipment.originRegionCode;
    }
    const toZip = EPS.destFromDom(o.zip || shipment.fromZip);
    if (toZip) shipment.toZip = toZip;
    const w = EPS.weightFromDom();
    if (w) shipment.weightOz = w;
    const dims = EPS.dimsFromDom();
    if (dims) {
      shipment.len = dims.len;
      shipment.wid = dims.wid;
      shipment.hei = dims.hei;
    }
    const svc = EPS.serviceFromDom();
    if (svc) shipment.service = svc;
    const cost = EPS.ebayCostFromDom();
    if (cost != null) shipment.ebayCost = cost;

    // Mirror eBay's signature / liability-coverage selections so the Pirate
    // Ship quote is like-for-like. background.js folds these into the rate.
    shipment.deliveryConfirmation = EPS.signatureFromDom();
    shipment.insuredValue = EPS.insuredValueFromDom();

    if (!shipment.weightOz && !shipment.toZip && !shipment.fromZip) {
      renderEmpty();
      return;
    }

    const key = shipmentKey(shipment);
    if (key === lastShipmentKey) return; // nothing changed
    lastShipmentKey = key;

    log("shipment", shipment);

    shipment.mailClassKey = EPS.mapService(shipment.service);
    shipment.alsoQuote = EPS.ALSO_QUOTE;

    renderLoading(shipment);

    if (!(shipment.fromZip || shipment.originZip)) {
      // no origin yet: can't quote, but clipboard handoff still works
      renderFallback(shipment, "Add your ship-from ZIP, or check manually.");
      return;
    }

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "EPS_GET_RATES", shipment });
    } catch (e) {
      resp = { ok: false, error: String(e && e.message) };
    }
    log("rates", resp);

    if (!resp || !resp.ok) {
      const reason =
        resp && resp.error === "needs_dims"
          ? "Pirate Ship needs package dimensions to quote this parcel."
          : "Couldn't reach Pirate Ship rates.";
      renderFallback(shipment, reason);
      return;
    }
    renderResult(shipment, resp.rates);
  }

  // ---- panel mount ---------------------------------------------------------
  function panel() {
    let el = document.getElementById("eps-panel");
    if (el) return el;
    el = document.createElement("div");
    el.id = "eps-panel";
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Pirate Ship price comparison");
    // default: top-right, clear of eBay's bottom-right Buy button
    el.style.left = Math.max(8, window.innerWidth - 300 - 16) + "px";
    el.style.top = "88px";
    (document.body || document.documentElement).appendChild(el);
    loadPosition(el);
    enableDrag(el);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") el.classList.add("eps-collapsed");
    });
    return el;
  }

  // ---- drag + remembered position -----------------------------------------
  function loadPosition(el) {
    try {
      chrome.storage.local.get("eps_pos", (r) => {
        const p = r && r.eps_pos;
        if (p && typeof p.left === "number") {
          el.style.left = clampX(p.left) + "px";
          el.style.top = clampY(p.top) + "px";
        }
      });
    } catch {}
  }
  function savePosition(left, top) {
    try {
      chrome.storage.local.set({ eps_pos: { left, top } });
    } catch {}
  }
  function clampX(x) {
    return Math.min(Math.max(0, x), window.innerWidth - 60);
  }
  function clampY(y) {
    return Math.min(Math.max(0, y), window.innerHeight - 30);
  }

  function enableDrag(el) {
    let sx, sy, ox, oy, dragging = false;
    function down(e) {
      if (e.target.closest(".eps-x")) return; // collapse button, not a drag
      const head = e.target.closest(".eps-head");
      if (!head) return;
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      sx = e.clientX;
      sy = e.clientY;
      el.classList.add("eps-dragging");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      const left = clampX(ox + (e.clientX - sx));
      const top = clampY(oy + (e.clientY - sy));
      el.style.left = left + "px";
      el.style.top = top + "px";
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("eps-dragging");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const r = el.getBoundingClientRect();
      savePosition(Math.round(r.left), Math.round(r.top));
    }
    el.addEventListener("mousedown", down);
  }

  function money(n) {
    return n == null ? "\u2014" : "$" + Number(n).toFixed(2);
  }

  function header() {
    const mark = chrome.runtime.getURL("icons/icon48.png");
    return `<div class="eps-head">
        <img class="eps-mark" src="${mark}" alt="Items and Stuff" />
        <span class="eps-title">eBay vs Pirate Ship</span>
        <span class="eps-ver">v0.2.0</span>
        <button class="eps-x" aria-label="Collapse">\u00d7</button>
      </div>`;
  }

  function wire(el) {
    const x = el.querySelector(".eps-x");
    if (x) x.onclick = () => el.classList.toggle("eps-collapsed");
    const copy = el.querySelector("[data-copy]");
    if (copy) copy.onclick = () => doCopy(copy);
  }

  function renderEmpty() {
    if (document.getElementById("eps-panel")) return; // don't clobber a result
    const el = panel();
    el.innerHTML = header() + `<div class="eps-body eps-muted">Open a shipping label to compare postage.</div>`;
    wire(el);
  }

  function renderLoading(s) {
    const el = panel();
    el.innerHTML =
      header() +
      `<div class="eps-body">
        <div class="eps-row"><span>eBay label</span><b>${money(s.ebayCost)}</b></div>
        <div class="eps-row eps-muted"><span>Pirate Ship</span><b class="eps-spin">checking\u2026</b></div>
      </div>`;
    wire(el);
  }

  function clipboardText(s) {
    const a = s.toAddress || {};
    const lines = [
      a.name,
      a.street1,
      a.street2,
      [a.city, a.state].filter(Boolean).join(", ") + (a.zip ? " " + a.zip : ""),
    ].filter((x) => x && x.trim());
    const pkg = [];
    if (s.weightOz) pkg.push(`Weight: ${(s.weightOz / 16).toFixed(2)} lb (${s.weightOz} oz)`);
    if (s.len && s.wid && s.hei) pkg.push(`Size: ${s.len} x ${s.wid} x ${s.hei} in`);
    if (s.toZip && lines.length === 0) lines.push(s.toZip);
    return lines.join("\n") + (pkg.length ? "\n\n" + pkg.join("\n") : "");
  }

  let pendingCopy = "";
  function doCopy(btn) {
    navigator.clipboard.writeText(pendingCopy).then(
      () => {
        const old = btn.textContent;
        btn.textContent = "Copied \u2713";
        setTimeout(() => (btn.textContent = old), 1500);
        window.open("https://ship.pirateship.com/ship", "_blank", "noopener");
      },
      () => (btn.textContent = "Copy failed")
    );
  }

  function copyBlock(s, label) {
    pendingCopy = clipboardText(s);
    return `<button class="eps-btn" data-copy>${label}</button>
      <div class="eps-note">Opens Pirate Ship with this shipment. Insurance and signature already match your eBay selections.</div>`;
  }

  // One-line summary of the add-ons mirrored from eBay, shown so the quoted
  // totals are clearly like-for-like. Empty when no add-ons are selected.
  function addonNote(s) {
    const parts = [];
    if (s.deliveryConfirmation === "signature") parts.push("signature");
    else if (s.deliveryConfirmation === "adult_signature") parts.push("adult signature");
    if (s.insuredValue > 0) parts.push(`${money(s.insuredValue)} coverage`);
    return parts.length
      ? `<div class="eps-sub eps-muted">Matched to eBay: ${parts.join(" · ")}</div>`
      : "";
  }

  function diag(s) {
    const wt = s.weightOz ? `${s.weightOz} oz` : '<i class="eps-miss">no weight</i>';
    const dims =
      s.len && s.wid && s.hei ? `${s.len}\u00d7${s.wid}\u00d7${s.hei} in` : "no dims";
    const from = s.fromZip || '<i class="eps-miss">no from</i>';
    const to = s.toZip || '<i class="eps-miss">no to</i>';
    const labels = EPS.CLASS_LABELS || {};
    const classes =
      [s.mailClassKey, ...(s.alsoQuote || [])]
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((k) => labels[k] || k)
        .join(", ") || "default";
    return `<div class="eps-diag">sent: ${wt} \u00b7 ${dims} \u00b7 ${from}\u2192${to}<br>classes: ${classes}</div>`;
  }

  function renderFallback(s, reason) {
    const el = panel();
    el.innerHTML =
      header() +
      `<div class="eps-body">
        <div class="eps-row"><span>eBay label</span><b>${money(s.ebayCost)}</b></div>
        <div class="eps-warn">${reason}</div>
        ${diag(s)}
        ${copyBlock(s, "Copy for Pirate Ship")}
      </div>`;
    wire(el);
  }

  function renderResult(s, rates) {
    const el = panel();
    if (!rates.length) {
      renderFallback(s, "Pirate Ship returned no rates for this package.");
      return;
    }
    const sorted = [...rates].sort((a, b) => a.totalPrice - b.totalPrice);
    const cheapest = sorted[0];

    const rows =
      `<div class="eps-rates">` +
      sorted
        .slice(0, 4)
        .map((r, i) => {
          const tag = r.cubicTier ? ` \u00b7 cubic ${r.cubicTier}` : "";
          const best = i === 0 ? " eps-best" : "";
          return `<div class="eps-rate${best}"><span>${r.title}${tag}</span><b>${money(r.totalPrice)}</b></div>`;
        })
        .join("") +
      `</div>`;

    let delta = "";
    if (s.ebayCost != null) {
      const diff = s.ebayCost - cheapest.totalPrice;
      if (diff > 0.005) {
        delta = `<div class="eps-save">Save ${money(diff)} on postage with ${cheapest.title}</div>`;
      } else if (diff < -0.005) {
        delta = `<div class="eps-even">eBay is cheaper here by ${money(-diff)}</div>`;
      } else {
        delta = `<div class="eps-even">Postage matches.</div>`;
      }
    }

    el.innerHTML =
      header() +
      `<div class="eps-body">
        <div class="eps-row"><span>eBay label</span><b>${money(s.ebayCost)}</b></div>
        ${addonNote(s)}
        <div class="eps-sub">Pirate Ship postage</div>
        ${rows}
        ${delta}
        <button class="eps-link" data-copy>Open this shipment in Pirate Ship</button>
      </div>`;
    wire(el);
    pendingCopy = clipboardText(s);
  }

  // first pass shortly after load in case data was server-rendered
  setTimeout(schedule, 1200);
})();
