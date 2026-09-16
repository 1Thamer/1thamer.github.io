# Travel Animator — Thamer Dev

A single-page, dependency-free clone of travelanimator.com. Draw a multi-stop trip on a real
interactive world map, animate it with plane / car / boat models, and export the result as a
**WebM video** — entirely in the browser. No API keys, no accounts, no build step, no watermarks.

```
index.html          the whole UI
css/style.css       glassmorphic theme (dark + light)
js/app.js           map engine, routing, playback, recorder  (~1.8k lines)
js/land.js          coarse world landmass — offline fallback basemap
js/countries.js     window.COUNTRY_FEATS  — 177 countries
js/states-us.js     window.US_STATE_FEATS — 50 states + DC
tools/build-geo.js  regenerates the three geo files from public-domain sources
serve.js            optional 40-line static server
```

## Run it

Double-click `index.html`. That's it.

For a proper `http://` origin (needed for clipboard share links and service-worker experiments):

```bash
node serve.js      # → http://localhost:8080
```

## Why the map is painted on a `<canvas>` instead of Leaflet

`canvas.captureStream()` records **canvas pixels only**. A Leaflet/DOM tile layer lives in
`<img>` elements stacked over the page, so a recorder would capture an empty canvas with a
route floating on nothing. Since video export is a core feature, the map itself had to become
canvas pixels.

So `js/app.js` implements its own slippy map:

- **Web Mercator** with fractional zoom — `worldPx(z) = 256 · 2^z`, `lonToWorldX` / `latToWorldY`
  and their inverses.
- **Raster tile compositing** with an LRU cache (620 tiles, evicted oldest-first, `img.src=''`
  on eviction). Missing tiles fall back to a scaled-up cached ancestor up to 4 zoom levels
  higher, so panning never flashes empty.
- **Drag-to-pan**, **scroll-to-zoom anchored at the cursor** (unproject → zoom → unproject →
  correct), pinch-zoom, horizontal world wrap.
- Every tile is requested with `crossOrigin="anonymous"`. **One tainted image permanently
  breaks video export**, which is why every endpoint below was CORS-verified.

## Keyless, CORS-open providers

| Purpose | Endpoint | `Access-Control-Allow-Origin` |
|---|---|---|
| Dark basemap | `server.arcgisonline.com/.../Canvas/World_Dark_Gray_Base/...` + `..._Reference` labels | `*` |
| Streets | `tile.openstreetmap.org/{z}/{x}/{y}.png` | `*` |
| Satellite | `server.arcgisonline.com/.../World_Imagery/...` + `Reference/World_Boundaries_and_Places` labels | `*` |
| Terrain | `{a,b,c}.tile.opentopomap.org/{z}/{x}/{y}.png` (maxZoom 16) | `*` |
| Geocoding | `photon.komoot.io/api?q=…&limit=8` | `*` |
| Geocoding fallback | `nominatim.openstreetmap.org/search?format=jsonv2` | `*` |
| Car routing | `router.project-osrm.org/route/v1/driving/…` | `*` |

**CARTO tiles are deliberately not used** — anonymous requests come back stamped with an
"API key required" watermark, which would be burned straight into every exported video.
Per-style attribution is shown bottom-right, as those licences require.

If tiles fail (offline, blocked, provider down), the app detects a >70% failure rate and swaps
in the built-in vector world map from `js/land.js`, so drawing, animating and recording keep
working with zero network.

## Features

**Map & drawing**
- 4 basemaps in a dropdown, live-switchable, each with its own attribution and max zoom.
- *Draw route* mode: click to add stops. Each new stop takes the currently selected transport
  mode for the leg **arriving** at it, so a single trip freely mixes flights, drives and sails.
- Right-click a stop to delete it, `U` to undo, Clear to wipe. Live stop count and distance.
- Stops dropped on the map are auto-named by point-in-polygon lookup (US state name inside the
  USA, otherwise the country name, otherwise coordinates).

**Visited regions**
- Ray-casting point-in-polygon over `COUNTRY_FEATS` with a bbox pre-check per feature.
- Visited countries get a subtle amber tint; visited **US states** get a stronger fill, a bright
  border stroke, a soft outer glow and their NAME drawn at the feature's label point.
- The HUD lists them: `Visited: Alaska, Nevada, Florida`.
- Country labels render at zoom ≤ 5.6 with collision-avoidance and a halo.

**Search**
- Photon type-ahead, 320 ms debounce, minimum 2 characters, Nominatim fallback.
- ↑/↓/Enter/Escape keyboard nav, `/` focuses the box, box expands 170px → 330px on focus.
- Choosing a result flies the camera with an eased multi-second animation that dips the zoom
  out mid-flight for long hops; a bounding box is fitted (zoom clamped 3–14), otherwise ~12.5.
  A pulsing pin lives ~6 s. Any manual pan or zoom cancels the fly instantly.

**Routing**
- Car legs pull real road geometry from the public OSRM demo server, then get: antimeridian
  unwrap → decimation to ≤2600 points → one Chaikin corner-rounding pass. The smoothed path
  feeds **both** the drawn line and the animation, so vehicles glide through bends.
- Plane legs are true great-circle arcs (spherical interpolation, antimeridian-safe);
  boat legs are straight lines. Routes are cached in a `Map`, including negative results, and
  a route that resolves mid-recording is deferred until the take finishes.
- Distance uses OSRM's own figure for car legs, haversine elsewhere. Any failure degrades to a
  straight line rather than breaking.

**Playback**
- `computeTimeline()`: total travel budget = `clamp(totalKm/1000, 12, 60)` seconds, split by
  each leg's share of the distance, floor 0.5 s per leg, `DWELL` 0.6 s at every stop, 0.9 s tail.
- Quintic ease-in-out per leg; heading low-pass filtered (`heading += angleDiff·0.16` per frame,
  reset on leg change) so the vehicle never twitches.
- Car / plane / boat glyphs drawn in canvas, rotated to heading, with an arrival pulse and the
  route line revealed progressively behind the vehicle.
- **Cinematic camera**: eases toward a frame of the active leg (18% / 22% padding) with per-frame
  lerp factors of `dt·1.7` (position), `dt·1.5` (framing) and `dt·1.0` (zoom) — tight on short
  hops, wide on ocean crossings. Manual pan/zoom suspends automation for 2.5 s, then it resumes.
- Speeds 1×, 2×, 4×, ½×, ¼×, 0.1×. Seekable timeline with per-stop tick marks.
- **Auto-fit** toggle refits the whole route whenever the stops change.

**WebM export**
- Seeks to 0, `captureStream(60)` + `MediaRecorder` with a `vp9 → vp8 → video/webm` mimeType
  fallback chain at 8 Mbps.
- Place-name captions, elapsed time, distance travelled, a photo card during dwells and a slim
  progress bar are **burned into the canvas**, so they exist inside the video file.
- Downloads as `travel-animation.webm` when the animation ends.

**Extras**
- **Shareable trips**: `#trip=<base64>` in the URL hash, copied to the clipboard in one click.
- **Save / load** a trip as `.ta.trip` JSON, plus `localStorage` autosave — a refresh never
  loses a drawn route.
- **Photo waypoints**: attach a local image to a stop (`FileReader`, never uploaded); it appears
  as a caption card during that stop's dwell, inside the recording.
- **GPX / KML import**: drops a real GPS track onto the map, decimated to 24 waypoints, reusing
  the whole routing and rendering pipeline.
- 5 demo trips, light/dark themes, toasts, first-run intro, help modal, full keyboard control,
  responsive down to phone width.

## Keyboard

`Space` play/pause · `D` draw · `1`/`2`/`3` plane/car/boat · `U` undo · `F` follow ·
`R` record · `←`/`→` seek ±2% · `/` search · `Esc` close · right-click a stop to delete.

## Regenerating the geo data

```bash
node tools/build-geo.js
```

Zero dependencies. It downloads `world-atlas@2/countries-110m.json` (Natural Earth 110m, public
domain) and a US-states GeoJSON, decodes the quantized TopoJSON arcs by hand, runs
Douglas–Peucker simplification, drops slivers, computes a bbox and an inside-the-polygon label
point per feature, and writes `js/countries.js`, `js/states-us.js` and the coarser
`js/land.js`. Rings are stored flat (`[lon,lat,lon,lat,…]`) and re-inflated at load time to keep
the files small.

## Known limits

- OSRM's demo server is rate-limited and best-effort; heavy use degrades to straight lines.
- WebM export needs `MediaRecorder` + `captureStream` (Chrome, Edge, Firefox — Safari lags).
- Clipboard share links need an `http(s)` origin; over `file://` the link lands in the address bar.
- Terrain tiles are clamped to zoom 16 per OpenTopoMap's tile policy.
