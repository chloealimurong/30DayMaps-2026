// Adapted from a sketch by Roni Kaufman (https://ronikaufman.github.io)
// Each Baltimore-area ZIP is drawn as its real boundary with a spiral at its centre.
// The map steps through the years. In each year a ZIP's price is the average of the rate
// plans in effect that year. Higher price = a tighter, faster spiral and a colour closer to red.

const BG = "#ffffff";           
const DISPLAY_FONT = '"Linotype Didot", Didot, "Bodoni Moda", serif';
const INK = [30, 30, 40];       // outlines, connections and the year label

const PAD = 30;
const MIN_YEAR_FLOOR = 2000;    // ignore plans that start before this
const FRAMES_PER_YEAR = 50;     // playback speed

let nodes = [];
let edges = [];

let ready = false;
let minP = 0, maxP = 1;
let lowColor, highColor;
let tooltipEl;

let yearMin, yearMax;
let yearF;                      // current year as a float, so playback is smooth
let lastYear = null;
let paused = false;

async function setup() {
  const c = createCanvas(600, 600);
  c.parent("canvas-holder");
  pixelDensity(2);
  noFill();

  lowColor = color("#241773");    // Ravens purple
  highColor = color("#ff3b30");   // red
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

  buildNodes(shapes, result.byZip, project);
  buildEdges(3);

  const withPrices = nodes.filter(n => n.series.some(v => v != null)).length;
  if (result.source === "none" || withPrices === 0) {
    status.textContent =
      "No dated rate plans loaded. Add an OpenEI API key in config.js, delete the old data/baltimore-rates.json, and reload.";
  } else {
    status.textContent =
      `${withPrices} of ${nodes.length} ZIP codes have dated rate plans, ${yearMin} to ${yearMax}. ` +
      "Click to pause, arrow keys to step.";
  }

  yearF = yearMin;
  ready = true;
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

function buildNodes(shapes, byZip, project) {
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

  const all = [];
  nodes = shapes.map(s => {
    const c = project(s.lat, s.lon);
    const rings = s.rings.map(r => r.map(([lon, lat]) => project(lat, lon)));

    // ring radius from the size of the ZIP's biggest piece
    const xs = rings[0].map(p => p.x), ys = rings[0].map(p => p.y);
    const R = constrain(min(max(...xs) - min(...xs), max(...ys) - min(...ys)) * 0.45, 5, 18);

    // average price of the plans in effect, for every year (null if none)
    const plans = datedPlans[s.zip];
    const series = [];
    for (let y = yearMin; y <= yearMax; y++) {
      const active = activePlans(plans, y);
      const v = active.length ? active.reduce((a, p) => a + p.price, 0) / active.length : null;
      series.push(v);
      if (v != null) all.push(v);
    }

    return { zip: s.zip, name: s.name, x: c.x, y: c.y, rings, R, plans, series, active: false, t: 0, target: 0, flash: 0, rot: random(TWO_PI) };
  });

  if (all.length) { minP = min(all); maxP = max(all); }
  document.getElementById("legend-min").textContent = "$" + minP.toFixed(3);
  document.getElementById("legend-max").textContent = "$" + maxP.toFixed(3);
}

// connect each ZIP to its k nearest neighbours (the "graph" from the original)
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

  // boundaries
  for (const n of nodes) {
    n.t = lerp(n.t, n.target, 0.08);   // ease toward the new price
    n.flash *= 0.94;
    if (!paused) n.rot += 0.01 + n.t * 0.04;   // pricier ZIPs swirl faster
    drawBoundary(n);
  }

  // connections
  stroke(...INK, 40);
  strokeWeight(1);
  for (const [a, b] of edges) line(nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y);

  // concentric rings on top
  let hovered = null, hoverD = Infinity;
  for (const n of nodes) {
    drawRings(n);
    const md = dist(mouseX, mouseY, n.x, n.y);
    if (md < max(16, n.R) && md < hoverD) { hovered = n; hoverD = md; }
  }

  drawYear(year);
  updateTooltip(hovered, year);
}

// set each ZIP's target price for this year
function applyYear(year) {
  for (const n of nodes) {
    const v = n.series[year - yearMin];
    if (v == null) { n.active = false; continue; }
    const tt = priceT(v);
    if (!n.active) n.t = tt;                          // just appeared: no colour sweep
    else if (abs(tt - n.target) > 0.002) n.flash = 1; // price changed: brief pulse
    n.target = tt;
    n.active = true;
  }
}

// 0 = cheapest ZIP-year anywhere on the map, 1 = priciest
function priceT(price) {
  if (maxP === minP) return 0.5;
  return constrain((price - minP) / (maxP - minP), 0, 1);
}

function drawBoundary(n) {
  if (n.active) {
    const col = lerpColor(lowColor, highColor, n.t);
    col.setAlpha(40 + n.flash * 70);
    fill(col);
  } else {
    noFill();
  }
  stroke(...INK, 60);
  strokeWeight(0.75);
  for (const ring of n.rings) {
    beginShape();
    for (const p of ring) vertex(p.x, p.y);
    endShape(CLOSE);
  }
  noFill();
}

function drawRings(n) {
  if (!n.active) {
    stroke(150, 150, 155, 170);
    strokeWeight(1);
    circle(n.x, n.y, 5);
    return;
  }

  stroke(lerpColor(lowColor, highColor, n.t));
  strokeWeight(1 + n.flash * 1.2);

  // higher price = more turns packed into the same radius, so the spiral winds tighter
  const turns = lerp(1.5, 6, n.t);
  const total = turns * TWO_PI;
  beginShape();
  for (let a = 0; a <= total; a += 0.12) {
    const r = n.R * (a / total);   // radius grows steadily from the centre out to R
    vertex(n.x + r * cos(a + n.rot), n.y + r * sin(a + n.rot));
  }
  endShape();
}

function drawYear(year) {
  push();
  noStroke();
  fill(...INK, 220);
  textFont("Bodoni Moda");
  textStyle(NORMAL);
  textAlign(LEFT, TOP);
  textSize(34);
  text(year, 16, 12);
  pop();
}

function updateTooltip(n, year) {
  if (!n) { tooltipEl.hidden = true; return; }
  tooltipEl.hidden = false;

  const v = n.series[year - yearMin];
  if (v == null) {
    tooltipEl.innerHTML = `<strong>${n.zip} ${n.name || ""}</strong>No rate plans in effect in ${year}`;
  } else {
    const active = activePlans(n.plans, year);
    const utilities = [...new Set(active.map(p => p.utility))].join(", ");
    tooltipEl.innerHTML =
      `<strong>${n.zip} ${n.name || ""}, ${year}</strong>${utilities}<br>` +
      `avg $${v.toFixed(3)}/kWh across ${active.length} plan${active.length === 1 ? "" : "s"}`;
  }
  tooltipEl.style.left = (winMouseX + 14) + "px";
  tooltipEl.style.top = (winMouseY + 14) + "px";
}

// ---------- controls ----------

function mousePressed() {
  if (mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height) paused = !paused;
}

function keyPressed() {
  if (!ready) return;
  if (keyCode === LEFT_ARROW) { yearF = constrain(currentYear() - 1, yearMin, yearMax); paused = true; }
  if (keyCode === RIGHT_ARROW) { yearF = constrain(currentYear() + 1, yearMin, yearMax); paused = true; }
}