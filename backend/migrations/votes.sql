-- Add like / dislike counters to shared routes. Run ONCE on an existing DB.
-- SQLite does not support ADD COLUMN IF NOT EXISTS, so re-running will error
-- on the ALTER statements — that's harmless, the rest of the script is
-- idempotent.

ALTER TABLE shared_routes ADD COLUMN like_count INTEGER DEFAULT 0;
ALTER TABLE shared_routes ADD COLUMN dislike_count INTEGER DEFAULT 0;

-- Per-user vote on a route. `vote` is +1 for like, -1 for dislike.
CREATE TABLE IF NOT EXISTS route_votes (
  route_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (route_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_route_votes_route ON route_votes(route_id);
