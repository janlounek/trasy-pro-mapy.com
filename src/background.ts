import { login, refreshAccessToken } from './lib/seznam-oauth';
import {
  uploadSharedRoute,
  deleteSharedRoute,
  fetchSharedRoutes,
  voteOnSharedRoute,
  isBackendConfigured
} from './lib/backend';
import {
  fetchRoute,
  reverseGeocode,
  fetchElevation,
  elevationGainLoss
} from './lib/mapy-api';
import { parseShareUrl } from './lib/share-url';
import {
  pickIntermediates,
  polylineDistance,
  estimateDurationSec,
  cumulativeDistances,
  classifyRouteShape
} from './lib/route-distance';
import {
  getUser,
  setUser,
  saveRoute,
  getRoutes,
  deleteRoute,
  updateRoute,
  getFolders,
  saveFolder,
  updateFolder,
  deleteFolder,
  getAuth,
  setAuth
} from './lib/storage';
import type {
  Difficulty,
  ElevationPoint,
  LonLat,
  RouteFolder,
  RouteType,
  RouteVote,
  SavedRoute,
  SharedRoute
} from './lib/types';
import { DIFFICULTY_COLORS } from './lib/types';

interface GeoJsonGeometry {
  type?: string;
  coordinates?: unknown;
}

/** Parse a stored GeoJSON geometry string back into a coordinate array. */
function parseGeometryCoords(geometryStr: string | undefined): LonLat[] {
  if (!geometryStr) return [];
  try {
    const g = JSON.parse(geometryStr) as GeoJsonGeometry;
    if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
      const out: LonLat[] = [];
      for (const c of g.coordinates as unknown[]) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          out.push({ lon: c[0], lat: c[1] });
        }
      }
      return out;
    }
    if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
      const out: LonLat[] = [];
      for (const seg of g.coordinates as unknown[]) {
        if (!Array.isArray(seg)) continue;
        for (const c of seg) {
          if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
            out.push({ lon: c[0], lat: c[1] });
          }
        }
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return [];
}

interface ElevationResult {
  gainM?: number;
  lossM?: number;
  profile?: ElevationPoint[];
}

/**
 * Return a usable access token, refreshing if the stored one has expired
 * (within a 60 second skew). Returns null if no auth is stored or refresh fails.
 */
async function ensureAccessToken(): Promise<string | null> {
  const auth = await getAuth();
  if (!auth) return null;
  const now = Math.floor(Date.now() / 1000);
  if (auth.expiresAt > now + 60) return auth.accessToken;
  const refreshed = await refreshAccessToken(auth.refreshToken);
  if (!refreshed) {
    await setAuth(null);
    return null;
  }
  await setAuth(refreshed);
  return refreshed.accessToken;
}

/** Best-effort: push a route to the community backend. Logs but never throws. */
async function syncUploadShared(route: SavedRoute): Promise<void> {
  if (!isBackendConfigured()) return;
  const token = await ensureAccessToken();
  if (!token) return;
  try {
    await uploadSharedRoute(route, token);
  } catch (err) {
    console.warn('[Mapy+] uploadSharedRoute failed:', err);
  }
}

/** Best-effort: remove a route from the community backend. */
async function syncDeleteShared(routeId: string): Promise<void> {
  if (!isBackendConfigured()) return;
  const token = await ensureAccessToken();
  if (!token) return;
  try {
    await deleteSharedRoute(routeId, token);
  } catch (err) {
    console.warn('[Mapy+] deleteSharedRoute failed:', err);
  }
}

/** Fetch community routes and cache them in chrome.storage for content scripts. */
async function refreshCommunityRoutesCache(): Promise<SharedRoute[]> {
  if (!isBackendConfigured()) return [];
  try {
    // Send the access token (if we have one) so the response includes
    // `myVote` for each route.
    const token = await ensureAccessToken().catch(() => null);
    const routes = await fetchSharedRoutes(0, token ?? undefined);
    await chrome.storage.local.set({ communityRoutes: routes });
    return routes;
  } catch (err) {
    console.warn('[Mapy+] refreshCommunityRoutesCache failed:', err);
    return [];
  }
}

/**
 * Apply a vote change to the locally-cached community-route list so the UI
 * updates instantly, without waiting for the next periodic refresh.
 */
async function patchLocalVote(
  routeId: string,
  result: { likeCount: number; dislikeCount: number; myVote: RouteVote }
): Promise<void> {
  const o = await chrome.storage.local.get('communityRoutes');
  const list = (o.communityRoutes as SharedRoute[] | undefined) ?? [];
  let changed = false;
  for (const r of list) {
    if (r.id === routeId) {
      r.likeCount = result.likeCount;
      r.dislikeCount = result.dislikeCount;
      r.myVote = result.myVote;
      changed = true;
      break;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ communityRoutes: list });
  }
}

async function safeElevationStats(polyline: LonLat[]): Promise<ElevationResult> {
  if (polyline.length < 2) return {};
  try {
    // Sample up to 100 points by index, also keeping the original indices so we
    // can read the polyline's true cumulative distance at each sample.
    const N = Math.min(polyline.length, 100);
    const indices: number[] = [];
    const sampled: LonLat[] = [];
    const step = (polyline.length - 1) / (N - 1);
    for (let i = 0; i < N; i++) {
      const idx = Math.round(step * i);
      indices.push(idx);
      sampled.push(polyline[idx]);
    }
    const elevs = await fetchElevation(sampled);
    if (elevs.length < 2) return {};

    const cum = cumulativeDistances(polyline);
    const profile: ElevationPoint[] = [];
    for (let i = 0; i < elevs.length && i < indices.length; i++) {
      profile.push({
        distanceM: Math.round(cum[indices[i]] ?? 0),
        elevationM: Math.round(elevs[i].elevation)
      });
    }
    const stats = elevationGainLoss(elevs.map((e) => e.elevation));
    return { gainM: stats.gainM, lossM: stats.lossM, profile };
  } catch {
    return {}; // best-effort
  }
}

type RouteUpdates = {
  name?: string;
  color?: string;
  difficulty?: Difficulty;
  routeType?: RouteType;
  description?: string;
  photos?: string[];
  hasParkingAtStart?: boolean;
  folderId?: string | null;
  shared?: boolean;
};

type FolderUpdates = {
  name?: string;
};

/**
 * Returns true when the stored label looks like an entity-type fallback rather
 * than a real place name. Older rgeocode responses set `label` (e.g. "Adresa")
 * instead of `name`, so those routes need a fresh reverse-geocode lookup.
 */
function isGenericLabel(label: string | undefined): boolean {
  if (!label) return true;
  const c = label.trim().toLowerCase();
  return (
    c === '' ||
    c === 'adresa' ||
    c === 'address' ||
    c === 'poi' ||
    c === 'místo' ||
    c === 'misto' ||
    c === 'lokalita'
  );
}

type Msg =
  | { type: 'login' }
  | { type: 'logout' }
  | { type: 'getUser' }
  | { type: 'addRoute'; shareUrl: string; name: string; color: string }
  | {
      type: 'createRoute';
      name: string;
      color: string;
      difficulty?: Difficulty;
      routeType: RouteType;
      points: LonLat[];
      description?: string;
      photos?: string[];
      hasParkingAtStart?: boolean;
      folderId?: string;
    }
  | {
      type: 'importRoute';
      name: string;
      color: string;
      difficulty?: Difficulty;
      routeType: RouteType;
      points: LonLat[];
      pageUrl?: string;
      description?: string;
      photos?: string[];
      hasParkingAtStart?: boolean;
      folderId?: string;
    }
  | { type: 'getRoutes' }
  | { type: 'deleteRoute'; routeId: string }
  | { type: 'updateRoute'; routeId: string; updates: RouteUpdates }
  | { type: 'backfillRoute'; routeId: string }
  | { type: 'getFolders' }
  | { type: 'createFolder'; name: string }
  | { type: 'updateFolder'; folderId: string; updates: FolderUpdates }
  | { type: 'deleteFolder'; folderId: string }
  | { type: 'refreshCommunity' }
  | { type: 'voteRoute'; routeId: string; vote: RouteVote };

async function buildAndSaveRoute(opts: {
  name: string;
  color: string;
  difficulty?: Difficulty;
  routeType: RouteType;
  start: LonLat;
  end: LonLat;
  waypoints: LonLat[];
  shareUrl: string;
  oauthUserId: string;
  description?: string;
  photos?: string[];
  hasParkingAtStart?: boolean;
  folderId?: string;
}): Promise<SavedRoute> {
  const parsed = {
    start: opts.start,
    end: opts.end,
    waypoints: opts.waypoints,
    routeType: opts.routeType,
    raw: opts.shareUrl
  };
  const [routeData, startLabel, endLabel] = await Promise.all([
    fetchRoute(parsed),
    reverseGeocode(opts.start),
    reverseGeocode(opts.end)
  ]);
  // Sample the routed polyline for elevation. Falls back to input waypoints if
  // the geometry didn't parse.
  const polyline =
    parseGeometryCoords(routeData.geometry).length >= 2
      ? parseGeometryCoords(routeData.geometry)
      : [opts.start, ...opts.waypoints, opts.end];
  const elev = await safeElevationStats(polyline);
  const color = opts.difficulty ? DIFFICULTY_COLORS[opts.difficulty] : opts.color;
  const shape = classifyRouteShape(polyline);
  const route: SavedRoute = {
    id: crypto.randomUUID(),
    name: opts.name,
    color,
    difficulty: opts.difficulty,
    shareUrl: opts.shareUrl,
    start: opts.start,
    end: opts.end,
    waypoints: opts.waypoints,
    routeType: opts.routeType,
    startLabel,
    endLabel,
    distanceM: routeData.distanceM,
    durationS: routeData.durationS,
    durationEstimated: false,
    geometry: routeData.geometry,
    description: opts.description?.trim() || undefined,
    elevationGainM: elev.gainM,
    elevationLossM: elev.lossM,
    elevationProfile: elev.profile,
    photos: opts.photos && opts.photos.length > 0 ? opts.photos : undefined,
    shape,
    hasParkingAtStart: opts.hasParkingAtStart || undefined,
    folderId: opts.folderId || undefined,
    createdAt: Date.now()
  };
  await saveRoute(opts.oauthUserId, route);
  return route;
}

function buildShareUrl(points: LonLat[], routeType: RouteType): string {
  if (points.length < 2) return '';
  const start = points[0];
  const end = points[points.length - 1];
  const waypoints = points.slice(1, -1);
  const u = new URL('https://mapy.com/fnc/v1/route');
  u.searchParams.set('start', `${start.lon},${start.lat}`);
  u.searchParams.set('end', `${end.lon},${end.lat}`);
  u.searchParams.set('routeType', routeType);
  if (waypoints.length) {
    u.searchParams.set(
      'waypoints',
      waypoints.map((w) => `${w.lon},${w.lat}`).join(';')
    );
  }
  return u.toString();
}

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case 'login': {
      const result = await login();
      await setUser(result.user);
      await setAuth(result.auth);
      // Kick off a community-routes fetch after sign-in.
      void refreshCommunityRoutesCache();
      return { ok: true, user: result.user };
    }
    case 'logout': {
      await setUser(null);
      await setAuth(null);
      return { ok: true };
    }
    case 'getUser': {
      const u = await getUser();
      return { ok: true, user: u };
    }
    case 'addRoute': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const parsed = parseShareUrl(msg.shareUrl);
      if (!parsed) return { ok: false, error: 'Could not parse Mapy.cz share-URL' };
      const route = await buildAndSaveRoute({
        name: msg.name,
        color: msg.color,
        routeType: parsed.routeType,
        start: parsed.start,
        end: parsed.end,
        waypoints: parsed.waypoints,
        shareUrl: parsed.raw,
        oauthUserId: u.oauthUserId
      });
      return { ok: true, route };
    }
    case 'createRoute': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      if (!Array.isArray(msg.points) || msg.points.length < 2) {
        return { ok: false, error: 'Need at least 2 points' };
      }
      if (msg.points.length > 17) {
        return { ok: false, error: 'Click-to-build supports at most 17 points (start + 15 waypoints + end). Use Import for longer routes.' };
      }
      const start = msg.points[0];
      const end = msg.points[msg.points.length - 1];
      const waypoints = msg.points.slice(1, -1);
      const shareUrl = buildShareUrl(msg.points, msg.routeType);
      const route = await buildAndSaveRoute({
        name: msg.name,
        color: msg.color,
        difficulty: msg.difficulty,
        routeType: msg.routeType,
        start,
        end,
        waypoints,
        shareUrl,
        oauthUserId: u.oauthUserId,
        description: msg.description,
        photos: msg.photos,
        hasParkingAtStart: msg.hasParkingAtStart,
        folderId: msg.folderId
      });
      return { ok: true, route };
    }
    case 'importRoute': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      if (!Array.isArray(msg.points) || msg.points.length < 2) {
        return { ok: false, error: 'Need at least 2 points' };
      }
      const points = msg.points;
      const start = points[0];
      const end = points[points.length - 1];
      // For the share-URL fallback, sparsely sample at most 15 waypoints.
      const sparseWaypoints = pickIntermediates(points, 15);
      // Prefer the original mapy.com page URL if it references the route server-side
      // (contains `dim=...`). Falling back to a synthetic /fnc/v1/route URL loses
      // detours because we can only encode ≤15 waypoints there.
      const shareUrl =
        msg.pageUrl && msg.pageUrl.includes('dim=')
          ? msg.pageUrl
          : buildShareUrl([start, ...sparseWaypoints, end], msg.routeType);
      // Use the imported polyline directly as the geometry (no Routing API call).
      const geometry = JSON.stringify({
        type: 'LineString',
        coordinates: points.map((p) => [p.lon, p.lat])
      });
      const distanceM = polylineDistance(points);
      const [startLabel, endLabel, elev] = await Promise.all([
        reverseGeocode(start),
        reverseGeocode(end),
        safeElevationStats(points)
      ]);
      const color = msg.difficulty ? DIFFICULTY_COLORS[msg.difficulty] : msg.color;
      // Naismith-corrected duration when we know the climb.
      const durationS = estimateDurationSec(
        distanceM,
        msg.routeType,
        elev.gainM ?? 0,
        elev.lossM ?? 0
      );
      const shape = classifyRouteShape(points);
      const route: SavedRoute = {
        id: crypto.randomUUID(),
        name: msg.name,
        color,
        difficulty: msg.difficulty,
        shareUrl,
        start,
        end,
        waypoints: sparseWaypoints,
        routeType: msg.routeType,
        startLabel,
        endLabel,
        distanceM,
        durationS,
        durationEstimated: true,
        geometry,
        description: msg.description?.trim() || undefined,
        elevationGainM: elev.gainM,
        elevationLossM: elev.lossM,
        elevationProfile: elev.profile,
        photos: msg.photos && msg.photos.length > 0 ? msg.photos : undefined,
        shape,
        hasParkingAtStart: msg.hasParkingAtStart || undefined,
        folderId: msg.folderId || undefined,
        createdAt: Date.now()
      };
      await saveRoute(u.oauthUserId, route);
      return { ok: true, route };
    }
    case 'updateRoute': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const updates: Partial<SavedRoute> = {};
      if (typeof msg.updates.name === 'string') updates.name = msg.updates.name.trim();
      if (typeof msg.updates.routeType === 'string') updates.routeType = msg.updates.routeType;
      if (msg.updates.difficulty) {
        updates.difficulty = msg.updates.difficulty;
        updates.color = DIFFICULTY_COLORS[msg.updates.difficulty];
      } else if (typeof msg.updates.color === 'string') {
        updates.color = msg.updates.color;
      }
      if (typeof msg.updates.description === 'string') {
        const trimmed = msg.updates.description.trim();
        updates.description = trimmed.length > 0 ? trimmed : undefined;
      }
      if (Array.isArray(msg.updates.photos)) {
        updates.photos = msg.updates.photos.length > 0 ? msg.updates.photos : undefined;
      }
      if (typeof msg.updates.hasParkingAtStart === 'boolean') {
        updates.hasParkingAtStart = msg.updates.hasParkingAtStart || undefined;
      }
      if (msg.updates.folderId !== undefined) {
        // null or empty string means "no folder"
        updates.folderId =
          typeof msg.updates.folderId === 'string' && msg.updates.folderId
            ? msg.updates.folderId
            : undefined;
      }
      // Track the previous shared state so we know whether to upload or delete
      // from the backend.
      const existingRoutes = await getRoutes(u.oauthUserId);
      const prev = existingRoutes.find((r) => r.id === msg.routeId);
      const wasShared = prev?.shared === true;
      let nowShared = wasShared;
      if (typeof msg.updates.shared === 'boolean') {
        updates.shared = msg.updates.shared;
        nowShared = msg.updates.shared;
      }
      const updated = await updateRoute(u.oauthUserId, msg.routeId, updates);
      if (!updated) return { ok: false, error: 'Route not found' };
      // Sync with the community backend. Best-effort — failures don't block the UI.
      if (nowShared) {
        void syncUploadShared(updated);
      } else if (wasShared) {
        void syncDeleteShared(updated.id);
      }
      return { ok: true, route: updated };
    }
    case 'getFolders': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const folders = await getFolders(u.oauthUserId);
      return { ok: true, folders };
    }
    case 'createFolder': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const trimmed = msg.name?.trim() ?? '';
      if (!trimmed) return { ok: false, error: 'Folder name is required' };
      const folder: RouteFolder = {
        id: crypto.randomUUID(),
        name: trimmed,
        createdAt: Date.now()
      };
      await saveFolder(u.oauthUserId, folder);
      return { ok: true, folder };
    }
    case 'updateFolder': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const updates: Partial<RouteFolder> = {};
      if (typeof msg.updates.name === 'string') {
        const trimmed = msg.updates.name.trim();
        if (!trimmed) return { ok: false, error: 'Folder name is required' };
        updates.name = trimmed;
      }
      const updated = await updateFolder(u.oauthUserId, msg.folderId, updates);
      if (!updated) return { ok: false, error: 'Folder not found' };
      return { ok: true, folder: updated };
    }
    case 'deleteFolder': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      await deleteFolder(u.oauthUserId, msg.folderId);
      // Move every route that was in this folder back to "unfiled".
      const routes = await getRoutes(u.oauthUserId);
      for (const r of routes) {
        if (r.folderId === msg.folderId) {
          await updateRoute(u.oauthUserId, r.id, { folderId: undefined });
        }
      }
      return { ok: true };
    }
    case 'backfillRoute': {
      // Recompute any missing distance/duration/elevation for a route saved
      // before those fields existed. Doesn't overwrite anything already set.
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const routes = await getRoutes(u.oauthUserId);
      const route = routes.find((r) => r.id === msg.routeId);
      if (!route) return { ok: false, error: 'Route not found' };

      const polyline =
        parseGeometryCoords(route.geometry).length >= 2
          ? parseGeometryCoords(route.geometry)
          : [route.start, ...route.waypoints, route.end];

      const updates: Partial<SavedRoute> = {};
      if (!route.distanceM && polyline.length >= 2) {
        updates.distanceM = polylineDistance(polyline);
      }

      // Refetch elevation only if we have nothing stored yet.
      let elevGain = route.elevationGainM;
      let elevLoss = route.elevationLossM;
      if (
        elevGain === undefined &&
        elevLoss === undefined &&
        (!route.elevationProfile || route.elevationProfile.length < 2)
      ) {
        const elev = await safeElevationStats(polyline);
        if (elev.gainM !== undefined) {
          updates.elevationGainM = elev.gainM;
          elevGain = elev.gainM;
        }
        if (elev.lossM !== undefined) {
          updates.elevationLossM = elev.lossM;
          elevLoss = elev.lossM;
        }
        if (elev.profile && elev.profile.length >= 2) {
          updates.elevationProfile = elev.profile;
        }
      }

      // Recompute duration if it was missing, OR if it was a flat-speed estimate
      // and we now have elevation data that would change the answer.
      const effectiveDistance = updates.distanceM ?? route.distanceM;
      const isFootRoute =
        route.routeType === 'foot_hiking' || route.routeType === 'foot_fast';
      const hasElevation = elevGain !== undefined || elevLoss !== undefined;
      const shouldRecomputeDuration =
        !route.durationS ||
        (route.durationEstimated && isFootRoute && hasElevation);

      if (shouldRecomputeDuration && effectiveDistance) {
        const newDur = estimateDurationSec(
          effectiveDistance,
          route.routeType,
          elevGain ?? 0,
          elevLoss ?? 0
        );
        if (newDur !== route.durationS) {
          updates.durationS = newDur;
          updates.durationEstimated = true;
        }
      }

      // Always re-run shape classification — the algorithm was buggy in earlier
      // builds (return-to-start trails were tagged as 'loop' even when they
      // retraced themselves). Updates only when the result actually changes.
      if (polyline.length >= 4) {
        const newShape = classifyRouteShape(polyline);
        if (newShape !== route.shape) {
          updates.shape = newShape;
        }
      }

      // Refresh place labels if they were stored as the entity type ("Adresa"
      // etc.) rather than the actual place name.
      if (isGenericLabel(route.startLabel)) {
        const fresh = await reverseGeocode(route.start);
        if (fresh && fresh !== route.startLabel) updates.startLabel = fresh;
      }
      if (isGenericLabel(route.endLabel)) {
        const fresh = await reverseGeocode(route.end);
        if (fresh && fresh !== route.endLabel) updates.endLabel = fresh;
      }

      if (Object.keys(updates).length === 0) {
        return { ok: true, route, unchanged: true };
      }
      const updated = await updateRoute(u.oauthUserId, msg.routeId, updates);
      return { ok: true, route: updated ?? route };
    }
    case 'getRoutes': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const routes = await getRoutes(u.oauthUserId);
      return { ok: true, routes };
    }
    case 'deleteRoute': {
      const u = await getUser();
      if (!u) return { ok: false, error: 'not_logged_in' };
      const existing = await getRoutes(u.oauthUserId);
      const prev = existing.find((r) => r.id === msg.routeId);
      await deleteRoute(u.oauthUserId, msg.routeId);
      if (prev?.shared) void syncDeleteShared(msg.routeId);
      return { ok: true };
    }
    case 'refreshCommunity': {
      const routes = await refreshCommunityRoutesCache();
      return { ok: true, routes };
    }
    case 'voteRoute': {
      if (!isBackendConfigured()) return { ok: false, error: 'backend_disabled' };
      const token = await ensureAccessToken();
      if (!token) return { ok: false, error: 'not_logged_in' };
      try {
        const result = await voteOnSharedRoute(msg.routeId, msg.vote, token);
        await patchLocalVote(msg.routeId, result);
        return { ok: true, ...result };
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        return { ok: false, error: m };
      }
    }
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error: message });
    });
  return true;
});

// ---- Periodic community-routes refresh ----

const COMMUNITY_ALARM = 'mfc:refreshCommunity';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(COMMUNITY_ALARM, {
    delayInMinutes: 0.5,
    periodInMinutes: 5
  });
  void refreshCommunityRoutesCache();
});

chrome.runtime.onStartup.addListener(() => {
  // Ensure the alarm exists after a browser restart.
  chrome.alarms.get(COMMUNITY_ALARM, (a) => {
    if (!a) {
      chrome.alarms.create(COMMUNITY_ALARM, {
        delayInMinutes: 0.5,
        periodInMinutes: 5
      });
    }
  });
  void refreshCommunityRoutesCache();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COMMUNITY_ALARM) {
    void refreshCommunityRoutesCache();
  }
});
