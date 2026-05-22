import './content.css';
import type {
  Difficulty,
  LonLat,
  RouteFolder,
  RouteShape,
  RouteType,
  RouteVote,
  SavedRoute,
  SharedRoute,
  User
} from './lib/types';
import {
  DIFFICULTY_COLORS,
  DIFFICULTY_LABELS,
  ROUTE_SHAPE_LABELS,
  routeDisplayColor
} from './lib/types';
import { buildPublicMapyUrl } from './lib/backend';
import { lonLatToScreen, screenToLonLat, type Viewport } from './lib/projection';
import { getRouteCoordinates } from './lib/route-geometry';

const ROOT_ID = 'mapy-for-chrome-root';
const OVERLAY_ID = 'mapy-for-chrome-overlay';
const MAP_SELECTOR = '#map.smap, #map';
const SVG_NS = 'http://www.w3.org/2000/svg';

const ROUTE_TYPES: { value: RouteType; label: string }[] = [
  { value: 'car_fast', label: 'Car — fast' },
  { value: 'car_fast_traffic', label: 'Car — fast + traffic' },
  { value: 'car_short', label: 'Car — short' },
  { value: 'foot_fast', label: 'Foot — fast' },
  { value: 'foot_hiking', label: 'Foot — hiking' },
  { value: 'bike_road', label: 'Bike — road' },
  { value: 'bike_mountain', label: 'Bike — mountain' }
];

interface BuildState {
  points: LonLat[];
  name: string;
  difficulty: Difficulty;
  routeType: RouteType;
  description: string;
  photos: string[]; // base64 data URLs
  hasParkingAtStart: boolean;
  folderId: string; // '' = no folder
  imported: boolean;
  importedPageUrl?: string;
}

interface ImportableRoute {
  points: LonLat[];
  capturedAt: number;
  pageUrl?: string;
}

interface EditState {
  routeId: string;
  name: string;
  difficulty: Difficulty;
  routeType: RouteType;
  description: string;
  photos: string[];
  hasParkingAtStart: boolean;
  folderId: string; // '' = no folder
  shared: boolean;
}

interface PopupState {
  routeId: string;
}

interface State {
  user: User | null;
  routes: SavedRoute[];
  folders: RouteFolder[];
  communityRoutes: SharedRoute[];
  showOnMap: boolean;
  building: BuildState | null;
  importable: ImportableRoute | null;
  editing: EditState | null;
  popup: PopupState | null;
}

const state: State = {
  user: null,
  routes: [],
  folders: [],
  communityRoutes: [],
  showOnMap: true,
  building: null,
  importable: null,
  editing: null,
  popup: null
};

// In-memory UI state for which folders are currently collapsed in the side
// panel. Resets on page reload — we deliberately don't persist this.
const collapsedFolderIds = new Set<string>();

// Per-route expansion state — collapsed (circle only) by default, click a circle
// to expand to the full polyline. Lives in memory; resets on page reload.
const expandedRouteIds = new Set<string>();

// ----- Per-route caching to avoid re-parsing geometry every animation frame -----

interface BBox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

interface RouteCacheEntry {
  coords: LonLat[];
  centroid: LonLat;
  bbox: BBox;
  fingerprint: string;
}

const routeCache = new Map<string, RouteCacheEntry>();

function routeFingerprint(r: SavedRoute): string {
  // Cheap stable identifier — re-parse only when geometry/updatedAt changes.
  return `${r.id}|${r.updatedAt ?? r.createdAt}|${r.geometry?.length ?? 0}`;
}

function computeBbox(coords: LonLat[]): BBox {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of coords) {
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(
    a.maxLon < b.minLon ||
    a.minLon > b.maxLon ||
    a.maxLat < b.minLat ||
    a.minLat > b.maxLat
  );
}

function viewportBbox(vp: Viewport): BBox {
  const tl = screenToLonLat(0, 0, vp);
  const br = screenToLonLat(vp.width, vp.height, vp);
  return {
    minLon: Math.min(tl.lon, br.lon),
    maxLon: Math.max(tl.lon, br.lon),
    minLat: Math.min(tl.lat, br.lat),
    maxLat: Math.max(tl.lat, br.lat)
  };
}

function getCachedRouteData(r: SavedRoute): RouteCacheEntry {
  const fp = routeFingerprint(r);
  const cached = routeCache.get(r.id);
  if (cached && cached.fingerprint === fp) return cached;
  const coords = getRouteCoordinates(r);
  const centroid = routeCentroid(coords);
  const bbox = computeBbox(coords);
  const entry: RouteCacheEntry = { coords, centroid, bbox, fingerprint: fp };
  routeCache.set(r.id, entry);
  return entry;
}

/**
 * Convert a community SharedRoute into the SavedRoute shape used by the
 * rendering pipeline. The result is read-only and only used for projection,
 * marker drawing, and popup display — it's never written to storage.
 */
function sharedToRouteView(s: SharedRoute): SavedRoute {
  return {
    id: s.id,
    name: s.name,
    color: s.difficulty ? DIFFICULTY_COLORS[s.difficulty] : '#888',
    difficulty: s.difficulty ?? undefined,
    shareUrl: s.shareUrl ?? '',
    start: s.start,
    end: s.end,
    waypoints: [],
    routeType: s.routeType,
    startLabel: s.startLabel ?? undefined,
    endLabel: s.endLabel ?? undefined,
    distanceM: s.distanceM ?? undefined,
    durationS: s.durationS ?? undefined,
    durationEstimated: s.durationEstimated,
    geometry: s.geometry ?? undefined,
    description: s.description ?? undefined,
    elevationGainM: s.elevationGainM ?? undefined,
    elevationLossM: s.elevationLossM ?? undefined,
    elevationProfile: s.elevationProfile ?? undefined,
    shape: s.shape ?? undefined,
    hasParkingAtStart: s.hasParkingAtStart,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  };
}

/**
 * Return all routes that should be rendered on the map (own + community).
 * Cached per render to avoid converting SharedRoutes repeatedly.
 */
function allMapRoutes(): SavedRoute[] {
  const arr: SavedRoute[] = [...state.routes];
  for (const c of state.communityRoutes) arr.push(sharedToRouteView(c));
  return arr;
}

/**
 * Sparse-sample at most `max` middle points from a GeoJSON LineString string,
 * skipping the first and last (which are start/end). Used to reconstruct a
 * public `mapy.com/fnc/v1/route` URL from a community route's stored geometry.
 */
function deriveWaypointsFromGeometry(
  geometry: string | null | undefined,
  max = 13
): LonLat[] {
  if (!geometry) return [];
  try {
    const g = JSON.parse(geometry) as { type?: string; coordinates?: unknown };
    let coords: unknown[] = [];
    if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
      coords = g.coordinates;
    } else if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
      coords = (g.coordinates as unknown[]).flat();
    }
    if (coords.length <= 2) return [];
    const middle = coords.slice(1, -1);
    const n = Math.min(max, middle.length);
    if (n === 0) return [];
    const out: LonLat[] = [];
    for (let i = 0; i < n; i++) {
      const idx =
        n === 1
          ? Math.floor(middle.length / 2)
          : Math.round((i / (n - 1)) * (middle.length - 1));
      const c = middle[idx];
      if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
        out.push({ lon: c[0], lat: c[1] });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Return a public, stateless mapy.com URL for a community route — even if the
 * stored `shareUrl` is a private `mapy.com/s/<code>` link from before the
 * upload-side fix.
 */
function publicMapyUrlForCommunity(s: SharedRoute): string {
  const waypoints = deriveWaypointsFromGeometry(s.geometry);
  return buildPublicMapyUrl(
    s.start,
    waypoints,
    s.end,
    s.routeType ?? 'foot_hiking'
  );
}

function getCommunityRoute(id: string): SharedRoute | undefined {
  return state.communityRoutes.find((c) => c.id === id);
}

function pruneRouteCache(): void {
  const liveIds = new Set(state.routes.map((r) => r.id));
  for (const id of routeCache.keys()) {
    if (!liveIds.has(id)) routeCache.delete(id);
  }
}

/**
 * Build an SVG path "d" string for a polyline, projecting through the viewport
 * and skipping consecutive points that map to the same screen pixel. For
 * dense polylines at low zoom this can cut the point count by 5–10×.
 */
function buildPathD(coords: LonLat[], vp: Viewport): string {
  if (coords.length < 2) return '';
  let d = '';
  let lastIX = Number.NaN;
  let lastIY = Number.NaN;
  let first = true;
  for (const c of coords) {
    const p = lonLatToScreen(c.lon, c.lat, vp);
    const ix = Math.round(p.x);
    const iy = Math.round(p.y);
    if (!first && ix === lastIX && iy === lastIY) continue;
    d += (first ? 'M' : 'L') + ix + ',' + iy;
    lastIX = ix;
    lastIY = iy;
    first = false;
  }
  return d;
}

/**
 * Click a route's circle on the map. Opens the detail popup for that route
 * and expands its polyline. Clicking the same circle again deselects (closes
 * popup + collapses). Clicking a different route while one is selected
 * switches the popup but keeps prior polylines visible (multi-expansion).
 */
function clickRouteCircle(routeId: string): void {
  const isFullyOn = state.popup?.routeId === routeId && expandedRouteIds.has(routeId);
  if (isFullyOn) {
    state.popup = null;
    expandedRouteIds.delete(routeId);
  } else {
    state.popup = { routeId };
    expandedRouteIds.add(routeId);
    // Trigger backfill of any missing stats so the popup shows complete data.
    const route = state.routes.find((r) => r.id === routeId);
    if (route) maybeBackfillStats(route);
  }
  lastKey = '';
  renderOverlay();
  renderPopup();
}

// Routes we've already asked the background to recompute (per session).
const backfillRequested = new Set<string>();

function maybeBackfillStats(route: SavedRoute): void {
  // Always trigger backfill once per route per session — the background
  // handler is idempotent (only writes when something actually changes) and
  // covers: missing distance/duration/elevation, shape (re)classification,
  // and re-geocoding generic place labels.
  if (backfillRequested.has(route.id)) return;
  backfillRequested.add(route.id);
  void send({ type: 'backfillRoute', routeId: route.id }).catch(() => {
    backfillRequested.delete(route.id); // allow retry on failure
  });
}

function closePopup(): void {
  if (state.popup) {
    expandedRouteIds.delete(state.popup.routeId);
    state.popup = null;
  }
  lastKey = '';
  renderOverlay();
  renderPopup();
}

function routeCentroid(coords: LonLat[]): LonLat {
  let sumLon = 0;
  let sumLat = 0;
  for (const c of coords) {
    sumLon += c.lon;
    sumLat += c.lat;
  }
  return { lon: sumLon / coords.length, lat: sumLat / coords.length };
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]!);
}

// ---- Inline line icons (Lucide-style) used throughout the UI ----
const ICON = {
  distance:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18M5 9v6M19 9v6M9 10v4M13 10v4M17 10v4"/></svg>',
  duration:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  ascent:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19L19 5M11 5h8v8"/></svg>',
  descent:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 11v8h-8"/></svg>',
  edit:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  trash:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  close:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  external:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
  plus:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  download:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  drag:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="9" cy="19" r="1.2"/><circle cx="15" cy="5" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="15" cy="19" r="1.2"/></svg>',
  image:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  routeBadge:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7C6 13 18 11 18 17"/></svg>',
  pin:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  flag:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  loop:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 4 21 9 16 9"/><polyline points="3 20 3 15 8 15"/><path d="M5 9a8 8 0 0 1 13.5-3l2.5 3M3 15l2.5 3A8 8 0 0 0 19 15"/></svg>',
  outAndBack:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 7 22 11 18 15"/><polyline points="6 17 2 13 6 9"/><line x1="3" y1="13" x2="21" y2="11"/></svg>',
  oneWay:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="20" y2="12"/><polyline points="13 5 20 12 13 19"/></svg>',
  parking:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/></svg>',
  folder:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  folderPlus:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/></svg>',
  chevronRight:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  compass:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  thumbsUp:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>',
  thumbsDown:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>'
};

function shapeIcon(shape: RouteShape): string {
  if (shape === 'loop') return ICON.loop;
  if (shape === 'out-and-back') return ICON.outAndBack;
  return ICON.oneWay;
}

function formatDistance(m?: number): string {
  if (!m || m <= 0) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function formatDuration(s?: number): string {
  if (!s || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function formatElevation(m?: number): string {
  if (m === undefined || m === null || m < 0) return '';
  return `${Math.round(m)} m`;
}

/** Resize an uploaded image to a max dimension and return as JPEG data URL. */
async function resizeImageFile(file: File, maxDim = 1200, quality = 0.82): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Image load failed'));
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2d context');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface DifficultyTarget {
  difficulty: Difficulty;
}

function renderDifficultyPicker(target: DifficultyTarget): string {
  const opts: Difficulty[] = ['green', 'red', 'black'];
  return `
    <div class="mfc-difficulty-picker">
      ${opts
        .map(
          (d) =>
            `<button type="button" class="mfc-diff-btn mfc-diff-${d} ${target.difficulty === d ? 'selected' : ''}" data-diff="${d}" title="${DIFFICULTY_LABELS[d]}" aria-label="${DIFFICULTY_LABELS[d]}"></button>`
        )
        .join('')}
    </div>
  `;
}

function wireDifficultyPicker(
  scope: HTMLElement,
  target: DifficultyTarget,
  onChange?: () => void
): void {
  scope.querySelectorAll<HTMLButtonElement>('.mfc-diff-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.diff as Difficulty | undefined;
      if (!d) return;
      target.difficulty = d;
      scope.querySelectorAll('.mfc-diff-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      if (onChange) onChange();
    });
  });
}

interface PhotoTarget {
  photos: string[];
}

function renderPhotoEditor(target: PhotoTarget): string {
  return `
    <div class="mfc-photos-editor">
      <input type="file" class="mfc-photos-input" accept="image/*" multiple hidden>
      <button type="button" class="mfc-photos-add">+ Přidat fotky</button>
      <div class="mfc-photos-thumbs">
        ${target.photos
          .map(
            (p, i) =>
              `<div class="mfc-photo-thumb"><img src="${escape(p)}"><button type="button" class="mfc-photo-remove" data-photo-idx="${i}" title="Odebrat fotku">×</button></div>`
          )
          .join('')}
      </div>
    </div>
  `;
}

function wirePhotoEditor(
  scope: HTMLElement,
  target: PhotoTarget,
  rerender: () => void
): void {
  const input = scope.querySelector<HTMLInputElement>('.mfc-photos-input');
  const addBtn = scope.querySelector<HTMLButtonElement>('.mfc-photos-add');
  if (!input || !addBtn) return;
  addBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    addBtn.disabled = true;
    addBtn.textContent = 'Načítám…';
    try {
      for (const f of files) {
        try {
          const dataUrl = await resizeImageFile(f);
          target.photos.push(dataUrl);
        } catch (err) {
          console.warn('[Trasy] photo resize failed', err);
        }
      }
    } finally {
      input.value = '';
      addBtn.disabled = false;
      addBtn.textContent = '+ Přidat fotky';
      rerender();
    }
  });
  scope.querySelectorAll<HTMLButtonElement>('.mfc-photo-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.photoIdx);
      if (!Number.isInteger(idx)) return;
      target.photos.splice(idx, 1);
      rerender();
    });
  });
}

/** SVG elevation profile chart (area under line) mirroring mapy.com's look. */
function renderElevationChart(
  profile: { distanceM: number; elevationM: number }[],
  color: string
): string {
  if (!profile || profile.length < 2) return '';
  const W = 320;
  const H = 90;
  const PAD_L = 4;
  const PAD_R = 4;
  const PAD_T = 4;
  const PAD_B = 16;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const totalDist = profile[profile.length - 1].distanceM;
  const minDist = profile[0].distanceM;
  const distSpan = Math.max(1, totalDist - minDist);

  let minE = Infinity;
  let maxE = -Infinity;
  for (const p of profile) {
    if (p.elevationM < minE) minE = p.elevationM;
    if (p.elevationM > maxE) maxE = p.elevationM;
  }
  const eRange = Math.max(1, maxE - minE);

  const pts: string[] = [];
  for (const p of profile) {
    const x = PAD_L + ((p.distanceM - minDist) / distSpan) * innerW;
    const y = PAD_T + (1 - (p.elevationM - minE) / eRange) * innerH;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const linePath = `M${pts.join(' L')}`;
  const baselineY = PAD_T + innerH;
  const lastX = PAD_L + innerW;
  const areaPath = `${linePath} L${lastX.toFixed(1)},${baselineY} L${PAD_L},${baselineY} Z`;

  function fmtDist(m: number): string {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  }

  // Distance ticks (start, 1/3, 2/3, end)
  const ticks: string[] = [];
  for (let i = 0; i <= 3; i++) {
    const d = minDist + (distSpan * i) / 3;
    const x = PAD_L + ((d - minDist) / distSpan) * innerW;
    ticks.push(
      `<text x="${x.toFixed(1)}" y="${H - 3}" font-size="9" fill="#888" text-anchor="${
        i === 0 ? 'start' : i === 3 ? 'end' : 'middle'
      }">${fmtDist(d)}</text>`
    );
  }

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="mfc-elev-chart" aria-label="Výškový profil">
      <path d="${areaPath}" fill="${color}" fill-opacity="0.20"></path>
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"></path>
      ${ticks.join('')}
      <text x="${PAD_L + 2}" y="${PAD_T + 9}" font-size="9" fill="#555" text-anchor="start">${Math.round(maxE)} m</text>
      <text x="${PAD_L + 2}" y="${PAD_T + innerH - 2}" font-size="9" fill="#888" text-anchor="start">${Math.round(minE)} m</text>
    </svg>
  `;
}

function renderStatsLine(route: SavedRoute): string {
  const parts: string[] = [];
  const dist = formatDistance(route.distanceM);
  if (dist) {
    parts.push(`<span class="mfc-stat">${ICON.distance}<span>${escape(dist)}</span></span>`);
  }
  const dur = formatDuration(route.durationS);
  if (dur) {
    parts.push(
      `<span class="mfc-stat" ${route.durationEstimated ? 'title="Odhad — nepočítáno z routovacího API"' : ''}>${ICON.duration}<span>${escape(dur)}${route.durationEstimated ? '<span class="mfc-stat-note">~</span>' : ''}</span></span>`
    );
  }
  if (route.elevationGainM !== undefined && route.elevationGainM > 0) {
    parts.push(
      `<span class="mfc-stat" title="Převýšení nahoru">${ICON.ascent}<span>${escape(formatElevation(route.elevationGainM))}</span></span>`
    );
  }
  if (route.elevationLossM !== undefined && route.elevationLossM > 0) {
    parts.push(
      `<span class="mfc-stat" title="Převýšení dolů">${ICON.descent}<span>${escape(formatElevation(route.elevationLossM))}</span></span>`
    );
  }
  return parts.join('');
}

function isExtensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function send<T = unknown>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!isExtensionAlive()) {
      reject(new Error('Extension reloaded — please refresh this page (Ctrl+R).'));
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(resp as T);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// -------- Viewport --------

function parseViewportFromUrl(): { lon: number; lat: number; zoom: number } | null {
  const sp = new URLSearchParams(location.search);
  const x = Number(sp.get('x'));
  const y = Number(sp.get('y'));
  const z = Number(sp.get('z'));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { lon: x, lat: y, zoom: z };
}

function getMapElement(): HTMLElement | null {
  return document.querySelector(MAP_SELECTOR) as HTMLElement | null;
}

function currentViewport(): Viewport | null {
  const map = getMapElement();
  if (!map) return null;
  const view = parseViewportFromUrl();
  if (!view) return null;
  const rect = map.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { ...view, width: rect.width, height: rect.height };
}

// -------- SVG overlay --------

let overlaySvg: SVGSVGElement | null = null;

interface EndpointMarker {
  group: SVGGElement;
  ring: SVGCircleElement;
  label: SVGTextElement;
}

interface RouteSvg {
  group: SVGGElement;
  halo: SVGPathElement;
  main: SVGPathElement;
  start: EndpointMarker;
  finish: EndpointMarker;
  markerGroup: SVGGElement;
  markerRing: SVGCircleElement;
  markerInner: SVGCircleElement;
  markerTitle: SVGTitleElement;
}

const routeSvgState = new Map<string, RouteSvg>();

/* ----- Marker clustering -----
 * Collapsed route markers are grouped by screen-space grid cell so that, at
 * low zoom, many nearby routes are summarised as a single bubble showing the
 * count. As the user zooms in, the same physical cell covers a smaller
 * geographic area, so clusters naturally break apart into individual markers.
 */

/**
 * Tighter grid cell so clusters dissolve sooner as the user zooms in.
 * (60 px kept too many routes grouped even after meaningful zoom.)
 */
const CLUSTER_CELL_PX = 44;

/**
 * Once we're zoomed in far enough that individual routes can be inspected
 * cleanly, stop clustering entirely. Without this floor, two routes that
 * happen to start within ~50 m of each other (e.g. same trailhead) would
 * stay clustered at every zoom level.
 */
const CLUSTER_DISABLED_AT_ZOOM = 14;

interface ClusterGroup {
  cx: number;
  cy: number;
  routes: SavedRoute[];
}

interface ClusterSvg {
  group: SVGGElement;
  ring: SVGCircleElement;
  fill: SVGCircleElement;
  label: SVGTextElement;
  title: SVGTitleElement;
}

const clusterSvgPool: ClusterSvg[] = [];
const clusterSvgInUse: ClusterSvg[] = [];

type ClusterGroupEl = SVGGElement & { __mfcCluster?: ClusterGroup };

/**
 * Single shared click handler for all cluster elements. The current cluster
 * data is read from the element's __mfcCluster property (set by
 * updateClusterSvg), so we don't reattach a fresh closure on every render.
 */
function onClusterClick(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const target = e.currentTarget as ClusterGroupEl | null;
  const cluster = target?.__mfcCluster;
  if (!cluster) return;
  let sumLon = 0;
  let sumLat = 0;
  for (const r of cluster.routes) {
    const cnt = getCachedRouteData(r).centroid;
    sumLon += cnt.lon;
    sumLat += cnt.lat;
  }
  const cLon = sumLon / cluster.routes.length;
  const cLat = sumLat / cluster.routes.length;
  const vp = currentViewport();
  const z = Math.min(19, (vp?.zoom ?? 12) + 2);
  try {
    const url = new URL(location.href);
    url.searchParams.set('x', String(cLon));
    url.searchParams.set('y', String(cLat));
    url.searchParams.set('z', String(z));
    history.pushState({}, '', url.toString());
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  } catch {
    /* ignore */
  }
}

function createClusterSvg(): ClusterSvg {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'mfc-cluster');
  group.setAttribute('style', 'pointer-events: auto; cursor: pointer;');

  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('fill', '#ffffff');
  ring.setAttribute('stroke', 'rgba(0,0,0,0.15)');
  ring.setAttribute('stroke-width', '1');
  group.appendChild(ring);

  const fill = document.createElementNS(SVG_NS, 'circle');
  fill.setAttribute('stroke', '#ffffff');
  fill.setAttribute('stroke-width', '2');
  group.appendChild(fill);

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute(
    'font-family',
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
  );
  label.setAttribute('font-weight', '600');
  label.setAttribute('fill', '#ffffff');
  label.setAttribute('pointer-events', 'none');
  group.appendChild(label);

  const title = document.createElementNS(SVG_NS, 'title');
  group.appendChild(title);

  // Attach interaction handlers ONCE — the click handler reads the cluster
  // data from the element on each fire (set by updateClusterSvg).
  group.addEventListener('click', onClusterClick);
  group.addEventListener('mousedown', (e) => e.stopPropagation());

  return { group, ring, fill, label, title };
}

function clusterDominantColor(routes: SavedRoute[]): string {
  if (routes.length === 0) return DIFFICULTY_COLORS.green;
  const counts: Record<string, number> = {};
  for (const r of routes) {
    const c = routeDisplayColor(r);
    counts[c] = (counts[c] ?? 0) + 1;
  }
  let best = DIFFICULTY_COLORS.green;
  let bestCount = 0;
  for (const [color, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

function acquireClusterSvg(svg: SVGSVGElement): ClusterSvg {
  let cs = clusterSvgPool.pop();
  if (!cs) {
    cs = createClusterSvg();
    // First-time creation: insert into the SVG once. Subsequent acquisitions
    // just toggle display.
    svg.appendChild(cs.group);
  } else if (cs.group.parentNode !== svg) {
    // Defensive: if the overlay SVG was replaced, re-attach.
    svg.appendChild(cs.group);
  }
  cs.group.style.display = '';
  clusterSvgInUse.push(cs);
  return cs;
}

function recycleClusterSvgs(): void {
  for (const cs of clusterSvgInUse) {
    cs.group.style.display = 'none';
    clusterSvgPool.push(cs);
  }
  clusterSvgInUse.length = 0;
}

function teardownClusters(): void {
  for (const cs of clusterSvgInUse) cs.group.remove();
  for (const cs of clusterSvgPool) cs.group.remove();
  clusterSvgInUse.length = 0;
  clusterSvgPool.length = 0;
}

function updateClusterSvg(cs: ClusterSvg, c: ClusterGroup): void {
  const count = c.routes.length;
  const r = count < 10 ? 18 : count < 50 ? 20 : 22;
  const fillR = r - 3;
  const fontSize = count < 10 ? 13 : count < 100 ? 12 : 11;
  const cx = c.cx.toFixed(1);
  const cy = c.cy.toFixed(1);

  cs.ring.setAttribute('cx', cx);
  cs.ring.setAttribute('cy', cy);
  cs.ring.setAttribute('r', String(r));

  cs.fill.setAttribute('cx', cx);
  cs.fill.setAttribute('cy', cy);
  cs.fill.setAttribute('r', String(fillR));
  cs.fill.setAttribute('fill', clusterDominantColor(c.routes));

  cs.label.setAttribute('x', cx);
  cs.label.setAttribute('y', (c.cy + fontSize * 0.36).toFixed(1));
  cs.label.setAttribute('font-size', String(fontSize));
  cs.label.textContent = count >= 100 ? '99+' : String(count);

  const names = c.routes.map((r) => r.name).join(', ');
  cs.title.textContent = `${count} tras: ${names}`;

  // Hand the current cluster data to the already-attached click handler.
  (cs.group as ClusterGroupEl).__mfcCluster = c;
}

/** Bin collapsed-route markers by grid cell and return the resulting clusters. */
function computeClusters(
  routes: SavedRoute[],
  vp: Viewport
): { ungroupedIds: Set<string>; clusters: ClusterGroup[] } {
  // Above the dissolve threshold, every route shows its own marker.
  if (vp.zoom >= CLUSTER_DISABLED_AT_ZOOM) {
    const ids = new Set<string>();
    for (const r of routes) ids.add(r.id);
    return { ungroupedIds: ids, clusters: [] };
  }

  const positions: Array<{ route: SavedRoute; x: number; y: number }> = [];
  for (const r of routes) {
    const { centroid } = getCachedRouteData(r);
    const sp = lonLatToScreen(centroid.lon, centroid.lat, vp);
    // Include a small margin so markers near the edge still cluster correctly.
    if (sp.x < -CLUSTER_CELL_PX || sp.x > vp.width + CLUSTER_CELL_PX) continue;
    if (sp.y < -CLUSTER_CELL_PX || sp.y > vp.height + CLUSTER_CELL_PX) continue;
    positions.push({ route: r, x: sp.x, y: sp.y });
  }

  const cells = new Map<string, Array<{ route: SavedRoute; x: number; y: number }>>();
  for (const p of positions) {
    const gx = Math.floor(p.x / CLUSTER_CELL_PX);
    const gy = Math.floor(p.y / CLUSTER_CELL_PX);
    const key = `${gx},${gy}`;
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(p);
  }

  const ungroupedIds = new Set<string>();
  const clusters: ClusterGroup[] = [];
  for (const items of cells.values()) {
    if (items.length === 1) {
      ungroupedIds.add(items[0].route.id);
    } else {
      let sx = 0;
      let sy = 0;
      for (const it of items) {
        sx += it.x;
        sy += it.y;
      }
      clusters.push({
        cx: sx / items.length,
        cy: sy / items.length,
        routes: items.map((i) => i.route)
      });
    }
  }
  return { ungroupedIds, clusters };
}

function ensureOverlay(map: HTMLElement): SVGSVGElement {
  if (overlaySvg && overlaySvg.isConnected) return overlaySvg;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = OVERLAY_ID;
  svg.setAttribute('xmlns', SVG_NS);
  const cs = getComputedStyle(map);
  if (cs.position === 'static') map.style.position = 'relative';
  map.appendChild(svg);
  overlaySvg = svg;
  return svg;
}

function removeOverlay(): void {
  if (overlaySvg && overlaySvg.isConnected) overlaySvg.remove();
  overlaySvg = null;
  routeSvgState.clear();
  teardownClusters();
}

/**
 * Build a Start / Finish marker — a white circle with a colored border and
 * a single-letter label. Hidden by default; the renderer toggles visibility
 * when the polyline becomes visible (i.e. the route is expanded).
 */
function createEndpointMarker(letter: 'S' | 'C', color: string): EndpointMarker {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'mfc-endpoint');
  group.setAttribute('pointer-events', 'none');
  group.style.display = 'none';

  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('r', '11');
  ring.setAttribute('fill', '#ffffff');
  ring.setAttribute('stroke', color);
  ring.setAttribute('stroke-width', '2');
  group.appendChild(ring);

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('dominant-baseline', 'central');
  label.setAttribute(
    'font-family',
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
  );
  label.setAttribute('font-weight', '700');
  label.setAttribute('font-size', '13');
  label.setAttribute('fill', color);
  label.setAttribute('pointer-events', 'none');
  label.textContent = letter;
  group.appendChild(label);

  return { group, ring, label };
}

function createRouteSvg(svg: SVGSVGElement, routeId: string): RouteSvg {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('data-route-id', routeId);

  // Polyline halo (always created; hidden when route is collapsed).
  const halo = document.createElementNS(SVG_NS, 'path');
  halo.setAttribute('fill', 'none');
  halo.setAttribute('stroke', '#ffffff');
  halo.setAttribute('stroke-width', '7');
  halo.setAttribute('stroke-opacity', '0.7');
  halo.setAttribute('stroke-linecap', 'round');
  halo.setAttribute('stroke-linejoin', 'round');
  halo.style.display = 'none';
  group.appendChild(halo);

  // Main colored path on top of halo.
  const main = document.createElementNS(SVG_NS, 'path');
  main.setAttribute('fill', 'none');
  main.setAttribute('stroke-width', '4');
  main.setAttribute('stroke-opacity', '0.9');
  main.setAttribute('stroke-linecap', 'round');
  main.setAttribute('stroke-linejoin', 'round');
  main.style.display = 'none';
  group.appendChild(main);

  // Start ("S") and Finish ("C", short for "Cíl") markers — appended after
  // the polyline so they draw on top of it but below the centroid marker.
  const start = createEndpointMarker('S', '#1f5132');
  const finish = createEndpointMarker('C', '#1a1d21');
  group.appendChild(start.group);
  group.appendChild(finish.group);

  // Marker (circle pair) — always present (until route is removed entirely).
  const markerGroup = document.createElementNS(SVG_NS, 'g');
  markerGroup.setAttribute('style', 'pointer-events: auto; cursor: pointer;');

  const markerRing = document.createElementNS(SVG_NS, 'circle');
  markerRing.setAttribute('fill', '#ffffff');
  markerRing.setAttribute('stroke', 'rgba(0,0,0,0.15)');
  markerRing.setAttribute('stroke-width', '1');
  markerGroup.appendChild(markerRing);

  const markerInner = document.createElementNS(SVG_NS, 'circle');
  markerGroup.appendChild(markerInner);

  const markerTitle = document.createElementNS(SVG_NS, 'title');
  markerGroup.appendChild(markerTitle);

  markerGroup.addEventListener('click', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clickRouteCircle(routeId);
  });
  markerGroup.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation());

  group.appendChild(markerGroup);
  svg.appendChild(group);

  return { group, halo, main, start, finish, markerGroup, markerRing, markerInner, markerTitle };
}

/** Rough metres between two coords, used as a fallback when the route's
 * `shape` field hasn't been classified yet. ~111 km per degree latitude. */
function approxMetres(a: LonLat, b: LonLat): number {
  const dLat = (a.lat - b.lat) * 111000;
  const dLon = (a.lon - b.lon) * 111000 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function positionEndpointMarker(m: EndpointMarker, x: number, y: number): void {
  const cx = x.toFixed(1);
  const cy = y.toFixed(1);
  m.ring.setAttribute('cx', cx);
  m.ring.setAttribute('cy', cy);
  m.label.setAttribute('x', cx);
  m.label.setAttribute('y', cy);
  m.group.style.display = '';
}

function positionEndpointMarkers(
  rs: RouteSvg,
  route: SavedRoute,
  coords: LonLat[],
  vp: Viewport
): void {
  if (coords.length < 2) {
    rs.start.group.style.display = 'none';
    rs.finish.group.style.display = 'none';
    return;
  }
  const startPt = coords[0];
  const endPt = coords[coords.length - 1];

  // Always show Start.
  const sp = lonLatToScreen(startPt.lon, startPt.lat, vp);
  positionEndpointMarker(rs.start, sp.x, sp.y);

  // Show Finish only when the route is genuinely one-way. For loops and
  // there-and-back trails, the start and end share a location and one marker
  // is enough.
  const closed =
    route.shape === 'loop' ||
    route.shape === 'out-and-back' ||
    (route.shape === undefined && approxMetres(startPt, endPt) < 100);

  if (closed) {
    rs.finish.group.style.display = 'none';
  } else {
    const ep = lonLatToScreen(endPt.lon, endPt.lat, vp);
    positionEndpointMarker(rs.finish, ep.x, ep.y);
  }
}

function updateRouteSvg(
  rs: RouteSvg,
  route: SavedRoute,
  vp: Viewport,
  vpBbox: BBox,
  hideMarker = false
): void {
  const cache = getCachedRouteData(route);
  const expanded = expandedRouteIds.has(route.id);
  const color = routeDisplayColor(route);

  // Polyline visibility: only when expanded AND the route's bbox intersects the viewport.
  const polylineVisible = expanded && bboxIntersects(cache.bbox, vpBbox);
  if (polylineVisible) {
    const d = buildPathD(cache.coords, vp);
    rs.halo.setAttribute('d', d);
    rs.main.setAttribute('d', d);
    rs.main.setAttribute('stroke', color);
    rs.halo.style.display = '';
    rs.main.style.display = '';
    // Start / Finish markers at the polyline endpoints.
    positionEndpointMarkers(rs, route, cache.coords, vp);
  } else {
    rs.halo.style.display = 'none';
    rs.main.style.display = 'none';
    rs.start.group.style.display = 'none';
    rs.finish.group.style.display = 'none';
  }

  // Marker position.
  const sp = lonLatToScreen(cache.centroid.lon, cache.centroid.lat, vp);
  const offscreen =
    sp.x < -40 || sp.y < -40 || sp.x > vp.width + 40 || sp.y > vp.height + 40;
  rs.markerGroup.style.display = hideMarker || offscreen ? 'none' : '';

  if (!hideMarker && !offscreen) {
    const cx = sp.x.toFixed(1);
    const cy = sp.y.toFixed(1);
    const ringR = expanded ? '7' : '12';
    const innerR = expanded ? '4' : '8';
    rs.markerRing.setAttribute('cx', cx);
    rs.markerRing.setAttribute('cy', cy);
    rs.markerRing.setAttribute('r', ringR);
    rs.markerInner.setAttribute('cx', cx);
    rs.markerInner.setAttribute('cy', cy);
    rs.markerInner.setAttribute('r', innerR);
    rs.markerInner.setAttribute('fill', color);
    rs.markerTitle.textContent = expanded
      ? `${route.name} — kliknutím sbalíš trasu`
      : `${route.name} — kliknutím zobrazíš trasu`;
  }
}

function drawPath(parent: SVGElement, coords: LonLat[], vp: Viewport, color: string, dashed = false): void {
  if (coords.length < 2) return;
  const d = buildPathD(coords, vp);
  const halo = document.createElementNS(SVG_NS, 'path');
  halo.setAttribute('d', d);
  halo.setAttribute('fill', 'none');
  halo.setAttribute('stroke', '#ffffff');
  halo.setAttribute('stroke-width', '7');
  halo.setAttribute('stroke-opacity', '0.7');
  halo.setAttribute('stroke-linecap', 'round');
  halo.setAttribute('stroke-linejoin', 'round');
  parent.appendChild(halo);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '4');
  path.setAttribute('stroke-opacity', '0.9');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (dashed) path.setAttribute('stroke-dasharray', '8,6');
  parent.appendChild(path);
}

function drawPoint(parent: SVGElement, p: LonLat, vp: Viewport, color: string, label: string): void {
  const s = lonLatToScreen(p.lon, p.lat, vp);
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', s.x.toFixed(1));
  circle.setAttribute('cy', s.y.toFixed(1));
  circle.setAttribute('r', '8');
  circle.setAttribute('fill', color);
  circle.setAttribute('stroke', '#ffffff');
  circle.setAttribute('stroke-width', '2');
  parent.appendChild(circle);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', s.x.toFixed(1));
  text.setAttribute('y', (s.y + 4).toFixed(1));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-family', '-apple-system, system-ui, sans-serif');
  text.setAttribute('font-size', '11');
  text.setAttribute('font-weight', '600');
  text.setAttribute('fill', '#ffffff');
  text.textContent = label;
  parent.appendChild(text);
}

function renderOverlay(): void {
  const map = getMapElement();
  if (!map) {
    removeOverlay();
    return;
  }
  const vp = currentViewport();
  if (!vp) {
    removeOverlay();
    return;
  }
  // Keep the popup pinned to its marker on every viewport change.
  positionPopup();

  // Render the overlay if there's anything to show — either personal routes,
  // or community routes from other users (a fresh account with no personal
  // routes still needs to see shared circles).
  const hasSaved =
    state.showOnMap &&
    (state.routes.length > 0 || state.communityRoutes.length > 0);
  const hasBuilding = state.building !== null;
  if (!hasSaved && !hasBuilding) {
    removeOverlay();
    return;
  }

  const svg = ensureOverlay(map);
  svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
  svg.setAttribute('width', String(vp.width));
  svg.setAttribute('height', String(vp.height));

  const vpBbox = viewportBbox(vp);

  // ----- Saved routes: element reuse + screen-space clustering -----
  if (hasSaved) {
    const renderRoutes = allMapRoutes();
    const liveIds = new Set(renderRoutes.map((r) => r.id));
    // Drop SVG state for routes that have been deleted.
    for (const [id, rs] of routeSvgState) {
      if (!liveIds.has(id)) {
        rs.group.remove();
        routeSvgState.delete(id);
      }
    }

    // Cluster collapsed (non-expanded) routes; expanded routes always show
    // their individual marker so the user can interact with the open popup.
    const collapsedRoutes = renderRoutes.filter((r) => !expandedRouteIds.has(r.id));
    const { ungroupedIds, clusters } = computeClusters(collapsedRoutes, vp);
    const showOwnMarker = (r: SavedRoute): boolean =>
      expandedRouteIds.has(r.id) || ungroupedIds.has(r.id);

    // Update / create for each live route.
    for (const r of renderRoutes) {
      let rs = routeSvgState.get(r.id);
      if (!rs) {
        rs = createRouteSvg(svg, r.id);
        routeSvgState.set(r.id, rs);
      }
      updateRouteSvg(rs, r, vp, vpBbox, !showOwnMarker(r));
    }

    // Render the cluster bubbles on top of individual markers.
    recycleClusterSvgs();
    for (const c of clusters) {
      const cs = acquireClusterSvg(svg);
      updateClusterSvg(cs, c);
    }
  } else {
    // Saved routes hidden — drop all their SVG state.
    for (const rs of routeSvgState.values()) rs.group.remove();
    routeSvgState.clear();
    recycleClusterSvgs();
  }

  // ----- Build-mode preview (rebuilt each render — only active during route creation) -----
  let buildGroup = svg.querySelector<SVGGElement>(':scope > g.mfc-build-preview');
  if (state.building) {
    if (!buildGroup) {
      buildGroup = document.createElementNS(SVG_NS, 'g');
      buildGroup.setAttribute('class', 'mfc-build-preview');
      svg.appendChild(buildGroup);
    }
    while (buildGroup.firstChild) buildGroup.removeChild(buildGroup.firstChild);
    const buildColor = DIFFICULTY_COLORS[state.building.difficulty];
    drawPath(buildGroup, state.building.points, vp, buildColor, true);
    state.building.points.forEach((p, i) => {
      drawPoint(buildGroup!, p, vp, buildColor, String(i + 1));
    });
  } else if (buildGroup) {
    buildGroup.remove();
  }
}

// -------- Build mode click capture --------

let buildClickListener: ((e: MouseEvent) => void) | null = null;
let buildClickTarget: HTMLElement | null = null;

function attachBuildClickCapture(): void {
  detachBuildClickCapture();
  const map = getMapElement();
  if (!map) return;
  buildClickTarget = map;
  buildClickListener = (e: MouseEvent) => {
    if (!state.building) return;
    const root = document.getElementById(ROOT_ID);
    if (root && root.contains(e.target as Node)) return;
    const vp = currentViewport();
    if (!vp) return;
    const rect = map.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ll = screenToLonLat(x, y, vp);
    state.building.points.push(ll);
    e.preventDefault();
    e.stopPropagation();
    rerenderPanel();
    renderOverlay();
  };
  map.addEventListener('click', buildClickListener, { capture: true });
}

function detachBuildClickCapture(): void {
  if (buildClickListener && buildClickTarget) {
    buildClickTarget.removeEventListener('click', buildClickListener, { capture: true });
  }
  buildClickListener = null;
  buildClickTarget = null;
}

// -------- Build mode controls --------

function startBuild(): void {
  state.building = {
    points: [],
    name: '',
    difficulty: 'green',
    routeType: 'foot_hiking',
    description: '',
    photos: [],
    hasParkingAtStart: false,
    folderId: '',
    imported: false
  };
  state.editing = null;
  attachBuildClickCapture();
  rerenderPanel();
  renderOverlay();
}

function cancelBuild(): void {
  state.building = null;
  detachBuildClickCapture();
  rerenderPanel();
  renderOverlay();
}

function importCurrentRoute(): void {
  if (!state.importable || state.importable.points.length < 2) return;
  state.building = {
    points: [...state.importable.points],
    name: '',
    difficulty: 'green',
    routeType: 'foot_hiking',
    description: '',
    photos: [],
    hasParkingAtStart: false,
    folderId: '',
    imported: true,
    importedPageUrl: state.importable.pageUrl
  };
  state.editing = null;
  attachBuildClickCapture();
  rerenderPanel();
  renderOverlay();
}

function startEdit(route: SavedRoute): void {
  state.editing = {
    routeId: route.id,
    name: route.name,
    difficulty: route.difficulty ?? 'green',
    routeType: route.routeType,
    description: route.description ?? '',
    photos: route.photos ? [...route.photos] : [],
    hasParkingAtStart: Boolean(route.hasParkingAtStart),
    folderId: route.folderId ?? '',
    shared: Boolean(route.shared)
  };
  state.popup = null;
  state.building = null;
  detachBuildClickCapture();
  // Make sure the side panel is open while editing.
  const root = document.getElementById(ROOT_ID);
  if (root) root.classList.remove('mfc-collapsed');
  rerenderPanel();
  renderPopup();
  renderOverlay();
}

function cancelEdit(): void {
  state.editing = null;
  rerenderPanel();
}

async function saveEdit(): Promise<void> {
  if (!state.editing) return;
  const e = state.editing;
  if (!e.name.trim()) return;
  const resp = await send<{ ok: boolean; error?: string; route?: SavedRoute }>({
    type: 'updateRoute',
    routeId: e.routeId,
    updates: {
      name: e.name.trim(),
      difficulty: e.difficulty,
      routeType: e.routeType,
      description: e.description,
      photos: e.photos,
      hasParkingAtStart: e.hasParkingAtStart,
      folderId: e.folderId || null,
      shared: e.shared
    }
  });
  if (!resp.ok) {
    const err = document.querySelector('.mfc-edit-error');
    if (err) err.textContent = resp.error ?? 'Save failed';
    return;
  }
  state.editing = null;
  await loadFromStorage();
  rerenderPanel();
  lastKey = '';
  renderOverlay();
  renderPopup();
}

async function deleteRouteFromUi(routeId: string): Promise<void> {
  const route = state.routes.find((r) => r.id === routeId);
  const name = route?.name ?? 'this route';
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  const resp = await send<{ ok: boolean; error?: string }>({ type: 'deleteRoute', routeId });
  if (!resp.ok) {
    alert(`Delete failed: ${resp.error ?? 'unknown error'}`);
    return;
  }
  if (state.popup?.routeId === routeId) state.popup = null;
  expandedRouteIds.delete(routeId);
  await loadFromStorage();
  rerenderPanel();
  lastKey = '';
  renderOverlay();
  renderPopup();
}

async function createFolderUi(): Promise<void> {
  const name = window.prompt('Název složky?');
  if (!name?.trim()) return;
  const resp = await send<{ ok: boolean; error?: string }>({
    type: 'createFolder',
    name: name.trim()
  });
  if (!resp.ok) {
    alert(`Nepodařilo se vytvořit složku: ${resp.error ?? 'unknown error'}`);
    return;
  }
  await loadFromStorage();
  rerenderPanel();
}

async function renameFolderUi(folder: RouteFolder): Promise<void> {
  const newName = window.prompt('Nový název složky?', folder.name);
  if (!newName?.trim() || newName.trim() === folder.name) return;
  const resp = await send<{ ok: boolean; error?: string }>({
    type: 'updateFolder',
    folderId: folder.id,
    updates: { name: newName.trim() }
  });
  if (!resp.ok) {
    alert(`Nepodařilo se přejmenovat: ${resp.error ?? 'unknown error'}`);
    return;
  }
  await loadFromStorage();
  rerenderPanel();
}

async function castVoteUi(community: SharedRoute, action: 'like' | 'dislike'): Promise<void> {
  // If the user is clicking their current vote, treat it as a toggle-off.
  const nextVote: RouteVote = community.myVote === action ? null : action;

  // Optimistic local update so the UI feels instant.
  const prevSnapshot = {
    likeCount: community.likeCount,
    dislikeCount: community.dislikeCount,
    myVote: community.myVote
  };
  applyVoteLocally(community, nextVote);
  renderPopup();

  try {
    const resp = await send<{
      ok: boolean;
      error?: string;
      likeCount?: number;
      dislikeCount?: number;
      myVote?: RouteVote;
    }>({ type: 'voteRoute', routeId: community.id, vote: nextVote });
    if (!resp.ok) {
      // Revert on failure.
      community.likeCount = prevSnapshot.likeCount;
      community.dislikeCount = prevSnapshot.dislikeCount;
      community.myVote = prevSnapshot.myVote;
      renderPopup();
      console.warn('[Trasy] vote failed:', resp.error);
      return;
    }
    // Sync against authoritative server counts.
    if (resp.likeCount !== undefined) community.likeCount = resp.likeCount;
    if (resp.dislikeCount !== undefined) community.dislikeCount = resp.dislikeCount;
    if (resp.myVote !== undefined) community.myVote = resp.myVote;
    renderPopup();
  } catch (err) {
    community.likeCount = prevSnapshot.likeCount;
    community.dislikeCount = prevSnapshot.dislikeCount;
    community.myVote = prevSnapshot.myVote;
    renderPopup();
    console.warn('[Trasy] vote error:', err);
  }
}

function applyVoteLocally(community: SharedRoute, next: RouteVote): void {
  const prev = community.myVote;
  if (prev === next) return;
  if (prev === 'like') community.likeCount = Math.max(0, community.likeCount - 1);
  if (prev === 'dislike') community.dislikeCount = Math.max(0, community.dislikeCount - 1);
  if (next === 'like') community.likeCount += 1;
  if (next === 'dislike') community.dislikeCount += 1;
  community.myVote = next;
}

async function deleteFolderUi(folder: RouteFolder): Promise<void> {
  const inFolder = state.routes.filter((r) => r.folderId === folder.id).length;
  const note =
    inFolder > 0
      ? `Smazat složku "${folder.name}"? ${inFolder} ${inFolder === 1 ? 'trasa' : inFolder < 5 ? 'trasy' : 'tras'} uvnitř bude přesunuto do "Bez složky".`
      : `Smazat složku "${folder.name}"?`;
  if (!confirm(note)) return;
  const resp = await send<{ ok: boolean; error?: string }>({
    type: 'deleteFolder',
    folderId: folder.id
  });
  if (!resp.ok) {
    alert(`Nepodařilo se smazat: ${resp.error ?? 'unknown error'}`);
    return;
  }
  collapsedFolderIds.delete(folder.id);
  await loadFromStorage();
  rerenderPanel();
}

function toggleFolderCollapse(folderId: string): void {
  if (collapsedFolderIds.has(folderId)) {
    collapsedFolderIds.delete(folderId);
  } else {
    collapsedFolderIds.add(folderId);
  }
  rerenderPanel();
}

function undoLastPoint(): void {
  if (!state.building) return;
  state.building.points.pop();
  rerenderPanel();
  renderOverlay();
}

async function saveBuild(): Promise<void> {
  if (!state.building) return;
  const b = state.building;
  if (b.points.length < 2) return;
  const trimmed = b.name.trim();
  if (!trimmed) return;
  const color = DIFFICULTY_COLORS[b.difficulty];
  const resp = await send<{ ok: boolean; error?: string; route?: SavedRoute }>(
    b.imported
      ? {
          type: 'importRoute',
          name: trimmed,
          color,
          difficulty: b.difficulty,
          routeType: b.routeType,
          points: b.points,
          pageUrl: b.importedPageUrl,
          description: b.description,
          photos: b.photos,
          hasParkingAtStart: b.hasParkingAtStart,
          folderId: b.folderId || undefined
        }
      : {
          type: 'createRoute',
          name: trimmed,
          color,
          difficulty: b.difficulty,
          routeType: b.routeType,
          points: b.points,
          description: b.description,
          photos: b.photos,
          hasParkingAtStart: b.hasParkingAtStart,
          folderId: b.folderId || undefined
        }
  );
  if (!resp.ok) {
    const errEl = document.querySelector('.mfc-build-error');
    if (errEl) errEl.textContent = resp.error ?? 'Failed to save';
    return;
  }
  state.building = null;
  detachBuildClickCapture();
  await loadFromStorage();
  rerenderPanel();
  renderOverlay();
}

// -------- rAF watcher --------

let lastKey = '';
// While the map's viewport is actively changing (drag/zoom), we hide the
// overlay and skip per-frame rendering. When the viewport stops changing for
// ~150 ms we re-render once and reveal. Effect: icons stay still (invisible)
// during a drag, then reappear in their correct positions when you let go.

function viewportSig(): string {
  const sp = new URLSearchParams(location.search);
  return `${sp.get('x')}|${sp.get('y')}|${sp.get('z')}`;
}

let prevViewportSig = '';
let viewportSettleTimer: number | null = null;
let overlayHiddenDuringMove = false;

function watcherLoop(): void {
  const map = getMapElement();
  if (map) {
    const r = map.getBoundingClientRect();
    const buildKey = state.building
      ? `${state.building.points.length}|${state.building.difficulty}`
      : 'none';
    const expandedKey = `${expandedRouteIds.size}:${[...expandedRouteIds].sort().join(',')}`;
    const key = `${location.href}|${Math.round(r.width)}x${Math.round(r.height)}|${state.showOnMap}|${state.routes.length}|${buildKey}|${expandedKey}`;

    if (key !== lastKey) {
      lastKey = key;
      const newSig = viewportSig();
      const viewportChanged = newSig !== prevViewportSig;
      prevViewportSig = newSig;

      if (viewportChanged) {
        // Drag / zoom in progress: hide overlay, defer rendering until motion stops.
        if (overlaySvg && !overlayHiddenDuringMove) {
          overlaySvg.style.visibility = 'hidden';
          overlayHiddenDuringMove = true;
        }
        if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
        viewportSettleTimer = window.setTimeout(() => {
          viewportSettleTimer = null;
          // Motion has settled — render once at the final viewport, then show.
          lastKey = '';
          renderOverlay();
          if (overlaySvg) overlaySvg.style.visibility = '';
          overlayHiddenDuringMove = false;
        }, 150);
      } else {
        // Non-viewport change (route added / edited / etc.) — render normally.
        renderOverlay();
      }
    }
  }
  requestAnimationFrame(watcherLoop);
}

// -------- Storage --------

async function loadFromStorage(): Promise<void> {
  if (!isExtensionAlive()) return;
  try {
    const o = await chrome.storage.local.get([
      'user',
      'routes',
      'folders',
      'showOnMap',
      'communityRoutes'
    ]);
    state.user = (o.user as User | undefined) ?? null;
    state.showOnMap = o.showOnMap === undefined ? true : Boolean(o.showOnMap);
    if (state.user) {
      const map = (o.routes as Record<string, SavedRoute[]> | undefined) ?? {};
      state.routes = map[state.user.oauthUserId] ?? [];
      const fmap = (o.folders as Record<string, RouteFolder[]> | undefined) ?? {};
      state.folders = fmap[state.user.oauthUserId] ?? [];
    } else {
      state.routes = [];
      state.folders = [];
    }
    // Community routes are global, filter out our own so we don't double-list.
    const community = (o.communityRoutes as SharedRoute[] | undefined) ?? [];
    state.communityRoutes = state.user
      ? community.filter((r) => r.ownerId !== state.user!.oauthUserId)
      : community;
    pruneRouteCache();
  } catch {
    // Context invalidated mid-call; nothing useful to do until page refresh.
  }
}

// -------- Side panel --------

function initSidePanel(): void {
  if (document.getElementById(ROOT_ID)) return;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.classList.add('mfc-collapsed');
  document.documentElement.appendChild(root);

  const toggle = document.createElement('button');
  toggle.className = 'mfc-toggle';
  toggle.title = 'Moje trasy';
  toggle.innerHTML = `${ICON.compass}<span>Trasy</span>`;
  root.appendChild(toggle);

  const panel = document.createElement('div');
  panel.className = 'mfc-panel';
  root.appendChild(panel);

  toggle.addEventListener('click', () => {
    const wasCollapsed = root.classList.contains('mfc-collapsed');
    root.classList.toggle('mfc-collapsed');
    if (wasCollapsed) {
      // Trigger a fresh probe before showing the panel — by now mapy.com has
      // usually finished decoding the full polyline into JS state, even if the
      // earlier auto-probes ran too soon.
      try {
        window.postMessage({ source: 'mfc-isolated', type: 'runProbe' }, '*');
      } catch {
        // ignore
      }
      void renderPanel();
    }
  });

  startTrasyButtonPositioning(root);
}

/**
 * Anchor the Trasy launcher just to the right of mapy.com's native left
 * toolbar (the Změnit mapu / Letecká / 3D / Panorama group). The toolbar's
 * width varies with viewport, so we observe it and reposition as needed.
 */
let trasyResizeObserver: ResizeObserver | null = null;
let trasyToolbarRef: HTMLElement | null = null;

function startTrasyButtonPositioning(root: HTMLElement): void {
  const reposition = (): void => {
    const tb = document.querySelector<HTMLElement>(
      '.map-controls__topToolbar__leftTools'
    );
    if (tb) {
      const rect = tb.getBoundingClientRect();
      const left = Math.round(rect.right + 12);
      root.style.left = `${left}px`;
      if (tb !== trasyToolbarRef) {
        trasyResizeObserver?.disconnect();
        trasyToolbarRef = tb;
        trasyResizeObserver = new ResizeObserver(() => reposition());
        try {
          trasyResizeObserver.observe(tb);
        } catch {
          /* ignore */
        }
      }
    }
  };

  reposition();
  window.addEventListener('resize', reposition);
  // mapy.com sometimes renders its toolbar after our content script loads —
  // keep checking briefly until we find it.
  let attempts = 0;
  const probe = window.setInterval(() => {
    reposition();
    if (trasyToolbarRef || ++attempts > 30) window.clearInterval(probe);
  }, 500);
}

function getPanelEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${ROOT_ID} .mfc-panel`);
}

function rerenderPanel(): void {
  const root = document.getElementById(ROOT_ID);
  if (!root || root.classList.contains('mfc-collapsed')) return;
  void renderPanel();
}

async function renderPanel(): Promise<void> {
  const panel = getPanelEl();
  if (!panel) return;
  if (!state.building && !state.editing) await loadFromStorage();

  if (state.editing) {
    renderEditPanel(panel);
    return;
  }

  if (state.building) {
    renderBuildPanel(panel);
    return;
  }

  if (!state.user) {
    panel.innerHTML = `<div class="mfc-empty">Log in via the extension popup to see your routes.</div>`;
    return;
  }

  const importBtn = state.importable
    ? `<button class="mfc-primary" id="mfc-import-route" title="Importovat trasu zobrazenou na mapy.com">${ICON.download}<span>Importovat aktuální trasu (${state.importable.points.length} bodů)</span></button>`
    : '';

  const count = state.routes.length;
  panel.innerHTML = `
    <div class="mfc-header">
      <div class="mfc-header-title">
        <span>Moje trasy</span>
        ${count > 0 ? `<span class="mfc-count">${count}</span>` : ''}
      </div>
      <label class="mfc-master">
        <input type="checkbox" id="mfc-show-on-map" ${state.showOnMap ? 'checked' : ''}>
        <span>Zobrazit na mapě</span>
      </label>
    </div>
    ${importBtn}
    <div class="mfc-toolbar">
      <button class="mfc-secondary" id="mfc-new-route">${ICON.plus}<span>Nová trasa</span></button>
      <button class="mfc-secondary" id="mfc-new-folder" title="Vytvořit novou složku">${ICON.folderPlus}<span>Nová složka</span></button>
    </div>
    ${
      state.routes.length === 0 && state.folders.length === 0
        ? `<div class="mfc-empty">
             <div class="mfc-empty-icon">${ICON.routeBadge}</div>
             <div class="mfc-empty-title">Zatím žádné trasy</div>
             <div class="mfc-empty-sub">Importuj trasu z mapy.com nebo si jednu sestav klikáním do mapy.</div>
           </div>`
        : renderRouteList()
    }
    ${renderCommunitySection()}
  `;

  panel.querySelector<HTMLInputElement>('#mfc-show-on-map')!.addEventListener('change', async (ev) => {
    state.showOnMap = (ev.target as HTMLInputElement).checked;
    await chrome.storage.local.set({ showOnMap: state.showOnMap });
    lastKey = '';
    renderOverlay();
  });
  panel.querySelector<HTMLButtonElement>('#mfc-new-route')!.addEventListener('click', () => {
    startBuild();
  });
  panel.querySelector<HTMLButtonElement>('#mfc-new-folder')!.addEventListener('click', () => {
    void createFolderUi();
  });
  panel.querySelector<HTMLButtonElement>('#mfc-import-route')?.addEventListener('click', () => {
    importCurrentRoute();
  });

  // Wire per-route action buttons.
  for (const r of state.routes) {
    panel.querySelector<HTMLButtonElement>(`[data-edit="${r.id}"]`)?.addEventListener('click', () => {
      startEdit(r);
    });
    panel.querySelector<HTMLButtonElement>(`[data-delete="${r.id}"]`)?.addEventListener('click', () => {
      void deleteRouteFromUi(r.id);
    });
    panel.querySelector<HTMLElement>(`[data-show="${r.id}"]`)?.addEventListener('click', () => {
      clickRouteCircle(r.id);
    });
  }

  // Wire per-folder action buttons + headers.
  for (const f of state.folders) {
    panel.querySelector<HTMLButtonElement>(`[data-folder-toggle="${f.id}"]`)?.addEventListener('click', () => {
      toggleFolderCollapse(f.id);
    });
    panel.querySelector<HTMLButtonElement>(`[data-folder-rename="${f.id}"]`)?.addEventListener('click', () => {
      void renameFolderUi(f);
    });
    panel.querySelector<HTMLButtonElement>(`[data-folder-delete="${f.id}"]`)?.addEventListener('click', () => {
      void deleteFolderUi(f);
    });
  }

  // Wire community route items
  for (const c of state.communityRoutes) {
    panel.querySelector<HTMLElement>(`[data-community-show="${c.id}"]`)?.addEventListener('click', () => {
      clickRouteCircle(c.id);
    });
  }
  panel.querySelector<HTMLButtonElement>('#mfc-refresh-community')?.addEventListener('click', () => {
    void send({ type: 'refreshCommunity' });
  });
}

function renderCommunitySection(): string {
  const routes = state.communityRoutes;
  if (routes.length === 0) {
    return `
      <section class="mfc-community">
        <div class="mfc-community-header">
          <span class="mfc-community-title">Komunitní trasy</span>
          <button class="mfc-iconbtn" id="mfc-refresh-community" title="Aktualizovat">${ICON.download}</button>
        </div>
        <div class="mfc-community-empty">Zatím nikdo nesdílí žádnou trasu.</div>
      </section>
    `;
  }
  return `
    <section class="mfc-community">
      <div class="mfc-community-header">
        <span class="mfc-community-title">Komunitní trasy</span>
        <span class="mfc-count">${routes.length}</span>
        <button class="mfc-iconbtn" id="mfc-refresh-community" title="Aktualizovat">${ICON.download}</button>
      </div>
      <ul class="mfc-list">
        ${routes.map(renderCommunityListItem).join('')}
      </ul>
    </section>
  `;
}

function renderCommunityListItem(c: SharedRoute): string {
  const color = c.difficulty ? DIFFICULTY_COLORS[c.difficulty] : '#888';
  const route = sharedToRouteView(c);
  const stats = renderStatsLine(route);
  // Privacy: do not surface the uploader's identity in the list view.
  return `
    <li class="mfc-route-card">
      <div class="mfc-route-body" data-community-show="${c.id}" title="Zobrazit trasu na mapě">
        <div class="mfc-route-headrow">
          <span class="mfc-route-dot" style="background:${escape(color)}"></span>
          <div class="mfc-route-name">${escape(c.name)}</div>
        </div>
        ${c.description ? `<div class="mfc-route-desc">${escape(c.description)}</div>` : ''}
        ${stats ? `<div class="mfc-route-stats">${stats}</div>` : ''}
      </div>
    </li>
  `;
}

function renderRouteList(): string {
  if (state.folders.length === 0) {
    // No folders: render routes as a single flat list (original behaviour).
    if (state.routes.length === 0) return '';
    return `<ul class="mfc-list">${state.routes.map(renderRouteListItem).join('')}</ul>`;
  }

  // Partition routes by folder
  const byFolder = new Map<string, SavedRoute[]>();
  const unfiled: SavedRoute[] = [];
  const folderIds = new Set(state.folders.map((f) => f.id));
  for (const r of state.routes) {
    if (r.folderId && folderIds.has(r.folderId)) {
      const arr = byFolder.get(r.folderId) ?? [];
      arr.push(r);
      byFolder.set(r.folderId, arr);
    } else {
      unfiled.push(r);
    }
  }

  const folderSections = state.folders
    .map((f) => renderFolderSection(f, byFolder.get(f.id) ?? []))
    .join('');

  const unfiledSection =
    unfiled.length > 0
      ? `<section class="mfc-folder mfc-folder-unfiled">
           <div class="mfc-folder-header">
             <span class="mfc-folder-chevron mfc-folder-chevron-placeholder"></span>
             <span class="mfc-folder-name">Bez složky</span>
             <span class="mfc-folder-count">${unfiled.length}</span>
           </div>
           <ul class="mfc-folder-list">${unfiled.map(renderRouteListItem).join('')}</ul>
         </section>`
      : '';

  return folderSections + unfiledSection;
}

function renderFolderSection(folder: RouteFolder, routes: SavedRoute[]): string {
  const collapsed = collapsedFolderIds.has(folder.id);
  return `
    <section class="mfc-folder${collapsed ? ' mfc-folder-collapsed' : ''}" data-folder-id="${folder.id}">
      <div class="mfc-folder-header">
        <button class="mfc-folder-chevron" data-folder-toggle="${folder.id}" title="${collapsed ? 'Rozbalit' : 'Sbalit'}">${ICON.chevronRight}</button>
        <span class="mfc-folder-icon">${ICON.folder}</span>
        <span class="mfc-folder-name">${escape(folder.name)}</span>
        <span class="mfc-folder-count">${routes.length}</span>
        <div class="mfc-folder-actions">
          <button class="mfc-iconbtn" data-folder-rename="${folder.id}" title="Přejmenovat">${ICON.edit}</button>
          <button class="mfc-iconbtn mfc-iconbtn-danger" data-folder-delete="${folder.id}" title="Smazat složku">${ICON.trash}</button>
        </div>
      </div>
      ${
        collapsed
          ? ''
          : routes.length === 0
            ? `<div class="mfc-folder-empty">Žádné trasy. Přesuň trasu pomocí tlačítka Upravit.</div>`
            : `<ul class="mfc-folder-list">${routes.map(renderRouteListItem).join('')}</ul>`
      }
    </section>
  `;
}

function renderRouteListItem(r: SavedRoute): string {
  const stats = renderStatsLine(r);
  const descShort = r.description
    ? `<div class="mfc-route-desc">${escape(r.description)}</div>`
    : '';
  return `
    <li class="mfc-route-card">
      <div class="mfc-route-body" data-show="${r.id}" title="Zobrazit trasu na mapě">
        <div class="mfc-route-headrow">
          <span class="mfc-route-dot" style="background:${escape(routeDisplayColor(r))}"></span>
          <div class="mfc-route-name">${escape(r.name)}</div>
        </div>
        ${descShort}
        ${stats ? `<div class="mfc-route-stats">${stats}</div>` : ''}
      </div>
      <div class="mfc-route-actions">
        <button class="mfc-iconbtn" data-edit="${r.id}" title="Upravit">${ICON.edit}</button>
        <button class="mfc-iconbtn mfc-iconbtn-danger" data-delete="${r.id}" title="Smazat">${ICON.trash}</button>
      </div>
    </li>
  `;
}

function renderEditPanel(panel: HTMLElement): void {
  const e = state.editing!;
  panel.innerHTML = `
    <div class="mfc-header">
      <div class="mfc-header-title"><span>Upravit trasu</span></div>
      <button class="mfc-iconbtn" id="mfc-edit-cancel" title="Zrušit">${ICON.close}</button>
    </div>
    <div class="mfc-build-form">
      <label>Název <input type="text" id="mfc-edit-name" value="${escape(e.name)}" placeholder="Název trasy"></label>
      <label>Popis
        <textarea id="mfc-edit-desc" rows="3" placeholder="Volitelný popis...">${escape(e.description)}</textarea>
      </label>
      <div class="mfc-row">
        <label>Obtížnost
          ${renderDifficultyPicker(e)}
        </label>
        <label>Typ
          <select id="mfc-edit-type">
            ${ROUTE_TYPES.map(
              (t) =>
                `<option value="${t.value}" ${t.value === e.routeType ? 'selected' : ''}>${escape(t.label)}</option>`
            ).join('')}
          </select>
        </label>
      </div>
      <label>Fotky</label>
      ${renderPhotoEditor(e)}
      <label>Složka
        <select id="mfc-edit-folder">
          <option value="" ${e.folderId === '' ? 'selected' : ''}>Bez složky</option>
          ${state.folders
            .map(
              (f) =>
                `<option value="${escape(f.id)}" ${f.id === e.folderId ? 'selected' : ''}>${escape(f.name)}</option>`
            )
            .join('')}
        </select>
      </label>
      <label class="mfc-checkbox">
        <input type="checkbox" id="mfc-edit-parking" ${e.hasParkingAtStart ? 'checked' : ''}>
        <span>Parkování u startu</span>
      </label>
      <label class="mfc-checkbox">
        <input type="checkbox" id="mfc-edit-shared" ${e.shared ? 'checked' : ''}>
        <span>Sdílet s komunitou</span>
      </label>
    </div>
    <div class="mfc-edit-error mfc-build-error"></div>
    <button class="mfc-primary" id="mfc-edit-save" ${e.name.trim() ? '' : 'disabled'}>Uložit změny</button>
    <button class="mfc-secondary" id="mfc-edit-cancel-2">Zrušit</button>
  `;

  panel.querySelector<HTMLButtonElement>('#mfc-edit-cancel')!.addEventListener('click', cancelEdit);
  panel.querySelector<HTMLButtonElement>('#mfc-edit-cancel-2')!.addEventListener('click', cancelEdit);
  panel.querySelector<HTMLButtonElement>('#mfc-edit-save')!.addEventListener('click', () => void saveEdit());
  panel.querySelector<HTMLInputElement>('#mfc-edit-name')!.addEventListener('input', (ev) => {
    if (state.editing) {
      state.editing.name = (ev.target as HTMLInputElement).value;
      const save = panel.querySelector<HTMLButtonElement>('#mfc-edit-save')!;
      save.disabled = !state.editing.name.trim();
    }
  });
  panel.querySelector<HTMLTextAreaElement>('#mfc-edit-desc')!.addEventListener('input', (ev) => {
    if (state.editing) state.editing.description = (ev.target as HTMLTextAreaElement).value;
  });
  panel.querySelector<HTMLSelectElement>('#mfc-edit-type')!.addEventListener('change', (ev) => {
    if (state.editing) state.editing.routeType = (ev.target as HTMLSelectElement).value as RouteType;
  });
  if (state.editing) wireDifficultyPicker(panel, state.editing);
  if (state.editing) wirePhotoEditor(panel, state.editing, () => rerenderPanel());
  panel.querySelector<HTMLInputElement>('#mfc-edit-parking')?.addEventListener('change', (ev) => {
    if (state.editing) state.editing.hasParkingAtStart = (ev.target as HTMLInputElement).checked;
  });
  panel.querySelector<HTMLSelectElement>('#mfc-edit-folder')?.addEventListener('change', (ev) => {
    if (state.editing) state.editing.folderId = (ev.target as HTMLSelectElement).value;
  });
  panel.querySelector<HTMLInputElement>('#mfc-edit-shared')?.addEventListener('change', (ev) => {
    if (state.editing) state.editing.shared = (ev.target as HTMLInputElement).checked;
  });
}

function renderBuildPanel(panel: HTMLElement): void {
  const b = state.building!;
  const canSave = b.points.length >= 2 && b.name.trim().length > 0;
  const headerLabel = b.imported ? 'Importovaná trasa' : 'Nová trasa';
  const hint = b.imported
    ? 'Můžeš ještě přidat další body kliknutím do mapy.'
    : 'Klikni do mapy a přidávej body (start → průjezdy → cíl).';
  panel.innerHTML = `
    <div class="mfc-header">
      <div class="mfc-header-title"><span>${headerLabel}</span></div>
      <button class="mfc-iconbtn" id="mfc-cancel" title="Zrušit">${ICON.close}</button>
    </div>
    <div class="mfc-build-hint">${escape(hint)}</div>
    <div class="mfc-build-points">
      ${
        b.points.length === 0
          ? `<div class="mfc-empty">Zatím žádné body.</div>`
          : `<ol class="mfc-pointlist">${b.points
              .slice(0, 50)
              .map(
                (p, i) =>
                  `<li>${i + 1}. ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</li>`
              )
              .join('')}${b.points.length > 50 ? `<li>… +${b.points.length - 50} dalších</li>` : ''}</ol>`
      }
    </div>
    <div class="mfc-build-actions">
      <button class="mfc-secondary" id="mfc-undo" ${b.points.length === 0 ? 'disabled' : ''}>Vrátit poslední bod</button>
    </div>
    <div class="mfc-build-form">
      <label>Název <input type="text" id="mfc-name" value="${escape(b.name)}" placeholder="Název trasy"></label>
      <label>Popis
        <textarea id="mfc-desc" rows="3" placeholder="Volitelný popis...">${escape(b.description)}</textarea>
      </label>
      <div class="mfc-row">
        <label>Obtížnost
          ${renderDifficultyPicker(b)}
        </label>
        <label>Typ
          <select id="mfc-type">
            ${ROUTE_TYPES.map(
              (t) =>
                `<option value="${t.value}" ${t.value === b.routeType ? 'selected' : ''}>${escape(t.label)}</option>`
            ).join('')}
          </select>
        </label>
      </div>
      <label>Fotky</label>
      ${renderPhotoEditor(b)}
      ${
        state.folders.length > 0
          ? `<label>Složka
              <select id="mfc-folder">
                <option value="" ${b.folderId === '' ? 'selected' : ''}>Bez složky</option>
                ${state.folders
                  .map(
                    (f) =>
                      `<option value="${escape(f.id)}" ${f.id === b.folderId ? 'selected' : ''}>${escape(f.name)}</option>`
                  )
                  .join('')}
              </select>
            </label>`
          : ''
      }
      <label class="mfc-checkbox">
        <input type="checkbox" id="mfc-parking" ${b.hasParkingAtStart ? 'checked' : ''}>
        <span>Parkování u startu</span>
      </label>
    </div>
    <div class="mfc-build-error"></div>
    <button class="mfc-primary" id="mfc-save" ${canSave ? '' : 'disabled'}>Uložit trasu</button>
  `;

  panel.querySelector<HTMLButtonElement>('#mfc-cancel')!.addEventListener('click', cancelBuild);
  panel.querySelector<HTMLButtonElement>('#mfc-undo')!.addEventListener('click', undoLastPoint);
  panel.querySelector<HTMLButtonElement>('#mfc-save')!.addEventListener('click', () => void saveBuild());
  panel.querySelector<HTMLInputElement>('#mfc-name')!.addEventListener('input', (ev) => {
    if (state.building) {
      state.building.name = (ev.target as HTMLInputElement).value;
      const saveBtn = panel.querySelector<HTMLButtonElement>('#mfc-save')!;
      saveBtn.disabled = !(state.building.points.length >= 2 && state.building.name.trim().length > 0);
    }
  });
  panel.querySelector<HTMLTextAreaElement>('#mfc-desc')!.addEventListener('input', (ev) => {
    if (state.building) state.building.description = (ev.target as HTMLTextAreaElement).value;
  });
  panel.querySelector<HTMLSelectElement>('#mfc-type')!.addEventListener('change', (ev) => {
    if (state.building) {
      state.building.routeType = (ev.target as HTMLSelectElement).value as RouteType;
    }
  });
  if (state.building) {
    wireDifficultyPicker(panel, state.building, () => {
      lastKey = '';
      renderOverlay();
    });
    wirePhotoEditor(panel, state.building, () => rerenderPanel());
  }
  panel.querySelector<HTMLInputElement>('#mfc-parking')?.addEventListener('change', (ev) => {
    if (state.building) state.building.hasParkingAtStart = (ev.target as HTMLInputElement).checked;
  });
  panel.querySelector<HTMLSelectElement>('#mfc-folder')?.addEventListener('change', (ev) => {
    if (state.building) state.building.folderId = (ev.target as HTMLSelectElement).value;
  });
}

// -------- Map popup (route details) --------

const POPUP_ID = 'mapy-for-chrome-popup';

function getPopupContainer(): HTMLElement | null {
  return document.getElementById(POPUP_ID);
}

function ensurePopupContainer(): HTMLElement {
  let el = getPopupContainer();
  if (el) return el;
  el = document.createElement('div');
  el.id = POPUP_ID;
  document.documentElement.appendChild(el);
  return el;
}

function removePopupContainer(): void {
  const el = getPopupContainer();
  if (el) el.remove();
}

/** Set to true once the user drags the popup, so it stops auto-snapping to the marker. */
let popupUserPositioned = false;

function positionPopup(): void {
  if (!state.popup) return;
  if (popupUserPositioned) return;
  const container = getPopupContainer();
  if (!container) return;
  const popupId = state.popup.routeId;
  // Look up the route in personal routes first, then community routes.
  const personal = state.routes.find((r) => r.id === popupId);
  const community = !personal ? getCommunityRoute(popupId) : undefined;
  const routeForPos = personal ?? (community ? sharedToRouteView(community) : null);
  if (!routeForPos) return;
  const vp = currentViewport();
  if (!vp) return;
  const mapEl = getMapElement();
  if (!mapEl) return;
  const mapRect = mapEl.getBoundingClientRect();
  const centroid = getCachedRouteData(routeForPos).centroid;
  const screen = lonLatToScreen(centroid.lon, centroid.lat, vp);
  // Marker position in viewport coords.
  const markerX = mapRect.left + screen.x;
  const markerY = mapRect.top + screen.y;

  const popupW = container.offsetWidth || 340;
  const popupH = container.offsetHeight || 280;
  const GAP = 18; // distance between marker edge and popup
  const PAD = 8;  // viewport edge padding

  // Prefer right side of marker; flip to left if no room.
  let left = markerX + GAP;
  if (left + popupW > window.innerWidth - PAD) {
    left = markerX - GAP - popupW;
  }
  if (left < PAD) left = PAD;

  // Vertically center on the marker, clamp to viewport.
  let top = markerY - popupH / 2;
  if (top < PAD) top = PAD;
  if (top + popupH > window.innerHeight - PAD) {
    top = window.innerHeight - popupH - PAD;
  }
  container.style.left = `${Math.round(left)}px`;
  container.style.top = `${Math.round(top)}px`;
}

function renderPopup(): void {
  if (!state.popup) {
    removePopupContainer();
    popupUserPositioned = false;
    return;
  }
  const popupId = state.popup.routeId;
  let route = state.routes.find((r) => r.id === popupId);
  const community = !route ? getCommunityRoute(popupId) : undefined;
  if (!route && community) {
    route = sharedToRouteView(community);
  }
  if (!route) {
    state.popup = null;
    removePopupContainer();
    popupUserPositioned = false;
    return;
  }
  const isCommunity = Boolean(community);
  const existing = getPopupContainer();
  const isNew = !existing;
  if (isNew) popupUserPositioned = false; // reset when popup is freshly created
  const container = ensurePopupContainer();

  const color = routeDisplayColor(route);
  const stats = renderStatsLine(route);
  const desc = route.description
    ? `<div class="mfc-popup-desc">${escape(route.description)}</div>`
    : '';

  function fmtPoint(label: string | undefined, point: LonLat): string {
    if (label && label.trim()) return escape(label);
    return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  }

  const isLoop = route.shape === 'loop';
  const startTxt = fmtPoint(route.startLabel, route.start);
  const endTxt = fmtPoint(route.endLabel, route.end);

  const pointsHtml = isLoop
    ? `<div class="mfc-points">
         <div class="mfc-point">
           <span class="mfc-point-icon mfc-point-icon-loop">${ICON.pin}</span>
           <div class="mfc-point-text">
             <div class="mfc-point-label">Start a cíl</div>
             <div class="mfc-point-value">${startTxt}</div>
           </div>
         </div>
       </div>`
    : `<div class="mfc-points">
         <div class="mfc-point">
           <span class="mfc-point-icon mfc-point-icon-start">${ICON.pin}</span>
           <div class="mfc-point-text">
             <div class="mfc-point-label">Start</div>
             <div class="mfc-point-value">${startTxt}</div>
           </div>
         </div>
         <div class="mfc-point">
           <span class="mfc-point-icon mfc-point-icon-end">${ICON.flag}</span>
           <div class="mfc-point-text">
             <div class="mfc-point-label">Cíl</div>
             <div class="mfc-point-value">${endTxt}</div>
           </div>
         </div>
       </div>`;

  const shapeBadge = route.shape
    ? `<span class="mfc-meta-badge" title="Charakter trasy">${shapeIcon(route.shape)}<span>${escape(ROUTE_SHAPE_LABELS[route.shape])}</span></span>`
    : '';
  const parkingBadge = route.hasParkingAtStart
    ? `<span class="mfc-meta-badge mfc-meta-parking" title="Parkování u startu">${ICON.parking}<span>Parkování</span></span>`
    : '';
  const metaRow =
    shapeBadge || parkingBadge
      ? `<div class="mfc-popup-meta">${shapeBadge}${parkingBadge}</div>`
      : '';

  const photos = route.photos && route.photos.length > 0
    ? `<div class="mfc-popup-photos">${route.photos
        .map((p, i) => `<img class="mfc-popup-photo" src="${escape(p)}" data-photo-idx="${i}" alt="Foto ${i + 1}">`)
        .join('')}</div>`
    : '';

  const chart =
    route.elevationProfile && route.elevationProfile.length >= 2
      ? `<div class="mfc-popup-chart">
           <div class="mfc-popup-chart-title">Výškový profil</div>
           ${renderElevationChart(route.elevationProfile, color)}
         </div>`
      : '';

  // Privacy: community routes deliberately do not name their uploader.
  const ownerByline = isCommunity
    ? '<div class="mfc-popup-owner">Sdíleno komunitou</div>'
    : '';

  const voteHtml = community
    ? `<div class="mfc-popup-votes">
         <button class="mfc-vote mfc-vote-up${community.myVote === 'like' ? ' mfc-vote-active' : ''}" data-vote="like" title="Líbí se mi">${ICON.thumbsUp}<span>${community.likeCount}</span></button>
         <button class="mfc-vote mfc-vote-down${community.myVote === 'dislike' ? ' mfc-vote-active' : ''}" data-vote="dislike" title="Nelíbí se mi">${ICON.thumbsDown}<span>${community.dislikeCount}</span></button>
       </div>`
    : '';

  const actionsHtml = isCommunity
    ? `<button class="mfc-primary mfc-primary-wide" id="mfc-popup-open">${ICON.external}<span>Otevřít na mapy.com</span></button>`
    : `<button class="mfc-primary mfc-primary-wide" id="mfc-popup-open">${ICON.external}<span>Otevřít na mapy.com</span></button>
       <div class="mfc-popup-actions-row">
         <button class="mfc-secondary mfc-popup-secondary" id="mfc-popup-edit">${ICON.edit}<span>Upravit</span></button>
         <button class="mfc-secondary mfc-popup-secondary mfc-danger" id="mfc-popup-delete">${ICON.trash}<span>Smazat</span></button>
       </div>`;

  container.innerHTML = `
    <div class="mfc-popup-card${isCommunity ? ' mfc-popup-community' : ''}" style="--mfc-route-color: ${escape(color)}">
      <div class="mfc-popup-header">
        <span class="mfc-popup-accent"></span>
        <span class="mfc-popup-drag" title="Přetáhněte pro posun" aria-hidden="true">${ICON.drag}</span>
        <span class="mfc-popup-title">${escape(route.name)}</span>
        <button class="mfc-iconbtn" id="mfc-popup-close" title="Zavřít">${ICON.close}</button>
      </div>
      <div class="mfc-popup-body">
        ${ownerByline}
        ${pointsHtml}
        ${metaRow}
        ${desc}
        ${stats ? `<div class="mfc-popup-stats">${stats}</div>` : ''}
        ${chart}
        ${photos}
        ${voteHtml}
      </div>
      <div class="mfc-popup-actions">
        ${actionsHtml}
      </div>
    </div>
  `;

  const finalRoute = route;
  container.querySelector<HTMLButtonElement>('#mfc-popup-close')!.addEventListener('click', closePopup);
  container.querySelector<HTMLButtonElement>('#mfc-popup-open')!.addEventListener('click', () => {
    // For community routes we always rebuild the URL from the route's
    // coordinates — never trust the stored shareUrl, since older uploads may
    // contain the owner's private `mapy.com/s/<code>` link that fails for
    // anyone else.
    const openUrl = community ? publicMapyUrlForCommunity(community) : finalRoute.shareUrl;
    if (openUrl) window.location.assign(openUrl);
  });
  if (!isCommunity) {
    container
      .querySelector<HTMLButtonElement>('#mfc-popup-edit')
      ?.addEventListener('click', () => startEdit(finalRoute));
    container
      .querySelector<HTMLButtonElement>('#mfc-popup-delete')
      ?.addEventListener('click', () => void deleteRouteFromUi(finalRoute.id));
  }

  if (community) {
    container.querySelectorAll<HTMLButtonElement>('.mfc-vote').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.vote === 'like' ? 'like' : 'dislike';
        void castVoteUi(community, target as 'like' | 'dislike');
      });
    });
  }

  // Photo click → open full-size in new tab as data URL.
  container.querySelectorAll<HTMLImageElement>('.mfc-popup-photo').forEach((img) => {
    img.addEventListener('click', () => {
      const w = window.open();
      if (w && img.src) {
        w.document.write(
          `<title>${escape(route.name)}</title><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="${escape(img.src)}" style="max-width:100vw;max-height:100vh"></body>`
        );
      }
    });
  });

  // Drag-to-move from the popup header.
  const header = container.querySelector<HTMLElement>('.mfc-popup-header');
  if (header) makePopupDraggable(container, header);

  positionPopup();
}

function makePopupDraggable(popup: HTMLElement, handle: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    // Ignore drags that begin on an interactive element inside the header (close button).
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = popup.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e: MouseEvent): void {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    popup.style.left = `${Math.round(startLeft + dx)}px`;
    popup.style.top = `${Math.round(startTop + dy)}px`;
    popupUserPositioned = true;
  }
  function onUp(): void {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

// -------- Main-world bridge (importable routes) --------

function watchMainWorld(): void {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data as { source?: string; type?: string; data?: unknown } | undefined;
    if (!d || d.source !== 'mfc-mainworld') return;
    if (d.type === 'captured') {
      const captured = d.data as ImportableRoute | null;
      if (captured && Array.isArray(captured.points) && captured.points.length >= 2) {
        state.importable = captured;
      } else {
        state.importable = null;
      }
      rerenderPanel();
    }
  });
  // Ask for any route captured before our listener was set up.
  window.postMessage({ source: 'mfc-isolated', type: 'getCaptured' }, '*');
}

// -------- Storage change listener --------

function watchStorage(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      !changes.user &&
      !changes.routes &&
      !changes.folders &&
      !changes.showOnMap &&
      !changes.communityRoutes
    ) {
      return;
    }
    void (async () => {
      await loadFromStorage();
      rerenderPanel();
      lastKey = '';
      renderOverlay();
      renderPopup();
    })();
  });
}

// -------- Boot --------

async function boot(): Promise<void> {
  initSidePanel();
  watchStorage();
  watchMainWorld();
  await loadFromStorage();
  requestAnimationFrame(watcherLoop);
}

void boot();
