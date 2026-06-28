// Service worker. Content scripts can't hit ship.pirateship.com directly
// (page CORS), but an extension fetch with host_permissions can. This builds
// the GraphQL rates query and returns parsed rates.

const ENDPOINT = "https://ship.pirateship.com/api/graphql?opname=RatesQuery";

// Slim version of the public rates query: only the fields the panel needs.
// insuredValue and deliveryConfirmation are appended inline (not as variables):
// PS 500s when the DeliveryConfirmation enum is passed as a variable, but takes
// it fine as a literal. Both are sanitised before injection (see addOnArgs).
const RATE_FIELDS = `title
    mailClassKey
    cubicTier
    zone
    totalPrice
    basePrice
    crossedTotalPrice
    cheapest
    fastest
    carrier { carrierKey title }
    surcharges { title price }`;

function buildQuery(extra) {
  return `query RatesQuery($originZip: String!, $destinationZip: String, $isResidential: Boolean, $weight: Float, $dimensionX: Float, $dimensionY: Float, $dimensionZ: Float, $mailClassKeys: [String!]!, $packageTypeKeys: [String!]!) {
  rates(originZip: $originZip, destinationZip: $destinationZip, isResidential: $isResidential, weight: $weight, dimensionX: $dimensionX, dimensionY: $dimensionY, dimensionZ: $dimensionZ, mailClassKeys: $mailClassKeys, packageTypeKeys: $packageTypeKeys${extra}) {
    ${RATE_FIELDS}
  }
}`;
}

// Whitelisted DeliveryConfirmation enum values (lowercase, as PS expects).
const SIGNATURE_OPTIONS = new Set(["signature", "adult_signature"]);

// Build the inline add-on argument string from a shipment, sanitising both
// values so only a number and a known enum can reach the query.
function addOnArgs(s) {
  let extra = "";
  const insured = Number(s.insuredValue);
  if (insured > 0) extra += `, insuredValue: ${insured}`;
  if (SIGNATURE_OPTIONS.has(s.deliveryConfirmation)) {
    extra += `, deliveryConfirmation: ${s.deliveryConfirmation}`;
  }
  return extra;
}

const FLAT_RATE = new Set([
  "FlatRateEnvelope",
  "FlatRateLegalEnvelope",
  "FlatRatePaddedEnvelope",
  "SmallFlatRateBox",
  "MediumFlatRateBox",
  "LargeFlatRateBox",
]);

// PS requires every non-flat-rate parcel to clear the minimum label size
// (6x3x0.25). Below that, or with dims missing, it returns no rates at all --
// it does not fall back to weight-only pricing for a Parcel.
function hasValidDims(s) {
  return s.len >= 6 && s.wid >= 3 && s.hei >= 0.25;
}

function safeDims(s, packageType) {
  if (FLAT_RATE.has(packageType)) return {};
  if (hasValidDims(s)) {
    return { dimensionX: s.len, dimensionY: s.wid, dimensionZ: s.hei };
  }
  return {};
}

async function getRates(shipment) {
  const mailClassKeys = Array.from(
    new Set([shipment.mailClassKey, ...(shipment.alsoQuote || [])].filter(Boolean))
  );
  if (mailClassKeys.length === 0) mailClassKeys.push("GroundAdvantage");

  const packageType = shipment.packageType || "Parcel";

  // PS won't quote a Parcel without valid dims; say so locally instead of
  // burning a request to get an empty list back.
  if (!FLAT_RATE.has(packageType) && !hasValidDims(shipment)) {
    return { ok: false, error: "needs_dims" };
  }

  const variables = {
    originZip: shipment.fromZip || shipment.originZip,
    destinationZip: shipment.toZip,
    isResidential: shipment.isResidential !== false,
    weight: shipment.weightOz,
    mailClassKeys,
    packageTypeKeys: [packageType],
    ...safeDims(shipment, packageType),
  };

  if (!variables.originZip) {
    return { ok: false, error: "no_origin_zip" };
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "RatesQuery",
      query: buildQuery(addOnArgs(shipment)),
      variables,
    }),
  });

  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  const json = await res.json();
  if (json.errors && (!json.data || !json.data.rates)) {
    return { ok: false, error: json.errors[0]?.message || "graphql_error" };
  }
  const rates = (json.data && json.data.rates) || [];
  return { ok: true, rates, quoted: mailClassKeys };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "EPS_GET_RATES") {
    getRates(msg.shipment)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true; // async
  }
});
