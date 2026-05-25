// Runs in mapy.com's main JS world (manifest: world: "MAIN", run_at: "document_start").
// Cannot use chrome.* APIs. Communicates with the isolated content script via
// window.postMessage.
//
// Purpose: capture the route data Mapy.com sends to its internal /api/tplanner
// endpoint so the user can import a planned route into the extension without
// re-clicking every waypoint.

const SOURCE = 'mfc-mainworld';
const TAG = '[Trasy mainworld]';

// Verbose POST logging — off by default to avoid console spam during pans.
// Enable from DevTools: __mfcDebugAllPosts(true)
let VERBOSE_POSTS = false;
if (import.meta.env.DEV) {
  (window as unknown as { __mfcDebugAllPosts?: (v: boolean) => void }).__mfcDebugAllPosts = (v: boolean) => {
    VERBOSE_POSTS = v;
    console.log(TAG, `verbose POST logging ${v ? 'enabled' : 'disabled'}`);
  };
}

interface PointPair {
  lon: number;
  lat: number;
}

interface CapturedRoute {
  points: PointPair[];
  rawBodyLength: number;
  capturedAt: number;
  url: string;       // request URL (e.g. /api/tplanner)
  pageUrl: string;   // location.href at capture time — preserves any ?dim=...
}

let lastCaptured: CapturedRoute | null = null;

function postToContent(type: string, data: unknown): void {
  window.postMessage({ source: SOURCE, type, data }, '*');
}

/**
 * Pull lon,lat pairs out of an arbitrary string. Mapy.com encodes explicit
 * coordinates in tplanner payloads as high-precision decimal pairs.
 * Heuristics:
 *   - both sides must have ≥4 decimal places (rules out random integers)
 *   - lon ∈ [-180, 180], lat ∈ [-90, 90]
 *   - skip pairs near (0, 0)
 */
function extractCoords(text: string): PointPair[] {
  const coords: PointPair[] = [];
  const re = /(-?\d+\.\d{4,})\s*,\s*(-?\d+\.\d{4,})/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(text)) !== null) {
    const lon = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    if (Math.abs(lon) < 0.0001 && Math.abs(lat) < 0.0001) continue;
    const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coords.push({ lon, lat });
  }
  return coords;
}

async function bodyToBytes(body: unknown): Promise<Uint8Array | null> {
  if (!body) return null;
  try {
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) {
      const v = body as ArrayBufferView;
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (typeof body === 'string') return new TextEncoder().encode(body);
  } catch {
    // fall through
  }
  return null;
}

async function tryCapture(source: 'fetch' | 'xhr', url: string, body: unknown): Promise<void> {
  try {
    const bytes = await bodyToBytes(body);
    if (!bytes || bytes.length === 0) {
      console.log(TAG, `${source} ${url}: empty body`);
      return;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const points = extractCoords(text);
    if (points.length >= 2) {
      // Same viewport-distance sanity check as runProbe: a captured polyline
      // whose centroid sits hundreds of km from the user's current map view
      // is almost certainly leftover data from a different route — drop it.
      const vp = urlViewport();
      if (vp) {
        const c = centroidOf(points);
        const d = distanceKm(vp, c);
        if (d > MAX_DISTANCE_FROM_VIEWPORT_KM) {
          console.log(
            TAG,
            `dropping ${source} capture: centroid ${d.toFixed(0)} km from viewport (${points.length} pts)`
          );
          return;
        }
      }
      lastCaptured = {
        points,
        rawBodyLength: bytes.length,
        capturedAt: Date.now(),
        url,
        pageUrl: location.href
      };
      console.log(TAG, `captured ${points.length} coord pair(s) from ${source} ${url}`);
      postToContent('captured', lastCaptured);
    } else {
      console.log(TAG, `${source} ${url}: body ${bytes.length}B, only ${points.length} literal coord(s) — will probe window.Mapy for full route`);
      // The route data lands in JS memory only after the response is processed and
      // the route is rendered. Try at several time offsets.
      setTimeout(runProbe, 1500);
      setTimeout(runProbe, 4000);
      setTimeout(runProbe, 8000);
    }
  } catch (err) {
    console.warn(TAG, `${source} capture failed:`, err);
  }
}

// ---- window.Mapy probe ----
// When mapy.com renders a route, the coordinates are in JS memory under
// window.Mapy somewhere. We walk the object graph looking for arrays of
// {lat, lon} (or {x, y} or [lon, lat]) and pick the longest reasonable one.

interface PointPair2 { lon: number; lat: number }

function asCoord(v: unknown): PointPair2 | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.lat === 'number' && typeof o.lon === 'number') {
    return { lon: o.lon, lat: o.lat };
  }
  if (typeof o.lat === 'number' && typeof o.lng === 'number') {
    return { lon: o.lng, lat: o.lat };
  }
  if (typeof o.y === 'number' && typeof o.x === 'number') {
    const x = o.x, y = o.y;
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return { lon: x, lat: y };
  }
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
    if (Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90) return { lon: v[0], lat: v[1] };
  }
  return null;
}

function sanity(out: PointPair2[]): PointPair2[] | null {
  if (out.length < 2) return null;
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const c of out) {
    if (Math.abs(c.lon) > 180 || Math.abs(c.lat) > 90) return null;
    if (c.lon < lonMin) lonMin = c.lon;
    if (c.lon > lonMax) lonMax = c.lon;
    if (c.lat < latMin) latMin = c.lat;
    if (c.lat > latMax) latMax = c.lat;
  }
  // Reject all-identical (e.g. zero arrays, single-point constants)
  if (lonMax - lonMin < 0.0001 && latMax - latMin < 0.0001) return null;
  return out;
}

function asCoordArray(v: unknown): PointPair2[] | null {
  // Typed arrays: Float64Array/Float32Array of [lon, lat, lon, lat, ...]
  if (v instanceof Float64Array || v instanceof Float32Array) {
    if (v.length < 4 || v.length % 2 !== 0) return null;
    const out: PointPair2[] = [];
    for (let i = 0; i < v.length; i += 2) {
      out.push({ lon: v[i], lat: v[i + 1] });
    }
    return sanity(out);
  }
  if (!Array.isArray(v) || v.length < 2) return null;
  const out: PointPair2[] = [];
  for (const el of v) {
    const c = asCoord(el);
    if (!c) return null;
    out.push(c);
  }
  return sanity(out);
}

interface ProbeHit { path: string; coords: PointPair2[] }

/**
 * Reject coord arrays that can't possibly be a continuous route polyline.
 * A real polyline has small gaps between consecutive points; a list of POIs
 * or search results scattered across a country has huge jumps.
 */
function isPlausiblePolyline(coords: PointPair2[]): boolean {
  if (coords.length < 5) return true; // small arrays may be waypoints, accept
  let maxGapDeg = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i].lon - coords[i - 1].lon;
    const dy = coords[i].lat - coords[i - 1].lat;
    const gap = Math.sqrt(dx * dx + dy * dy);
    if (gap > maxGapDeg) maxGapDeg = gap;
  }
  // 1° ≈ 111 km. Any consecutive jump bigger than this isn't a route.
  return maxGapDeg < 1.0;
}

/**
 * Pull the user's current map viewport from the URL. mapy.com encodes the
 * map centre as `?x=<lon>&y=<lat>&z=<zoom>` in every URL. When the user
 * navigates between saved routes, the URL is rewritten to centre on the new
 * route — so the URL viewport is the most reliable signal for "what route
 * is the user actually looking at right now."
 *
 * Returns null when the URL doesn't carry a viewport, in which case we fall
 * back to accepting any plausible polyline.
 */
function urlViewport(): { lon: number; lat: number; z: number } | null {
  try {
    const p = new URLSearchParams(location.search);
    const lon = Number(p.get('x'));
    const lat = Number(p.get('y'));
    const z = Number(p.get('z'));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return { lon, lat, z: Number.isFinite(z) ? z : 12 };
  } catch {
    return null;
  }
}

/**
 * Return the centroid of a polyline (rough arithmetic mean of lon/lat).
 * Good enough for distance comparisons at hiking-route scale.
 */
function centroidOf(coords: PointPair2[]): { lon: number; lat: number } {
  let lon = 0;
  let lat = 0;
  for (const c of coords) {
    lon += c.lon;
    lat += c.lat;
  }
  return { lon: lon / coords.length, lat: lat / coords.length };
}

/**
 * Cheap great-circle-ish distance in km between two lon/lat points using the
 * equirectangular approximation. Plenty accurate for the "is this route
 * within sight of the user's current map view" check.
 */
function distanceKm(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number }
): number {
  const R = 6371;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const meanLat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const x = dLon * Math.cos(meanLat);
  return Math.hypot(x, dLat) * R;
}

/**
 * Anything farther than this from the URL viewport is treated as a leftover
 * from a previously-viewed route still cached in mapy.com's JS memory and
 * gets rejected. 200 km is loose enough to allow zoomed-out browsing of a
 * regional polyline whose centroid sits outside the current viewport, but
 * tight enough to reject "the user is in Czechia, this polyline is in Italy"
 * — the actual bug we're fighting.
 */
const MAX_DISTANCE_FROM_VIEWPORT_KM = 200;

function probeForRoutes(maxDepth = 9, maxNodes = 20000): ProbeHit[] {
  const results: ProbeHit[] = [];
  const visited = new WeakSet<object>();
  let nodes = 0;

  function walk(obj: unknown, path: string, depth: number): void {
    if (nodes++ > maxNodes) return;
    if (depth > maxDepth) return;
    if (obj === null || obj === undefined) return;

    // Typed arrays are objects but we want to inspect them as coord arrays.
    if (obj instanceof Float64Array || obj instanceof Float32Array) {
      const ca = asCoordArray(obj);
      if (ca) results.push({ path, coords: ca });
      return;
    }

    if (typeof obj !== 'object') return;
    if (visited.has(obj as object)) return;
    visited.add(obj as object);

    // Skip uninteresting types
    if (
      obj instanceof Element ||
      obj instanceof Document ||
      (typeof Window !== 'undefined' && obj instanceof Window) ||
      obj instanceof Promise ||
      obj instanceof Map ||
      obj instanceof Set ||
      obj instanceof RegExp ||
      obj instanceof Date ||
      obj instanceof ArrayBuffer
    ) {
      return;
    }

    const ca = asCoordArray(obj);
    if (ca) {
      results.push({ path, coords: ca });
      return; // don't recurse into coord arrays
    }

    let keys: string[];
    try {
      keys = Object.keys(obj as object);
    } catch {
      return;
    }
    if (keys.length > 500) return; // huge objects = caches, skip

    for (const k of keys) {
      // Skip DOM tree links and a few well-known cycles, but DO follow _underscored
      // keys — Seznam/Mapy code uses them for app state.
      if (k === 'parent' || k === 'parentNode' || k === 'parentElement' || k === 'ownerDocument') continue;
      if (k === 'children' || k === 'childNodes') continue;
      try {
        walk((obj as Record<string, unknown>)[k], `${path}.${k}`, depth + 1);
      } catch {
        // some getters throw; ignore
      }
    }
  }

  const w = window as unknown as Record<string, unknown>;
  if (w.Mapy) walk(w.Mapy, 'window.Mapy', 0);
  if (w.SMap) walk(w.SMap, 'window.SMap', 0);
  if (w.MapyConfig) walk(w.MapyConfig, 'window.MapyConfig', 0);
  // The map DOM element often has the SMap instance attached as a property.
  const mapEl = document.getElementById('map');
  if (mapEl) walk(mapEl as unknown as object, 'document.getElementById("map")', 0);

  // Sort: longest plausible polyline first.
  results.sort((a, b) => b.coords.length - a.coords.length);
  return results;
}

function runDiagnostic(): void {
  const w = window as unknown as Record<string, unknown>;
  console.group(TAG, 'diagnostic');
  console.log('Mapy keys:', w.Mapy ? Object.keys(w.Mapy as object) : '(no Mapy)');
  console.log('SMap keys:', w.SMap ? Object.keys(w.SMap as object).slice(0, 50) : '(no SMap)');
  console.log('MapyConfig.map:', (w.MapyConfig as { map?: unknown } | undefined)?.map);
  const mapEl = document.getElementById('map');
  if (mapEl) {
    const ownProps: string[] = [];
    for (const k in mapEl) {
      try { if (Object.prototype.hasOwnProperty.call(mapEl, k)) ownProps.push(k); } catch { /* ignore */ }
    }
    console.log('#map own properties:', ownProps);
  }
  console.log('Last captured route:', lastCaptured);
  console.groupEnd();
}

if (import.meta.env.DEV) {
  (window as unknown as { __mfcDiag?: () => void }).__mfcDiag = runDiagnostic;
}

/**
 * Walk window.Mapy / SMap for the best route polyline in JS memory.
 *
 * When `force` is true, any plausible candidate overwrites the existing
 * capture — used when the content script is about to import and wants a
 * fresh snapshot regardless of what's buffered. When `force` is false (the
 * default), a longer existing capture is preserved so the multi-stage load
 * — "waypoint summary first, full polyline later" — stabilises on the
 * longer one. We deliberately do NOT keep "longest wins" forever: the
 * onNavigation handler nulls `lastCaptured` whenever the URL changes, so
 * SPA navigation between saved routes starts from a clean slate.
 */
function runProbe(force = false): void {
  const all = probeForRoutes();
  let plausible = all.filter((r) => isPlausiblePolyline(r.coords));

  // Viewport filter: mapy.com keeps multiple routes in JS memory after SPA
  // navigation (the just-viewed one, the one before that, search results,
  // etc.). probeForRoutes finds them all and "longest wins" picks the wrong
  // one when the user-facing route happens to be shorter than a stale one.
  // The URL viewport is the authoritative signal for "what the user is
  // looking at right now" — drop any candidate that's clearly somewhere
  // else on the planet.
  const vp = urlViewport();
  if (vp) {
    const before = plausible.length;
    plausible = plausible.filter((r) => {
      const c = centroidOf(r.coords);
      const d = distanceKm(vp, c);
      if (d > MAX_DISTANCE_FROM_VIEWPORT_KM) {
        console.log(
          TAG,
          `dropping ${r.path}: centroid ${d.toFixed(0)} km from viewport (${r.coords.length} pts)`
        );
        return false;
      }
      return true;
    });
    if (before !== plausible.length) {
      console.log(TAG, `viewport filter kept ${plausible.length}/${before}`);
    }
  }

  console.log(
    TAG,
    `probe (force=${force}): ${all.length} candidate(s), ${plausible.length} plausible after filter`
  );
  plausible.slice(0, 6).forEach((r, i) => {
    const first = r.coords[0];
    const last = r.coords[r.coords.length - 1];
    console.log(
      TAG,
      `  ${i + 1}. ${r.path} — ${r.coords.length} pts (${first.lon.toFixed(3)},${first.lat.toFixed(3)} → ${last.lon.toFixed(3)},${last.lat.toFixed(3)})`
    );
  });
  if (plausible.length === 0) {
    if (force) postToContent('probeDone', { ok: false, reason: 'no_plausible' });
    return;
  }
  const best = plausible[0]; // longest-first

  if (!force && lastCaptured && lastCaptured.points.length >= best.coords.length) {
    console.log(
      TAG,
      `keeping existing capture (${lastCaptured.points.length} pts ≥ candidate ${best.coords.length})`
    );
    return;
  }
  lastCaptured = {
    points: best.coords,
    rawBodyLength: 0,
    capturedAt: Date.now(),
    url: `probe:${best.path}`,
    pageUrl: location.href
  };
  console.log(TAG, `using ${best.path} (${best.coords.length} pts) as captured route`);
  postToContent('captured', lastCaptured);
  if (force) postToContent('probeDone', { ok: true, points: best.coords.length });
}

// Expose for manual debugging from DevTools: __mfcProbe()
if (import.meta.env.DEV) {
  (window as unknown as { __mfcProbe?: () => void }).__mfcProbe = runProbe;
}

// ---- fetch hook ----
const origFetch = window.fetch.bind(window);
window.fetch = async function (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let url = '';
  let method = 'GET';
  let body: BodyInit | null | undefined;
  try {
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
      method = input.method;
    }
    if (init?.method) method = init.method;
    body = init?.body;
  } catch {
    // ignore
  }

  if (method.toUpperCase() === 'POST') {
    if (VERBOSE_POSTS) console.log(TAG, 'fetch POST:', url);
    if (url.includes('tplanner') || url.includes('planner') || url.includes('route')) {
      await tryCapture('fetch', url, body);
    }
  }

  return origFetch(input as RequestInfo | URL, init);
};

// ---- XHR hook ----
// Mapy.com's older Seznam JS library uses XMLHttpRequest, not fetch.
type XHRWithMfc = XMLHttpRequest & { __mfcUrl?: string; __mfcMethod?: string };

const origXHROpen = XMLHttpRequest.prototype.open;
const origXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (
  this: XHRWithMfc,
  method: string,
  url: string | URL,
  ...rest: unknown[]
): void {
  this.__mfcMethod = method;
  this.__mfcUrl = typeof url === 'string' ? url : url.toString();
  // eslint-disable-next-line prefer-spread
  return origXHROpen.apply(this, [method, url, ...rest] as unknown as Parameters<typeof origXHROpen>);
};

XMLHttpRequest.prototype.send = function (
  this: XHRWithMfc,
  body?: Document | XMLHttpRequestBodyInit | null
): void {
  const url = this.__mfcUrl ?? '';
  const method = this.__mfcMethod ?? 'GET';

  if (method.toUpperCase() === 'POST') {
    if (VERBOSE_POSTS) console.log(TAG, 'XHR POST:', url);
    if (url.includes('tplanner') || url.includes('planner') || url.includes('route')) {
      void tryCapture('xhr', url, body);
      // Also try to read the response after it lands.
      this.addEventListener('load', () => {
        try {
          const r: unknown = this.response;
          let bytes: Uint8Array | null = null;
          if (r instanceof ArrayBuffer) {
            bytes = new Uint8Array(r);
          } else if (typeof r === 'string') {
            bytes = new TextEncoder().encode(r);
          } else if (r instanceof Blob) {
            void r.arrayBuffer().then((ab) => {
              processResponseBytes(new Uint8Array(ab), `${url} (response)`);
            });
            return;
          }
          if (bytes) processResponseBytes(bytes, `${url} (response)`);
        } catch (err) {
          console.warn(TAG, 'XHR response read failed:', err);
        }
      });
    }
  }

  return origXHRSend.call(this, body as XMLHttpRequestBodyInit | null);
};

function processResponseBytes(bytes: Uint8Array, label: string): void {
  if (bytes.length === 0) return;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const points = extractCoords(text);
  if (points.length >= 2) {
    lastCaptured = {
      points,
      rawBodyLength: bytes.length,
      capturedAt: Date.now(),
      url: label,
      pageUrl: location.href
    };
    console.log(TAG, `response (${label}): captured ${points.length} literal coord pair(s)`);
    postToContent('captured', lastCaptured);
  } else {
    console.log(TAG, `response (${label}): ${bytes.length}B but no literal coords`);
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data as { source?: string; type?: string } | undefined;
  if (!d || d.source !== 'mfc-isolated') return;
  if (d.type === 'getCaptured') {
    postToContent('captured', lastCaptured);
  }
  if (d.type === 'runProbe') {
    runProbe(false);
  }
  if (d.type === 'forceProbe') {
    // Reset the buffered capture so the "longest wins" guard inside runProbe
    // doesn't keep a stale polyline from before the user navigated.
    lastCaptured = null;
    runProbe(true);
  }
  if (d.type === 'probeDebug') {
    const w = window as unknown as Record<string, unknown>;
    console.log(TAG, 'debug probe — Mapy:', w.Mapy, 'SMap:', w.SMap, 'lastCaptured:', lastCaptured);
  }
});

console.log(TAG, 'loaded; fetch hook active');

// Proactive probes. The fetch hook only fires when the page actually requests
// route data — for a saved-route URL the SPA may resolve it through internal
// state or a request URL that doesn't match our pattern. Walking window.Mapy /
// SMap at several offsets after load catches those cases without forcing the
// user to reload.
setTimeout(runProbe, 2000);
setTimeout(runProbe, 5000);
setTimeout(runProbe, 10000);
setTimeout(runProbe, 20000);

// Same again after every SPA route change. mapy.com pushes URL state without
// reloading, so a fresh probe per navigation catches routes opened by clicking
// a different saved item in the side panel. We hook history.pushState /
// replaceState rather than polling so we don't burn cycles on every DOM mutation.
function onNavigation(): void {
  // Reset the "longest wins" guard so a new route can replace the old one.
  lastCaptured = null;
  setTimeout(runProbe, 800);
  setTimeout(runProbe, 2500);
  setTimeout(runProbe, 6000);
}
const origPush = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);
history.pushState = function (...args: Parameters<History['pushState']>) {
  const r = origPush(...args);
  onNavigation();
  return r;
};
history.replaceState = function (...args: Parameters<History['replaceState']>) {
  const r = origReplace(...args);
  onNavigation();
  return r;
};
window.addEventListener('popstate', onNavigation);
