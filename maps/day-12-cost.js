// What households actually spend on electricity, by ZIP.
//
// Sources
//   1. DOE LEAD Tool, 2022 update (ACS 2018-2022, calibrated to EIA-861 utility revenue).
//      Modeled annual household electricity spending by census tract. Download:
//      https://data.openei.org/files/6219/MD-2022-LEAD-data.zip
//      The raw tract file (MD_AMI_Census_Tracts_2022.csv) is 130 MB, too big to load in a page.
//      data/lead-md-2022.csv is that file summed to one row per tract:
//        fip, households (sum of "ELEP UNITS"), total_electricity_spend (sum of "ELEP*UNITS")
//   2. Census tract 2020 internal points from MD iMAP (layer 2, attributes only).
//
// A tract is assigned to the ZIP whose boundary contains the tract's internal point,
// and a ZIP's cost is the household-weighted average of its tracts.
//
// day-12.js then turns this into a value for each year:
//   bill(year) = ZIP cost in ANCHOR_YEAR  x  rate(year) / rate(ANCHOR_YEAR)
// i.e. the 2022 figure (2022 usage), moved up or down by how the average rate changed.

const LEAD_CSV = "../data/lead-md-2022.csv";
const ANCHOR_YEAR = 2022;       // LEAD 2022 = ACS 2018-2022
const TRACT_LAYER =
  "https://mdgeodata.md.gov/imap/rest/services/Demographics/MD_CensusBoundaries/MapServer/2/query";

// ---------- CSV ----------

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- LEAD -> tract totals ----------

// returns { tractGeoid: { households, spend } }  (spend = total annual $ for those households)
function leadByTract(text) {
  const rows = parseCSV(text);
  const header = rows[0].map(h => h.trim());
  const id = header.indexOf("fip");
  const units = header.indexOf("households");
  const spendCol = header.indexOf("total_electricity_spend");
  if (id < 0 || units < 0 || spendCol < 0) {
    throw new Error("lead-md-2022.csv needs the columns fip, households, total_electricity_spend. Header was: " + header.join(", "));
  }

  const out = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const geoid = String(row[id]).replace(/\D/g, "").padStart(11, "0");
    const hh = parseFloat(row[units]);
    const spend = parseFloat(row[spendCol]);
    if (!(hh > 0) || !isFinite(spend)) continue;
    const t = (out[geoid] = out[geoid] || { households: 0, spend: 0 });
    t.households += hh;
    t.spend += spend;
  }
  return out;
}

// ---------- tract internal points ----------

async function loadTractPoints() {
  const params = new URLSearchParams({
    where: "STATEFP20='24'",
    outFields: "GEOID20,INTPTLAT20,INTPTLON20",
    returnGeometry: "false",
    f: "json"
  });
  const res = await fetch(`${TRACT_LAYER}?${params}`);
  if (!res.ok) throw new Error(`Tract layer request failed (${res.status})`);
  const json = await res.json();
  if (!json.features) throw new Error("Tract layer returned no features");

  const out = {};
  for (const f of json.features) {
    const a = f.attributes;
    const lat = parseFloat(a.INTPTLAT20), lon = parseFloat(a.INTPTLON20);
    if (isFinite(lat) && isFinite(lon)) out[a.GEOID20] = { lat, lon };
  }
  return out;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- ZIP costs ----------

// shapes: output of loadZipShapes()  ->  { zip: { cost, households } }
async function loadZipCost(shapes) {
  const res = await fetch(LEAD_CSV);
  if (!res.ok) throw new Error(`Missing ${LEAD_CSV} (${res.status}). See the header of day-12-cost.js.`);
  const lead = leadByTract(await res.text());
  const points = await loadTractPoints();

  const acc = {};
  for (const [geoid, t] of Object.entries(lead)) {
    const p = points[geoid];
    if (!p) continue;
    const hit = shapes.find(s => s.rings.some(r => pointInRing(p.lon, p.lat, r)));
    if (!hit) continue;
    const a = (acc[hit.zip] = acc[hit.zip] || { households: 0, spend: 0 });
    a.households += t.households;
    a.spend += t.spend;
  }

  const byZip = {};
  for (const [zip, a] of Object.entries(acc)) {
    byZip[zip] = { cost: a.spend / a.households, households: a.households };
  }
  return byZip;
}