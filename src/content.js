// Isolated-world orchestrator. Collects captures from the interceptor, asks
// the adapter for a shipment, requests PS rates from the background worker,
// and renders the panel. Falls back to clipboard-only when the endpoint fails.

(() => {
  const DEBUG = () => window.EPS_DEBUG === true;
  const log = (...a) => DEBUG() && console.log("[EPS]", ...a);

  // After the extension is reloaded/updated, content scripts already injected in
  // open tabs keep running but lose their connection - any chrome.* call then
  // throws "Extension context invalidated". Guard the entry points and bail
  // quietly until the page is refreshed and a fresh script takes over.
  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };
  const extURL = (p) => {
    try {
      return chrome.runtime.getURL(p);
    } catch {
      return "";
    }
  };

  const captures = [];
  let lastShipmentKey = null;
  let debounceTimer = null;

  // collect network payloads from the MAIN-world interceptor
  window.addEventListener("message", (e) => {
    if (!alive()) return;
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

  // Post-purchase "label is ready to print" / print surfaces. The label is
  // already bought and there's no ship-from/weight form to read, so the
  // comparison is moot — never show the panel here.
  function isPrintPage() {
    return /\/print(\/|$)|\/sl\/prnt/i.test(location.pathname);
  }

  // "Get labels in bulk" combine page. It lists one row per shipment; the panel
  // describes a single shipment, so only compare when exactly one row is in view
  // (i.e. orders combined into one). Otherwise the readers would mix rows.
  function isBulkPage() {
    return /\/ship\/bulk/i.test(location.pathname);
  }

  function removePanel() {
    const el = document.getElementById("eps-panel");
    if (el) el.remove();
  }

  async function tryCompare() {
    if (!alive()) return;
    if (isPrintPage()) {
      removePanel();
      return;
    }
    if (isBulkPage()) {
      const rows = EPS.bulkRowCount();
      if (rows !== 1) {
        renderNote(
          rows > 1
            ? `Combine these ${rows} orders into one shipment to compare.`
            : "Open a shipping label to compare postage."
        );
        return;
      }
    }
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

    // eBay carries a 1x1x1 placeholder when the seller never set real
    // dimensions, which is below the carrier minimum and makes Pirate Ship
    // refuse to quote. When all three dims are present but under the minimum,
    // raise them to the smallest size PS will quote (longest 6, middle 3,
    // thinnest 1) so we still return a baseline. Order doesn't affect pricing.
    if (shipment.len > 0 && shipment.wid > 0 && shipment.hei > 0) {
      const d = [shipment.len, shipment.wid, shipment.hei].map(Number).sort((a, b) => b - a);
      if (!(d[0] >= 6 && d[1] >= 3 && d[2] >= 0.25)) {
        shipment.len = Math.max(d[0], 6);
        shipment.wid = Math.max(d[1], 3);
        shipment.hei = Math.max(d[2], 1);
        shipment.dimsBumped = true;
      }
    }

    const svc = EPS.serviceFromDom();
    if (svc) shipment.service = svc;
    const cost = EPS.ebayCostFromDom();
    if (cost != null) shipment.ebayCost = cost;

    // The join key into Pirate Ship's native eBay import - lets the handoff land
    // on this exact order instead of a blank ship page. Skipped for combined
    // shipments: one label covers two orders, so a single-order deep link (and
    // its tracking-back) would be wrong - fall back to the manual copy.
    shipment.orderId = isBulkPage() ? null : EPS.orderIdFromPage();

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
    renderResult(shipment, resp.rates, resp.weightHack);
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
      if (e.target.closest(".eps-x, .eps-min")) return; // toolbar buttons, not a drag
      const head = e.target.closest(".eps-bar, .eps-head");
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
    return n == null ? "-" : "$" + Number(n).toFixed(2);
  }

  function header() {
    const mark = extURL("icons/icon128.png");
    const img = mark
      ? `<img class="eps-mark" src="${mark}" alt="Items and Stuff" />`
      : "";
    return `<div class="eps-bar">
        <span class="eps-bar-title">SHIP-COMPARE.TOOL</span>
        <span class="eps-ver">v0.3.4</span>
        <button class="eps-min" aria-label="Minimize">-</button>
        <button class="eps-x" aria-label="Close">\u00d7</button>
      </div>
      <div class="eps-head">
        ${img}
        <span class="eps-title">eBay vs Pirate Ship</span>
      </div>`;
  }

  // Keep the minimize glyph in sync with the fold state (rebuilt on each render).
  function syncControls(el) {
    const min = el.querySelector(".eps-min");
    if (!min) return;
    const folded =
      el.classList.contains("eps-collapsed") || el.classList.contains("eps-baronly");
    min.textContent = folded ? "+" : "-";
    min.setAttribute("aria-label", folded ? "Expand" : "Minimize");
  }

  function wire(el) {
    // Minimize folds to the toolbar + brand bar; Close folds to just the
    // toolbar. Either button restores from any folded state.
    const min = el.querySelector(".eps-min");
    if (min)
      min.onclick = () => {
        el.classList.remove("eps-baronly");
        el.classList.toggle("eps-collapsed");
        syncControls(el);
      };
    const x = el.querySelector(".eps-x");
    if (x)
      x.onclick = () => {
        el.classList.remove("eps-collapsed");
        el.classList.toggle("eps-baronly");
        syncControls(el);
      };
    syncControls(el);
    const copy = el.querySelector("[data-copy]");
    if (copy) copy.onclick = () => handoff(copy);
    const bump = el.querySelector("[data-bump]");
    if (bump) {
      const go = () => {
        const oz = Number(bump.getAttribute("data-bump"));
        if (oz > 0 && EPS.setWeightDom(oz)) {
          lastShipmentKey = null; // force a fresh quote at the new weight
          // re-quote once eBay has committed both fields (~2s of focus/blur)
          setTimeout(schedule, 2000);
        }
      };
      bump.onclick = go;
      bump.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      };
    }
  }

  function renderEmpty() {
    if (document.getElementById("eps-panel")) return; // don't clobber a result
    const el = panel();
    el.innerHTML = header() + `<div class="eps-body eps-muted">Open a shipping label to compare postage.</div>`;
    wire(el);
  }

  // A standalone message in the panel (e.g. the bulk combine prompt).
  function renderNote(msg) {
    const el = panel();
    el.innerHTML = header() + `<div class="eps-body eps-muted">${msg}</div>`;
    wire(el);
  }

  function renderLoading(s) {
    const el = panel();
    const skRow =
      `<div class="eps-rate"><span class="eps-sk eps-sk-line"></span><span class="eps-sk eps-sk-price"></span></div>`;
    el.innerHTML =
      header() +
      `<div class="eps-body" aria-busy="true">
        <div class="eps-row"><span>eBay label</span><b>${money(s.ebayCost)}</b></div>
        <div class="eps-sub">Pirate Ship postage</div>
        <div class="eps-rates eps-rates-sk" aria-hidden="true">${skRow.repeat(4)}</div>
        <div class="eps-sk eps-sk-block" aria-hidden="true"></div>
        <div class="eps-sr">Checking Pirate Ship rates\u2026</div>
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

  const PS_IMPORT = "https://ship.pirateship.com/import?search=";
  const PS_SHIP = "https://ship.pirateship.com/ship";

  let pendingCopy = "";
  let pendingOrderId = null;
  let pendingPkg = null;

  function rememberHandoff(s) {
    pendingOrderId = s.orderId || null;
    pendingPkg = { len: s.len, wid: s.wid, hei: s.hei, weightOz: s.weightOz };
  }

  // Stash the package data so the Pirate Ship content script can fill the
  // weight and dimensions that PS's eBay import leaves blank.
  function stashHandoff() {
    try {
      chrome.storage.local.set({
        eps_handoff: {
          orderId: pendingOrderId,
          len: (pendingPkg && pendingPkg.len) || null,
          wid: (pendingPkg && pendingPkg.wid) || null,
          hei: (pendingPkg && pendingPkg.hei) || null,
          weightOz: (pendingPkg && pendingPkg.weightOz) || null,
          ts: Date.now(),
        },
      });
    } catch {}
  }

  // With an eBay order id we deep-link into Pirate Ship's eBay-import grid,
  // already filtered to this order \u2014 the seller clicks "Get Rates" and the
  // address and order details are pre-filled by PS's native import; our PS
  // content script then fills the weight and size. Without an order id (older
  // label surfaces), fall back to copying the address and opening a blank ship
  // page.
  function handoff(btn) {
    if (pendingOrderId) {
      stashHandoff();
      window.open(PS_IMPORT + encodeURIComponent(pendingOrderId), "_blank", "noopener");
      return;
    }
    navigator.clipboard.writeText(pendingCopy).then(
      () => {
        const old = btn.textContent;
        btn.textContent = "Copied \u2713";
        setTimeout(() => (btn.textContent = old), 1500);
        window.open(PS_SHIP, "_blank", "noopener");
      },
      () => (btn.textContent = "Copy failed")
    );
  }

  function copyBlock(s, label) {
    pendingCopy = clipboardText(s);
    rememberHandoff(s);
    const note = pendingOrderId
      ? "Opens this order in Pirate Ship with the address, weight, and size already filled in."
      : "Copies the address and opens Pirate Ship. Insurance and signature already match your eBay selections.";
    return `<button class="eps-btn" data-copy>${label}</button>
      <div class="eps-note">${note}</div>`;
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

  function lbLabel(oz) {
    const lb = oz / 16;
    return (Number.isInteger(lb) ? lb : lb.toFixed(1)) + " lb";
  }

  // USPS Ground Advantage weight-band quirk: declaring a heavier weight can be
  // cheaper. Shown only when it beats the current best rate. Clicking it writes
  // the bumped weight back into eBay's form, which re-quotes and also carries
  // through to the Pirate Ship prefill.
  function hackBlock(weightHack, cheapest) {
    if (!weightHack || weightHack.price >= cheapest.totalPrice - 0.005) return "";
    const saving = cheapest.totalPrice - weightHack.price;
    const w = lbLabel(weightHack.toOz);
    return `<div class="eps-hack" role="button" tabindex="0" data-bump="${weightHack.toOz}"
        aria-label="Set the eBay weight to ${w} to save ${money(saving)} on Ground Advantage">
        <span class="eps-hack-tag"><span class="eps-spark">✨</span> Bump &amp; Save</span>
        Mark it <b>${w}</b> for Ground Advantage at ${money(weightHack.price)},
        <span class="eps-hack-save">save ${money(saving)}</span>
        <span class="eps-hack-cta">Tap to set eBay weight to ${w} →</span>
      </div>`;
  }

  function renderResult(s, rates, weightHack) {
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
        ${
          s.dimsBumped
            ? `<div class="eps-note">Sized up to ${s.len}×${s.wid}×${s.hei} in (eBay dimensions were below the carrier minimum).</div>`
            : ""
        }
        ${hackBlock(weightHack, cheapest)}
        ${delta}
        <button class="eps-link" data-copy>Open in Pirate Ship</button>
      </div>`;
    wire(el);
    pendingCopy = clipboardText(s);
    rememberHandoff(s);
  }

  // eBay's label flow is a single-page app, so navigating (e.g. to the print
  // page after buying) doesn't reload this script. Watch for URL changes and
  // re-evaluate — tryCompare drops the panel on print pages and rebuilds it
  // elsewhere.
  let lastUrl = location.href;
  setInterval(() => {
    if (!alive()) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (isPrintPage()) removePanel();
      else {
        lastShipmentKey = null;
        schedule();
      }
    }
  }, 600);

  // first pass shortly after load in case data was server-rendered
  setTimeout(schedule, 1200);
})();
