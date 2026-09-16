/* ============================================================================
 * Travel Animator — Thamer Dev
 * Single-canvas slippy map + trip animator + WebM exporter. Vanilla JS, no deps.
 *
 * Why is the map drawn on a <canvas> instead of Leaflet?
 * Because canvas.captureStream() can only record canvas pixels. A DOM tile layer
 * would be invisible to the recorder, and video export is a core feature here.
 * So we implement Web Mercator, tile compositing, pan/zoom and every overlay
 * ourselves, all onto one surface that MediaRecorder can capture verbatim.
 * ==========================================================================*/
'use strict';

/* ─────────────────────────── constants ─────────────────────────── */

const TILE = 256;
const MIN_Z = 1.2, MAX_Z = 18;
const R_EARTH = 6371.0088;                      // km, mean radius
const DWELL = 0.6;                              // s pause at each stop
const TAIL = 0.9;                               // s hold on the final frame
const SPEEDS = [1, 2, 4, 0.5, 0.25, 0.1];
const SPEED_LBL = ['1×', '2×', '4×', '½×', '¼×', '0.1×'];
const CAM_HOLD_MS = 2500;                       // manual-interaction camera suspend
const MAX_ROUTE_PTS = 2600;

const STYLES = {
  dark: {
    name: 'Dark',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    overlay: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 16, dark: true, bg: '#0d1220',
    attrib: 'Esri — Light/Dark Gray Canvas · HERE, Garmin, © OpenStreetMap contributors'
  },
  streets: {
    name: 'Streets',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    overlay: null, maxZoom: 19, dark: false, bg: '#e8e3dc',
    attrib: '© OpenStreetMap contributors'
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    overlay: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 18, dark: true, bg: '#0a1018',
    attrib: 'Esri World Imagery — Maxar, Earthstar Geographics, USDA, USGS, IGN'
  },
  terrain: {
    name: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    overlay: null, maxZoom: 16, dark: false, bg: '#dfe6d8',
    attrib: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap contributors'
  }
};

const MODE_COLOR = { plane: '#4fc3f7', car: '#ffb347', boat: '#43d39e' };
const MODE_NAME = { plane: 'Flight', car: 'Drive', boat: 'Sail' };

const DEMOS = {
  'US Highlights': { mode: 'plane', stops: [
    ['New York', -74.006, 40.7128, 'plane'], ['Chicago', -87.6298, 41.8781, 'plane'],
    ['Denver', -104.9903, 39.7392, 'plane'], ['Las Vegas', -115.1398, 36.1699, 'car'],
    ['Los Angeles', -118.2437, 34.0522, 'car'], ['Anchorage', -149.9003, 61.2181, 'plane'],
    ['Miami', -80.1918, 25.7617, 'plane']] },
  'World Tour': { mode: 'plane', stops: [
    ['Riyadh', 46.6753, 24.7136, 'plane'], ['Cairo', 31.2357, 30.0444, 'plane'],
    ['Rome', 12.4964, 41.9028, 'plane'], ['London', -0.1276, 51.5072, 'plane'],
    ['New York', -74.006, 40.7128, 'plane'], ['Tokyo', 139.6917, 35.6895, 'plane'],
    ['Sydney', 151.2093, -33.8688, 'plane']] },
  'Route 66': { mode: 'car', stops: [
    ['Chicago', -87.6298, 41.8781, 'car'], ['St. Louis', -90.1994, 38.627, 'car'],
    ['Oklahoma City', -97.5164, 35.4676, 'car'], ['Amarillo', -101.8313, 35.222, 'car'],
    ['Albuquerque', -106.6504, 35.0844, 'car'], ['Flagstaff', -111.6513, 35.1983, 'car'],
    ['Santa Monica', -118.4912, 34.0195, 'car']] },
  'Iceland': { mode: 'car', stops: [
    ['Reykjavík', -21.8277, 64.1283, 'car'], ['Vík í Mýrdal', -19.0059, 63.4187, 'car'],
    ['Höfn', -15.2082, 64.2539, 'car'], ['Egilsstaðir', -14.3948, 65.2669, 'car'],
    ['Akureyri', -18.0878, 65.6835, 'car'], ['Reykjavík', -21.8277, 64.1283, 'car']] },
  'Aegean': { mode: 'boat', stops: [
    ['Athens', 23.7275, 37.9838, 'boat'], ['Mykonos', 25.3289, 37.4467, 'boat'],
    ['Naxos', 25.3767, 37.1036, 'boat'], ['Santorini', 25.4615, 36.3932, 'boat'],
    ['Rhodes', 28.2176, 36.4349, 'boat'], ['Bodrum', 27.4305, 37.0344, 'boat']] }
};

/* ─────────────────────────── tiny helpers ─────────────────────────── */

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

function easeInOutQuint(t) {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
}
function fmtKm(km) {
  if (km >= 10000) return Math.round(km).toLocaleString('en-US') + ' km';
  if (km >= 100) return Math.round(km) + ' km';
  if (km >= 10) return km.toFixed(1) + ' km';
  return km.toFixed(2) + ' km';
}
function haversine(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}
function angleDiff(a, b) {                      // shortest signed a→b, radians
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
function unwrapLon(list) {                      // kill antimeridian jumps
  const out = [];
  let prev = null;
  for (const p of list) {
    let lon = p[0];
    if (prev !== null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
    prev = lon;
    out.push([lon, p[1]]);
  }
  return out;
}
function decimate(pts, max) {
  if (pts.length <= max) return pts;
  const step = pts.length / max, out = [];
  for (let i = 0; i < max - 1; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}
function chaikin(pts, iters) {                  // corner rounding so vehicles glide
  let cur = pts;
  for (let k = 0; k < iters; k++) {
    if (cur.length < 3) break;
    const out = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const p = cur[i], q = cur[i + 1];
      out.push([p[0] * .75 + q[0] * .25, p[1] * .75 + q[1] * .25]);
      out.push([p[0] * .25 + q[0] * .75, p[1] * .25 + q[1] * .75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/* ───────────────── Web Mercator projection ─────────────────
   worldPx(z) = 256 * 2^z with fractional zoom supported. */

const worldPx = z => TILE * Math.pow(2, z);
function lonToWorldX(lon, z) { return (lon + 180) / 360 * worldPx(z); }
function latToWorldY(lat, z) {
  const s = Math.sin(rad(clamp(lat, -85.05112878, 85.05112878)));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z);
}
function worldXToLon(x, z) { return x / worldPx(z) * 360 - 180; }
function worldYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / worldPx(z);
  return deg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
}

/* ─────────────────────────── app state ─────────────────────────── */

const cv = $('#map');
const ctx = cv.getContext('2d', { alpha: false, desynchronized: false });

const cam = { lon: 8, lat: 26, zoom: 2.2 };
const view = { w: 0, h: 0 };

const S = {
  style: 'dark',
  stops: [],                   // {name, lon, lat, mode, photo?, img?}
  legs: [],                    // {a,b,mode,path,km,t0,t1,dwellEnd}
  mode: 'plane',
  drawing: false,
  playing: false,
  t: 0,                        // playhead seconds
  total: 0,
  speed: 0,
  follow: true,
  autoZoom: false,
  recording: false,
  camHoldUntil: 0,
  fly: null,                   // active camera fly animation
  pin: null,                   // pulsing search pin
  heading: 0, headingLeg: -1,
  visitedCountries: new Set(),
  visitedStates: new Set(),
  visitedCities: new Set(),
  cityLabelled: new Set(),
  routing: 0,                  // in-flight OSRM requests
  tilesOK: true, tileFails: 0, tileTries: 0,
  hoverStop: -1
};

const routeCache = new Map();  // "lon,lat|lon,lat" -> {path, km}

/* ═══════════════════════ tile engine (LRU cache) ═══════════════════════ */

const TileCache = {
  max: 620,
  map: new Map(),                      // key -> {img, ok}
  get(key) {
    const e = this.map.get(key);
    if (e) { this.map.delete(key); this.map.set(key, e); }   // refresh LRU order
    return e;
  },
  set(key, val) {
    this.map.set(key, val);
    while (this.map.size > this.max) {
      const k = this.map.keys().next().value;
      const e = this.map.get(k);
      if (e && e.img) e.img.src = '';
      this.map.delete(k);
    }
  }
};

let pendingTiles = 0;

function tileURL(style, layer, z, x, y) {
  const cfg = STYLES[style];
  let tpl = layer === 'overlay' ? cfg.overlay : cfg.url;
  if (!tpl) return null;
  if (cfg.subdomains) tpl = tpl.replace('{s}', cfg.subdomains[(x + y) % cfg.subdomains.length]);
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function getTile(style, layer, z, x, y) {
  const n = 1 << z;
  x = ((x % n) + n) % n;                                  // horizontal wrap
  if (y < 0 || y >= n) return null;
  const key = style + '|' + layer + '|' + z + '/' + x + '/' + y;
  const hit = TileCache.get(key);
  if (hit) return hit.ok ? hit.img : null;

  const url = tileURL(style, layer, z, x, y);
  if (!url) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';                          // MUST: keeps canvas untainted
  const rec = { img, ok: false };
  TileCache.set(key, rec);
  pendingTiles++;
  S.tileTries++;
  img.onload = () => {
    rec.ok = true; pendingTiles--;
    S.tilesOK = true;
    requestRender();
  };
  img.onerror = () => {
    pendingTiles--; S.tileFails++;
    if (S.tileTries > 6 && S.tileFails / S.tileTries > 0.7) S.tilesOK = false;
    requestRender();
  };
  img.src = url;
  return null;
}

/* Draw one tile layer. Falls back to a parent tile (scaled up) while the exact
   zoom level is still loading, so panning never flashes empty. */
function drawTileLayer(layer) {
  const cfg = STYLES[S.style];
  if (layer === 'overlay' && !cfg.overlay) return true;

  const zi = clamp(Math.round(cam.zoom), 0, cfg.maxZoom);
  const scale = worldPx(cam.zoom) / worldPx(zi);
  const size = TILE * scale;
  const cx = lonToWorldX(cam.lon, zi) * scale;
  const cy = latToWorldY(cam.lat, zi) * scale;
  const left = cx - view.w / 2, top = cy - view.h / 2;

  const x0 = Math.floor(left / size), x1 = Math.floor((left + view.w) / size);
  const y0 = Math.floor(top / size), y1 = Math.floor((top + view.h) / size);
  const n = 1 << zi;
  let any = false;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = x0; x <= x1; x++) {
      const px = Math.round(x * size - left), py = Math.round(y * size - top);
      const w = Math.ceil(size) + 1;
      const img = getTile(S.style, layer, zi, x, y);
      if (img) { ctx.drawImage(img, px, py, w, w); any = true; continue; }
      // parent fallback: walk up to 4 levels looking for a cached ancestor
      let found = false;
      for (let up = 1; up <= 4 && zi - up >= 0; up++) {
        const pz = zi - up, f = 1 << up;
        const pxi = Math.floor(x / f), pyi = Math.floor(y / f);
        const pn = 1 << pz;
        const key = S.style + '|' + layer + '|' + pz + '/' + (((pxi % pn) + pn) % pn) + '/' + pyi;
        const e = TileCache.map.get(key);
        if (e && e.ok) {
          const sub = TILE / f;
          ctx.drawImage(e.img, (x % f + f) % f * sub, (y % f + f) % f * sub, sub, sub, px, py, w, w);
          found = true; any = true; break;
        }
      }
      if (!found && layer === 'base') {
        ctx.fillStyle = cfg.dark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.035)';
        ctx.fillRect(px, py, w, w);
      }
    }
  }
  return any;
}

/* ── screen <-> geo (uses live camera) ── */
function project(lon, lat) {
  const wp = worldPx(cam.zoom);
  let x = lonToWorldX(lon, cam.zoom) - lonToWorldX(cam.lon, cam.zoom);
  while (x > wp / 2) x -= wp;                             // shortest way around
  while (x < -wp / 2) x += wp;
  return [x + view.w / 2, latToWorldY(lat, cam.zoom) - latToWorldY(cam.lat, cam.zoom) + view.h / 2];
}
function unproject(px, py) {
  const x = lonToWorldX(cam.lon, cam.zoom) + (px - view.w / 2);
  const y = latToWorldY(cam.lat, cam.zoom) + (py - view.h / 2);
  let lon = worldXToLon(x, cam.zoom);
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return [lon, worldYToLat(clamp(y, 0, worldPx(cam.zoom)), cam.zoom)];
}

/* ═════════════ offline fallback basemap (vector landmass) ═════════════ */

function drawVectorWorld() {
  const dark = STYLES[S.style].dark;
  ctx.fillStyle = dark ? '#0b1220' : '#cfe0f0';
  ctx.fillRect(0, 0, view.w, view.h);
  const feats = window.LAND_FEATS || [];
  ctx.fillStyle = dark ? '#1b2740' : '#e9eee6';
  ctx.strokeStyle = dark ? 'rgba(120,150,200,.30)' : 'rgba(60,90,120,.35)';
  ctx.lineWidth = 1;
  for (const f of feats) {
    if (!bboxVisible(f.bbox)) continue;
    for (const ring of f.rings) {
      ctx.beginPath();
      tracePath(ring);
      ctx.fill(); ctx.stroke();
    }
  }
}
function bboxVisible(bb) {
  const a = project(bb[0], bb[3]), b = project(bb[2], bb[1]);
  const pad = 80;
  return !(Math.max(a[0], b[0]) < -pad || Math.min(a[0], b[0]) > view.w + pad ||
           Math.max(a[1], b[1]) < -pad || Math.min(a[1], b[1]) > view.h + pad);
}
/* Trace a lon/lat ring into the current path.
   A ring that straddles the antimeridian projects into two far-apart runs of
   points; joining them would smear a band across the whole map, so each run is
   emitted as its own closed subpath. */
function tracePath(ring) {
  const brk = worldPx(cam.zoom) / 2;
  let prevX = null, open = false;
  for (let i = 0; i < ring.length; i++) {
    const p = project(ring[i][0], ring[i][1]);
    if (!open || (prevX !== null && Math.abs(p[0] - prevX) > brk)) {
      if (open) ctx.closePath();
      ctx.moveTo(p[0], p[1]);
      open = true;
    } else ctx.lineTo(p[0], p[1]);
    prevX = p[0];
  }
  if (open) ctx.closePath();
}

/* ═════════════ point-in-polygon country / state detection ═════════════ */

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function featureAt(lon, lat, feats) {
  for (const f of feats) {
    const b = f.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;   // bbox pre-check
    for (const ring of f.rings) if (pointInRing(lon, lat, ring)) return f;
  }
  return null;
}
const isUSA = n => n === 'United States of America' || n === 'United States' || n === 'USA';

function recomputeVisited() {
  S.visitedCountries = new Set();
  S.visitedStates = new Set();
  S.visitedCities = new Set();
  const C = window.COUNTRY_FEATS || [], U = window.US_STATE_FEATS || [];
  for (const s of S.stops) {
    if (s.city) S.visitedCities.add(s.city);
    const c = featureAt(s.lon, s.lat, C);
    if (c) {
      S.visitedCountries.add(c.name);
      if (isUSA(c.name)) {
        const st = featureAt(s.lon, s.lat, U);
        if (st) S.visitedStates.add(st.name);
      }
    } else {
      const st = featureAt(s.lon, s.lat, U);   // Alaska/Hawaii can miss the 110m outline
      if (st) { S.visitedStates.add(st.name); S.visitedCountries.add('United States of America'); }
    }
  }
}

/* ═════════════════════════ leg geometry ═════════════════════════ */

function greatCircle(a, b, n) {
  const φ1 = rad(a[1]), λ1 = rad(a[0]), φ2 = rad(b[1]), λ2 = rad(b[0]);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d < 1e-9) return [[a[0], a[1]], [b[0], b[1]]];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return unwrapLon(pts);
}
function straight(a, b, n) {
  const u = unwrapLon([[a[0], a[1]], [b[0], b[1]]]);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([lerp(u[0][0], u[1][0], i / n), lerp(u[0][1], u[1][1], i / n)]);
  return pts;
}
function pathKm(pts) {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversine(pts[i - 1], pts[i]);
  return km;
}

/* OSRM public demo server — keyless, CORS-open. */
function osrmKey(a, b) {
  return a.lon.toFixed(4) + ',' + a.lat.toFixed(4) + '|' + b.lon.toFixed(4) + ',' + b.lat.toFixed(4);
}
async function fetchRoad(a, b) {
  const key = osrmKey(a, b);
  if (routeCache.has(key)) return routeCache.get(key);
  const url = 'https://router.project-osrm.org/route/v1/driving/' +
    a.lon + ',' + a.lat + ';' + b.lon + ',' + b.lat + '?overview=full&geometries=geojson';
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error(j.code || 'no route');
    let pts = j.routes[0].geometry.coordinates;
    pts = chaikin(decimate(unwrapLon(pts), MAX_ROUTE_PTS), 1);   // smooth once
    const out = { path: pts, km: j.routes[0].distance / 1000 };
    routeCache.set(key, out);
    return out;
  } catch (e) {
    clearTimeout(to);
    routeCache.set(key, null);      // negative-cache so we don't hammer the server
    return null;
  }
}

function buildLegs() {
  S.legs = [];
  for (let i = 1; i < S.stops.length; i++) {
    const a = S.stops[i - 1], b = S.stops[i], mode = b.mode || 'plane';
    const A = [a.lon, a.lat], B = [b.lon, b.lat];
    let path;
    if (mode === 'plane') path = greatCircle(A, B, Math.max(48, Math.min(220, Math.round(haversine(A, B) / 25))));
    else path = straight(A, B, 64);
    const cached = mode === 'car' ? routeCache.get(osrmKey(a, b)) : null;
    if (cached) { path = cached.path; }
    S.legs.push({
      a, b, mode, path,
      km: cached ? cached.km : pathKm(path),
      road: !!cached, t0: 0, t1: 0, dwellEnd: 0
    });
  }
  computeTimeline();
  recomputeVisited();
}

/* Kick off road-geometry fetches for car legs, then rebuild. */
async function resolveRoads() {
  const jobs = [];
  for (let i = 1; i < S.stops.length; i++) {
    const a = S.stops[i - 1], b = S.stops[i];
    if ((b.mode || 'plane') !== 'car') continue;
    const key = osrmKey(a, b);
    if (routeCache.has(key)) continue;
    jobs.push((async () => {
      S.routing++;
      updateHUD();
      const res = await fetchRoad(a, b);
      S.routing--;
      if (!res) return false;
      return true;
    })());
  }
  if (!jobs.length) return;
  const results = await Promise.all(jobs);
  if (S.recording) { S.pendingRoads = true; return; }   // never mutate geometry mid-take
  if (results.some(Boolean)) { buildLegs(); updateHUD(); requestRender(); }
  else if (jobs.length) toast('Road routing unavailable — using direct lines', 'err');
}

function totalKm() { return S.legs.reduce((s, l) => s + l.km, 0); }

function computeTimeline() {
  const tot = totalKm();
  const budget = clamp(tot / 1000, 12, 60);        // 12s .. 60s of travel time
  let t = 0;
  for (const leg of S.legs) {
    const share = tot > 0 ? leg.km / tot : 1 / Math.max(1, S.legs.length);
    const dur = Math.max(0.5, budget * share);
    leg.t0 = t; leg.t1 = t + dur;
    t = leg.t1 + DWELL;
    leg.dwellEnd = t;
  }
  S.total = S.legs.length ? t + TAIL - DWELL + DWELL : 0;
  if (S.legs.length) S.total = S.legs[S.legs.length - 1].dwellEnd + TAIL;
  S.t = clamp(S.t, 0, S.total);
}

/* Position + heading along a leg at eased progress p∈[0,1]. */
function sampleLeg(leg, p) {
  const path = leg.path;
  if (path.length < 2) return { lon: leg.a.lon, lat: leg.a.lat, hdg: 0, idx: 0 };
  // cumulative lengths (cached on the leg)
  if (!leg._cum || leg._cumFor !== path) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
    leg._cum = cum; leg._cumFor = path; leg._len = cum[cum.length - 1] || 1;
  }
  const target = clamp(p, 0, 1) * leg._len;
  const cum = leg._cum;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid; }
  const seg = (cum[hi] - cum[lo]) || 1;
  const f = (target - cum[lo]) / seg;
  const A = path[lo], B = path[hi];
  const lon = lerp(A[0], B[0], f), lat = lerp(A[1], B[1], f);
  const hdg = Math.atan2((B[0] - A[0]) * Math.cos(rad(lat)), -(B[1] - A[1]));
  return { lon, lat, hdg, idx: hi };
}

/* ═════════════════════════ render pipeline ═════════════════════════ */

let renderQueued = false;
function requestRender() {
  if (renderQueued || S.playing) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; draw(); });
}

function resize() {
  const r = dpr();
  view.w = window.innerWidth; view.h = window.innerHeight;
  cv.width = Math.round(view.w * r); cv.height = Math.round(view.h * r);
  cv.style.width = view.w + 'px'; cv.style.height = view.h + 'px';
  ctx.setTransform(r, 0, 0, r, 0, 0);
  requestRender();
}

function draw() {
  const cfg = STYLES[S.style];
  ctx.save();
  ctx.fillStyle = cfg.bg;
  ctx.fillRect(0, 0, view.w, view.h);

  const painted = drawTileLayer('base');
  if (!painted && !S.tilesOK) drawVectorWorld();
  drawVisitedRegions();
  if (painted) drawTileLayer('overlay');
  drawCountryLabels();
  drawCityLabels();
  drawRoute();
  drawStops();
  drawVehicle();
  drawPin();
  if (S.recording) drawBurnIns();
  ctx.restore();
}

/* ── visited-region tinting ── */
function drawVisitedRegions() {
  if (!S.visitedCountries.size && !S.visitedStates.size) return;
  const C = window.COUNTRY_FEATS || [], U = window.US_STATE_FEATS || [];

  /* Fade the tints out as we zoom in: at street level the fill would otherwise
     flood the whole viewport in amber and hide the map underneath. */
  const fade = clamp((9.5 - cam.zoom) / 3.0, 0.12, 1);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgba(255,179,71,0.13)';               // subtle amber tint
  for (const f of C) {
    if (!S.visitedCountries.has(f.name) || !bboxVisible(f.bbox)) continue;
    for (const ring of f.rings) { ctx.beginPath(); tracePath(ring); ctx.fill(); }
  }

  // US states: stronger fill + stroke + soft outer glow (stroke stays crisp)
  for (const f of U) {
    if (!S.visitedStates.has(f.name) || !bboxVisible(f.bbox)) continue;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(255,179,71,0.30)';
    for (const ring of f.rings) { ctx.beginPath(); tracePath(ring); ctx.fill(); }
    ctx.globalAlpha = Math.max(fade, 0.75);
    ctx.shadowColor = 'rgba(255,179,71,0.85)';
    ctx.shadowBlur = 22;
    ctx.strokeStyle = 'rgba(255,196,110,0.95)';
    ctx.lineWidth = 1.8;
    for (const ring of f.rings) { ctx.beginPath(); tracePath(ring); ctx.stroke(); }
    ctx.restore();
  }
  ctx.restore();
}

function labelStyle(size, weight) {
  ctx.font = (weight || 600) + ' ' + size + 'px Inter,system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
}
function outlinedText(txt, x, y, fill, halo, lw) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw || 3.5;
  ctx.strokeStyle = halo;
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(txt, x, y);
}

function drawCountryLabels() {
  if (cam.zoom > 5.6) return;                          // low zoom only
  const feats = window.COUNTRY_FEATS || [];
  const dark = STYLES[S.style].dark;
  const alpha = clamp((5.6 - cam.zoom) / 1.4, 0, 1) * 0.92;
  ctx.save();
  ctx.globalAlpha = alpha;
  labelStyle(cam.zoom < 3 ? 10 : 11.5, 600);
  const placed = [];
  for (const f of feats) {
    const w = f.bbox[2] - f.bbox[0], h = f.bbox[3] - f.bbox[1];
    if (cam.zoom < 3.2 && w * h < 22) continue;         // hide tiny nations when zoomed out
    if (!bboxVisible(f.bbox)) continue;
    const p = project(f.label[0], f.label[1]);
    if (p[0] < 30 || p[0] > view.w - 30 || p[1] < 70 || p[1] > view.h - 120) continue;
    let clash = false;
    for (const q of placed) if (Math.abs(q[0] - p[0]) < 66 && Math.abs(q[1] - p[1]) < 15) { clash = true; break; }
    if (clash) continue;
    placed.push(p);
    outlinedText(f.name, p[0], p[1],
      dark ? 'rgba(215,228,248,.9)' : 'rgba(30,45,70,.9)',
      dark ? 'rgba(6,10,18,.75)' : 'rgba(255,255,255,.8)');
  }
  ctx.restore();
}

/* City labels for the trip's stops. These replace the old state-name labels:
   a stop is a place you actually went, so the city is the meaningful name.
   Drawn under the stop pin and skipped when it would collide with a
   neighbouring label. */
function drawCityLabels() {
  S.cityLabelled = new Set();
  if (!S.stops.length) return;
  ctx.save();
  labelStyle(clamp(11.5 + cam.zoom * 0.35, 11.5, 16), 700);
  const placed = [];
  for (let si = 0; si < S.stops.length; si++) {
    const st = S.stops[si];
    const nm = st.city || st.name;
    if (!nm || /^-?[\d.]+°/.test(nm)) continue;      // skip raw coordinates
    const p = project(st.lon, st.lat);
    if (p[0] < -60 || p[0] > view.w + 60 || p[1] < -40 || p[1] > view.h + 40) continue;
    const y = p[1] + 26;                             // sit below the pin
    const w = ctx.measureText(nm).width;
    let hit = false;
    for (const q of placed) {
      if (Math.abs(q.x - p[0]) < (q.w + w) / 2 + 8 && Math.abs(q.y - y) < 16) { hit = true; break; }
    }
    if (hit) continue;
    placed.push({ x: p[0], y, w });
    S.cityLabelled.add(si);
    outlinedText(nm.toUpperCase(), p[0], y, '#ffd79a', 'rgba(20,10,0,.8)', 4);
  }
  ctx.restore();
}

/* ── the route polyline (progressively revealed during playback) ── */
/* Shift a path by whole turns so it sits on the same "copy" of the world as the
   camera. Without this a Tokyo→Sydney arc unwrapped to lon 190 would project on
   the far side of the seam. */
function anchorPath(pts) {
  if (!pts.length) return pts;
  let mid = pts[pts.length >> 1][0];
  let shift = 0;
  while (mid - cam.lon - shift > 180) shift += 360;
  while (mid - cam.lon - shift < -180) shift -= 360;
  if (!shift) return pts;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) out[i] = [pts[i][0] - shift, pts[i][1]];
  return out;
}

function strokePath(pts, from, to) {
  pts = anchorPath(pts);
  ctx.beginPath();
  let started = false, prev = null;
  const brk = worldPx(cam.zoom) / 2;
  const n = pts.length;
  const i0 = Math.max(0, Math.floor(from * (n - 1)));
  const i1 = Math.min(n - 1, Math.ceil(to * (n - 1)));
  for (let i = i0; i <= i1; i++) {
    const p = project(pts[i][0], pts[i][1]);
    if (prev && Math.abs(p[0] - prev[0]) > brk) { ctx.moveTo(p[0], p[1]); }
    else if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
    else ctx.lineTo(p[0], p[1]);
    prev = p;
  }
  ctx.stroke();
}

function legProgressAt(leg, t) {
  if (t <= leg.t0) return 0;
  if (t >= leg.t1) return 1;
  return easeInOutQuint((t - leg.t0) / (leg.t1 - leg.t0));
}

function drawRoute() {
  if (!S.legs.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const showAll = !S.playing && S.t <= 0;
  for (const leg of S.legs) {
    const col = MODE_COLOR[leg.mode];
    const p = showAll ? 1 : legProgressAt(leg, S.t);
    // ghost of the full leg
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.setLineDash(leg.mode === 'plane' ? [7, 7] : leg.mode === 'boat' ? [3, 6] : []);
    strokePath(leg.path, 0, 1);
    ctx.setLineDash([]);
    if (p <= 0) continue;
    // travelled portion, with glow
    ctx.globalAlpha = 1;
    ctx.shadowColor = col; ctx.shadowBlur = 12;
    ctx.strokeStyle = col; ctx.lineWidth = 3.4;
    strokePath(leg.path, 0, p);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 1.1;
    strokePath(leg.path, 0, p);
  }
  ctx.restore();
}

function drawStops() {
  if (!S.stops.length) return;
  ctx.save();
  labelStyle(12, 700);
  const now = performance.now() / 1000;
  for (let i = 0; i < S.stops.length; i++) {
    const s = S.stops[i];
    const p = project(s.lon, s.lat);
    if (p[0] < -60 || p[0] > view.w + 60 || p[1] < -60 || p[1] > view.h + 60) continue;
    const reached = !S.playing && S.t <= 0 ? true : stopReached(i);
    const hov = S.hoverStop === i;

    if (reached) {                                     // arrival pulse
      const ph = (now * 0.9) % 1;
      ctx.globalAlpha = (1 - ph) * 0.45;
      ctx.beginPath(); ctx.arc(p[0], p[1], 7 + ph * 20, 0, 7);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath(); ctx.arc(p[0], p[1], hov ? 8.5 : 6.5, 0, 7);
    ctx.fillStyle = reached ? '#ffffff' : 'rgba(255,255,255,.45)';
    ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 8;
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 7);
    ctx.fillStyle = MODE_COLOR[s.mode || S.mode]; ctx.fill();

    if (cam.zoom > 2.2 || S.stops.length <= 10) {
      const t = (S.cityLabelled && S.cityLabelled.has(i))
        ? String(i + 1)                       // amber label already names it
        : (i + 1) + '. ' + s.name;
      ctx.font = '700 12px Inter,system-ui,sans-serif';
      const w = ctx.measureText(t).width;
      const bx = p[0] - w / 2 - 7, by = p[1] - 30;
      ctx.fillStyle = 'rgba(10,14,22,.72)';
      roundRect(bx, by, w + 14, 20, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t, p[0], by + 10.5);
    }
  }
  ctx.restore();
}
function stopReached(i) {
  if (i === 0) return S.t >= 0;
  const leg = S.legs[i - 1];
  return leg ? S.t >= leg.t1 : false;
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ── the active leg + vehicle glyph ── */
function activeLeg() {
  for (const leg of S.legs) if (S.t < leg.dwellEnd) return leg;
  return S.legs[S.legs.length - 1] || null;
}
function vehicleState() {
  const leg = activeLeg();
  if (!leg) return null;
  const p = legProgressAt(leg, S.t);
  const s = sampleLeg(leg, p);
  return { leg, p, ...s, dwelling: S.t > leg.t1 };
}

function drawVehicle() {
  if (!S.legs.length) return;
  if (!S.playing && S.t <= 0) return;
  const v = vehicleState();
  if (!v) return;
  const idx = S.legs.indexOf(v.leg);
  if (idx !== S.headingLeg) { S.heading = v.hdg; S.headingLeg = idx; }
  S.heading += angleDiff(S.heading, v.hdg) * 0.16;      // low-pass filter

  const p = project(v.lon, v.lat);
  const col = MODE_COLOR[v.leg.mode];
  ctx.save();
  ctx.translate(p[0], p[1]);

  if (v.dwelling) {                                     // arrival pulse ring
    const ph = ((S.t - v.leg.t1) / DWELL);
    ctx.save();
    ctx.globalAlpha = (1 - ph) * 0.6;
    ctx.beginPath(); ctx.arc(0, 0, 10 + ph * 34, 0, 7);
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, 7);
  ctx.fillStyle = 'rgba(12,17,28,.82)'; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();

  ctx.rotate(S.heading);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (v.leg.mode === 'plane') glyphPlane();
  else if (v.leg.mode === 'car') glyphCar();
  else glyphBoat();
  ctx.restore();
}
function glyphPlane() {
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(2.4, -2.4); ctx.lineTo(9, 2.2); ctx.lineTo(9, 4.4); ctx.lineTo(2.4, 2.6);
  ctx.lineTo(2, 7); ctx.lineTo(4.4, 8.6); ctx.lineTo(4.4, 9.6); ctx.lineTo(0, 8.4);
  ctx.lineTo(-4.4, 9.6); ctx.lineTo(-4.4, 8.6); ctx.lineTo(-2, 7); ctx.lineTo(-2.4, 2.6);
  ctx.lineTo(-9, 4.4); ctx.lineTo(-9, 2.2); ctx.lineTo(-2.4, -2.4);
  ctx.closePath(); ctx.fill();
}
function glyphCar() {
  ctx.beginPath();
  roundRectP(-4.6, -8, 9.2, 16, 3.2); ctx.fill();
  ctx.fillStyle = 'rgba(30,40,60,.95)';
  ctx.beginPath(); roundRectP(-3.4, -5.6, 6.8, 5, 1.6); ctx.fill();
  ctx.beginPath(); roundRectP(-3.4, 1.4, 6.8, 4.4, 1.6); ctx.fill();
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath(); ctx.arc(-2.8, -7.4, 1.1, 0, 7); ctx.arc(2.8, -7.4, 1.1, 0, 7); ctx.fill();
}
function glyphBoat() {
  ctx.beginPath();
  ctx.moveTo(0, -9.5); ctx.lineTo(4.6, 1); ctx.lineTo(3.4, 7.6);
  ctx.lineTo(-3.4, 7.6); ctx.lineTo(-4.6, 1);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(30,45,65,.95)';
  ctx.beginPath(); roundRectP(-2.6, -3.4, 5.2, 5, 1.2); ctx.fill();
}
function roundRectP(x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ── pulsing search pin (lives ~6s) ── */
function drawPin() {
  if (!S.pin) return;
  const age = (performance.now() - S.pin.t0) / 1000;
  if (age > 6) { S.pin = null; return; }
  const p = project(S.pin.lon, S.pin.lat);
  const fade = age > 5 ? 1 - (age - 5) : 1;
  const ph = (age * 1.1) % 1;
  ctx.save();
  ctx.globalAlpha = (1 - ph) * 0.55 * fade;
  ctx.beginPath(); ctx.arc(p[0], p[1], 8 + ph * 30, 0, 7);
  ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2.4; ctx.stroke();
  ctx.globalAlpha = fade;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.bezierCurveTo(p[0] - 11, p[1] - 14, p[0] - 9, p[1] - 28, p[0], p[1] - 28);
  ctx.bezierCurveTo(p[0] + 9, p[1] - 28, p[0] + 11, p[1] - 14, p[0], p[1]);
  ctx.fillStyle = '#4fc3f7';
  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(p[0], p[1] - 20, 4.2, 0, 7); ctx.fillStyle = '#0b1220'; ctx.fill();
  if (S.pin.name) {
    ctx.font = '700 12.5px Inter,system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(S.pin.name).width;
    ctx.fillStyle = 'rgba(10,14,22,.8)';
    roundRect(p[0] - w / 2 - 9, p[1] - 54, w + 18, 22, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(S.pin.name, p[0], p[1] - 43);
  }
  ctx.restore();
}

/* ═════════════ burned-in captions (must live inside the video) ═════════════ */

function currentCaption() {
  if (!S.legs.length) return { title: '', sub: '' };
  const leg = activeLeg();
  if (!leg) return { title: '', sub: '' };
  if (S.t > leg.t1) return { title: leg.b.name, sub: 'Arrived' };
  const p = legProgressAt(leg, S.t);
  return {
    title: leg.a.name + '  →  ' + leg.b.name,
    sub: MODE_NAME[leg.mode] + ' · ' + fmtKm(leg.km) + ' · ' + Math.round(p * 100) + '%'
  };
}

function drawBurnIns() {
  const cap = currentCaption();
  const pad = 26;
  ctx.save();

  // top-left brand watermark of our own (not a provider watermark)
  ctx.font = '700 15px Inter,system-ui,sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  roundRect(pad - 10, pad - 8, ctx.measureText('Travel Animator').width + 20, 30, 9); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.fillText('Travel Animator', pad, pad);

  // caption card, bottom-left
  if (cap.title) {
    ctx.font = '700 24px Inter,system-ui,sans-serif';
    const w1 = ctx.measureText(cap.title).width;
    ctx.font = '600 14px Inter,system-ui,sans-serif';
    const w2 = ctx.measureText(cap.sub).width;
    const w = Math.max(w1, w2) + 34;
    const y = view.h - 118;
    ctx.fillStyle = 'rgba(8,12,20,.62)';
    roundRect(pad, y, w, 74, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = '700 24px Inter,system-ui,sans-serif';
    ctx.fillStyle = '#fff'; ctx.fillText(cap.title, pad + 17, y + 33);
    ctx.font = '600 14px Inter,system-ui,sans-serif';
    ctx.fillStyle = 'rgba(210,225,245,.85)'; ctx.fillText(cap.sub, pad + 17, y + 56);
  }

  // photo waypoint card during the dwell
  const leg = activeLeg();
  if (leg && S.t > leg.t1 && leg.b.img && leg.b.img.complete) {
    const ph = clamp((S.t - leg.t1) / DWELL, 0, 1);
    const a = Math.sin(ph * Math.PI);
    const cw = Math.min(300, view.w * 0.3), chh = cw * 0.68;
    const x = view.w - cw - pad, y = view.h - chh - 118;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(8,12,20,.7)';
    roundRect(x - 8, y - 8, cw + 16, chh + 42, 14); ctx.fill();
    ctx.save(); roundRect(x, y, cw, chh, 9); ctx.clip();
    const im = leg.b.img, s = Math.max(cw / im.width, chh / im.height);
    ctx.drawImage(im, x + (cw - im.width * s) / 2, y + (chh - im.height * s) / 2, im.width * s, im.height * s);
    ctx.restore();
    ctx.font = '600 13px Inter,system-ui,sans-serif';
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(230,238,250,.9)';
    ctx.fillText(leg.b.name, x + 2, y + chh + 20);
    ctx.restore();
  }

  // elapsed + distance chips, top-right
  const travelled = travelledKm();
  const chips = [fmtTime(S.t) + ' / ' + fmtTime(S.total), fmtKm(travelled) + ' travelled'];
  ctx.font = '600 13px Inter,system-ui,sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  let cy = pad + 10;
  for (const c of chips) {
    const w = ctx.measureText(c).width + 22;
    ctx.fillStyle = 'rgba(8,12,20,.6)';
    roundRect(view.w - pad - w, cy - 13, w, 26, 8); ctx.fill();
    ctx.fillStyle = 'rgba(235,242,252,.92)';
    ctx.fillText(c, view.w - pad - 11, cy);
    cy += 32;
  }

  // slim progress bar along the bottom edge
  const pr = S.total ? clamp(S.t / S.total, 0, 1) : 0;
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.fillRect(0, view.h - 5, view.w, 5);
  const g = ctx.createLinearGradient(0, 0, view.w, 0);
  g.addColorStop(0, '#4fc3f7'); g.addColorStop(1, '#7c8cff');
  ctx.fillStyle = g;
  ctx.fillRect(0, view.h - 5, view.w * pr, 5);
  ctx.restore();
}

function travelledKm() {
  let km = 0;
  for (const leg of S.legs) {
    if (S.t >= leg.t1) km += leg.km;
    else if (S.t > leg.t0) { km += leg.km * legProgressAt(leg, S.t); break; }
    else break;
  }
  return km;
}

/* ═════════════════════════ camera ═════════════════════════ */

function boundsOf(points) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) {
    minLon = Math.min(minLon, p[0]); maxLon = Math.max(maxLon, p[0]);
    minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
  }
  return [minLon, minLat, maxLon, maxLat];
}
/* Zoom that fits a lon/lat bbox into the viewport with fractional padding. */
function zoomForBounds(bb, padX, padY) {
  const w = Math.max(60, view.w * (1 - padX * 2));
  const h = Math.max(60, view.h * (1 - padY * 2));
  const Z = 8;                                    // reference zoom for the math
  const dx = Math.abs(lonToWorldX(bb[2], Z) - lonToWorldX(bb[0], Z)) || 1;
  const dy = Math.abs(latToWorldY(bb[1], Z) - latToWorldY(bb[3], Z)) || 1;
  const z = Z + Math.log2(Math.min(w / dx, h / dy));
  return clamp(z, MIN_Z, MAX_Z);
}
function centerOfBounds(bb) {
  const Z = 8;
  const lon = (bb[0] + bb[2]) / 2;
  const lat = worldYToLat((latToWorldY(bb[1], Z) + latToWorldY(bb[3], Z)) / 2, Z);
  return [lon, lat];
}
function tripBounds() {
  const pts = [];
  for (const s of S.stops) pts.push([s.lon, s.lat]);
  for (const l of S.legs) for (let i = 0; i < l.path.length; i += Math.max(1, Math.floor(l.path.length / 60))) pts.push(l.path[i]);
  return pts.length ? boundsOf(pts) : null;
}
function fitTrip(animated) {
  const bb = tripBounds();
  if (!bb) return;
  const c = centerOfBounds(bb);
  const z = zoomForBounds(bb, 0.14, 0.20);
  if (animated) flyTo(c[0], c[1], z, 1200);
  else { cam.lon = c[0]; cam.lat = c[1]; cam.zoom = z; requestRender(); }
}

function flyTo(lon, lat, zoom, ms) {
  S.fly = {
    t0: performance.now(), ms: ms || 1800,
    from: { lon: cam.lon, lat: cam.lat, zoom: cam.zoom },
    to: { lon, lat, zoom: clamp(zoom, MIN_Z, MAX_Z) }
  };
  if (!S.playing) tickFly();
}
function tickFly() {
  if (!S.fly) return;
  const f = S.fly;
  const t = clamp((performance.now() - f.t0) / f.ms, 0, 1);
  const e = easeInOutCubic(t);
  // zoom out slightly mid-flight for long hops (cinematic arc)
  const dist = Math.hypot(f.to.lon - f.from.lon, f.to.lat - f.from.lat);
  const dip = dist > 25 ? Math.sin(t * Math.PI) * Math.min(2.2, dist / 40) : 0;
  cam.lon = lerp(f.from.lon, f.to.lon, e);
  cam.lat = lerp(f.from.lat, f.to.lat, e);
  cam.zoom = lerp(f.from.zoom, f.to.zoom, e) - dip;
  if (t >= 1) S.fly = null;
  if (!S.playing) { draw(); if (S.fly) requestAnimationFrame(tickFly); }
}
function cancelFly() { S.fly = null; }

/* Cinematic follow camera: frame the active leg, ease toward it each frame. */
function cameraStep(dt) {
  if (!S.follow || !S.legs.length) return;
  if (performance.now() < S.camHoldUntil) return;
  const v = vehicleState();
  if (!v) return;

  const leg = v.leg;
  const bb = boundsOf([[leg.a.lon, leg.a.lat], [leg.b.lon, leg.b.lat], [v.lon, v.lat]]);
  const segZoom = zoomForBounds(bb, 0.18, 0.22);
  const c = centerOfBounds(bb);

  // blend: early/late in the leg hug the vehicle, mid-leg frame the whole segment
  const hug = 1 - Math.sin(clamp(v.p, 0, 1) * Math.PI);           // 1 at ends, 0 mid
  const tgtLon = lerp(c[0], v.lon, hug * 0.75);
  const tgtLat = lerp(c[1], v.lat, hug * 0.75);
  const tgtZoom = clamp(segZoom + hug * 0.85, MIN_Z, 13.5);

  cam.lon += angleDiffDeg(cam.lon, tgtLon) * clamp(dt * 1.7, 0, 1);
  cam.lat += (tgtLat - cam.lat) * clamp(dt * 1.5, 0, 1);
  cam.zoom += (tgtZoom - cam.zoom) * clamp(dt * 1.0, 0, 1);
  cam.zoom = clamp(cam.zoom, MIN_Z, MAX_Z);
}
function angleDiffDeg(a, b) {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/* ═════════════════════════ playback loop ═════════════════════════ */

let lastFrame = 0, rafId = 0;

function loop(now) {
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;

  if (S.fly) tickFly();
  if (S.playing) {
    S.t += dt * SPEEDS[S.speed];
    if (S.t >= S.total) { S.t = S.total; setPlaying(false); onPlaybackEnd(); }
    if (!S.fly) cameraStep(dt);
  }
  draw();
  syncScrub();
}
function startLoop() { if (!rafId) { lastFrame = performance.now(); rafId = requestAnimationFrame(loop); } }
function stopLoop() {
  if (rafId && !S.playing && !S.recording && !S.fly) { cancelAnimationFrame(rafId); rafId = 0; requestRender(); }
}
function setPlaying(on) {
  if (on && !S.legs.length) { toast('Draw a route first — hit “Draw route” or load a demo', 'err'); return; }
  if (on && S.t >= S.total) S.t = 0;
  S.playing = on;
  S.headingLeg = -1;
  $('#playIco').innerHTML = on
    ? '<path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2.4"/>'
    : '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>';
  $('#playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on) startLoop(); else setTimeout(stopLoop, 60);
}
function onPlaybackEnd() {
  if (S.recording) setTimeout(stopRecording, 700);
}

/* ═════════════════════════ pointer interaction ═════════════════════════ */

let drag = null;
cv.addEventListener('pointerdown', e => {
  if (e.button === 2) return;
  cv.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
});
cv.addEventListener('pointermove', e => {
  if (!drag) {
    const [lon, lat] = unproject(e.clientX, e.clientY);
    let hit = -1;
    for (let i = 0; i < S.stops.length; i++) {
      const p = project(S.stops[i].lon, S.stops[i].lat);
      if (Math.hypot(p[0] - e.clientX, p[1] - e.clientY) < 12) { hit = i; break; }
    }
    if (hit !== S.hoverStop) { S.hoverStop = hit; cv.style.cursor = hit >= 0 ? 'pointer' : (S.drawing ? 'crosshair' : 'grab'); requestRender(); }
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4) {
    drag.moved = true;
    cv.classList.add('dragging');
    userTookControl();
  }
  drag.x = e.clientX; drag.y = e.clientY;
  const wp = worldPx(cam.zoom);
  let wx = lonToWorldX(cam.lon, cam.zoom) - dx;
  const wy = clamp(latToWorldY(cam.lat, cam.zoom) - dy, 1, wp - 1);
  wx = ((wx % wp) + wp) % wp;
  cam.lon = worldXToLon(wx, cam.zoom);
  cam.lat = worldYToLat(wy, cam.zoom);
  requestRender();
});
cv.addEventListener('pointerup', e => {
  const wasDrag = drag && drag.moved;
  cv.classList.remove('dragging');
  drag = null;
  if (wasDrag) return;
  if (S.hoverStop >= 0 && !S.drawing) { flyToStop(S.hoverStop); return; }
  if (S.drawing) addStopAt(e.clientX, e.clientY);
});
cv.addEventListener('pointercancel', () => { drag = null; cv.classList.remove('dragging'); });

cv.addEventListener('contextmenu', e => {
  e.preventDefault();
  for (let i = 0; i < S.stops.length; i++) {
    const p = project(S.stops[i].lon, S.stops[i].lat);
    if (Math.hypot(p[0] - e.clientX, p[1] - e.clientY) < 14) {
      const nm = S.stops[i].name;
      S.stops.splice(i, 1);
      afterStopsChanged();
      toast('Removed ' + nm);
      return;
    }
  }
});

cv.addEventListener('wheel', e => {
  e.preventDefault();
  userTookControl();
  const before = unproject(e.clientX, e.clientY);
  const delta = -e.deltaY * (e.deltaMode === 1 ? 0.03 : 0.0022);
  cam.zoom = clamp(cam.zoom + delta * 2.2, MIN_Z, MAX_Z);
  const after = unproject(e.clientX, e.clientY);
  cam.lon += before[0] - after[0];                 // keep the cursor anchored
  cam.lat += before[1] - after[1];
  cam.lat = clamp(cam.lat, -85, 85);
  requestRender();
}, { passive: false });

/* pinch zoom */
const touches = new Map();
cv.addEventListener('touchstart', e => { for (const t of e.changedTouches) touches.set(t.identifier, t); }, { passive: true });
cv.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (cv._pd) {
      userTookControl();
      cam.zoom = clamp(cam.zoom + Math.log2(d / cv._pd), MIN_Z, MAX_Z);
      requestRender();
    }
    cv._pd = d;
  }
}, { passive: false });
cv.addEventListener('touchend', () => { cv._pd = 0; }, { passive: true });

function userTookControl() {
  cancelFly();
  S.camHoldUntil = performance.now() + CAM_HOLD_MS;
}

function flyToStop(i) {
  const s = S.stops[i];
  flyTo(s.lon, s.lat, Math.max(cam.zoom, 8), 1100);
  S.pin = { lon: s.lon, lat: s.lat, name: s.name, t0: performance.now() };
}

/* ═════════════════════════ stops ═════════════════════════ */

/* ═══════════ reverse geocoding → city names (keyless, CORS-open) ═══════════
   Photon first (fast, no usage policy), Nominatim as the fallback. Both send
   Access-Control-Allow-Origin: *, so neither can taint the canvas.
   Photon's `name` is often a POI ("WSKQ-FM (New York)"), so structured
   locality fields are preferred and `name` is only a last resort. */
const revCache = new Map();
const revKey = (lon, lat) => lon.toFixed(3) + ',' + lat.toFixed(3);

function pickLocality(o) {
  return o.city || o.town || o.village || o.hamlet || o.municipality ||
         o.locality || o.suburb || o.city_district || o.district || null;
}

async function reverseGeocode(lon, lat) {
  const key = revKey(lon, lat);
  if (revCache.has(key)) return revCache.get(key);

  let name = null;
  try {                                                   // ── Photon
    const r = await fetch('https://photon.komoot.io/reverse?lon=' + lon +
                          '&lat=' + lat + '&limit=1');
    if (r.ok) {
      const p = (await r.json())?.features?.[0]?.properties;
      if (p) {
        name = pickLocality(p) || p.county ||
               (['city','town','village','locality'].includes(p.type) ? p.name : null);
      }
    }
  } catch (e) { /* offline → fall through */ }

  if (!name) {
    try {                                                 // ── Nominatim
      const r = await fetch('https://nominatim.openstreetmap.org/reverse' +
                            '?format=jsonv2&zoom=10&lon=' + lon + '&lat=' + lat);
      if (r.ok) {
        const a = (await r.json())?.address;
        if (a) name = pickLocality(a) || a.county || null;
      }
    } catch (e) { /* offline */ }
  }

  revCache.set(key, name);        // negative-cached too: don't re-ask on failure
  return name;
}

/* Give the stop an instant offline name, then upgrade it to the real city
   as soon as the network answers. Never blocks the UI. */
async function resolveCity(stop) {
  const city = await reverseGeocode(stop.lon, stop.lat);
  if (!city || !S.stops.includes(stop)) return;
  stop.city = city;
  stop.name = city;
  recomputeVisited();
  updateHUD();
  buildTicks();
  autosave();
  requestRender();
}

function stopLabel(lon, lat) {
  const c = featureAt(lon, lat, window.COUNTRY_FEATS || []);
  if (c && isUSA(c.name)) {
    const st = featureAt(lon, lat, window.US_STATE_FEATS || []);
    if (st) return st.name;
  }
  if (c) return c.name;
  const st = featureAt(lon, lat, window.US_STATE_FEATS || []);
  if (st) return st.name;
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  return Math.abs(lat).toFixed(1) + '°' + ns + ' ' + Math.abs(lon).toFixed(1) + '°' + ew;
}
function addStopAt(px, py) {
  const [lon, lat] = unproject(px, py);
  const stop = { name: stopLabel(lon, lat), lon, lat, mode: S.mode };
  addStop(stop);
  resolveCity(stop);            // upgrades "Georgia" → "Atlanta" when it lands
}
function addStop(s) {
  S.stops.push(s);
  afterStopsChanged();
}
function afterStopsChanged() {
  buildLegs();
  resolveRoads();
  updateHUD();
  buildTicks();
  autosave();
  if (S.autoZoom && S.stops.length > 1) fitTrip(true);
  requestRender();
}

/* ═════════════════════════ HUD / dock sync ═════════════════════════ */

function updateHUD() {
  $('#hudStops').textContent = S.stops.length;
  $('#hudDist').textContent = fmtKm(totalKm());
  const counts = { plane: 0, car: 0, boat: 0 };
  for (const l of S.legs) counts[l.mode]++;
  const parts = [];
  if (counts.plane) parts.push(counts.plane + '✈');
  if (counts.car) parts.push(counts.car + '🚗');
  if (counts.boat) parts.push(counts.boat + '⛵');
  $('#hudLegs').textContent = (parts.join('  ') || '—') + (S.routing ? '  ⟳' : '');

  const vis = $('#hudVisited');
  const cities = [...S.visitedCities].sort();
  const states = [...S.visitedStates].sort();
  const countries = [...S.visitedCountries].sort();
  if (cities.length || states.length || countries.length) {
    vis.classList.add('on');
    let html = '';
    if (cities.length) html += 'Visited: <b>' + cities.join(', ') + '</b>';
    else if (states.length) html += 'Visited: <b>' + states.join(', ') + '</b>';
    if (cities.length && states.length)
      html += '<br><span style="opacity:.75">' +
              states.length + (states.length === 1 ? ' state: ' : ' states: ') +
              states.join(', ') + '</span>';
    if (countries.length) html += (html ? '<br>' : '') +
      '<span style="opacity:.75">' + countries.length + ' ' +
      (countries.length === 1 ? 'country' : 'countries') + ': ' +
      countries.map(c => c.replace('United States of America', 'USA')).join(', ') + '</span>';
    vis.innerHTML = html;
  } else vis.classList.remove('on');

  const meta = $('#tMeta');
  if (!S.legs.length) meta.textContent = 'Draw a route to begin';
  else {
    const cap = currentCaption();
    meta.textContent = (S.playing || S.t > 0 ? cap.title + ' · ' : '') +
      S.legs.length + ' legs · ' + fmtKm(totalKm());
  }
  $('#tTot').textContent = fmtTime(S.total);
}

function buildTicks() {
  const el = $('#ticks');
  el.innerHTML = '';
  if (!S.total) return;
  for (const leg of S.legs) {
    const i = document.createElement('i');
    i.style.left = (leg.t1 / S.total * 100) + '%';
    el.appendChild(i);
  }
}
function syncScrub() {
  const pr = S.total ? clamp(S.t / S.total, 0, 1) : 0;
  $('#trackFill').style.width = (pr * 100) + '%';
  $('#knob').style.left = (pr * 100) + '%';
  $('#tCur').textContent = fmtTime(S.t);
  if (S.playing) {
    const cap = currentCaption();
    $('#tMeta').textContent = cap.title + ' · ' + cap.sub;
  }
}

/* ═════════════════════════ toasts ═════════════════════════ */

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

/* ═════════════════════════ place search ═════════════════════════ */

const searchEl = $('#search'), resultsEl = $('#results'), wrapEl = $('#searchWrap');
let searchTimer = 0, searchSeq = 0, results = [], selIdx = -1;

searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim();
  wrapEl.classList.toggle('filled', q.length > 0);
  clearTimeout(searchTimer);
  if (q.length < 2) { closeResults(); return; }
  searchTimer = setTimeout(() => runSearch(q), 320);
});
searchEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (results.length) chooseResult(results[Math.max(0, selIdx)]);
  } else if (e.key === 'Escape') { closeResults(); searchEl.blur(); }
});
$('#searchClear').onclick = () => { searchEl.value = ''; wrapEl.classList.remove('filled'); closeResults(); searchEl.focus(); };
document.addEventListener('click', e => { if (!wrapEl.contains(e.target)) closeResults(); });

function move(d) {
  if (!results.length) return;
  selIdx = (selIdx + d + results.length) % results.length;
  [...resultsEl.children].forEach((c, i) => c.classList.toggle('sel', i === selIdx));
  const n = resultsEl.children[selIdx];
  if (n) n.scrollIntoView({ block: 'nearest' });
}
function closeResults() { resultsEl.classList.remove('open'); results = []; selIdx = -1; }

async function runSearch(q) {
  const seq = ++searchSeq;
  resultsEl.classList.add('open');
  resultsEl.innerHTML = '<div class="empty">Searching…</div>';
  let list = await photon(q);
  if (!list) list = await nominatim(q);
  if (seq !== searchSeq) return;
  if (!list || !list.length) {
    resultsEl.innerHTML = '<div class="empty">No matches — try another spelling</div>';
    results = [];
    return;
  }
  results = list;
  selIdx = 0;
  renderResults();
}
async function photon(q) {
  try {
    const r = await fetch('https://photon.komoot.io/api?q=' + encodeURIComponent(q) + '&limit=8');
    if (!r.ok) throw 0;
    const j = await r.json();
    return (j.features || []).map(f => {
      const p = f.properties || {};
      const sub = [p.city, p.state, p.country].filter(Boolean).join(', ');
      const e = p.extent;   // [minLon, maxLat, maxLon, minLat]
      return {
        name: p.name || p.city || q,
        sub: sub || (p.osm_value || ''),
        lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
        bbox: e ? [Math.min(e[0], e[2]), Math.min(e[1], e[3]), Math.max(e[0], e[2]), Math.max(e[1], e[3])] : null
      };
    });
  } catch (e) { return null; }
}
async function nominatim(q) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=' + encodeURIComponent(q));
    if (!r.ok) throw 0;
    const j = await r.json();
    return j.map(f => {
      const bb = f.boundingbox;   // [minLat, maxLat, minLon, maxLon]
      const parts = (f.display_name || '').split(',');
      return {
        name: parts[0].trim(),
        sub: parts.slice(1, 4).join(',').trim(),
        lon: +f.lon, lat: +f.lat,
        bbox: bb ? [+bb[2], +bb[0], +bb[3], +bb[1]] : null
      };
    });
  } catch (e) { return null; }
}
function renderResults() {
  resultsEl.innerHTML = '';
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === selIdx ? ' sel' : '');
    row.innerHTML = '<svg class="pin" viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>' +
      '<div><div class="nm"></div><div class="sub"></div></div>';
    row.querySelector('.nm').textContent = r.name;
    row.querySelector('.sub').textContent = r.sub || '';
    row.onclick = () => chooseResult(r);
    resultsEl.appendChild(row);
  });
  resultsEl.classList.add('open');
}
function chooseResult(r) {
  closeResults();
  searchEl.blur();
  let z = 12.5;
  if (r.bbox && (r.bbox[2] - r.bbox[0] > 0.001 || r.bbox[3] - r.bbox[1] > 0.001)) {
    z = clamp(zoomForBounds(r.bbox, 0.12, 0.16), 3, 14);
  }
  flyTo(r.lon, r.lat, z, 2400);
  S.pin = { lon: r.lon, lat: r.lat, name: r.name, t0: performance.now() };
  toast('Flying to ' + r.name);
  if (S.drawing) {
    addStop({ name: r.name, city: r.name, lon: r.lon, lat: r.lat, mode: S.mode });
    toast('Added ' + r.name + ' as stop ' + S.stops.length, 'ok');
  }
}

/* ═════════════════════════ WebM export ═════════════════════════ */

let recorder = null, chunks = [];

function pickMime() {
  const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return null;
}
function startRecording() {
  if (!S.legs.length) { toast('Draw a route before recording', 'err'); return; }
  if (!window.MediaRecorder || !cv.captureStream) { toast('This browser cannot record canvas video', 'err'); return; }
  const mime = pickMime();
  if (!mime) { toast('No WebM encoder available in this browser', 'err'); return; }
  let stream;
  try { stream = cv.captureStream(60); }
  catch (e) { toast('captureStream failed: ' + e.message, 'err'); return; }
  chunks = [];
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
  } catch (e) { toast('MediaRecorder failed: ' + e.message, 'err'); return; }

  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    chunks = [];
    if (!blob.size) { toast('Recording produced no data', 'err'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'travel-animation.webm';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    toast('Saved travel-animation.webm (' + (blob.size / 1048576).toFixed(1) + ' MB)', 'ok');
  };

  S.recording = true;
  S.t = 0; S.headingLeg = -1;
  $('#recBtn').classList.add('on');
  $('#recLbl').textContent = 'Stop';
  recorder.start(250);
  startLoop();
  setPlaying(true);
  toast('Recording… captions are burned into the video', 'ok');
}
function stopRecording() {
  if (!S.recording) return;
  S.recording = false;
  $('#recBtn').classList.remove('on');
  $('#recLbl').textContent = 'Record';
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
  recorder = null;
  setPlaying(false);
  if (S.pendingRoads) { S.pendingRoads = false; buildLegs(); updateHUD(); requestRender(); }
}

/* ═════════════════════════ trip persistence ═════════════════════════ */

function serializeTrip() {
  return {
    v: 1, style: S.style,
    stops: S.stops.map(s => ({ n: s.name, o: +s.lon.toFixed(5), a: +s.lat.toFixed(5), m: s.mode || 'plane' }))
  };
}
function loadTrip(obj, quiet) {
  if (!obj || !Array.isArray(obj.stops)) { toast('That file is not a Travel Animator trip', 'err'); return; }
  S.stops = obj.stops.map(s => ({ name: s.n || s.name || 'Stop', lon: +(s.o ?? s.lon), lat: +(s.a ?? s.lat), mode: s.m || s.mode || 'plane' }))
    .filter(s => isFinite(s.lon) && isFinite(s.lat));
  if (obj.style && STYLES[obj.style]) setStyle(obj.style, true);
  S.t = 0;
  afterStopsChanged();
  fitTrip(true);
  if (!quiet) toast('Loaded ' + S.stops.length + ' stops', 'ok');
}
function autosave() {
  try { localStorage.setItem('ta.trip', JSON.stringify(serializeTrip())); } catch (e) {}
}
function restoreAutosave() {
  try {
    const raw = localStorage.getItem('ta.trip');
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o.stops || !o.stops.length) return false;
    loadTrip(o, true);
    return true;
  } catch (e) { return false; }
}
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))).replace(/=+$/, ''); }
function b64decode(str) { return decodeURIComponent(escape(atob(str))); }
function shareLink() {
  if (!S.stops.length) { toast('Nothing to share yet', 'err'); return; }
  const hash = '#trip=' + b64encode(JSON.stringify(serializeTrip()));
  const url = location.origin + location.pathname + hash;
  history.replaceState(null, '', hash);
  if (navigator.clipboard && location.protocol !== 'file:') {
    navigator.clipboard.writeText(url).then(
      () => toast('Share link copied to clipboard', 'ok'),
      () => toast('Link is in the address bar — copy it', 'ok'));
  } else toast('Link is in the address bar — copy it', 'ok');
}
function loadFromHash() {
  const m = /[#&]trip=([^&]+)/.exec(location.hash);
  if (!m) return false;
  try { loadTrip(JSON.parse(b64decode(m[1])), true); toast('Loaded shared trip', 'ok'); return true; }
  catch (e) { return false; }
}
function downloadTrip() {
  if (!S.stops.length) { toast('Nothing to save yet', 'err'); return; }
  const blob = new Blob([JSON.stringify(serializeTrip(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'my-trip.ta.trip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Saved my-trip.ta.trip', 'ok');
}

/* GPX / KML import — reuses the whole rendering pipeline. */
function importTrack(text, filename) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'text/xml'); } catch (e) { doc = null; }
  if (!doc || doc.querySelector('parsererror')) { toast('Could not parse that file', 'err'); return; }
  let pts = [];
  const trkpts = doc.getElementsByTagName('trkpt');
  const rtepts = doc.getElementsByTagName('rtept');
  const wpts = doc.getElementsByTagName('wpt');
  const src = trkpts.length ? trkpts : rtepts.length ? rtepts : wpts;
  for (const n of src) {
    const lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
    const nameEl = n.getElementsByTagName('name')[0];
    if (isFinite(lat) && isFinite(lon)) pts.push({ lon, lat, name: nameEl ? nameEl.textContent.trim() : null });
  }
  if (!pts.length) {                                   // KML
    for (const c of doc.getElementsByTagName('coordinates')) {
      for (const tri of c.textContent.trim().split(/\s+/)) {
        const [lon, lat] = tri.split(',').map(Number);
        if (isFinite(lat) && isFinite(lon)) pts.push({ lon, lat, name: null });
      }
    }
  }
  if (!pts.length) { toast('No track points found', 'err'); return; }
  const keep = decimate(pts, 24);
  S.stops = keep.map((p, i) => ({
    name: p.name || (i === 0 ? 'Start' : i === keep.length - 1 ? 'Finish' : stopLabel(p.lon, p.lat)),
    lon: p.lon, lat: p.lat, mode: S.mode
  }));
  S.t = 0;
  afterStopsChanged();
  fitTrip(true);
  toast('Imported ' + S.stops.length + ' points from ' + filename, 'ok');
}

/* ═════════════════════════ UI wiring ═════════════════════════ */

function setStyle(k, quiet) {
  S.style = k;
  $('#styleLabel').textContent = STYLES[k].name;
  $('#attrib').textContent = STYLES[k].attrib;
  [...$('#styleMenu').children].forEach(b => b.classList.toggle('on', b.dataset.style === k));
  cam.zoom = Math.min(cam.zoom, STYLES[k].maxZoom);
  S.tileFails = 0; S.tileTries = 0; S.tilesOK = true;
  requestRender();
  if (!quiet) toast(STYLES[k].name + ' basemap');
}

(function buildStyleMenu() {
  const m = $('#styleMenu');
  for (const [k, cfg] of Object.entries(STYLES)) {
    const b = document.createElement('button');
    b.dataset.style = k;
    b.innerHTML = '<span>' + cfg.name + '</span><span class="mi-sub">' +
      (k === 'dark' ? 'Esri Canvas' : k === 'streets' ? 'OSM' : k === 'satellite' ? 'Esri Imagery' : 'OpenTopoMap') + '</span>';
    b.onclick = () => { setStyle(k); closeMenus(); };
    m.appendChild(b);
  }
})();
(function buildDemoMenu() {
  const m = $('#demoMenu');
  for (const name of Object.keys(DEMOS)) {
    const b = document.createElement('button');
    const d = DEMOS[name];
    b.innerHTML = '<span>' + name + '</span><span class="mi-sub">' + d.stops.length + ' stops</span>';
    b.onclick = () => { loadDemo(name); closeMenus(); };
    m.appendChild(b);
  }
})();
function loadDemo(name) {
  const d = DEMOS[name];
  if (!d) return;
  S.mode = d.mode;
  syncModeSeg();
  S.stops = d.stops.map(([n, lon, lat, mode]) => ({ name: n, city: n, lon, lat, mode }));
  S.t = 0;
  afterStopsChanged();
  fitTrip(true);
  toast(name + ' loaded — press Play', 'ok');
}

function toggleMenu(hostBtn, menu) {
  const open = menu.classList.contains('open');
  closeMenus();
  if (!open) menu.classList.add('open');
}
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
document.addEventListener('click', e => { if (!e.target.closest('.menu-host')) closeMenus(); });
$('#styleBtn').onclick = () => toggleMenu(0, $('#styleMenu'));
$('#demoBtn').onclick = () => toggleMenu(0, $('#demoMenu'));
$('#tripBtn').onclick = () => toggleMenu(0, $('#tripMenu'));

$('#tripMenu').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  closeMenus();
  const a = b.dataset.trip;
  if (a === 'share') shareLink();
  else if (a === 'save') downloadTrip();
  else if (a === 'load') $('#fileTrip').click();
  else if (a === 'gpx') $('#fileGpx').click();
  else if (a === 'photo') {
    if (!S.stops.length) { toast('Add a stop first', 'err'); return; }
    $('#filePhoto').click();
  }
};
$('#fileTrip').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { loadTrip(JSON.parse(r.result)); } catch (x) { toast('Invalid trip file', 'err'); } };
  r.readAsText(f); e.target.value = '';
};
$('#fileGpx').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => importTrack(r.result, f.name);
  r.readAsText(f); e.target.value = '';
};
$('#filePhoto').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    const stop = S.stops[S.stops.length - 1];
    const img = new Image();
    img.onload = () => { stop.img = img; requestRender(); toast('Photo attached to ' + stop.name, 'ok'); };
    img.src = r.result;
  };
  r.readAsDataURL(f); e.target.value = '';
};

$('#playBtn').onclick = () => setPlaying(!S.playing);
$('#zoomIn').onclick = () => { userTookControl(); cam.zoom = clamp(cam.zoom + 1, MIN_Z, MAX_Z); requestRender(); };
$('#zoomOut').onclick = () => { userTookControl(); cam.zoom = clamp(cam.zoom - 1, MIN_Z, MAX_Z); requestRender(); };
$('#fitBtn').onclick = () => { if (S.stops.length) fitTrip(true); else flyTo(8, 26, 2.2, 900); };

$('#drawBtn').onclick = () => {
  S.drawing = !S.drawing;
  $('#drawBtn').classList.toggle('on', S.drawing);
  cv.classList.toggle('drawing', S.drawing);
  cv.style.cursor = S.drawing ? 'crosshair' : 'grab';
  toast(S.drawing ? 'Click the map to add stops · right-click a stop to delete' : 'Draw mode off');
};
$('#modeSeg').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  S.mode = b.dataset.mode;
  syncModeSeg();
  toast(MODE_NAME[S.mode] + ' selected for the next leg');
};
function syncModeSeg() {
  [...$('#modeSeg').children].forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
}
$('#undoBtn').onclick = () => {
  if (!S.stops.length) { toast('Nothing to undo', 'err'); return; }
  const s = S.stops.pop();
  afterStopsChanged();
  toast('Removed ' + s.name);
};
$('#clearBtn').onclick = () => {
  if (!S.stops.length) return;
  S.stops = []; S.legs = []; S.t = 0; S.total = 0;
  setPlaying(false);
  afterStopsChanged();
  toast('Trip cleared');
};
$('#speedBtn').onclick = () => {
  S.speed = (S.speed + 1) % SPEEDS.length;
  $('#speedLbl').textContent = SPEED_LBL[S.speed];
  toast('Speed ' + SPEED_LBL[S.speed]);
};
$('#autozoomBtn').onclick = () => {
  S.autoZoom = !S.autoZoom;
  $('#autozoomBtn').classList.toggle('on', S.autoZoom);
  toast('Auto-fit ' + (S.autoZoom ? 'on' : 'off'));
  if (S.autoZoom && S.stops.length > 1) fitTrip(true);
};
$('#followBtn').onclick = () => {
  S.follow = !S.follow;
  $('#followBtn').classList.toggle('on', S.follow);
  toast('Cinematic follow ' + (S.follow ? 'on' : 'off'));
};
$('#recBtn').onclick = () => S.recording ? stopRecording() : startRecording();

/* scrubbing */
const track = $('#track');
let scrubbing = false;
function scrubTo(clientX) {
  const r = track.getBoundingClientRect();
  S.t = clamp((clientX - r.left) / r.width, 0, 1) * S.total;
  S.headingLeg = -1;
  syncScrub();
  requestRender();
}
track.addEventListener('pointerdown', e => { scrubbing = true; track.setPointerCapture(e.pointerId); scrubTo(e.clientX); });
track.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e.clientX); });
track.addEventListener('pointerup', () => { scrubbing = false; });

/* theme */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ta.theme', t); } catch (e) {}
  $('#themeIco').innerHTML = t === 'dark'
    ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'
    : '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>';
}
$('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

/* overlays */
const SHORTCUTS = [
  ['Space', 'Play / pause'], ['D', 'Toggle draw-route mode'], ['1 / 2 / 3', 'Plane / car / boat leg'],
  ['U', 'Undo last stop'], ['F', 'Toggle cinematic follow'], ['← / →', 'Seek ∓2%'],
  ['/', 'Focus the search box'], ['R', 'Start / stop recording'], ['Esc', 'Close menus & overlays'],
  ['Right-click', 'Delete a stop'], ['Scroll', 'Zoom around the cursor'], ['Drag', 'Pan the map']
];
(function buildKbd() {
  const g = $('#kbdGrid');
  for (const [k, d] of SHORTCUTS) {
    const kb = document.createElement('kbd'); kb.textContent = k;
    const sp = document.createElement('span'); sp.textContent = d;
    g.append(kb, sp);
  }
})();
$('#helpBtn').onclick = () => { $('#help').hidden = false; };
$('#helpClose').onclick = () => { $('#help').hidden = true; };
$('#help').onclick = e => { if (e.target.id === 'help') $('#help').hidden = true; };
$('#introGo').onclick = () => { $('#intro').hidden = true; $('#drawBtn').click(); };
$('#introDemo').onclick = () => { $('#intro').hidden = true; loadDemo('US Highlights'); };

/* keyboard */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === '/') { e.preventDefault(); searchEl.focus(); return; }
  if (e.key === ' ') { e.preventDefault(); setPlaying(!S.playing); }
  else if (k === 'd') $('#drawBtn').click();
  else if (k === '1' || k === '2' || k === '3') {
    S.mode = ['plane', 'car', 'boat'][+k - 1]; syncModeSeg();
    toast(MODE_NAME[S.mode] + ' selected for the next leg');
  }
  else if (k === 'u') $('#undoBtn').click();
  else if (k === 'f') $('#followBtn').click();
  else if (k === 'r') $('#recBtn').click();
  else if (e.key === 'ArrowRight') { S.t = clamp(S.t + S.total * 0.02, 0, S.total); S.headingLeg = -1; syncScrub(); requestRender(); }
  else if (e.key === 'ArrowLeft') { S.t = clamp(S.t - S.total * 0.02, 0, S.total); S.headingLeg = -1; syncScrub(); requestRender(); }
  else if (e.key === 'Escape') { closeMenus(); $('#help').hidden = true; $('#intro').hidden = true; }
});

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', () => { if (S.stops.length) autosave(); });

/* ═════════════════════════ boot ═════════════════════════ */

(function boot() {
  try { setTheme(localStorage.getItem('ta.theme') || 'dark'); } catch (e) { setTheme('dark'); }
  setStyle('dark', true);
  syncModeSeg();
  resize();
  const fromHash = loadFromHash();
  const restored = fromHash ? true : restoreAutosave();
  let seen = false;
  try { seen = localStorage.getItem('ta.seen') === '1'; } catch (e) {}
  if (!seen && !restored) {
    $('#intro').hidden = false;
    try { localStorage.setItem('ta.seen', '1'); } catch (e) {}
  }
  if (restored) toast('Restored your last trip', 'ok');
  updateHUD();
  requestRender();
  setTimeout(() => {
    if (!S.tilesOK) toast('Map tiles unavailable — using the built-in offline world map', 'err');
  }, 6000);
})();
