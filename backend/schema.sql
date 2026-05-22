-- Mapy for Chrome — shared-routes schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS shared_routes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_name TEXT,
  name TEXT NOT NULL,
  description TEXT,
  share_url TEXT,
  difficulty TEXT,
  route_type TEXT NOT NULL,
  geometry TEXT,
  start_lon REAL NOT NULL,
  start_lat REAL NOT NULL,
  end_lon REAL NOT NULL,
  end_lat REAL NOT NULL,
  start_label TEXT,
  end_label TEXT,
  distance_m INTEGER,
  duration_s INTEGER,
  duration_estimated INTEGER,
  elevation_gain_m INTEGER,
  elevation_loss_m INTEGER,
  elevation_profile TEXT,
  shape TEXT,
  has_parking_at_start INTEGER,
  like_count INTEGER NOT NULL DEFAULT 0,
  dislike_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-user vote on a route. `vote` is +1 for like, -1 for dislike.
CREATE TABLE IF NOT EXISTS route_votes (
  route_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (route_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_route_votes_route ON route_votes(route_id);

CREATE INDEX IF NOT EXISTS idx_shared_routes_owner ON shared_routes(owner_id);
CREATE INDEX IF NOT EXISTS idx_shared_routes_updated ON shared_routes(updated_at);

-- Token verification cache so we don't hit login.szn.cz for every request.
CREATE TABLE IF NOT EXISTS token_cache (
  token_hash TEXT PRIMARY KEY,
  oauth_user_id TEXT NOT NULL,
  user_name TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_cache_expires ON token_cache(expires_at);
