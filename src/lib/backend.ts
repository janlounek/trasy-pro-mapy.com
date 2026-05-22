import type { LonLat, RouteVote, SavedRoute, SharedRoute } from './types';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/+$/, '');

export function isBackendConfigured(): boolean {
  return BACKEND_URL.length > 0;
}

export function getBackendUrl(): string {
  return BACKEND_URL;
}

/**
 * Build a mapy.com URL that anyone can open. The /fnc/v1/route format is
 * documented and stateless — it carries the route inside its query string,
 * unlike `mapy.com/s/<code>` / `?dim=…` URLs which point to server-stored
 * data the owner hasn't actually shared.
 */
export function buildPublicMapyUrl(
  start: LonLat,
  waypoints: LonLat[],
  end: LonLat,
  routeType: string
): string {
  const u = new URL('https://mapy.com/fnc/v1/route');
  u.searchParams.set('start', `${start.lon},${start.lat}`);
  u.searchParams.set('end', `${end.lon},${end.lat}`);
  u.searchParams.set('routeType', routeType);
  if (waypoints.length > 0) {
    u.searchParams.set(
      'waypoints',
      waypoints.map((w) => `${w.lon},${w.lat}`).join(';')
    );
  }
  return u.toString();
}

/** Build the JSON payload for uploading a route to the community backend. */
function sharedPayload(route: SavedRoute): Record<string, unknown> {
  // Always use a public, stateless mapy.com URL — never the owner's
  // private `mapy.com/s/<code>` / `?dim=…` link.
  const publicShareUrl = buildPublicMapyUrl(
    route.start,
    route.waypoints,
    route.end,
    route.routeType
  );
  return {
    id: route.id,
    name: route.name,
    description: route.description ?? null,
    shareUrl: publicShareUrl,
    difficulty: route.difficulty ?? null,
    routeType: route.routeType,
    geometry: route.geometry ?? null,
    start: route.start,
    end: route.end,
    startLabel: route.startLabel ?? null,
    endLabel: route.endLabel ?? null,
    distanceM: route.distanceM ?? null,
    durationS: route.durationS ?? null,
    durationEstimated: Boolean(route.durationEstimated),
    elevationGainM: route.elevationGainM ?? null,
    elevationLossM: route.elevationLossM ?? null,
    elevationProfile: route.elevationProfile ?? null,
    shape: route.shape ?? null,
    hasParkingAtStart: Boolean(route.hasParkingAtStart),
    createdAt: route.createdAt
  };
}

export async function uploadSharedRoute(
  route: SavedRoute,
  accessToken: string
): Promise<void> {
  if (!BACKEND_URL) throw new Error('Backend not configured');
  if (!accessToken) throw new Error('Missing access token');
  const res = await fetch(`${BACKEND_URL}/v1/routes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(sharedPayload(route))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Backend upload failed: ${res.status} ${text}`);
  }
}

export async function deleteSharedRoute(
  routeId: string,
  accessToken: string
): Promise<void> {
  if (!BACKEND_URL) return;
  if (!accessToken) throw new Error('Missing access token');
  const res = await fetch(
    `${BACKEND_URL}/v1/routes/${encodeURIComponent(routeId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  // 404 = already gone, treat as success.
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`Backend delete failed: ${res.status} ${text}`);
  }
}

export async function fetchSharedRoutes(
  since = 0,
  accessToken?: string
): Promise<SharedRoute[]> {
  if (!BACKEND_URL) return [];
  // Auth on GET is optional — when we send it, the response includes `myVote`
  // for each route so the UI can show the user's current like/dislike state.
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${BACKEND_URL}/v1/routes?since=${since}`, { headers });
  if (!res.ok) throw new Error(`Backend list failed: ${res.status}`);
  const j = (await res.json()) as { routes?: SharedRoute[] };
  return j.routes ?? [];
}

export interface VoteResult {
  likeCount: number;
  dislikeCount: number;
  myVote: RouteVote;
}

export async function voteOnSharedRoute(
  routeId: string,
  vote: RouteVote,
  accessToken: string
): Promise<VoteResult> {
  if (!BACKEND_URL) throw new Error('Backend not configured');
  if (!accessToken) throw new Error('Missing access token');
  const res = await fetch(
    `${BACKEND_URL}/v1/routes/${encodeURIComponent(routeId)}/vote`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ vote })
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vote failed: ${res.status} ${text}`);
  }
  const j = (await res.json()) as VoteResult;
  return j;
}
