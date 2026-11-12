// Adapted from a sketch by Roni Kaufman (https://ronikaufman.github.io)
// Bokeh particles inspired by https://openprocessing.org/@u180407/724534
// Each Baltimore-area ZIP is drawn as its real boundary, filled with small bokeh lights spread across it.
// Steps through the years, each ZIP showing its estimated electric bill at 2022 usage, compared with the area average in 2022.
// The higher the bill, the more lights a ZIP has and the brighter and yellower they get, from dim purple to bright yellow.
// Neighbouring ZIPs are joined by swaying lines; they sway wider and pulses speed up in years when the rate rises quickly.

const BG = "#0b0b14";           // canvas background (dark, so the lights glow)
const INK = [235, 232, 225];    // outlines, connections and the year label

const PAD = 30;
const MIN_YEAR_FLOOR = 2000;    // ignore plans that start before this
const FRAMES_PER_YEAR = 200;     // playback speed
const OUTLINE_ALPHA = 190;     // boundary line opacity, 0 to 255
const OUTLINE_WEIGHT = 1.1;     // boundary line thickness
const POLY_ALPHA = 45;          // fill opacity of the ZIP polygons, 0 (clear) to 255 (solid)

const LIGHT_MIN = 10;           // lights alive at once in a ZIP at the lowest value
const LIGHT_MAX = 110;          // ... and at the highest value
const LIGHT_ALPHA_MIN = 0.18;   // brightness of the lights at the lowest value, 0 to 1
const LIGHT_ALPHA_MAX = 0.95;   // ... and at the highest value
const LIGHT_BUCKETS = 24;       // colour steps, each with a pre-drawn glow

let nodes = [];
let edges = [];

let ready = false;
let minP = 0, maxP = 1;
let maxChange = 0.01;           // biggest year-over-year rise in any ZIP, to scale the pulse speed
let edgePhase = [];             // where each connection's pulse is along its line, 0 to 1
let lowColor, midColor, highColor;
let tooltipEl;

let yearMin, yearMax;
let yearF;                      // current year as a float, so playback is smooth
let lastYear = null;
let paused = false;

// zoom and pan: screen = world * zoom + (panX, panY)
const ZOOM_MAX = 8;
let zoom = 1, panX = 0, panY = 0;
let dragging = false, dragMoved = 0;

async function setup() {
  const c = createCanvas(600, 600);
  c.parent("canvas-holder");
  pixelDensity(2);
  noFill();

  lowColor = color("#4a35a6");    // purple, kept dim at this end
  midColor = color("#d6457a");    // rose, keeps the middle from turning a muddy brown
  highColor = color("#fff04a");   // bright yellow
  tooltipEl = document.getElementById("tooltip");
  const status = document.getElementById("status");

  let shapes;
  try {
    setStatus("Loading ZIP code boundaries…");
    shapes = await loadZipShapes();
  } catch (err) {
    console.error(err);
    status.textContent = "Could not load ZIP boundaries from MD iMAP. Check the console.";
    return;
  }

  const project = makeProjection(shapes);

  let result;
  try {
    result = await loadZipRates();
  } catch (err) {
    console.error(err);
    result = { byZip: {}, source: "none" };
  }

  let zipCost = {};
  let costError = null;
  try {
    setStatus("Loading household electricity costs…");
    zipCost = await loadZipCost(shapes);
  } catch (err) {
    console.error(err);
    costError = err.message;
  }

  buildNodes(shapes, result.byZip, project, zipCost);
  buildEdges(3);

  zipCostOk = !costError && nodes.some(n => n.base != null);
  costNote = costError || "no census tracts matched your ZIP codes";
  buildControls();
  initSeries();

  if (!nodes.some(n => n.series.some(v => v != null))) {
    status.textContent =
      "No dated rate plans loaded. Add an OpenEI API key in config.js, delete the old data/baltimore-rates.json, and reload.";
  }

  ready = true;
}

// ---------- text and data modes ----------
let zipMode = "lead";       // "lead": estimated bill at 2022 usage by ZIP (shown relative to the area average), "none": just the rate
let areaAvg = 1;            // household-weighted average 2022 bill across all the ZIPs, in dollars. Only used to make ratios.
let zipCostOk = false;
let costNote = "";

function buildControls() {
  const style = document.createElement("style");
  style.textContent = `
    #controls { margin: 0 0 14px; font-size: 0.9rem; }
    #how-to { margin: 0; line-height: 1.4; color: var(--muted, #6b6b76); }
    #data-note { margin: 12px 0 0; font-size: 0.8rem; line-height: 1.4; color: var(--muted, #6b6b76); }`;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "controls";
  bar.innerHTML = `<p id="how-to"></p>`;
  const holder = document.getElementById("canvas-holder");
  holder.insertAdjacentElement("beforebegin", bar);

  const note = document.createElement("p");
  note.id = "data-note";
  note.textContent =
    "Estimates, not metered bills. Each ZIP's electricity use is modeled from 2022 data (built on 2018–2022 survey data) and held fixed; other years show what that same use would cost at that year's average electricity rate. Figures are shown against the area average, not as exact dollar amounts.";
  holder.insertAdjacentElement("afterend", note);

}

function initSeries() {
  zipMode = zipCostOk ? "lead" : "none";
  yearF = yearMin;
  lastYear = null;
  computeSeries();
  updateText();
}

// plain-language explanation, legend note and status line for the current view
function updateText() {
  const lead = zipMode === "lead";

  let how;
  if (lead) {
    how = "Each outlined shape is a ZIP code: more lights, in brighter yellow instead of dim purple, mean a higher estimated electric bill at 2022 usage, and the lines between ZIP codes sway and pulse faster in years when the shared utility rate jumps.";
  } else {
    how = "Each outlined shape is a ZIP code: more lights, in brighter yellow instead of dim purple, mean a higher electricity rate, and the lines between ZIP codes sway and pulse faster in years when the rate jumps.";
  }
  if (!zipCostOk) how += ` (Household spending isn't available: ${costNote}. Put the data file at data/lead-md-2022.csv.)`;
  document.getElementById("how-to").textContent = how;

  const legendNote = document.querySelector(".legend-note");
  if (legendNote) legendNote.textContent = lead ? "Estimated electric bill at 2022 usage, as a percent of the 2022 area average (100% = average)." : "Electricity rate per kWh. More lights means a higher rate.";

  document.getElementById("data-note").hidden = !lead;

  if (nodes.some(n => n.series.some(v => v != null))) {
    document.getElementById("status").textContent =
      `Showing ${yearMin} to ${yearMax}. Hover a ZIP code for details. Scroll to zoom, drag or use the arrow keys to move, click to pause.`;
  }
}

// the rate ($/kWh) a ZIP pays in year y: the average of the rate plans in effect.
function rateFor(plans, y) {
  const prices = activePlans(plans, y).map(p => p.price);
  if (!prices.length) return null;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

// every ZIP's value for every year
//   zipMode "lead": yearly $ = LEAD cost in ANCHOR_YEAR, moved by the rate's change since then
//   zipMode "none": the rate itself, $/kWh
function computeSeries() {
  const all = [];
  for (const n of nodes) {
    const anchor = rateFor(n.plans, ANCHOR_YEAR);
    n.series = []; n.rates = [];
    for (let y = yearMin; y <= yearMax; y++) {
      const rate = rateFor(n.plans, y);
      n.rates.push(rate);
      let v = null;
      if (zipMode === "lead") v = n.base != null && anchor && rate ? n.base * rate / anchor : null;
      else v = rate;
      n.series.push(v);
      if (v != null) all.push(v);
    }
  }

  if (all.length) {
    all.sort((a, b) => a - b);
    minP = all[Math.floor(all.length * 0.02)];
    maxP = all[Math.ceil(all.length * 0.98) - 1];
  }
  // biggest one-year rise, so the pulse speed can be scaled from 0 to 1
  maxChange = 0.01;
  for (const n of nodes) {
    for (let i = 1; i < n.series.length; i++) {
      const a = n.series[i - 1], b = n.series[i];
      if (a != null && b != null && a > 0) maxChange = max(maxChange, (b - a) / a);
    }
  }
  const fmt = v => zipMode === "lead" ? Math.round(v / areaAvg * 100) + "% of average" : (v * 100).toFixed(1) + "¢ per kWh";
  document.getElementById("legend-min").textContent = "Lower: " + fmt(minP);
  document.getElementById("legend-max").textContent = "Higher: " + fmt(maxP);
  lastYear = null;   // re-apply the current year so the lights ease to the new values
}

// equirectangular projection fitted to the canvas, with longitude scaled by cos(lat)
function makeProjection(shapes) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const s of shapes) {
    for (const ring of s.rings) {
      for (const [lon, lat] of ring) {
        minLat = min(minLat, lat); maxLat = max(maxLat, lat);
        minLon = min(minLon, lon); maxLon = max(maxLon, lon);
      }
    }
  }
  const kx = cos(radians((minLat + maxLat) / 2));
  const w = (maxLon - minLon) * kx, h = maxLat - minLat;
  const scale = (width - 2 * PAD) / max(w, h);
  const offX = (width - 2 * PAD - w * scale) / 2;
  const offY = (height - 2 * PAD - h * scale) / 2;
  return (lat, lon) => ({
    x: PAD + offX + (lon - minLon) * kx * scale,
    y: PAD + offY + (maxLat - lat) * scale
  });
}

// ---------- time ----------

const yearStart = y => Date.UTC(y, 0, 1) / 1000;
const yearEnd = y => Date.UTC(y + 1, 0, 1) / 1000 - 1;

// plans in effect at any point during year y
function activePlans(plans, y) {
  return plans.filter(p => p.start <= yearEnd(y) && (p.end == null || p.end >= yearStart(y)));
}

function currentYear() {
  return constrain(floor(yearF), yearMin, yearMax);
}

function stepTime() {
  yearF += 1 / FRAMES_PER_YEAR;
  // hold on the last year for a moment, then loop
  if (yearF > yearMax + 1.6) yearF = yearMin;
}

// ---------- building ----------

function buildNodes(shapes, byZip, project, zipCost) {
  const datedPlans = {};
  let firstYear = Infinity;
  for (const s of shapes) {
    datedPlans[s.zip] = (byZip[s.zip] || []).filter(p => p.start != null);
    for (const p of datedPlans[s.zip]) {
      firstYear = min(firstYear, new Date(p.start * 1000).getUTCFullYear());
    }
  }

  yearMax = new Date().getFullYear();
  yearMin = isFinite(firstYear) ? constrain(firstYear, MIN_YEAR_FLOOR, yearMax) : yearMax;

  nodes = shapes.map(s => {
    const c = project(s.lat, s.lon);
    const rings = s.rings.map(r => r.map(([lon, lat]) => project(lat, lon)));

    // size of the ZIP's biggest piece (used for hover distance)
    const xs = rings[0].map(p => p.x), ys = rings[0].map(p => p.y);
    const R = constrain(min(max(...xs) - min(...xs), max(...ys) - min(...ys)) * 0.45, 5, 18);

    // series and rates are filled in by computeSeries(), which depends on the chosen options
    const plans = datedPlans[s.zip];
    const base = zipCost[s.zip] ? zipCost[s.zip].cost : null;   // LEAD annual $ per household
    const hh = zipCost[s.zip] ? zipCost[s.zip].households : 0;
    return { zip: s.zip, name: s.name, x: c.x, y: c.y, rings, R, plans, series: [], rates: [], base, hh, active: false, t: 0, target: 0, lights: [] };
  });

  // household-weighted average of the 2022 bills, used only to turn dollars into "% of the average"
  let tot = 0, cnt = 0;
  for (const n of nodes) if (n.base != null && n.hh > 0) { tot += n.base * n.hh; cnt += n.hh; }
  areaAvg = cnt > 0 ? tot / cnt : 1;
}

// connect each ZIP to its k nearest neighbours; drawConnections() draws these as swaying lines
function buildEdges(k) {
  const seen = new Set();
  edges = [];
  for (let i = 0; i < nodes.length; i++) {
    const nearest = nodes
      .map((n, j) => ({ j, d: dist(nodes[i].x, nodes[i].y, n.x, n.y) }))
      .filter(o => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, k);
    for (const o of nearest) {
      const key = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
      if (!seen.has(key)) { seen.add(key); edges.push([i, o.j]); }
    }
  }
}

// ---------- drawing ----------

function draw() {
  background(BG);
  if (!ready) return;

  if (!paused) stepTime();
  const year = currentYear();
  if (year !== lastYear) { applyYear(year); lastYear = year; }

  handleArrowPan();

  // everything on the map is drawn in world space, then zoomed and panned
  push();
  translate(panX, panY);
  scale(zoom);

  // boundaries
  for (const n of nodes) {
    n.t = lerp(n.t, n.target, 0.08);   // ease toward the new value
    n.chg = lerp(n.chg || 0, n.chgTarget || 0, 0.05);
    drawBoundary(n);
  }

  drawConnections();

  // bokeh lights
  for (const n of nodes) drawLights(n);
  for (const n of nodes) drawOutline(n);

  const wx = (mouseX - panX) / zoom, wy = (mouseY - panY) / zoom;
  let hovered = null, hoverD = Infinity;
  for (const n of nodes) {
    if (!n.active) drawIdleDot(n);
    const md = dist(wx, wy, n.x, n.y);
    if (md < max(16 / zoom, n.R) && md < hoverD) { hovered = n; hoverD = md; }
  }
  pop();

  drawYear(year);
  updateTooltip(hovered, year);
}

// set each ZIP's target price for this year
function applyYear(year) {
  for (const n of nodes) {
    const v = n.series[year - yearMin];
    if (v == null) { n.active = false; continue; }
    const tt = priceT(v);
    const prev = n.series[year - yearMin - 1];
    n.chgTarget = prev != null && prev > 0 ? constrain((v - prev) / prev / maxChange, 0, 1) : 0;   // 0 = flat or falling, 1 = biggest rise
    if (!n.active) n.t = tt;                          // just appeared: no sweep
    n.target = tt;
    n.active = true;
  }
}

// colour for a position t on the scale: purple (0) -> rose -> yellow (1)
function scaleColor(t) {
  return t < 0.5 ? lerpColor(lowColor, midColor, t * 2) : lerpColor(midColor, highColor, (t - 0.5) * 2);
}

// 0 = cheapest ZIP-year anywhere on the map, 1 = priciest
function priceT(price) {
  if (maxP === minP) return 0.5;
  return constrain((price - minP) / (maxP - minP), 0, 1);
}

function drawBoundary(n) {
  if (n.active) {
    const col = scaleColor(n.t);
    col.setAlpha(POLY_ALPHA);
    fill(col);
  } else {
    noFill();
  }
  noStroke();
  for (const ring of n.rings) {
    beginShape();
    for (const p of ring) vertex(p.x, p.y);
    endShape(CLOSE);
  }
  noFill();
}

// Connections between neighbouring ZIPs: each is a curve that sways like a ribbon in water,
// tinted by the colours of the two ZIPs it joins, with a bright pulse travelling along it.
// In years when the rate rises quickly the lines sway wider and the pulses speed up.
function drawConnections() {
  const time = frameCount * 0.012;
  noFill();
  for (let i = 0; i < edges.length; i++) {
    const A = nodes[edges[i][0]], B = nodes[edges[i][1]];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;                       // sideways direction
    const change = ((A.chg || 0) + (B.chg || 0)) / 2;           // 0 to 1: how fast the rate is rising this year
    const sway = len * (0.12 + 0.18 * change);
    const w1 = sin(time * 1.3 + i * 1.7) * sway + (noise(i, time * 0.6) - 0.5) * sway;
    const w2 = sin(time * 1.0 + i * 2.9 + 2) * sway + (noise(i + 99, time * 0.6) - 0.5) * sway;
    const c1x = A.x + dx * 0.3 + nx * w1, c1y = A.y + dy * 0.3 + ny * w1;
    const c2x = A.x + dx * 0.7 + nx * w2, c2y = A.y + dy * 0.7 + ny * w2;

    const col = lerpColor(scaleColor(A.t), scaleColor(B.t), 0.5);
    stroke(red(col), green(col), blue(col), 70);
    strokeWeight(1 / zoom);
    bezier(A.x, A.y, c1x, c1y, c2x, c2y, B.x, B.y);

    // pulse
    if (edgePhase[i] === undefined) edgePhase[i] = (i * 0.37) % 1;
    edgePhase[i] = (edgePhase[i] + 0.002 + 0.02 * change) % 1;   // slow crawl when flat, fast when the rate jumps
    const u = edgePhase[i];
    const px = bezierPoint(A.x, c1x, c2x, B.x, u), py = bezierPoint(A.y, c1y, c2y, B.y, u);
    noStroke();
    fill(red(col), green(col), blue(col), 60);
    circle(px, py, 9);
    fill(...INK, 230);
    circle(px, py, 2.6);
    noFill();
  }
}

// outlines are drawn on top of the lights so the ZIP boundaries stay easy to see
function drawOutline(n) {
  noFill();
  stroke(...INK, OUTLINE_ALPHA);
  strokeWeight(OUTLINE_WEIGHT / zoom);   // keeps the line the same thickness when zoomed
  for (const ring of n.rings) {
    beginShape();
    for (const p of ring) vertex(p.x, p.y);
    endShape(CLOSE);
  }
}

// a small grey dot for ZIP codes with no data
function drawIdleDot(n) {
  stroke(150, 150, 155, 170);
  strokeWeight(1);
  circle(n.x, n.y, 5);
}

// One bokeh light of one colour of the scale, drawn once and reused:
// a round, see-through disc with a brighter rim and a very slightly soft edge.
const spriteCache = [];
function lightSprite(bucket) {
  if (spriteCache[bucket]) return spriteCache[bucket];
  const c = scaleColor(bucket / (LIGHT_BUCKETS - 1)).levels;
  const size = 128, h = size / 2, cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  const rgba = a => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

  g.beginPath();
  g.arc(h, h, h * 0.8, 0, TWO_PI);
  g.fillStyle = rgba(0.34);          // flat, see-through middle
  g.fill();
  g.shadowColor = rgba(0.9);         // soft glow around the rim
  g.shadowBlur = 5;
  g.lineWidth = 5;
  g.strokeStyle = rgba(1);           // brighter rim
  g.stroke();
  return (spriteCache[bucket] = cv);
}

// the width of a ZIP's polygon as a square would have it, so lights can be sized relative to it
function zipSpan(n) {
  if (n.span === undefined) {
    let area = 0;
    for (const ring of n.rings) {
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
      area += abs(a) / 2;
    }
    n.span = sqrt(area);
  }
  return n.span;
}

// random spot inside a ZIP's own boundary (any of its pieces), so lights spread over the whole shape
function randomPointIn(n) {
  if (!n.box) {
    const all = n.rings.flat();
    n.box = { x0: min(all.map(p => p.x)), x1: max(all.map(p => p.x)), y0: min(all.map(p => p.y)), y1: max(all.map(p => p.y)) };
  }
  for (let tries = 0; tries < 40; tries++) {
    const x = random(n.box.x0, n.box.x1), y = random(n.box.y0, n.box.y1);
    if (n.rings.some(r => pointInPolygon(x, y, r))) return { x, y };
  }
  return { x: n.x, y: n.y };
}

function pointInPolygon(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// A ZIP holds LIGHT_MIN..LIGHT_MAX lights, depending on its value. Every light in a ZIP shares one
// brightness that rises with the value, and stays put (it only wobbles a couple of pixels).
// When the value changes, lights are added or removed, and take the ZIP's current colour.
function drawLights(n) {
  const want = n.active ? round(lerp(LIGHT_MIN, LIGHT_MAX, n.t)) : 0;
  const bucket = round(n.t * (LIGHT_BUCKETS - 1));
  const alive = n.lights.filter(L => !L.dying).length;

  for (let k = alive; k < want; k++) {
    const pt = randomPointIn(n);
    n.lights.push({
      hx: pt.x - n.x, hy: pt.y - n.y, ph: random(TWO_PI), sp: random(0.004, 0.012),
      // size is relative to the ZIP: mostly small lights, a few big ones
      size: constrain(zipSpan(n) * (0.05 + 0.24 * random() ** 2), 3, 44),
      bucket, a: 0, dying: false
    });
  }
  for (let k = alive, i = n.lights.length - 1; k > want && i >= 0; i--) {
    if (!n.lights[i].dying) { n.lights[i].dying = true; k--; }
  }

  const ctx = drawingContext;
  for (let i = n.lights.length - 1; i >= 0; i--) {
    const L = n.lights[i];
    L.bucket = bucket;                                       // every light follows the ZIP's current colour
    L.a = constrain(L.a + (L.dying ? -0.05 : 0.05), 0, 1);   // quick fade only when added or removed
    if (L.dying && L.a <= 0) { n.lights.splice(i, 1); continue; }
    L.ph += L.sp;
    const x = n.x + L.hx + cos(L.ph) * 2, y = n.y + L.hy + sin(L.ph * 1.3) * 2;
    ctx.globalAlpha = lerp(LIGHT_ALPHA_MIN, LIGHT_ALPHA_MAX, n.t) * L.a;   // brighter as the value rises
    ctx.drawImage(lightSprite(L.bucket), x - L.size / 2, y - L.size / 2, L.size, L.size);
  }
  ctx.globalAlpha = 1;
}

function drawYear(year) {
  push();
  noStroke();
  fill(...INK, 220);
  textAlign(LEFT, TOP);
  textFont("'Linotype Didot', 'Didot', 'Bodoni Moda', serif");
  textStyle(NORMAL);
  textSize(36);
  text(year, 16, 12);
  pop();
}

// 1.12 -> "12% above", 0.9 -> "10% below"
function vsAverage(ratio) {
  const pct = Math.round((ratio - 1) * 100);
  return pct === 0 ? "about the same as" : `${Math.abs(pct)}% ${pct > 0 ? "above" : "below"}`;
}

function updateTooltip(n, year) {
  if (!n) { tooltipEl.hidden = true; return; }
  tooltipEl.hidden = false;

  const v = n.series[year - yearMin];
  if (v == null) {
    tooltipEl.innerHTML = `<strong>${n.zip} ${n.name || ""}, ${year}</strong>No data for this year`;
  } else {
    const rate = n.rates[year - yearMin];
    let bill = "";
    if (zipMode === "lead") {
      bill = `Bill at 2022 usage: ${vsAverage(v / areaAvg)} the 2022 area average<br>` +
        `Compared with other ZIP codes: ${vsAverage(n.base / areaAvg)} the area average<br>`;
    }
    tooltipEl.innerHTML =
      `<strong>${n.zip} ${n.name || ""}, ${year}</strong>` +
      `${bill}Electricity rate: ${(rate * 100).toFixed(1)}¢ per kWh`;
  }
  tooltipEl.style.left = (winMouseX + 14) + "px";
  tooltipEl.style.top = (winMouseY + 14) + "px";
}

// ---------- controls ----------
// Mouse wheel or + / -  zoom        Drag or arrow keys  move the map
// Double-click or 0     reset       Click  pause / play       Shift + left / right arrow  step a year

const overCanvas = () => mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height;

function limitPan() {
  panX = constrain(panX, width * (1 - zoom), 0);
  panY = constrain(panY, height * (1 - zoom), 0);
}

// zoom toward a point on the canvas so that point stays under the cursor
function zoomAt(mx, my, factor) {
  const k = constrain(zoom * factor, 1, ZOOM_MAX);
  panX = mx - (mx - panX) * (k / zoom);
  panY = my - (my - panY) * (k / zoom);
  zoom = k;
  limitPan();
}

function resetView() { zoom = 1; panX = 0; panY = 0; }

function handleArrowPan() {
  if (keyIsDown(SHIFT)) return;
  const step = 9;
  if (keyIsDown(LEFT_ARROW)) panX += step;
  if (keyIsDown(RIGHT_ARROW)) panX -= step;
  if (keyIsDown(UP_ARROW)) panY += step;
  if (keyIsDown(DOWN_ARROW)) panY -= step;
  limitPan();
}

function mouseWheel(event) {
  if (!ready || !overCanvas()) return;
  zoomAt(mouseX, mouseY, Math.exp(-event.delta * 0.0015));
  return false;                       // stop the page from scrolling
}

function mousePressed() {
  if (!overCanvas()) return;
  dragging = true; dragMoved = 0;
}

function mouseDragged() {
  if (!dragging) return;
  dragMoved += abs(mouseX - pmouseX) + abs(mouseY - pmouseY);
  panX += mouseX - pmouseX;
  panY += mouseY - pmouseY;
  limitPan();
}

function mouseReleased() {
  if (dragging && dragMoved < 5) paused = !paused;   // a click, not a drag
  dragging = false;
}

function doubleClicked() {
  if (overCanvas()) resetView();   // the two clicks before it cancel out, so pause is unchanged
}

function keyPressed() {
  if (!ready) return;
  if (keyIsDown(SHIFT) && keyCode === LEFT_ARROW) { yearF = constrain(currentYear() - 1, yearMin, yearMax); paused = true; }
  if (keyIsDown(SHIFT) && keyCode === RIGHT_ARROW) { yearF = constrain(currentYear() + 1, yearMin, yearMax); paused = true; }
  if (key === "+" || key === "=") zoomAt(width / 2, height / 2, 1.3);
  if (key === "-" || key === "_") zoomAt(width / 2, height / 2, 1 / 1.3);
  if (key === "0") resetView();
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return false;   // keep the page from scrolling
}