#!/usr/bin/env node
/*
 * tools/build-geo.js — regenerates js/countries.js, js/states-us.js and js/land.js
 * Zero dependencies: downloads public-domain / CORS-open sources over https and
 * decodes TopoJSON by hand (no npm, no build step anywhere in this project).
 *
 *   node tools/build-geo.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'js');
const SRC_COUNTRIES = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
const SRC_STATES = 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'travel-animator-build/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(url + ' -> HTTP ' + res.statusCode)); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => buf += d);
      res.on('end', () => resolve(buf));
    }).on('error', reject);
  });
}

/* ---------- minimal TopoJSON decoder (quantized arcs -> lon/lat rings) ---------- */
function transformPoint(topo, p) {
  const t = topo.transform;
  if (!t) return [p[0], p[1]];
  return [p[0] * t.scale[0] + t.translate[0], p[1] * t.scale[1] + t.translate[1]];
}
function decodeArc(topo, i) {
  const arc = topo.arcs[i];
  const out = [];
  let x = 0, y = 0;
  for (const d of arc) {
    if (topo.transform) { x += d[0]; y += d[1]; out.push(transformPoint(topo, [x, y])); }
    else out.push([d[0], d[1]]);
  }
  return out;
}
function arcsToRing(topo, arcIdx, cache) {
  const ring = [];
  for (const ai of arcIdx) {
    const rev = ai < 0;
    const idx = rev ? ~ai : ai;
    if (!cache[idx]) cache[idx] = decodeArc(topo, idx);
    let pts = cache[idx];
    if (rev) pts = pts.slice().reverse();
    if (ring.length) ring.pop();
    for (const p of pts) ring.push(p);
  }
  return ring;
}
function geometryRings(topo, geom, cache) {
  const rings = [];
  if (geom.type === 'Polygon') for (const r of geom.arcs) rings.push(arcsToRing(topo, r, cache));
  else if (geom.type === 'MultiPolygon') for (const poly of geom.arcs) for (const r of poly) rings.push(arcsToRing(topo, r, cache));
  return rings;
}
function geojsonRings(geom) {
  const rings = [];
  if (!geom) return rings;
  if (geom.type === 'Polygon') for (const r of geom.coordinates) rings.push(r.map(p => [p[0], p[1]]));
  else if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) for (const r of poly) rings.push(r.map(p => [p[0], p[1]]));
  return rings;
}

/* ---------- geometry helpers ---------- */
const r5 = n => Math.round(n * 1e4) / 1e4;

function simplify(ring, tol) {           // Douglas–Peucker, keeps ring closed
  if (ring.length < 40) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out;
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]);
  return Math.abs(a / 2);
}
function bboxOf(rings) {
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  for (const r of rings) for (const [x, y] of r) {
    if (x < minLon) minLon = x; if (x > maxLon) maxLon = x;
    if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
  }
  return [r5(minLon), r5(minLat), r5(maxLon), r5(maxLat)];
}
/* pole of inaccessibility-ish: centroid of the largest ring, nudged inside via grid scan */
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function labelPoint(rings) {
  let best = rings[0], bestA = -1;
  for (const r of rings) { const a = ringArea(r); if (a > bestA) { bestA = a; best = r; } }
  const bb = bboxOf([best]);
  let cx = 0, cy = 0;
  for (const p of best) { cx += p[0]; cy += p[1]; }
  cx /= best.length; cy /= best.length;
  if (pointInRing([cx, cy], best)) return [r5(cx), r5(cy)];
  let found = null, bestScore = -1;
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
    const x = bb[0] + (bb[2] - bb[0]) * i / 12, y = bb[1] + (bb[3] - bb[1]) * j / 12;
    if (pointInRing([x, y], best)) {
      const score = -((x - cx) ** 2 + (y - cy) ** 2);
      if (score > bestScore) { bestScore = score; found = [x, y]; }
    }
  }
  return found ? [r5(found[0]), r5(found[1])] : [r5(cx), r5(cy)];
}
function prepare(rings, tol, minArea) {
  return rings
    .map(r => simplify(r.map(p => [r5(p[0]), r5(p[1])]), tol))
    .filter(r => r.length >= 4 && ringArea(r) >= minArea);
}
function emit(file, varName, feats, banner) {
  const body = feats.map(f =>
    '{n:' + JSON.stringify(f.name) +
    ',b:[' + f.bbox.join(',') + ']' +
    ',l:[' + f.label.join(',') + ']' +
    ',r:[' + f.rings.map(r => '[' + r.map(p => p[0] + ',' + p[1]).join(',') + ']').join(',') + ']}'
  ).join(',\n');
  const js =
`/* ${banner}
 * GENERATED by tools/build-geo.js — do not edit by hand. Re-run: node tools/build-geo.js
 * Rings are stored flat ([lon,lat,lon,lat,...]) to keep the file small; they are
 * expanded into [[lon,lat],...] at load time.
 */
(function () {
  var RAW = [
${body}
  ];
  window.${varName} = RAW.map(function (f) {
    return {
      name: f.n, bbox: f.b, label: f.l,
      rings: f.r.map(function (flat) {
        var ring = [];
        for (var i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
        return ring;
      })
    };
  });
})();
`;
  fs.writeFileSync(path.join(OUT, file), js);
  console.log('  wrote js/' + file, '(' + feats.length + ' features, ' + (js.length / 1024).toFixed(0) + ' KB)');
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log('· downloading world-atlas countries-110m.json …');
  const topo = JSON.parse(await get(SRC_COUNTRIES));
  const cache = {};
  const countries = [];
  for (const geom of topo.objects.countries.geometries) {
    const name = (geom.properties && geom.properties.name) || geom.id;
    if (!name) continue;
    const rings = prepare(geometryRings(topo, geom, cache), 0.05, 0.02);
    if (!rings.length) continue;
    countries.push({ name, bbox: bboxOf(rings), label: labelPoint(rings), rings });
  }
  countries.sort((a, b) => a.name.localeCompare(b.name));
  emit('countries.js', 'COUNTRY_FEATS', countries, 'World countries (Natural Earth 110m via world-atlas, public domain).');

  console.log('· downloading US states GeoJSON …');
  const gj = JSON.parse(await get(SRC_STATES));
  const states = [];
  for (const f of gj.features) {
    const name = f.properties && f.properties.name;
    if (!name) continue;
    const rings = prepare(geojsonRings(f.geometry), 0.02, 0.001);
    if (!rings.length) continue;
    states.push({ name, bbox: bboxOf(rings), label: labelPoint(rings), rings });
  }
  states.sort((a, b) => a.name.localeCompare(b.name));
  emit('states-us.js', 'US_STATE_FEATS', states, 'US states + DC (US Census cartographic boundaries, public domain).');

  console.log('· deriving offline landmass fallback …');
  const land = [];
  for (const geom of topo.objects.countries.geometries) {
    const name = (geom.properties && geom.properties.name) || '';
    const rings = prepare(geometryRings(topo, geom, {}), 0.28, 0.6);
    if (rings.length) land.push({ name, bbox: bboxOf(rings), label: labelPoint(rings), rings });
  }
  emit('land.js', 'LAND_FEATS', land, 'Coarse world landmass polygons — offline fallback basemap when tiles fail.');

  console.log('done.');
})().catch(e => { console.error('build-geo failed:', e.message); process.exit(1); });
