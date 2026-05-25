export type RouteType =
  | 'car_fast'
  | 'car_fast_traffic'
  | 'car_short'
  | 'foot_fast'
  | 'foot_hiking'
  | 'bike_road'
  | 'bike_mountain';

export interface LonLat {
  lon: number;
  lat: number;
}

export interface ParsedShareUrl {
  start: LonLat;
  end: LonLat;
  waypoints: LonLat[];
  routeType: RouteType;
  raw: string;
}

/** Route difficulty — drives the route's display color (green/red/black). */
export type Difficulty = 'green' | 'red' | 'black';

export const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  // Deep forest green — intentionally NOT Seznam's bright #1EAE00.
  green: '#1f5132',
  red: '#e25555',
  black: '#1a1a1a'
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  green: 'Lehká',
  red: 'Střední',
  black: 'Těžká'
};

/** A single elevation sample with cumulative distance from the route start. */
export interface ElevationPoint {
  distanceM: number;
  elevationM: number;
}

/**
 * Topological shape of the route.
 *  - loop:         start ≈ end, you return where you started
 *  - out-and-back: you walk the same path in both directions
 *  - one-way:      A → B, start and end are different places
 */
export type RouteShape = 'loop' | 'out-and-back' | 'one-way';

export const ROUTE_SHAPE_LABELS: Record<RouteShape, string> = {
  loop: 'Okruh',
  'out-and-back': 'Tam a zpět',
  'one-way': 'Jednosměrná'
};

export interface SavedRoute {
  id: string;
  name: string;
  color: string;
  /** Newer routes use difficulty; color above is derived from it (kept for legacy routes). */
  difficulty?: Difficulty;
  shareUrl: string;
  start: LonLat;
  end: LonLat;
  waypoints: LonLat[];
  routeType: RouteType;
  startLabel?: string;
  endLabel?: string;
  distanceM?: number;
  durationS?: number;
  /** Whether durationS is an estimate (Haversine + speed) rather than from the routing API. */
  durationEstimated?: boolean;
  geometry?: string;
  description?: string;
  elevationGainM?: number;
  elevationLossM?: number;
  /** Sampled elevation series for the elevation-profile chart (≤100 points). */
  elevationProfile?: ElevationPoint[];
  /** Inline photos as base64 data URLs (already resized client-side). */
  photos?: string[];
  /** Topological shape (loop / out-and-back / one-way), classified from the polyline. */
  shape?: RouteShape;
  /** Is there parking at the start of the route? Used as a hiking-route indicator. */
  hasParkingAtStart?: boolean;
  /** ID of the folder this route belongs to (undefined = unfiled). */
  folderId?: string;
  /** Whether this route is shared to the community backend. */
  shared?: boolean;
  createdAt: number;
  updatedAt?: number;
}

/** A "like" or "dislike" vote on a shared route. */
export type RouteVote = 'like' | 'dislike' | null;

/** Read-only route from the community backend (someone else's shared route). */
export interface SharedRoute {
  id: string;
  /**
   * Always null on responses from the current backend — kept for back-compat
   * with older bundles that may have cached community routes from when the
   * field carried the raw oauth_user_id.
   */
  ownerId: string | null;
  /**
   * Server-set: true only when the authenticated requester is this route's
   * owner. Lets the client de-duplicate its own routes from the community
   * view without the server having to leak a stable per-uploader identifier.
   */
  isMine?: boolean;
  ownerName: string | null;
  name: string;
  description: string | null;
  shareUrl: string | null;
  difficulty: Difficulty | null;
  routeType: RouteType;
  geometry: string | null;
  start: LonLat;
  end: LonLat;
  startLabel: string | null;
  endLabel: string | null;
  distanceM: number | null;
  durationS: number | null;
  durationEstimated: boolean;
  elevationGainM: number | null;
  elevationLossM: number | null;
  elevationProfile: ElevationPoint[] | null;
  shape: RouteShape | null;
  hasParkingAtStart: boolean;
  /** Total upvotes across all users. */
  likeCount: number;
  /** Total downvotes across all users. */
  dislikeCount: number;
  /** The current user's vote on this route, if any. */
  myVote: RouteVote;
  createdAt: number;
  updatedAt: number;
}

/** Cached Seznam OAuth credentials. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds at which `accessToken` expires. */
  expiresAt: number;
}

/** A user-defined grouping of routes shown as a collapsible section. */
export interface RouteFolder {
  id: string;
  name: string;
  createdAt: number;
}

/** Returns the colour to use when rendering a route. */
export function routeDisplayColor(r: Pick<SavedRoute, 'color' | 'difficulty'>): string {
  if (r.difficulty) return DIFFICULTY_COLORS[r.difficulty];
  return r.color;
}

export interface User {
  /**
   * Stable Seznam identifier for this user. The only piece of OAuth-returned
   * identity we keep — `email`, `firstname`, and `lastname` are deliberately
   * discarded after the OAuth exchange to minimise PII storage and exposure.
   */
  oauthUserId: string;
}
