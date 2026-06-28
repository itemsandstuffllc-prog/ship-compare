// Runs in the page's MAIN world at document_start so it patches fetch/XHR
// before eBay's own scripts fire their rate calls. It does not parse anything
// itself; it just forwards response bodies to the isolated content script.

(() => {
  const TAG = "EPS_NET";
  const MAX_BYTES = 600_000; // skip giant payloads (images, bundles)

  function forward(url, method, status, bodyText) {
    if (!bodyText || bodyText.length > MAX_BYTES) return;
    // Only bother with things that look like JSON.
    const t = bodyText.trimStart();
    if (t[0] !== "{" && t[0] !== "[") return;
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return;
    }
    window.postMessage({ source: TAG, url, method, status, payload }, "*");
  }

  // fetch
  const realFetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === "string" ? req : req && req.url ? req.url : "";
    const method =
      (args[1] && args[1].method) ||
      (req && req.method) ||
      "GET";
    return realFetch.apply(this, args).then((res) => {
      try {
        res
          .clone()
          .text()
          .then((txt) => forward(url, method, res.status, txt))
          .catch(() => {});
      } catch {}
      return res;
    });
  };

  // XMLHttpRequest
  const RealXHR = window.XMLHttpRequest;
  const open = RealXHR.prototype.open;
  const send = RealXHR.prototype.send;
  RealXHR.prototype.open = function (method, url) {
    this.__eps = { method, url };
    return open.apply(this, arguments);
  };
  RealXHR.prototype.send = function () {
    this.addEventListener("load", () => {
      try {
        const meta = this.__eps || {};
        const type = this.responseType;
        if (type === "" || type === "text") {
          forward(meta.url, meta.method, this.status, this.responseText);
        } else if (type === "json" && this.response) {
          window.postMessage(
            {
              source: TAG,
              url: meta.url,
              method: meta.method,
              status: this.status,
              payload: this.response,
            },
            "*"
          );
        }
      } catch {}
    });
    return send.apply(this, arguments);
  };
})();
