// ============================================================================
// TUNE THIS FILE. Everything that depends on eBay's private page schema lives
// here so the rest of the extension stays stable. eBay's label-page network
// shape is not public and changes; the functions below use heuristics that
// work without knowing exact field paths, but you'll get cleaner results by
// pinning real paths/selectors once you inspect your own label page.
//
// Turn on logging (Options or console) to see captured payloads:
//   window.EPS_DEBUG = true
// Then open a label, watch the console, and tighten the matchers below.
// ============================================================================

window.EPS = window.EPS || {};

// --- service name -> Pirate Ship mailClassKey ------------------------------
// Add any eBay service strings you see that don't map yet.
EPS.mapService = function (raw) {
  const s = (raw || "").toLowerCase();
  if (/priority\s*mail\s*express/.test(s)) return "PriorityExpress";
  if (/priority/.test(s)) return "Priority";
  if (/media/.test(s)) return "MediaMail";
  if (/parcel\s*select/.test(s)) return "ParcelSelect";
  if (/ground\s*advantage/.test(s)) return "GroundAdvantage";
  // First-Class Package retired domestically -> Ground Advantage is the heir.
  if (/first[-\s]*class/.test(s)) return "GroundAdvantage";
  return null;
};

// Classes to always quote alongside the matched one, so the panel can surface
// a cheaper alternative -- now across carriers. UPS keys are numeric service
// codes (03 = UPS Ground, 93 = UPS Ground Saver); the rates response carries
// human titles, so the panel's rate rows read fine without a lookup. Deduped
// later.
EPS.ALSO_QUOTE = ["GroundAdvantage", "Priority", "03", "93"];

// Friendly names for the diagnostic line only (rate rows use the API's titles).
EPS.CLASS_LABELS = {
  GroundAdvantage: "USPS Ground Advantage",
  Priority: "USPS Priority",
  PriorityExpress: "USPS Priority Express",
  MediaMail: "USPS Media Mail",
  ParcelSelect: "USPS Parcel Select",
  "03": "UPS Ground",
  "93": "UPS Ground Saver",
  "02": "UPS 2nd Day Air",
};

// --- eBay order id ----------------------------------------------------------
// eBay order/record ids are formatted NN-NNNNN-NNNNN. On the single-label page
// it sits right in the URL (/ship/single/12-34567-89012); other label surfaces
// carry it in a query param or somewhere in the rendered page. This is the join
// key into Pirate Ship's native eBay import, so the panel can hand the seller
// straight to the matching order instead of a blank ship page.
EPS.ORDER_ID_RE = /\b\d{2}-\d{5}-\d{5}\b/;

EPS.orderIdFromPage = function () {
  const fromUrl = (location.href.match(EPS.ORDER_ID_RE) || [])[0];
  if (fromUrl) return fromUrl;
  const fromBody = ((document.body && document.body.innerText) || "").match(
    EPS.ORDER_ID_RE
  );
  return fromBody ? fromBody[0] : null;
};

// --- deep search helpers ----------------------------------------------------
function walk(obj, visit, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    visit(k, v, obj);
    if (v && typeof v === "object") walk(v, visit, depth + 1);
  }
}

function firstNumber(obj, keyRe) {
  let found;
  walk(obj, (k, v) => {
    if (found !== undefined) return;
    if (keyRe.test(k)) {
      const n = typeof v === "number" ? v : parseFloat(v);
      if (!Number.isNaN(n)) found = n;
    }
  });
  return found;
}

function firstString(obj, keyRe, valRe) {
  let found;
  walk(obj, (k, v) => {
    if (found !== undefined) return;
    if (keyRe.test(k) && typeof v === "string" && (!valRe || valRe.test(v))) {
      found = v;
    }
  });
  return found;
}

function firstZip(obj, keyRe) {
  let found;
  walk(obj, (k, v) => {
    if (found !== undefined) return;
    if (keyRe.test(k)) {
      const z = pickZip(String(v));
      if (z) found = z;
    }
  });
  return found;
}

// Pick the postal ZIP out of an address blob. A US street address often leads
// with a 5-digit house number ("12345 Main St ... TX 75001-1234"), so a naive
// first-match grabs the wrong number. Prefer, in order: a ZIP+4, a 5-digit run
// right after a 2-letter state code, then the last bare 5-digit run.
function pickZip(text) {
  if (!text) return null;
  const s = String(text);
  let m = s.match(/\b(\d{5})-\d{4}\b/);
  if (m) return m[1];
  m = s.match(/\b[A-Z]{2}\s+(\d{5})\b/);
  if (m) return m[1];
  const all = s.match(/\b\d{5}\b/g);
  return all && all.length ? all[all.length - 1] : null;
}

// Resolve total ounces from whatever weight shape eBay used.
function resolveWeightOz(obj) {
  // 1) explicit pounds + ounces fields
  const lbs = firstNumber(obj, /(weightlb|^lbs?$|pounds|weight_?lb|weightmajor)/i);
  const oz = firstNumber(obj, /(weightoz|^oz$|ounces|weight_?oz|weightminor)/i);
  if (lbs !== undefined || oz !== undefined) {
    const total = (lbs || 0) * 16 + (oz || 0);
    if (total > 0) return total;
  }
  // 2) a weight object like { value: 20, unit: "OUNCE" } / "POUND" / "GRAM"
  let viaObj;
  walk(obj, (k, v) => {
    if (viaObj !== undefined) return;
    if (!/weight/i.test(k) || !v || typeof v !== "object") return;
    const val = parseFloat(v.value ?? v.amount ?? v.measure);
    const unit = String(v.unit ?? v.unitOfMeasure ?? v.uom ?? "").toLowerCase();
    if (Number.isNaN(val)) return;
    if (/pound|^lb/.test(unit)) viaObj = val * 16;
    else if (/gram|^g\b/.test(unit)) viaObj = val * 0.035274;
    else viaObj = val; // assume ounces
  });
  if (viaObj && viaObj > 0) return viaObj;
  // 3) bare `weight` number, assumed ounces
  const plain = firstNumber(obj, /^weight$/i);
  if (plain && plain > 0) return plain;
  return undefined;
}

// --- extract a shipment from captured network payloads ----------------------
// Returns null if nothing usable is found yet. `captures` is an array of
// { url, payload } most-recent-last.
EPS.extractFromCaptures = function (captures) {
  // Search newest first; a later payload is more likely the live rate call.
  for (let i = captures.length - 1; i >= 0; i--) {
    const p = captures[i].payload;

    const weightOz = resolveWeightOz(p);

    const len = firstNumber(p, /(length|dimx|^l$|pkglength)/i);
    const wid = firstNumber(p, /(width|dimy|^w$|pkgwidth)/i);
    const hei = firstNumber(p, /(height|depth|dimz|^h$|pkgheight)/i);

    const toZip = firstZip(p, /(tozip|destinationzip|recipient.*(zip|postal)|ship.*to.*(zip|postal)|deliver.*(zip|postal))/i);
    const fromZip = firstZip(p, /(fromzip|originzip|sender.*(zip|postal)|ship.*from.*(zip|postal))/i);

    const service = firstString(
      p,
      /(servicename|shippingservice|mailclass|servicecode|service)/i
    );

    const ebayCost = firstNumber(
      p,
      /(labelcost|shippingcost|ratecost|totalcost|grandtotal|amount|charge|price|total)/i
    );

    if (weightOz && toZip) {
      return {
        weightOz,
        len,
        wid,
        hei,
        toZip,
        fromZip,
        service: service || null,
        ebayCost: ebayCost || null,
        source: "network",
        rawUrl: captures[i].url,
      };
    }
  }
  return null;
};

// --- DOM fallback -----------------------------------------------------------
// Used when no rate payload was captured (e.g. data was server-rendered).
// Replace the selectors with the real ones from your label page. Returns a
// partial shipment; missing fields are fine, the panel degrades gracefully.
EPS.extractFromDom = function () {
  const txt = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.value || el.textContent || "").trim() : "";
  };

  // TODO: pin these to your label page. Left broad on purpose.
  const costText =
    txt('[class*="label-cost"]') ||
    txt('[class*="shipping-cost"]') ||
    txt('[data-test-id*="cost"]');
  const ebayCost = parseFloat(String(costText).replace(/[^0-9.]/g, "")) || null;

  const origin = EPS.originFromDom();
  const toZip = (document.body.innerText.match(/\b\d{5}(?:-\d{4})?\b/) || [])[0];

  if (!ebayCost && !toZip && !origin.zip) return null;
  return {
    weightOz: null,
    len: null,
    wid: null,
    hei: null,
    toZip: toZip || null,
    fromZip: origin.zip,
    originRegionCode: origin.region,
    service: null,
    ebayCost,
    source: "dom",
  };
};

// The "Ship to" and "Ship from / Return to" blocks sit in one shared
// container, each a short heading whose next sibling holds the address. Match
// the heading (kept short so we don't grab the whole container) and read the
// sibling that carries a ZIP -- scanning the container scoops the wrong block.
function labelValue(labelRe, notRe) {
  const nodes = document.querySelectorAll(
    "h1, h2, h3, h4, h5, h6, div, span, p, dt, strong, b, label"
  );
  for (const n of nodes) {
    const t = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > 40 || !labelRe.test(t)) continue;
    if (notRe && notRe.test(t)) continue;
    let sib = n.nextElementSibling;
    for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
      const txt = (sib.innerText || sib.textContent || "").replace(/\s+/g, " ").trim();
      if (/\d{5}/.test(txt)) return txt;
    }
  }
  return "";
}

// --- origin (Ship from / Return to) from the page -------------------------
// e.g. heading "Ship from / Return to" -> "Austin TX 78701-1234".
// Returns { zip, region } using the 5-digit ZIP (drops the +4).
EPS.originFromDom = function () {
  const v = labelValue(/ship\s*from|return\s*to/i, null);
  let zip = pickZip(v);
  let region = zip ? (v.match(/\b([A-Z]{2})\b(?=\s*\d{5})/) || [])[1] || null : null;
  if (!zip) {
    // bulk "Get labels in bulk" rows print the origin as "... from 43213-2131".
    const m = (document.body.innerText || "").match(/\bfrom\s+(\d{5})(?:-\d{4})?/i);
    if (m) zip = m[1];
  }
  return { zip: zip || null, region };
};

// How many shipment rows the bulk page is showing (each has its own lb input).
// 0 on non-bulk pages. Used to only compare when a single combined shipment is
// in view, since the panel describes one shipment at a time.
EPS.bulkRowCount = function () {
  return document.querySelectorAll('input[aria-label="lb"]').length;
};

// Destination ZIP from the "Ship to" block. If no labeled block is found,
// take the last 5-digit ZIP on the page that isn't the origin.
EPS.destFromDom = function (originZip) {
  const v = labelValue(/ship\s*to|deliver\s*to|recipient/i, /ship\s*from|return\s*to/i);
  const zip = pickZip(v);
  if (zip && zip !== originZip) return zip;
  // fallback: last page ZIP that isn't the origin (ZIPs trail addresses)
  const all = (document.body.innerText.match(/\b\d{5}(?:-\d{4})?\b/g) || []).map(
    (z) => z.slice(0, 5)
  );
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i] !== originZip) return all[i];
  }
  return null;
};

// Package dimensions from the label form's inch inputs. Returns {len,wid,hei}
// in inches, or null if none are present.
EPS.dimsFromDom = function () {
  const v = (sel) => {
    const el = document.querySelector(sel);
    const n = el ? parseFloat(el.value) : NaN;
    return Number.isNaN(n) ? null : n;
  };
  const len =
    v('input[name="dimensions.length"]') ??
    v('input[aria-label="Package length in inches"]') ??
    v('input[name="dim-length"]'); // bulk "Get labels in bulk" page
  const wid =
    v('input[name="dimensions.width"]') ??
    v('input[aria-label="Package width in inches"]') ??
    v('input[name="dim-width"]');
  const hei =
    v('input[name="dimensions.height"]') ??
    v('input[aria-label="Package height in inches"]') ??
    v('input[name="dim-height"]');
  if (len || wid || hei) return { len, wid, hei };
  return null;
};

// The service the seller actually selected, from the checked radio. Its id
// looks like "USPS-GROUND_ADVANTAGE-PACKAGE-DROP_OFF"; separators are
// normalised so mapService can read it like a service name.
EPS.serviceFromDom = function () {
  const r = document.querySelector('input[name="service"]:checked');
  return r ? r.id.replace(/[-_]+/g, " ").trim() : null;
};

// The postage eBay is charging: the footer "Total", else the checked service's
// price. Class names on this page are hashed, so anchor on visible text.
EPS.ebayCostFromDom = function () {
  const money = (s) => {
    const m = String(s || "").match(/\$\s?(\d[\d,]*\.\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };
  const leaves = Array.from(document.querySelectorAll("*")).filter((e) => !e.children.length);
  for (const e of leaves) {
    if (!/^total$/i.test((e.textContent || "").trim())) continue;
    const scope = e.closest("div, section, footer") || e.parentElement;
    const c = money(scope && scope.innerText);
    if (c != null) return c;
  }
  const r = document.querySelector('input[name="service"]:checked');
  if (r) {
    const card = r.closest('li, [class*="option"], label') || r.parentElement;
    const c = money(card && card.innerText);
    if (c != null) return c;
  }
  return null;
};

// --- extra services (signature / liability coverage) ----------------------
// eBay's label form has two opt-in checkboxes: "Require signature at delivery"
// and "Additional liability coverage". Auto-match mirrors the seller's choices
// into the Pirate Ship quote so the comparison is like-for-like -- each side's
// total already includes its own add-on fee.
function checkboxByLabel(re) {
  for (const el of document.querySelectorAll('input[type="checkbox"]')) {
    const box = el.closest("label, li, div");
    const ctx = ((box && box.innerText) || el.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
    if (re.test(ctx)) return el;
  }
  return null;
}

// "signature" when the seller required signature, else "none". eBay exposes a
// single standard signature option (no separate adult-signature checkbox).
EPS.signatureFromDom = function () {
  const box = checkboxByLabel(/require signature|signature at delivery/i);
  return box && box.checked ? "signature" : "none";
};

// Value to insure when the seller added liability coverage -- mirrors eBay's
// order value (falls back to item price). Returns 0 when coverage isn't
// selected, so PS isn't charged for insurance eBay isn't applying either.
EPS.insuredValueFromDom = function () {
  const box = checkboxByLabel(/liability coverage|additional coverage/i);
  if (!box || !box.checked) return 0;
  const t = document.body.innerText;
  const num = (m) => (m ? parseFloat(m[1].replace(/,/g, "")) : NaN);
  return (
    num(t.match(/Order value\s*\$?([\d,]+\.\d{2})/)) ||
    num(t.match(/Item price:\s*\$([\d,]+\.\d{2})/)) ||
    0
  );
};

// Write a weight (in ounces) back into eBay's label form, split into the lb/oz
// inputs, and get eBay to commit and re-price it. eBay's fields are
// framework-controlled and only commit a value on a real focus change - so for
// each field: focus, set the value via the native setter + an "input" event,
// then call .blur() (the method - a genuine focus change). Dispatching "change"
// or "blur" *events* does NOT commit and, combined, drives an infinite
// oz<->total reconciliation loop; the .blur() method commits cleanly. eBay
// derives the total from both fields, so commit oz first and let eBay recompute
// before committing lb (otherwise lb reads a stale oz and the total lands wrong).
function setInput(el, value) {
  const proto =
    el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function commitField(el, value) {
  el.focus();
  setInput(el, String(value));
  await wait(120); // let the framework process the input before committing
  el.blur();
  await wait(800); // let eBay re-price before the next field
}

EPS.setWeightDom = function (oz) {
  const lb = Math.floor(oz / 16);
  const rem = Math.round((oz - lb * 16) * 10) / 10;
  // single-label page aria labels, falling back to the bulk page's "lb"/"oz".
  const lbEl =
    document.querySelector('input[aria-label="Package weight in pounds"]') ||
    document.querySelector('input[aria-label="lb"]');
  const ozEl =
    document.querySelector('input[aria-label="Package weight in ounces"]') ||
    document.querySelector('input[aria-label="oz"]');
  if (!lbEl && !ozEl) return false;
  (async () => {
    if (ozEl) await commitField(ozEl, rem);
    if (lbEl) await commitField(lbEl, lb);
  })();
  return true;
};

// Weight from the rendered page. Handles "2 lb 4 oz", "1.5 lbs", "12 oz",
// and weight input fields. Returns total ounces.
EPS.weightFromDom = function () {
  // 0) eBay's label form: lb/oz inputs tagged by aria-label.
  const aria = (label) => {
    const el = document.querySelector(`input[aria-label="${label}"]`);
    const n = el ? parseFloat(el.value) : NaN;
    return Number.isNaN(n) ? undefined : n;
  };
  const albs = aria("Package weight in pounds");
  const aoz = aria("Package weight in ounces");
  if (albs !== undefined || aoz !== undefined) {
    const t = (albs || 0) * 16 + (aoz || 0);
    if (t > 0) return t;
  }
  // 0b) bulk "Get labels in bulk" rows tag the weight inputs aria "lb"/"oz".
  const blb = aria("lb");
  const boz = aria("oz");
  if (blb !== undefined || boz !== undefined) {
    const t = (blb || 0) * 16 + (boz || 0);
    if (t > 0) return t;
  }
  // 1) explicit lb/oz input fields
  const inputs = document.querySelectorAll("input, select");
  let lb, oz;
  for (const el of inputs) {
    const id = ((el.name || "") + " " + (el.id || "") + " " + (el.placeholder || "")).toLowerCase();
    const v = parseFloat(el.value);
    if (Number.isNaN(v)) continue;
    if (/(weight).*(lb|pound)|(^|[^a-z])lbs?([^a-z]|$)/.test(id)) lb = v;
    else if (/(weight).*(oz|ounce)|(^|[^a-z])oz([^a-z]|$)/.test(id)) oz = v;
  }
  if (lb !== undefined || oz !== undefined) {
    const t = (lb || 0) * 16 + (oz || 0);
    if (t > 0) return t;
  }
  // 2) text patterns near a weight label. Drop "Max weight 70 lb ..." hint text
  // first so it isn't mistaken for the package weight (the bulk page shows it).
  const text = (document.body.innerText || "").replace(/max\s+weight[^\n]*/gi, "");
  let m = text.match(/(\d+(?:\.\d+)?)\s*lb[s]?\s*(?:(\d+(?:\.\d+)?)\s*oz)?/i);
  if (m) {
    const t = parseFloat(m[1]) * 16 + (m[2] ? parseFloat(m[2]) : 0);
    if (t > 0) return t;
  }
  m = text.match(/(\d+(?:\.\d+)?)\s*oz\b/i);
  if (m) {
    const t = parseFloat(m[1]);
    if (t > 0) return t;
  }
  return null;
};
