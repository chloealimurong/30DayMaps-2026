const W = window.innerWidth, H = window.innerHeight;
const S = Math.min(W / 1600, H / 1000);    // scales the map to fit any window
const T = Math.max(S, 0.75);               // text scale (never tiny)
const GRID = 50;
const MAX_LINK = 70 * S;
const MAX_ZOOM = 12;
const FONT = `"Century Gothic", CenturyGothic, Questrial, "Avenir Next", sans-serif`;
const US_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";

let proj, subs = [], cities = [], gridLayer, linkLayer, dotLayer, pulses = [], labels = [];
let urbanSubs = [], ruralSubs = [], linkedSubs = [];
let landPath = null;                       // US outline as a Path2D, in world coordinates

// view: screen = world * k + (x, y)
const view = { k: 1, x: 0, y: 0 };
let drawn = { k: 1, x: 0, y: 0 };
let dirty = false, lastChange = 0, ready = false;
let showCityNames = false;

const P = {
  bg:        [226, 238, 222],            // pale sage outside the US
  land:      [172, 216, 146],            // solid light green US
  grid:      [255, 255, 255, 140],
  link:      [240, 185, 30, 40],
  dotUrban:  [250, 190, 20, 205],
  dotRural:  [255, 250, 220, 235],
  cityHalo:  [255, 215, 70, 60],
  cityCore:  [255, 232, 120, 240],
  pulse:     [255, 246, 200, 240],
  label:     [22, 66, 38, 235],
};

const rgba = (c) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;
const toScreen = (x, y) => [x * view.k + view.x, y * view.k + view.y];
const newBox = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const grow = (b, p) => {
  b.x0 = Math.min(b.x0, p[0]); b.x1 = Math.max(b.x1, p[0]);
  b.y0 = Math.min(b.y0, p[1]); b.y1 = Math.max(b.y1, p[1]);
};

class City {
    constructor(x, y, pop, name) {
        this.x = x;
        this.y = y;
        this.pop = pop;
        this.name = name;
    }
  show() {
    const [sx, sy] = toScreen(this.x, this.y);
    if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) return;
    const r = (sqrt(this.pop) / 90) * S * Math.sqrt(view.k);
    noStroke();
    fill(...P.cityHalo); circle(sx, sy, r * 3);
    fill(...P.cityCore); circle(sx, sy, r);
  }
}

class Substation {
  constructor(x, y, kv) { this.x = x; this.y = y; this.kv = kv; this.city = null; }
  link(cities) {
    let best = Infinity, nearest = null;
    for (const c of cities) {
      const d = Math.hypot(this.x - c.x, this.y - c.y);
      if (d < best) { best = d; nearest = c; }
    }
    this.city = best < MAX_LINK ? nearest : null;
  }
}

class Pulse {
  constructor(s) { this.s = s; this.t = random(); this.speed = random(0.002, 0.006); }
  show() {
    this.t = (this.t + this.speed) % 1;
    const [sx, sy] = toScreen(
      lerp(this.s.x, this.s.city.x, this.t),
      lerp(this.s.y, this.s.city.y, this.t)
    );
    if (sx < 0 || sx > W || sy < 0 || sy > H) return;
    fill(...P.pulse);
    circle(sx, sy, 2.2 * S * Math.sqrt(view.k));
  }
}

async function setup() {
  createCanvas(W, H);
  createCityToggle();
  background(...P.bg);
    fill(...P.label);
    textAlign(CENTER, CENTER);
    textFont(FONT);
    textSize(18);
    text(
    "LOADING SUBSTATIONS",
    W / 2,
    H / 2 - 75
    );
    textSize(13);
    text(
    "Please wait...",
    W / 2,
    H / 2 + 65
    );

  try {
    await document.fonts.load("400 16px Questrial");
    await document.fonts.load("700 16px Questrial");
  } catch (e) {}

  proj = d3.geoAlbersUsa().scale(1300 * S).translate([W / 2, H / 2]);

  const [sFeat, cFeat, us] = await Promise.all([
    fetchAll(SUB_URL,  { fields: "MAX_VOLT", orderBy: "OBJECTID_1", pageSize: 2000 }),
    fetchAll(CITY_URL, { fields: "NAME,POPULATION", where: "POPULATION > 100000" }),
    d3.json(US_URL).catch(e => { console.warn("Could not load US outline:", e); return null; }),
  ]);

  if (us) {
    const nation = topojson.feature(us, us.objects.nation);
    landPath = new Path2D(d3.geoPath(proj)(nation));
  }

  for (const f of cFeat) {
    const p = proj(f.geometry.coordinates);
    if (p) cities.push(new City(p[0], p[1], +f.properties.POPULATION,f.properties.NAME));
  }

  const ak = newBox(), hi = newBox();
  for (const f of sFeat) {
    const [lon, lat] = f.geometry.coordinates;
    const p = proj([lon, lat]);
    if (!p) continue;
    const kv = +f.properties.MAX_VOLT;
    subs.push(new Substation(p[0], p[1], kv > 0 ? kv : 0));
    if (lon < -130 && lon > -170 && lat > 54.5) grow(ak, p);                       // Alaska
    else if (lon > -161 && lon < -154 && lat > 18 && lat < 23) grow(hi, p);        // Hawaii
  }
  if (ak.x1 > ak.x0) labels.push({ text: "Alaska", x: (ak.x0 + ak.x1) / 2, y: ak.y1 });
  if (hi.x1 > hi.x0) labels.push({ text: "Hawaii", x: (hi.x0 + hi.x1) / 2, y: hi.y1 });
  console.log(`${subs.length} substations, ${cities.length} cities`);

  subs.forEach(s => s.link(cities));
  urbanSubs  = subs.filter(s => s.city);
  ruralSubs  = subs.filter(s => !s.city);
  linkedSubs = urbanSubs;

  gridLayer = createGraphics(W, H);
  linkLayer = createGraphics(W, H);
  dotLayer  = createGraphics(W, H);
  renderViewLayers();
  subs.filter(s => s.city && random() < 0.03).forEach(s => pulses.push(new Pulse(s)));
  ready = true;
}

// ---------- layers ----------
function renderGrid() {
  const { k, x: vx, y: vy } = view;
  gridLayer.clear();
  const g = gridLayer.drawingContext;
  const step = GRID * k;
  g.strokeStyle = rgba(P.grid);
  g.lineWidth = 1;
  g.beginPath();
  for (let i = Math.floor(-vx / step); ; i++) {
    const x = Math.round(vx + i * step) + 0.5;
    if (x > W) break;
    if (x < 0) continue;
    g.moveTo(x, 0); g.lineTo(x, H);
  }
  for (let j = Math.floor(-vy / step); ; j++) {
    const y = Math.round(vy + j * step) + 0.5;
    if (y > H) break;
    if (y < 0) continue;
    g.moveTo(0, y); g.lineTo(W, y);
  }
  g.stroke();
}

function renderViewLayers() {
  const { k, x: vx, y: vy } = view;
  const sz = Math.sqrt(k) * S;

  renderGrid();

  linkLayer.clear();
  const lc = linkLayer.drawingContext;
  lc.lineWidth = 0.5 * Math.min(sz, 2);
  lc.strokeStyle = rgba(P.link);
  for (const s of linkedSubs) {
    const ax = s.x * k + vx, ay = s.y * k + vy;
    const bx = s.city.x * k + vx, by = s.city.y * k + vy;
    if ((ax < 0 && bx < 0) || (ax > W && bx > W) || (ay < 0 && by < 0) || (ay > H && by > H)) continue;
    lc.beginPath(); lc.moveTo(ax, ay); lc.lineTo(bx, by); lc.stroke();
  }

  dotLayer.clear();
  const dc = dotLayer.drawingContext;
  for (const [group, col] of [[urbanSubs, P.dotUrban], [ruralSubs, P.dotRural]]) {
    dc.fillStyle = rgba(col);
    for (const s of group) {
      const x = s.x * k + vx, y = s.y * k + vy;
      if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
      dc.beginPath();
      dc.arc(x, y, (s.kv > 300 ? 1.1 : 0.6) * sz, 0, Math.PI * 2);
      dc.fill();
    }
  }

  drawn = { ...view };
  dirty = false;
}

// ---------- drawing ----------
function drawLand() {
  const ctx = drawingContext;
  ctx.save();
  ctx.fillStyle = rgba(P.land);
  if (landPath) {
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    ctx.fill(landPath);
  } else {
    ctx.fillRect(0, 0, W, H);            
  }
  ctx.restore();
}

function drawSources() {
  const ctx = drawingContext;
  const pad = 10 * T;
  const x = 24 * T;
  const y = H - 105 * T;
  const w = 200 * T;
  const h = 82 * T;
  ctx.save();

  ctx.fillStyle = "rgba(226, 238, 222, 0.94)";
  ctx.strokeStyle = "rgba(22, 66, 38, 0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4 * T);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = rgba(P.label);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `700 ${12 * T}px ${FONT}`;
  ctx.fillText("DATA SOURCES", x + pad, y + pad);

  // clickable source links
  ctx.font = `400 ${10 * T}px ${FONT}`;

  const link1 = {
    text: "Electric Substations — ArcGIS ↗",
    x: x + pad,
    y: y + pad + 22 * T,
    url: "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Electric_Substations/FeatureServer/0"
  };

  const link2 = {
    text: "USA Major Cities — ArcGIS ↗",
    x: x + pad,
    y: y + pad + 22 * T + 17 * T,
    url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Major_Cities_/FeatureServer/0"
  };

  ctx.fillStyle = "rgb(22, 66, 38)";
  ctx.fillText(link1.text, link1.x, link1.y);
  ctx.fillText(link2.text, link2.x, link2.y);

  ctx.restore();
  
  window.sourceLinks = [link1, link2].map(link => ({
    ...link,
    width: ctx.measureText(link.text).width,
    height: 16 * T
  }));
}

function drawLabels() {
  const ctx = drawingContext;
  ctx.save();
  ctx.font = `400 ${13 * T}px ${FONT}`;
  ctx.fillStyle = rgba(P.label);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const l of labels) {
    const [sx, sy] = toScreen(l.x, l.y);
    if (sx < -80 || sx > W + 80 || sy < -40 || sy > H + 40) continue;
    ctx.fillText(l.text, sx, sy + 16 * T);
  }
  ctx.restore();
}

function drawCityNames() {
  if (!showCityNames) return;

  const ctx = drawingContext;
  ctx.save();

  ctx.font = `400 ${12 * T}px ${FONT}`;
  ctx.fillStyle = rgba(P.label);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // Reveal smaller cities as users zoom in
  let minPopulation;

  if (view.k < 1.5) {
    minPopulation = 1000000;  // Biggest cities only
  } else if (view.k < 2.5) {
    minPopulation = 500000;
  } else if (view.k < 4) {
    minPopulation = 250000;
  } else if (view.k < 6) {
    minPopulation = 150000;
  } else {
    minPopulation = 100000;   // All loaded cities
  }

  for (const c of cities) {
    if (c.pop < minPopulation) continue;

    const [sx, sy] = toScreen(c.x, c.y);

    if (sx < -100 || sx > W + 100 ||
        sy < -40 || sy > H + 40) continue;

    ctx.fillText(c.name, sx + 8 * T, sy);
  }

  ctx.restore();
}

function createCityToggle() {
  const btn = document.createElement("button");
  btn.id = "cityToggle";
  function updateButton() {
    btn.textContent = showCityNames
      ? "CITY LABELS: ON"
      : "CITY LABELS: OFF";
  }

  Object.assign(btn.style, {
    position: "fixed",
    top: "24px",
    left: "24px",
    zIndex: "10000",
    padding: "12px 18px",
    border: "1px solid rgba(22, 66, 38, 0.35)",
    borderRadius: "6px",
    background: "rgba(226, 238, 222, 0.95)",
    color: "rgb(22, 66, 38)",
    fontFamily: FONT,
    fontSize: "12px",
    fontWeight: "bold",
    letterSpacing: "1px",
    cursor: "pointer",
    touchAction: "manipulation"
  });
  ["pointerdown", "pointerup", "mousedown", "mouseup",
   "dblclick", "click", "touchstart", "touchend"].forEach(event => {
    btn.addEventListener(event, e => {
      e.stopPropagation();
    });
  });

  btn.addEventListener("click", e => {
    e.preventDefault();

    showCityNames = !showCityNames;
    updateButton();
  });

  updateButton();
  document.body.appendChild(btn);
}

function drawSignature() {
  const ctx = drawingContext;
  const m = 28 * T;
  ctx.save();
  ctx.fillStyle = rgba(P.label);
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 ${18 * T}px ${FONT}`;
  ctx.fillText("Chloe Alimurong", W - m, H - m - 22 * T);
  ctx.font = `400 ${13 * T}px ${FONT}`;
  ctx.fillText("Master of Urban Spatial Analytics at UPenn", W - m, H - m);
  ctx.restore();
}

function draw() {
  if (!ready) return;
  background(...P.bg);
  drawLand();

  const f = view.k / drawn.k;
  push();
  translate(view.x - drawn.x * f, view.y - drawn.y * f);
  scale(f);
  image(gridLayer, 0, 0, W, H);
  image(linkLayer, 0, 0, W, H);
  image(dotLayer, 0, 0, W, H);
  pop();

  pulses.forEach(p => p.show());
  cities.forEach(c => c.show());
  drawCityNames();
  drawLabels();
  drawSignature();
  drawSources();

  if (dirty && millis() - lastChange > 120) renderViewLayers();
}

// ---------- interaction ----------
function clampView() {
  view.x = constrain(view.x, W - W * view.k, 0);
  view.y = constrain(view.y, H - H * view.k, 0);
}
function markDirty() { dirty = true; lastChange = millis(); }

function zoomAt(mx, my, factor) {
  const k2 = constrain(view.k * factor, 1, MAX_ZOOM);
  const wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
  view.k = k2;
  view.x = mx - wx * k2;
  view.y = my - wy * k2;
  clampView();
  markDirty();
}

function mouseWheel(e) {
  if (!ready) return;
  zoomAt(mouseX, mouseY, Math.exp(-e.delta * 0.0015));
  return false;
}

function mouseDragged() {
  if (!ready) return;
  view.x += mouseX - pmouseX;
  view.y += mouseY - pmouseY;
  clampView();
  markDirty();
  return false;
}

function doubleClicked() {
  if (!ready) return;
  const btn = document.getElementById("cityToggle");
  if (btn) {
    const rect = btn.getBoundingClientRect();

    if (
      mouseX >= rect.left &&
      mouseX <= rect.right &&
      mouseY >= rect.top &&
      mouseY <= rect.bottom
    ) {
      return false;
    }
  }
  zoomAt(mouseX, mouseY, 2);
  return false;
}

function keyPressed() {
  if (key === 's') saveCanvas('day09_urban_rural', 'png');
  if (key === 'r') {
    view.k = 1;
    view.x = 0;
    view.y = 0;
    markDirty();
  }
  if (key === '+' || key === '=') zoomAt(W / 2, H / 2, 1.5);
  if (key === '-') zoomAt(W / 2, H / 2, 1 / 1.5);
  if (key === 'c' || key === 'C') {
    showCityNames = !showCityNames;
    const btn = document.getElementById("cityToggle");
    if (btn) {
      btn.textContent = showCityNames
        ? "CITY LABELS: ON"
        : "CITY LABELS: OFF";
    }
  }
}
function mousePressed() {
  if (!window.sourceLinks) return;

  for (const link of window.sourceLinks) {
    if (
      mouseX >= link.x &&
      mouseX <= link.x + link.width &&
      mouseY >= link.y &&
      mouseY <= link.y + link.height
    ) {
      window.open(link.url, "_blank");
      return false;
    }
  }
}
