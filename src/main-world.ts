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

function runProbe(): void {
  const all = probeForRoutes();
  const plausible = all.filter((r) => isPlausiblePolyline(r.coords));
  console.log(
    TAG,
    `probe: ${all.length} candidate(s), ${plausible.length} pass plausibility check`
  );
  plausible.slice(0, 6).forEach((r, i) => {
    const first = r.coords[0];
    const last = r.coords[r.coords.length - 1];
    console.log(
      TAG,
      `  ${i + 1}. ${r.path} — ${r.coords.length} pts (${first.lon.toFixed(3)},${first.lat.toFixed(3)} → ${last.lon.toFixed(3)},${last.lat.toFixed(3)})`
    );
  });
  if (plausible.length === 0) return;
  const best = plausible[0]; // longest-first (probeForRoutes sorts by length desc)

  // Lifetime "longest wins": never downgrade a capture. The full polyline often
  // lands in JS memory later than the waypoint summary, and we don't want to
  // overwrite a 500-pt polyline with a 12-pt waypoint list.
  if (lastCaptured && lastCaptured.points.length >= best.coords.length) {
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
    runProbe();
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
