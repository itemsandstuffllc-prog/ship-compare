# Ship Compare for eBay + Pirate Ship

Chrome extension (Manifest V3). On an eBay shipping-label page it reads the
shipment, pulls live Pirate Ship postage, and shows a side-by-side panel with a
one-click handoff into Pirate Ship to confirm insurance/signature savings.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open an eBay label page. Panel appears bottom-right.

## How it works

- `src/interceptor.js` — runs in the page's MAIN world at `document_start`,
  monkeypatches `fetch`/`XHR`, forwards JSON responses to the content script.
- `src/ebay-adapter.js` — **the file you tune.** Pulls weight/dims/ZIPs/service/
  cost out of captured payloads with heuristics, maps eBay services to PS mail
  classes. DOM fallback included.
- `src/background.js` — calls Pirate Ship's GraphQL rates endpoint
  (`ship.pirateship.com/api/graphql`). Routed here because the content script
  can't hit it directly (page CORS); an extension fetch with host permission can.
- `src/content.js` — orchestrates, renders the panel, handles the clipboard
  handoff and all states (loading / result / fallback / empty).

## Tuning (do this once)

eBay's label-page network shape is private and shifts. The heuristics work
without exact paths, but to tighten:

1. In the page console: `window.EPS_DEBUG = true`
2. Reload the label. Watch `[EPS] capture …` logs to find the real rate payload.
3. In `ebay-adapter.js`, pin the field paths in `extractFromCaptures` and the
   selectors in `extractFromDom` to what you see. Add any unmapped service
   strings to `mapService`.

If data is server-rendered (no rate XHR fires), only the DOM fallback runs —
pin those selectors to your label page.

## Known limits

- **Inline number is postage only.** PS's rates endpoint returns postage +
  carrier surcharges, not insurance or signature. Those are added inside PS's
  flow — which is the point of the **Copy → paste into Pirate Ship** button.
  That's where your insurance/sig arbitrage actually shows up.
- **Unofficial endpoint.** PS has no public API. This uses the same
  unauthenticated GraphQL call their own rates calculator uses. It can change or
  get blocked without notice. The panel degrades to clipboard-only when it fails,
  so the tool still works if the endpoint breaks.
- **To-address for the clipboard** isn't wired to a real source yet — populate
  `shipment.toAddress` ({name, street1, street2, city, state, zip}) in the
  adapter once you locate it in the payload; until then the copy uses the ZIP.

## Match patterns

`manifest.json` matches a few eBay label URLs. If your label flow lives on a
different path, add it to both `content_scripts` blocks (MAIN and ISOLATED).
