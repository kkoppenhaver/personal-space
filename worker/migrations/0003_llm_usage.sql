-- LLM spend ledger (Phase 0b). One row per UTC day x route x model; the
-- worker upserts after every upstream call, cache hit, and upstream error.
-- A day's spend: SELECT SUM(cost_usd) FROM llm_usage WHERE day = 'YYYY-MM-DD';

CREATE TABLE IF NOT EXISTS llm_usage (
  day                TEXT    NOT NULL,           -- UTC 'YYYY-MM-DD'
  route              TEXT    NOT NULL,           -- concept | tier2 | tier3 | pick
  model              TEXT    NOT NULL,
  calls              INTEGER NOT NULL DEFAULT 0, -- billed upstream calls
  cache_hits         INTEGER NOT NULL DEFAULT 0, -- served from KV (free)
  errors             INTEGER NOT NULL DEFAULT 0, -- upstream non-2xx, refusal, missing tool_use
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route, model)
);
