/**
 * Mapy for Chrome — shared routes backend (Cloudflare Worker + D1).
 *
 * Endpoints:
 *   GET    /v1/routes              List every shared route (public).
 *   POST   /v1/routes              Create/update a shared route (auth required).
 *   DELETE /v1/routes/:id          Delete a shared route (auth required, owner only).
 *
 * Auth: the client passes the Seznam OAuth access token as `Authorization:
 *       Bearer <token>`. We verify by calling Seznam's userinfo endpoint and
 *       cache the result in D1 for 15 minutes so we don't hammer login.szn.cz.
 */

interface Env {
  DB: D1Database;
}

interface SharedRouteRow {
  id: string;
  owner_id: string;
  owner_name: string | null;
  name: string;
  description: string | null;
  share_url: string | null;
  difficulty: string | null;
  route_type: string;
  geometry: string | null;
  start_lon: number;
  start_lat: number;
  end_lon: number;
  end_lat: number;
  start_label: string | null;
  end_label: string | null;
  distance_m: number | null;
  duration_s: number | null;
  duration_estimated: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  elevation_profile: string | null;
  shape: string | null;
  has_parking_at_start: number | null;
  like_count: number | null;
  dislike_count: number | null;
  created_at: number;
  updated_at: number;
  /** Set by the LEFT JOIN against route_votes when an authenticated GET runs. */
  my_vote?: number | null;
}

interface VerifiedUser {
  oauthUserId: string;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyToken(token: string, env: Env): Promise<VerifiedUser | null> {
  const hash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  const cached = await env.DB.prepare(
    'SELECT oauth_user_id FROM token_cache WHERE token_hash = ? AND expires_at > ?'
  )
    .bind(hash, now)
    .first<{ oauth_user_id: string }>();
  if (cached) {
    return { oauthUserId: cached.oauth_user_id };
  }

  try {
    const res = await fetch('https://login.szn.cz/api/v1/user', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    // Privacy: only consume `oauth_user_id` from the userinfo response. The
    // identity scope returns email + firstname + lastname automatically, but
    // we deliberately discard them — we never want to persist or share PII.
    const u = (await res.json()) as { oauth_user_id?: string };
    if (!u.oauth_user_id) return null;

    // Cache for 15 minutes (well within Seznam's usual 1h access-token lifetime).
    const expires = now + 15 * 60;
    await env.DB.prepare(
      'INSERT OR REPLACE INTO token_cache (token_hash, oauth_user_id, user_name, expires_at) VALUES (?, ?, NULL, ?)'
    )
      .bind(hash, u.oauth_user_id, expires)
      .run();

    // Opportunistically drop expired cache rows.
    await env.DB.prepare('DELETE FROM token_cache WHERE expires_at < ?').bind(now).run();

    return { oauthUserId: u.oauth_user_id };
  } catch {
    return null;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin?.startsWith('chrome-extension://') ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(
  data: unknown,
  init: { status?: number; cors: Record<string, string> }
): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.cors }
  });
}

async function getUserFromAuth(req: Request, env: Env): Promise<VerifiedUser | null> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  return verifyToken(token, env);
}

function rowToRoute(row: SharedRouteRow): unknown {
  return {
    id: row.id,
    ownerId: row.owner_id,
    // Privacy: owner_name is no longer surfaced. Field kept for back-compat
    // with older client builds that read it; always null.
    ownerName: null,
    name: row.name,
    description: row.description,
    shareUrl: row.share_url,
    difficulty: row.difficulty,
    routeType: row.route_type,
    geometry: row.geometry,
    start: { lon: row.start_lon, lat: row.start_lat },
    end: { lon: row.end_lon, lat: row.end_lat },
    startLabel: row.start_label,
    endLabel: row.end_label,
    distanceM: row.distance_m,
    durationS: row.duration_s,
    durationEstimated: row.duration_estimated === 1,
    elevationGainM: row.elevation_gain_m,
    elevationLossM: row.elevation_loss_m,
    elevationProfile: row.elevation_profile
      ? safeParse(row.elevation_profile)
      : null,
    shape: row.shape,
    hasParkingAtStart: row.has_parking_at_start === 1,
    likeCount: row.like_count ?? 0,
    dislikeCount: row.dislike_count ?? 0,
    myVote:
      row.my_vote === 1 ? 'like' : row.my_vote === -1 ? 'dislike' : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function listRoutes(
  env: Env,
  since: number,
  voterId: string | null
): Promise<unknown[]> {
  if (voterId) {
    const res = await env.DB.prepare(
      `SELECT sr.*, rv.vote AS my_vote
       FROM shared_routes sr
       LEFT JOIN route_votes rv
         ON rv.route_id = sr.id AND rv.voter_id = ?
       WHERE sr.updated_at >= ?
       ORDER BY sr.updated_at DESC
       LIMIT 500`
    )
      .bind(voterId, since)
      .all<SharedRouteRow>();
    return (res.results ?? []).map(rowToRoute);
  }
  const res = await env.DB.prepare(
    'SELECT * FROM shared_routes WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 500'
  )
    .bind(since)
    .all<SharedRouteRow>();
  return (res.results ?? []).map(rowToRoute);
}

/**
 * Cast or change a user's vote on a route.
 *   vote: 1   → like
 *   vote: -1  → dislike
 *   vote: 0   → remove existing vote
 */
async function castVote(
  env: Env,
  user: VerifiedUser,
  routeId: string,
  vote: 1 | -1 | 0
): Promise<{ ok: true; likeCount: number; dislikeCount: number; myVote: 'like' | 'dislike' | null } | { error: string; status: number }> {
  const existsRow = await env.DB.prepare(
    'SELECT id FROM shared_routes WHERE id = ?'
  )
    .bind(routeId)
    .first<{ id: string }>();
  if (!existsRow) return { error: 'route_not_found', status: 404 };

  const prior = await env.DB.prepare(
    'SELECT vote FROM route_votes WHERE route_id = ? AND voter_id = ?'
  )
    .bind(routeId, user.oauthUserId)
    .first<{ vote: number }>();
  const priorVote = prior?.vote ?? 0;

  // Compute deltas for the counter columns.
  let likeDelta = 0;
  let dislikeDelta = 0;
  if (priorVote === 1) likeDelta -= 1;
  if (priorVote === -1) dislikeDelta -= 1;
  if (vote === 1) likeDelta += 1;
  if (vote === -1) dislikeDelta += 1;

  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];

  if (vote === 0) {
    if (priorVote !== 0) {
      statements.push(
        env.DB.prepare(
          'DELETE FROM route_votes WHERE route_id = ? AND voter_id = ?'
        ).bind(routeId, user.oauthUserId)
      );
    }
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO route_votes (route_id, voter_id, vote, voted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(route_id, voter_id) DO UPDATE SET
           vote = excluded.vote,
           voted_at = excluded.voted_at`
      ).bind(routeId, user.oauthUserId, vote, now)
    );
  }

  if (likeDelta !== 0 || dislikeDelta !== 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE shared_routes
         SET like_count = MAX(0, like_count + ?),
             dislike_count = MAX(0, dislike_count + ?)
         WHERE id = ?`
      ).bind(likeDelta, dislikeDelta, routeId)
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  const updated = await env.DB.prepare(
    'SELECT like_count, dislike_count FROM shared_routes WHERE id = ?'
  )
    .bind(routeId)
    .first<{ like_count: number; dislike_count: number }>();

  return {
    ok: true,
    likeCount: updated?.like_count ?? 0,
    dislikeCount: updated?.dislike_count ?? 0,
    myVote: vote === 1 ? 'like' : vote === -1 ? 'dislike' : null
  };
}

// ---- Input limits (defense against DoS via oversized uploads) ----

const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_NAME_LEN = 200;
const MAX_DESC_LEN = 4000;
const MAX_GEOMETRY_LEN = 256 * 1024; // 256 KB (JSON-encoded GeoJSON LineString)
const MAX_ELEVATION_POINTS = 300;
const MAX_ID_LEN = 64;
const MAX_LABEL_LEN = 256;
const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function strLen(v: unknown): number {
  return typeof v === 'string' ? v.length : 0;
}

function validateUploadPayload(
  body: Record<string, unknown>
): { ok: true } | { error: string; status: number } {
  const id = String(body.id ?? '');
  if (id.length === 0 || id.length > MAX_ID_LEN || !ID_REGEX.test(id)) {
    return { error: 'invalid_id', status: 400 };
  }
  const name = String(body.name ?? '').trim();
  if (name.length === 0 || name.length > MAX_NAME_LEN) {
    return { error: 'invalid_name', status: 400 };
  }
  const routeType = String(body.routeType ?? '');
  if (routeType.length === 0 || routeType.length > MAX_LABEL_LEN) {
    return { error: 'invalid_routeType', status: 400 };
  }
  if (strLen(body.description) > MAX_DESC_LEN) {
    return { error: 'description_too_long', status: 413 };
  }
  if (strLen(body.geometry) > MAX_GEOMETRY_LEN) {
    return { error: 'geometry_too_long', status: 413 };
  }
  if (
    Array.isArray(body.elevationProfile) &&
    body.elevationProfile.length > MAX_ELEVATION_POINTS
  ) {
    return { error: 'elevation_profile_too_long', status: 413 };
  }
  const labelFields = ['shareUrl', 'startLabel', 'endLabel', 'shape', 'difficulty'] as const;
  for (const f of labelFields) {
    if (strLen(body[f]) > MAX_LABEL_LEN) {
      return { error: `${f}_too_long`, status: 413 };
    }
  }
  const start = body.start as { lon?: unknown; lat?: unknown } | undefined;
  const end = body.end as { lon?: unknown; lat?: unknown } | undefined;
  const startLon = Number(start?.lon);
  const startLat = Number(start?.lat);
  const endLon = Number(end?.lon);
  const endLat = Number(end?.lat);
  if (
    !Number.isFinite(startLon) ||
    !Number.isFinite(startLat) ||
    !Number.isFinite(endLon) ||
    !Number.isFinite(endLat) ||
    Math.abs(startLon) > 180 ||
    Math.abs(endLon) > 180 ||
    Math.abs(startLat) > 90 ||
    Math.abs(endLat) > 90
  ) {
    return { error: 'invalid_coordinates', status: 400 };
  }
  return { ok: true };
}

async function upsertRoute(
  env: Env,
  user: VerifiedUser,
  body: Record<string, unknown>
): Promise<{ ok: true } | { error: string; status: number }> {
  const validation = validateUploadPayload(body);
  if ('error' in validation) return validation;

  const id = String(body.id);
  const name = String(body.name).trim();
  const routeType = String(body.routeType);
  const start = body.start as { lon: number; lat: number };
  const end = body.end as { lon: number; lat: number };
  const startLon = Number(start.lon);
  const startLat = Number(start.lat);
  const endLon = Number(end.lon);
  const endLat = Number(end.lat);

  const existing = await env.DB.prepare(
    'SELECT owner_id, created_at FROM shared_routes WHERE id = ?'
  )
    .bind(id)
    .first<{ owner_id: string; created_at: number }>();
  if (existing && existing.owner_id !== user.oauthUserId) {
    return { error: 'forbidden', status: 403 };
  }

  const now = Math.floor(Date.now() / 1000);
  const createdAt = existing?.created_at ?? Number(body.createdAt) ?? now;

  const description = (body.description as string | undefined) ?? null;
  const shareUrl = (body.shareUrl as string | undefined) ?? null;
  const difficulty = (body.difficulty as string | undefined) ?? null;
  const geometry = (body.geometry as string | undefined) ?? null;
  const startLabel = (body.startLabel as string | undefined) ?? null;
  const endLabel = (body.endLabel as string | undefined) ?? null;
  const distanceM = numOrNull(body.distanceM);
  const durationS = numOrNull(body.durationS);
  const durationEstimated = (body.durationEstimated ? 1 : 0) | 0;
  const elevationGainM = numOrNull(body.elevationGainM);
  const elevationLossM = numOrNull(body.elevationLossM);
  const elevationProfile = body.elevationProfile
    ? JSON.stringify(body.elevationProfile)
    : null;
  const shape = (body.shape as string | undefined) ?? null;
  const hasParkingAtStart = (body.hasParkingAtStart ? 1 : 0) | 0;

  // Privacy: `owner_name` column is kept for backward compatibility but always
  // stored as NULL. We never identify the uploader by real name.
  await env.DB.prepare(
    `INSERT INTO shared_routes (
      id, owner_id, owner_name, name, description, share_url, difficulty, route_type,
      geometry, start_lon, start_lat, end_lon, end_lat, start_label, end_label,
      distance_m, duration_s, duration_estimated, elevation_gain_m, elevation_loss_m,
      elevation_profile, shape, has_parking_at_start, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_name = NULL,
      name = excluded.name,
      description = excluded.description,
      share_url = excluded.share_url,
      difficulty = excluded.difficulty,
      route_type = excluded.route_type,
      geometry = excluded.geometry,
      start_lon = excluded.start_lon,
      start_lat = excluded.start_lat,
      end_lon = excluded.end_lon,
      end_lat = excluded.end_lat,
      start_label = excluded.start_label,
      end_label = excluded.end_label,
      distance_m = excluded.distance_m,
      duration_s = excluded.duration_s,
      duration_estimated = excluded.duration_estimated,
      elevation_gain_m = excluded.elevation_gain_m,
      elevation_loss_m = excluded.elevation_loss_m,
      elevation_profile = excluded.elevation_profile,
      shape = excluded.shape,
      has_parking_at_start = excluded.has_parking_at_start,
      updated_at = excluded.updated_at`
  )
    .bind(
      id,
      user.oauthUserId,
      name,
      description,
      shareUrl,
      difficulty,
      routeType,
      geometry,
      startLon,
      startLat,
      endLon,
      endLat,
      startLabel,
      endLabel,
      distanceM,
      durationS,
      durationEstimated,
      elevationGainM,
      elevationLossM,
      elevationProfile,
      shape,
      hasParkingAtStart,
      createdAt,
      now
    )
    .run();

  return { ok: true };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function deleteRouteHandler(
  env: Env,
  user: VerifiedUser,
  id: string
): Promise<{ ok: true; deleted: number } | { error: string; status: number }> {
  const existing = await env.DB.prepare(
    'SELECT owner_id FROM shared_routes WHERE id = ?'
  )
    .bind(id)
    .first<{ owner_id: string }>();
  if (!existing) return { ok: true, deleted: 0 };
  if (existing.owner_id !== user.oauthUserId) {
    return { error: 'forbidden', status: 403 };
  }
  await env.DB.prepare('DELETE FROM shared_routes WHERE id = ?').bind(id).run();
  return { ok: true, deleted: 1 };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Reject obviously oversized requests before reading the body. The Worker
    // also has a hard 100 MB limit, but we never want to buffer that much.
    const contentLength = req.headers.get('Content-Length');
    if (contentLength) {
      const n = Number(contentLength);
      if (Number.isFinite(n) && n > MAX_REQUEST_BODY_BYTES) {
        return json({ error: 'payload_too_large' }, { status: 413, cors });
      }
    }

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/v1/routes') {
        const since = Number(url.searchParams.get('since') ?? '0');
        // Auth on GET is OPTIONAL: when present, we attach `myVote` to each
        // returned route. When absent, just counts are returned.
        const maybeUser = await getUserFromAuth(req, env).catch(() => null);
        const routes = await listRoutes(
          env,
          Number.isFinite(since) ? since : 0,
          maybeUser?.oauthUserId ?? null
        );
        return json({ routes }, { cors });
      }

      if (req.method === 'POST' && path === '/v1/routes') {
        const user = await getUserFromAuth(req, env);
        if (!user) return json({ error: 'unauthorized' }, { status: 401, cors });
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return json({ error: 'bad_json' }, { status: 400, cors });
        }
        const result = await upsertRoute(env, user, body);
        if ('error' in result) {
          return json({ error: result.error }, { status: result.status, cors });
        }
        return json(result, { cors });
      }

      if (req.method === 'DELETE' && path.startsWith('/v1/routes/')) {
        const id = decodeURIComponent(path.slice('/v1/routes/'.length));
        if (!id) return json({ error: 'missing_id' }, { status: 400, cors });
        const user = await getUserFromAuth(req, env);
        if (!user) return json({ error: 'unauthorized' }, { status: 401, cors });
        const result = await deleteRouteHandler(env, user, id);
        if ('error' in result) {
          return json({ error: result.error }, { status: result.status, cors });
        }
        return json(result, { cors });
      }

      // POST /v1/routes/:id/vote — cast or clear a vote.
      // Body: { vote: "like" | "dislike" | null }
      const voteMatch = path.match(/^\/v1\/routes\/([^/]+)\/vote$/);
      if (req.method === 'POST' && voteMatch) {
        const id = decodeURIComponent(voteMatch[1]);
        const user = await getUserFromAuth(req, env);
        if (!user) return json({ error: 'unauthorized' }, { status: 401, cors });
        let body: { vote?: unknown };
        try {
          body = (await req.json()) as { vote?: unknown };
        } catch {
          return json({ error: 'bad_json' }, { status: 400, cors });
        }
        let voteVal: 1 | -1 | 0;
        if (body.vote === 'like' || body.vote === 1) voteVal = 1;
        else if (body.vote === 'dislike' || body.vote === -1) voteVal = -1;
        else if (body.vote === null || body.vote === 0 || body.vote === undefined)
          voteVal = 0;
        else return json({ error: 'invalid_vote' }, { status: 400, cors });
        const result = await castVote(env, user, id, voteVal);
        if ('error' in result) {
          return json({ error: result.error }, { status: result.status, cors });
        }
        return json(result, { cors });
      }

      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        return json({ ok: true, service: 'mapy-for-chrome-backend' }, { cors });
      }

      return json({ error: 'not_found' }, { status: 404, cors });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: 'internal', detail: msg }, { status: 500, cors });
    }
  }
} satisfies ExportedHandler<Env>;
