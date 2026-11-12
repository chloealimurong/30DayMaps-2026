// Two data sources:
//   1. ZIP polygons: MD iMAP "Zip Codes - 5 Digit" (MD_PoliticalBoundaries, layer 4)
//   2. Rate plans per ZIP: OpenEI USURDB, including each plan's start and end date
//
// Rates are loaded in this order:
//   a. ../data/baltimore-rates.json  (cached copy, no API key needed)
//      Only used if its plans carry dates. An older cache without dates is ignored.
//   b. the live API, one request per ZIP (needs CONFIG.API_KEY)
//   If neither is available, no rates are shown (ZIPs draw as grey outlines).
//
// After a live load, run downloadRates() in the browser console to save the JSON,
// then put it in data/baltimore-rates.json.

const ZIP_LAYER =
  "https://mdgeodata.md.gov/imap/rest/services/Boundaries/MD_PoliticalBoundaries/MapServer/4/query";

// Baltimore city plus nearby ZIPs. Edit freely.
const ZIP_CODES = [
  "21201", "21202", "21205", "21206", "21207", "21208", "21209", "21210",
  "21211", "21212", "21213", "21214", "21215", "21216", "21217", "21218",
  "21219", "21220", "21221", "21222", "21223", "21224", "21225", "21227",
  "21228", "21229", "21230", "21231", "21234", "21236", "21237", "21239",
  "21030", "21043", "21045", "21061", "21093", "21117", "21122"
];

let lastRates = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const setStatus = msg => { document.getElementById("status").textContent = msg; };

// ---------- ZIP shapes ----------

// Returns [{ zip, name, rings: [[ [lon,lat], ... ], ...], lat, lon }]
// rings are outer rings only, largest first. lat/lon is the centroid of the largest ring.
async function loadZipShapes() {
  const list = ZIP_CODES.map(z => `'${z}'`).join(",");
  const params = new URLSearchParams({
    where: `ZIPCODE1 IN (${list})`,
    outFields: "ZIPCODE1,ZIPNAME",
    outSR: "4326",                 // lon/lat
    returnGeometry: "true",
    maxAllowableOffset: "0.0004",  // simplify, in degrees
    geometryPrecision: "5",
    f: "geojson"
  });

  const res = await fetch(`${ZIP_LAYER}?${params}`);
  if (!res.ok) throw new Error(`ZIP layer request failed (${res.status})`);
  const json = await res.json();
  if (!json.features) throw new Error("ZIP layer returned no features");

  // a ZIP can come back as several features, so group them
  const byZip = {};
  for (const f of json.features) {
    const zip = f.properties.ZIPCODE1;
    if (!f.geometry) continue;
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    byZip[zip] = byZip[zip] || { zip, name: f.properties.ZIPNAME, rings: [] };
    for (const poly of polys) byZip[zip].rings.push(poly[0]); // outer ring, ignore holes
  }

  return Object.values(byZip).map(s => {
    const stats = s.rings.map(r => ({ ring: r, ...ringCentroid(r) }));
    stats.sort((a, b) => b.area - a.area);
    return {
      zip: s.zip,
      name: s.name,
      rings: stats.map(o => o.ring),
      lat: stats[0].lat,
      lon: stats[0].lon
    };
  });
}

function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  a *= 0.5;
  if (a === 0) { // degenerate ring, fall back to the mean of its points
    const n = ring.length;
    return { area: 0, lon: ring.reduce((s, p) => s + p[0], 0) / n, lat: ring.reduce((s, p) => s + p[1], 0) / n };
  }
  return { area: Math.abs(a), lon: cx / (6 * a), lat: cy / (6 * a) };
}

// ---------- Rates ----------

// true if at least one cached plan has a start date
function hasDates(byZip) {
  return Object.values(byZip).some(plans => plans.some(p => p.start != null));
}

async function loadZipRates() {
  // a. cached file
  try {
    const res = await fetch("../data/baltimore-rates.json");
    if (res.ok) {
      const byZip = await res.json();
      if (hasDates(byZip)) {
        lastRates = byZip;
        return { byZip, source: "file" };
      }
      console.warn("data/baltimore-rates.json has no plan dates. Reloading from the API.");
    }
  } catch (err) { /* fall through */ }

  // no usable cache and no key: nothing to show
  if (!CONFIG.API_KEY) return { byZip: {}, source: "none" };

  // b. live API
  const byZip = {};
  for (let k = 0; k < ZIP_CODES.length; k++) {
    setStatus(`Loading rates… ${k + 1} of ${ZIP_CODES.length} ZIP codes`);
    byZip[ZIP_CODES[k]] = await fetchZip(ZIP_CODES[k]);
    await sleep(250); // be polite to the API
  }
  lastRates = byZip;
  return { byZip, source: "api" };
}

async function fetchZip(zip) {
  const params = new URLSearchParams({
    version: "8",
    format: "json",
    api_key: CONFIG.API_KEY,
    address: zip,
    sector: CONFIG.SECTOR,
    approved: "true",
    detail: "full",
    limit: "500"
  });
  try {
    const res = await fetch(`https://api.openei.org/utility_rates?${params}`);
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    return (json.items || []).map(normalizeRate).filter(r => r !== null);
  } catch (err) {
    console.warn(`ZIP ${zip} failed`, err);
    return [];
  }
}

// OpenEI gives dates as Unix seconds. Accept ISO strings too, and repair
// years entered with a typo like "0022-".
function toSeconds(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") v = v.replace(/^00(\d{2})-/, "20$1-");
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms / 1000;
}

// energyratestructure is [period][tier] = { rate, adj, max, unit }
// Every period/tier is averaged into one price. Ended plans are kept, because
// the map steps through the years.
function normalizeRate(item) {
  const prices = [];
  for (const period of item.energyratestructure || []) {
    for (const tier of period) {
      const p = (tier.rate || 0) + (tier.adj || 0);
      if (p > 0) prices.push(p);
    }
  }
  if (prices.length === 0) return null;

  return {
    price: prices.reduce((a, b) => a + b, 0) / prices.length,
    start: toSeconds(item.startdate),
    end: toSeconds(item.enddate)
  };
}

// run downloadRates() in the console after a live load
function downloadRates() {
  if (!lastRates) return console.warn("No rates loaded yet.");
  const blob = new Blob([JSON.stringify(lastRates)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "baltimore-rates.json";
  a.click();
}