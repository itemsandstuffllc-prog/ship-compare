// Runs on ship.pirateship.com. When the panel hands a shipment off (deep-link
// into the eBay import), it leaves the package data in chrome.storage.local.
// Pirate Ship's native import fills the address but NOT the weight or
// dimensions, so this fills those once the ship form renders -- matched to the
// right order and only into empty fields, so it never clobbers manual edits.

(() => {
  const KEY = "eps_handoff";
  const MAX_AGE_MS = 10 * 60 * 1000; // ignore stale handoffs
  const FIELD = "packagePreset.packageDetails.package.";
  const q = (name) => document.querySelector(`input[name="${name}"]`);

  // Pirate Ship's package inputs are React-controlled, so a plain value
  // assignment is ignored. Use the native setter, then fire the events React
  // listens for so its state tracks the new value.
  function setReactValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  const formReady = () => q(FIELD + "dimensionX") && q(FIELD + "weightPounds");

  // The ship page prints "eBay Order <id>"; only fill when that order is the one
  // on screen, so we never write one order's package onto another.
  const orderOnPage = (id) =>
    !id || (document.body.innerText || "").includes(id);

  function fillEmpty(el, value) {
    const n = Number(value);
    if (!el || el.value || !(n > 0)) return false;
    setReactValue(el, String(value));
    return true;
  }

  function apply(h) {
    let did = false;
    did = fillEmpty(q(FIELD + "dimensionX"), h.len) || did;
    did = fillEmpty(q(FIELD + "dimensionY"), h.wid) || did;
    did = fillEmpty(q(FIELD + "dimensionZ"), h.hei) || did;
    if (h.weightOz > 0) {
      const total = Math.round(h.weightOz * 10) / 10;
      const lb = Math.floor(total / 16);
      const oz = Math.round((total - lb * 16) * 10) / 10;
      // weight needs both fields, so seed a 0 rather than leaving one blank
      const wlb = q(FIELD + "weightPounds");
      const woz = q(FIELD + "weightOunces");
      if (wlb && !wlb.value) {
        setReactValue(wlb, String(lb));
        did = true;
      }
      if (woz && !woz.value) {
        setReactValue(woz, String(oz));
        did = true;
      }
    }
    return did;
  }

  function run(h) {
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 360) return clearInterval(timer); // give up after ~3 min
      if (!formReady() || !orderOnPage(h.orderId)) return;
      clearInterval(timer);
      apply(h);
      try {
        chrome.storage.local.remove(KEY);
      } catch {}
    }, 500);
  }

  try {
    chrome.storage.local.get(KEY, (r) => {
      const h = r && r[KEY];
      if (!h) return;
      if (!h.ts || Date.now() - h.ts > MAX_AGE_MS) {
        try {
          chrome.storage.local.remove(KEY);
        } catch {}
        return;
      }
      if (!(h.weightOz > 0) && !(h.len > 0) && !(h.wid > 0) && !(h.hei > 0)) return;
      run(h);
    });
  } catch {}
})();
