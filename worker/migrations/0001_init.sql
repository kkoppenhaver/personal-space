-- Personal Space — initial schema for accounts + cloud-backed logbook.
-- See docs/plans/2026-05-20-001-feat-logbook-cloud-memoir-plan.md

CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- UUIDv7
  email         TEXT UNIQUE,                -- nullable; set once user provides one
  anonymous     INTEGER NOT NULL DEFAULT 1, -- 0/1
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  claim_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_anon_seen ON users (anonymous, last_seen_at);

CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,            -- credentialID base64url
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   BLOB NOT NULL,
  counter      INTEGER NOT NULL,
  transports   TEXT,                        -- JSON array
  device_type  TEXT,
  backed_up    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkeys_user ON passkeys (user_id);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,           -- 32-byte random, b64url
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE email_tokens (
  token_hash  TEXT PRIMARY KEY,             -- sha256(raw token)
  email       TEXT NOT NULL,
  user_id     TEXT,                         -- pre-claim a future user, or attach to existing
  purpose     TEXT NOT NULL,                -- 'login' | 'verify'
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_email_tokens_email ON email_tokens (email);
CREATE INDEX idx_email_tokens_expires ON email_tokens (expires_at);

CREATE TABLE entries (
  id                   TEXT PRIMARY KEY,    -- UUIDv7, client-generated for idempotency
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  galaxy_seed          INTEGER NOT NULL,
  cell_x               INTEGER NOT NULL,
  cell_y               INTEGER NOT NULL,
  cell_z               INTEGER NOT NULL,
  planet_index         INTEGER NOT NULL,
  planet_seed          INTEGER NOT NULL,
  planet_name          TEXT NOT NULL,
  biome                TEXT,
  palette              TEXT,                -- JSON
  landmarks            TEXT,                -- JSON array
  lore                 TEXT,                -- nullable until Tier 3 returns
  lore_status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ready' | 'failed'
  thumbnail_key        TEXT,                -- R2 key, nullable until upload completes
  stat_time_to_land_ms INTEGER,
  stat_top_speed       REAL,
  stat_crashes         INTEGER,
  stat_distance_m      REAL,
  legacy               INTEGER NOT NULL DEFAULT 0,
  claimed_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index)
);
CREATE INDEX idx_entries_user_claimed ON entries (user_id, claimed_at DESC);
