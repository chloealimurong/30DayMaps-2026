/*
  Real city boundaries from OpenStreetMap, fetched through Nominatim and cached in the browser,
  so each outline is downloaded only once per visitor.
  Exposes window.CityBoundaries = { cities, load(city) }.
*/
(function () {
  'use strict';

  // The order here is the order of the show.
  // thr = how much Nominatim may simplify the outline, in degrees (smaller = more detail).
  const CITIES = [
    { id: 'baltimore', label: 'Baltimore', queries: [{ q: 'Baltimore, Maryland, United States', type: 'city', thr: 0.0001 }] },
    { id: 'durham', label: 'Durham, North Carolina', queries: [{ q: 'Durham, North Carolina, United States', type: 'city', thr: 0.0001 }] },
    { id: 'barcelona', label: 'Barcelona', queries: [{ q: 'Barcelona, Catalonia, Spain', type: 'city', thr: 0.0001 }] },
    { id: 'jiangsu', label: 'Jiangsu Province, China', queries: [{ q: 'Jiangsu, China', type: 'state', thr: 0.0008 }] },
    // New Zealand's country outline, keeping only the pieces whose centre lies north of Cook Strait
    { id: 'north-island', label: 'North Island, New Zealand', queries: [{ q: 'New Zealand', type: 'country', thr: 0.002, minLat: -41.9 }] },
    { id: 'dc', label: 'Washington, DC', queries: [{ q: 'Washington, District of Columbia, United States', type: 'city', thr: 0.0001 }] },
    { id: 'philadelphia', label: 'Philadelphia', queries: [{ q: 'Philadelphia, Pennsylvania, United States', type: 'city', thr: 0.0001 }] }
  ];

  const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  const CACHE_KEY = 'square-city-boundary-v2:';
  const MIN_GAP_MS = 1100;          // Nominatim asks for at most one request per second
  const KEEP_FRACTION = 0.01;       // drop islands smaller than 1% of the biggest piece

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let lastRequest = 0;
  const pending = {};

  async function search(q, type, thr) {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastRequest));
    if (wait) await sleep(wait);
    lastRequest = Date.now();
    const p = new URLSearchParams({
      q: q, format: 'jsonv2', polygon_geojson: '1', polygon_threshold: String(thr),
      limit: '5', 'accept-language': 'en'
    });
    if (type) p.set('featuretype', type);
    const res = await fetch(ENDPOINT + '?' + p.toString());
    if (!res.ok) throw new Error('Nominatim answered ' + res.status);
    return res.json();
  }

  function isPolygon(g) { return g && (g.type === 'Polygon' || g.type === 'MultiPolygon'); }

  function pickBoundary(results) {
    for (const r of results) if (isPolygon(r.geojson) && (r.category || r.class) === 'boundary') return r.geojson;
    for (const r of results) if (isPolygon(r.geojson)) return r.geojson;
    return null;
  }

  const round5 = n => Math.round(n * 1e5) / 1e5;

  // GeoJSON -> [ polygon, ... ], polygon = [ ring, ... ], ring = [ [lon, lat], ... ]
  function toPolygons(g) {
    const list = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    return list.map(poly => poly.map(ring => ring.map(c => [round5(c[0]), round5(c[1])])));
  }

  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(a / 2);
  }

  function dropTinyIslands(polys) {
    const areas = polys.map(p => ringArea(p[0]));
    const biggest = Math.max.apply(null, areas);
    return polys.filter((p, i) => areas[i] >= biggest * KEEP_FRACTION);
  }

  // shapes that straddle the 180 degree line (like New Zealand's outlying islands) get shifted east
  function unwrapAntimeridian(polys) {
    let lo = Infinity, hi = -Infinity;
    polys.forEach(p => p.forEach(r => r.forEach(c => { lo = Math.min(lo, c[0]); hi = Math.max(hi, c[0]); })));
    if (hi - lo <= 180) return polys;
    return polys.map(p => p.map(r => r.map(c => [c[0] < 0 ? c[0] + 360 : c[0], c[1]])));
  }

  async function fetchQuery(spec) {
    let results = await search(spec.q, spec.type, spec.thr);
    let g = pickBoundary(results);
    if (!g) {                                  // some places are not filed under the type we guessed
      results = await search(spec.q, null, spec.thr);
      g = pickBoundary(results);
    }
    if (!g) throw new Error('No boundary found for ' + spec.q);
    let polys = toPolygons(g);
    if (spec.minLat !== undefined) {            // keep only pieces centred north of this latitude
      polys = polys.filter(p => {
        const ring = p[0];
        return ring.reduce((a, c) => a + c[1], 0) / ring.length > spec.minLat;
      });
    }
    return polys;
  }

  async function loadCity(city) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY + city.id) || 'null');
      if (Array.isArray(cached) && cached.length) return cached;
    } catch (e) { /* no storage: fetch every time */ }

    let polys = [];
    for (const spec of city.queries) polys = polys.concat(await fetchQuery(spec));
    polys = unwrapAntimeridian(dropTinyIslands(polys));

    try { localStorage.setItem(CACHE_KEY + city.id, JSON.stringify(polys)); } catch (e) { /* too big or blocked */ }
    return polys;
  }

  function load(city) {
    if (!pending[city.id]) {
      pending[city.id] = loadCity(city).catch(err => { delete pending[city.id]; throw err; });
    }
    return pending[city.id];
  }

  // quietly fetch the rest in the background while the first city plays
  async function prefetchAll() {
    for (const c of CITIES) {
      try { await load(c); } catch (e) { console.warn('Could not load ' + c.label + ':', e.message); }
    }
  }

  window.CityBoundaries = { cities: CITIES, load: load };
  prefetchAll();
})();