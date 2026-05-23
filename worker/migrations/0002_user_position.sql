-- Add per-user last-known position. Stored as JSON so we can evolve the
-- payload (add velocity, time-in-galaxy, etc.) without further migrations.
-- Shape: { "pos": [x, y, z], "fwd": [x, y, z], "ts": <ms epoch> }
-- pos is galaxy-space, not render-space, so it survives floating-origin rebases.

ALTER TABLE users ADD COLUMN last_position TEXT;
