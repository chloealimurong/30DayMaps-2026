/*
  Small pink and orange squares try to fit inside real city outlines, then travel in clusters
  and flow into the next place. The same squares are reused the whole time.
  Squares that sit completely inside a boundary stay. Squares that would poke over the edge
  are turned away, so the gaps along the edge show how specific each shape is.
  Plain canvas, no libraries. Boundaries come from boundaries.js.
*/
(function () {
  'use strict';

  const canvas = document.getElementById('c');            // paper, outline, caption
  const ctx = canvas.getContext('2d');
  const sqCanvas = document.getElementById('squares');    // the squares, melted by the CSS goo filter
  const sctx = sqCanvas.getContext('2d');
  const stage = document.getElementById('stage');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPEED = Number(new URLSearchParams(window.location.search).get('speed')) || 1;   // ?speed=3 to preview faster

  const PAPER = '#F8F8DD';
  const INK = '#554242';

  const SQUARES_ACROSS = 54;       // how many squares would fit across the whole canvas
  const GAP = 0.82;                // square size as a fraction of its grid cell
  const FIT_MIN = 0.985;           // a square stays only if at least this much of it is inside the city
  const TRY_MIN = 0.3;             // squares at least this far inside still try, then get turned away
  const PINK = [345, 82, 78];      // hue, saturation, lightness
  const ORANGE = [26, 90, 66];
  const RING_POINTS = 360;         // the outline is resampled to this many points so shapes can morph
  const CLUSTERS = 14;             // squares travel between cities in this many groups

  // timeline for one city, in milliseconds
  const MORPH = reduceMotion ? 1 : 4200;      // travel as clusters and flow into the new shape
  const TRY_SPAN = 2200;                      // after landing, misfit squares get turned away over this time
  const HOLD = 2600;                          // the finished picture
  const CITY_TIME = MORPH + TRY_SPAN + HOLD;

  const cities = window.CityBoundaries.cities;
  let S = 600, dpr = 1;
  let idx = 0, scene = null, status = 'loading', message = '', token = 0;
  let lastNow = 0, clock = 0, morphT = CITY_TIME, loadingNext = false;
  let ringFrom = null, extraFrom = null, extraFromA = 0, capFrom = null;
  let squares = [];

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const smooth = k => k * k * (3 - 2 * k);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    S = Math.max(300, Math.floor(Math.min(window.innerWidth - 24, window.innerHeight - 24, 820)));
    stage.style.width = S + 'px';
    stage.style.height = S + 'px';
    [canvas, sqCanvas].forEach(c => {
      c.width = S * dpr; c.height = S * dpr;
      c.style.width = S + 'px'; c.style.height = S + 'px';
    });
    if (scene) {                                      // rebuild for the new size and put everything in place
      scene = buildScene(scene.city, scene.polys);
      ringFrom = scene.ring; extraFrom = null;
      assignTargets(scene);
      squares.forEach(q => { q.x = q.tx; q.y = q.ty; q.vx = q.vy = 0; });
      morphT = CITY_TIME;
    }
  }

  // ---------- building one city ----------
  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return a / 2;
  }

  // walk along a closed ring and drop n evenly spaced points on it
  function resample(pts, n) {
    const m = pts.length;
    const cum = [0];
    for (let i = 1; i <= m; i++) {
      const a = pts[i - 1], b = pts[i % m];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[m] || 1;
    const out = [];
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const d = (k / n) * total;
      while (seg < m - 1 && cum[seg + 1] < d) seg++;
      const a = pts[seg], b = pts[(seg + 1) % m];
      const len = cum[seg + 1] - cum[seg] || 1;
      const u = (d - cum[seg]) / len;
      out.push([lerp(a[0], b[0], u), lerp(a[1], b[1], u)]);
    }
    return out;
  }

  function buildScene(city, polys) {
    // fit the real outline into the canvas, leaving room for the caption underneath
    const pad = S * 0.08, capH = S * 0.15;
    const boxW = S - 2 * pad, boxH = S - pad - capH - pad * 0.5;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    polys.forEach(p => p.forEach(r => r.forEach(c => {
      minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]);
      minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
    })));
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);      // squeeze longitude so shapes aren't stretched
    const w = (maxLon - minLon) * kx, h = maxLat - minLat;
    const sc = Math.min(boxW / w, boxH / h);
    const ox = pad + (boxW - w * sc) / 2, oy = pad + (boxH - h * sc) / 2;
    const proj = c => [ox + (c[0] - minLon) * kx * sc, oy + (maxLat - c[1]) * sc];

    // every ring in canvas pixels; the biggest outer ring is the one that morphs, the rest just fade
    const rings = [];
    polys.forEach((p, pi) => p.forEach((ring, ri) => rings.push({ pts: ring.map(proj), outer: ri === 0 })));
    let main = null, mainArea = -1;
    rings.forEach(r => { const a = Math.abs(ringArea(r.pts)); if (r.outer && a > mainArea) { mainArea = a; main = r; } });

    const path = new Path2D();          // everything, for testing squares against the true shape
    const extra = new Path2D();         // everything except the morphing ring
    rings.forEach(r => {
      const target = r === main ? [path] : [path, extra];
      target.forEach(pa => {
        r.pts.forEach((c, i) => { if (i === 0) pa.moveTo(c[0], c[1]); else pa.lineTo(c[0], c[1]); });
        pa.closePath();
      });
    });

    // same direction, same starting point (the top-most point) for every city, so the morph doesn't twist
    let pts = main.pts.slice();
    if (ringArea(pts) < 0) pts.reverse();
    let top = 0;
    pts.forEach((c, i) => { if (c[1] < pts[top][1]) top = i; });
    pts = pts.slice(top).concat(pts.slice(0, top));
    const ring = resample(pts, RING_POINTS);

    // a mask of the city (alpha > 0 means inside)
    const mask = document.createElement('canvas');
    mask.width = S; mask.height = S;
    const mctx = mask.getContext('2d');
    mctx.fillStyle = '#000';
    mctx.fill(path, 'evenodd');
    const px = mctx.getImageData(0, 0, S, S).data;
    let cityPixels = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 127) cityPixels++;

    // try a square in every cell of one regular grid
    const pitch = S / SQUARES_ACROSS, side = pitch * GAP;
    const fit = [], tryout = [];
    for (let j = 0; j < SQUARES_ACROSS; j++) {
      for (let i = 0; i < SQUARES_ACROSS; i++) {
        const x0 = Math.floor(i * pitch), x1 = Math.min(S, Math.ceil((i + 1) * pitch));
        const y0 = Math.floor(j * pitch), y1 = Math.min(S, Math.ceil((j + 1) * pitch));
        let inside = 0, total = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) { total++; if (px[(y * S + x) * 4 + 3] > 127) inside++; }
        }
        const cover = inside / total;
        if (cover < TRY_MIN) continue;
        (cover >= FIT_MIN ? fit : tryout).push({ x: (i + 0.5) * pitch, y: (j + 0.5) * pitch });
      }
    }
    return { city: city, polys: polys, ring: ring, extra: extra, fit: fit, tryout: tryout, pitch: pitch, side: side, cityPixels: cityPixels };
  }

  // ---------- squares ----------
  function newSquare() {
    const base = Math.random() < 0.5 ? PINK : ORANGE;
    const edge = Math.floor(rand(0, 4)), along = rand(0, S);
    return {
      x: edge === 0 ? -20 : edge === 1 ? S + 20 : along, y: edge === 2 ? -20 : edge === 3 ? S + 20 : along,
      vx: 0, vy: 0, tx: S / 2, ty: S / 2, a: 0, aT: 0, role: 'out', rejectAt: 0, rejected: false, ph: rand(0, 6.28),
      color: 'hsl(' + (base[0] + rand(-6, 6)).toFixed(0) + ',' + base[1] + '%,' + (base[2] + rand(-6, 6)).toFixed(0) + '%)'
    };
  }

  // order along a snake through ten horizontal bands, so neighbours in this order are neighbours on screen
  function snakeKey(x, y) {
    const band = Math.floor((y / S) * 10);
    return band * S * 2 + (band % 2 ? S - x : x);
  }

  // hand every slot of the new city to one of the squares, trying to keep the trip short
  function assignTargets(sc) {
    const slots = sc.fit.map(s => ({ x: s.x, y: s.y, fit: true })).concat(sc.tryout.map(s => ({ x: s.x, y: s.y, fit: false })));
    while (squares.length < slots.length) squares.push(newSquare());
    const order = squares.slice().sort((a, b) => snakeKey(a.x, a.y) - snakeKey(b.x, b.y));
    slots.sort((a, b) => snakeKey(a.x, a.y) - snakeKey(b.x, b.y));
    const cx = slots.reduce((a, s) => a + s.x, 0) / slots.length, cy = slots.reduce((a, s) => a + s.y, 0) / slots.length;
    const chosen = new Set();
    slots.forEach((slot, k) => {
      const q = order[Math.floor((k + 0.5) * order.length / slots.length)];
      chosen.add(q);
      q.tx = slot.x; q.ty = slot.y; q.aT = 1;
      q.role = slot.fit ? 'fit' : 'try';
      q.rejected = false;
      q.rejectAt = MORPH + rand(500, TRY_SPAN);
      q.ox = slot.x - cx; q.oy = slot.y - cy;                 // direction it will be pushed back out
    });
    squares.forEach(q => {
      if (chosen.has(q)) return;
      q.role = 'out'; q.aT = 0;                               // not needed in this city, drift off and fade
      const a = rand(0, 6.28);
      q.tx = S / 2 + Math.cos(a) * S * 0.75; q.ty = S / 2 + Math.sin(a) * S * 0.75;
    });
  }

  function currentRing() {
    if (!ringFrom) return null;
    const e = smooth(clamp(morphT / (MORPH * 0.9), 0, 1));
    return ringFrom.map((p, i) => [lerp(p[0], scene.ring[i][0], e), lerp(p[1], scene.ring[i][1], e)]);
  }

  function startMorph(next) {
    const showing = scene ? currentRing() : null;
    const e = smooth(clamp(morphT / (MORPH * 0.9), 0, 1));
    if (scene) {
      capFrom = { label: scene.city.label, landed: counts.landed, away: counts.away, covered: counts.covered, a: capAlpha() };
      extraFrom = scene.extra; extraFromA = e;
    } else {
      capFrom = null; extraFrom = null; extraFromA = 0;
    }
    ringFrom = showing || resample([[S / 2 - 8, S / 2], [S / 2, S / 2 - 8], [S / 2 + 8, S / 2], [S / 2, S / 2 + 8]], RING_POINTS);
    scene = next;
    morphT = 0;
    assignTargets(scene);
    // split the squares into clusters; each cluster drifts as one group while the shape changes
    const seeds = [];
    for (let i = 0; i < CLUSTERS; i++) { const q = squares[Math.floor(rand(0, squares.length))]; seeds.push({ x: q.x, y: q.y, ph: rand(0, 6.28), ph2: rand(0, 6.28) }); }
    squares.forEach(q => {
      let best = seeds[0], bd = Infinity;
      seeds.forEach(sd => { const d = (sd.x - q.x) * (sd.x - q.x) + (sd.y - q.y) * (sd.y - q.y); if (d < bd) { bd = d; best = sd; } });
      q.cl = best;
      q.vx += (Math.cos(best.ph) * 80); q.vy += (Math.sin(best.ph) * 80);
    });
  }

  function updateSquares(dt) {
    const p = clamp(morphT / MORPH, 0, 1);
    const swirl = Math.sin(Math.PI * p) * S * 1.1;                   // wobble, strongest in the middle of the melt
    const K = 12 + 160 * smooth(clamp((p - 0.25) / 0.75, 0, 1));      // pull toward the new slot grows as the melt ends
    const D = 2 * Math.sqrt(K) * 0.9;
    const tt = clock / 1000;
    const steps = Math.max(1, Math.ceil(dt / 16));
    const h = dt / steps / 1000;
    counts.landed = 0; counts.away = 0;
    squares.forEach(q => {
      let tx = q.tx, ty = q.ty, k = K, d = D, sw = swirl;
      if (q.role === 'try') {
        if (morphT >= q.rejectAt) {                                  // turned away: pushed back out and faded
          q.rejected = true;
          const m = Math.hypot(q.ox, q.oy) || 1;
          tx = q.tx + (q.ox / m) * S * 0.2 + Math.sin(q.ph) * S * 0.05; ty = q.ty + (q.oy / m) * S * 0.2 + Math.cos(q.ph) * S * 0.05;
          k = 2.5; d = 2 * Math.sqrt(k);
          q.aT = 0;
        } else if (morphT >= q.rejectAt - 350 && p >= 1) {
          tx += Math.sin(morphT * 0.07 + q.ph) * 1.8;                // a little shake against the outline
        }
      }
      for (let s = 0; s < steps; s++) {
        const c = q.cl || q;                                          // everyone in a cluster feels the same push
        const fx = Math.sin(tt * 1.1 + c.ph) + Math.cos(tt * 0.7 + c.ph2);
        const fy = Math.cos(tt * 0.9 + c.ph2) + Math.sin(tt * 0.6 + c.ph);
        q.vx += ((tx - q.x) * k - q.vx * d + fx * sw) * h;
        q.vy += ((ty - q.y) * k - q.vy * d + fy * sw) * h;
        q.x += q.vx * h; q.y += q.vy * h;
      }
      q.a += (q.aT - q.a) * Math.min(1, dt * (q.role === 'out' ? 0.0012 : 0.004));
      if (q.role === 'fit' && p >= 1 && Math.abs(q.x - q.tx) < 2 && Math.abs(q.y - q.ty) < 2) counts.landed++;
      if (q.role === 'try' && q.rejected) counts.away++;
    });
    counts.covered = Math.round((100 * counts.landed * scene.pitch * scene.pitch) / scene.cityPixels);
  }
  const counts = { landed: 0, away: 0, covered: 0 };

  // ---------- going to a city ----------
  async function go(i) {
    const target = (i + cities.length) % cities.length;
    const mine = ++token;
    loadingNext = true;
    if (!scene) { status = 'loading'; message = cities[target].label; }
    try {
      const polys = await window.CityBoundaries.load(cities[target]);
      if (mine !== token) return;
      idx = target;
      startMorph(buildScene(cities[target], polys));
      status = 'play'; loadingNext = false;
    } catch (err) {
      if (mine !== token) return;
      console.warn('Could not load ' + cities[target].label + ':', err.message);
      status = scene ? 'play' : 'error'; message = cities[target].label;
      setTimeout(function () { if (mine === token) go(target + 1); }, 2500);   // skip ahead and try the next one
    }
  }

  // ---------- drawing ----------
  function drawText(text, x, y, size, alpha, italic) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = INK;
    ctx.font = (italic ? 'italic ' : '') + size + 'px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  // the old caption fades out while the shape melts, the new one fades in as it settles
  function capAlpha() {
    const p = clamp(morphT / MORPH, 0, 1);
    return clamp((p - 0.6) / 0.4, 0, 1);
  }

  function drawCaption(label, landed, away, covered, alpha) {
    if (alpha <= 0.01) return;
    drawText(label, S / 2, S - S * 0.095, Math.max(16, S * 0.032), alpha, false);
    drawText(landed + ' squares fit  ·  ' + away + " didn't  ·  " + covered + '% of the area covered',
      S / 2, S - S * 0.05, Math.max(11, S * 0.019), 0.8 * alpha, true);
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, S, S);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, S, S);

    if (!scene) {
      const text = status === 'error' ? "Couldn't load " + message + ". Trying the next city..." : 'Loading ' + message + '...';
      drawText(text, S / 2, S / 2, 16, 0.8, true);
      return;
    }

    // outline: the shape morphs from the old city into the new one
    const p = clamp(morphT / MORPH, 0, 1);
    const e = smooth(clamp(morphT / (MORPH * 0.9), 0, 1));
    ctx.strokeStyle = INK; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
    const r = currentRing();
    ctx.beginPath();
    r.forEach((c, i) => { if (i === 0) ctx.moveTo(c[0], c[1]); else ctx.lineTo(c[0], c[1]); });
    ctx.closePath();
    ctx.stroke();
    if (extraFrom && extraFromA * (1 - e) > 0.01) { ctx.globalAlpha = extraFromA * (1 - e); ctx.stroke(extraFrom); }
    ctx.globalAlpha = e; ctx.stroke(scene.extra); ctx.globalAlpha = 1;

    // squares, always crisp
    const side = scene.side;
    squares.forEach(q => {
      if (q.a < 0.02) return;
      sctx.globalAlpha = Math.min(1, q.a);
      sctx.fillStyle = q.color;
      sctx.fillRect(q.x - side / 2, q.y - side / 2, side, side);
    });
    sctx.globalAlpha = 1;

    // caption
    if (capFrom) drawCaption(capFrom.label, capFrom.landed, capFrom.away, capFrom.covered, 1 - clamp(p / 0.4, 0, 1));
    drawCaption(scene.city.label, counts.landed, counts.away, counts.covered, capAlpha());
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = INK;
    ctx.font = Math.max(11, S * 0.018) + 'px Georgia, serif';
    ctx.fillText((idx + 1) + ' / ' + cities.length, S * 0.04, S * 0.05);
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    const dt = Math.min(now - (lastNow || now), 100) * SPEED;
    lastNow = now;
    clock += dt;
    if (scene) {
      morphT += dt;
      updateSquares(dt);
      if (morphT > CITY_TIME && !loadingNext) go(idx + 1);
    }
    render();
    requestAnimationFrame(frame);
  }

  stage.addEventListener('click', function () { go(idx + 1); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') go(idx + 1);
    if (e.key === 'ArrowLeft') go(idx - 1);
  });
  window.addEventListener('resize', resize);

  resize();
  go(0);
  requestAnimationFrame(frame);
})();