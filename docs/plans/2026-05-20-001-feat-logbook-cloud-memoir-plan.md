---
title: Logbook as cloud-backed memoir (accounts + D1 + R2)
type: feat
status: completed
date: 2026-05-20
supersedes: plan.md Phase 2 / Task 17 "Logbook revisit-by-coordinates"
---

# Logbook as cloud-backed memoir (accounts + D1 + R2)

## Overview

Replace the localStorage-only logbook with a cloud-backed, account-bound memoir of every planet the player has claimed. Each entry captures **planet identity**, **planet thumbnail**, **full Tier 3 lore + landmarks**, and **flight stats**. Auth is passkey-primary with email magic-link fallback. The game remains fully playable offline; the cloud is a mirror, not a gate.

**This plan supersedes the original Task 17** ("Logbook revisit-by-coordinates") in `plan.md:62`. The product decision is that the logbook is a keepsake/scrapbook, not a navigation aid — players do not revisit planets. We still record planet identity so we can dedupe across devices and so the Worker's KV-cached lore stays deterministic.

## Problem Statement

The current logbook (`src/ui/Logbook.js`, persisted under `paper-airplane:logbook:v1`) is a 5-field array (`seed`, `name`, `biome`, `palette`, `landmarks`, `visitedAt`) on localStorage. It has four concrete problems:

1. **No memory of the moment.** The Tier 3 lore that arrives after landing (`src/main.js:378-384`) is shown for ~6 seconds in the HUD and then discarded. The most evocative thing the LLM produces never lives in the logbook.
2. **Per-device, per-browser.** Players who clear data or switch machines lose everything.
3. **Dedupe-by-seed bug.** `Logbook.add` (`src/ui/Logbook.js:17`) keys on planet seed alone. Once the galaxy generator reuses seeds across cells (which it can — `hashSeeds` is a 32-bit derivation), two genuinely-different planets collide. This is latent today; it bites the first time a player travels far enough.
4. **No memoir affordance.** No thumbnail, no stats, no detail view. The entry is a one-line label.

## Proposed Solution

Build an authenticated cloud subsystem (extending the existing Worker) that owns logbook truth, and rebuild the local logbook to be an **append-only outbox** that syncs to the cloud and renders the UI from local state. The game remains playable without network; the logbook just queues.

Three pillars:

- **Server-side anonymous accounts from day one.** On first launch the client POSTs `/api/auth/anonymous` and gets a session cookie. Every entry is FK'd to a `users` row from the very first claim. Sign-up later flips `anonymous=false` and attaches credentials to the same `user_id` — no migration of entries needed.
- **Two-phase save per claim.** Entry written immediately on `markClaimed()` with `lore=null, lore_status='pending'`. A second PATCH writes lore + landmarks when `llm.land()` resolves. Thumbnail upload is independent and idempotent.
- **IndexedDB outbox.** All entries live in a local IDB store first; a background flusher replays them to the cloud. Thumbnails (up to ~50KB each) would blow the 5MB localStorage quota in ~100 claims, so IDB is non-negotiable.

## Technical Approach

### Architecture

```
Browser (personalspace.fun, Cloudflare Pages)
  ├── Game (Three.js + Rapier)
  ├── src/logbook/
  │     ├── LogbookStore.js     — IDB outbox + dedupe + entry CRUD
  │     ├── LogbookSync.js      — background flusher, retries, conflict resolution
  │     └── ThumbnailCapture.js — offscreen WebGLRenderTarget snapshotter
  ├── src/auth/
  │     ├── AuthClient.js       — passkey + magic-link client flows
  │     └── Session.js          — session state, /me hydration, signed-out UI
  └── src/game/FlightStats.js   — per-attempt + per-flight metrics

Cloudflare Worker (api.personalspace.fun — custom domain on existing Worker)
  ├── Hono router
  ├── /tier1, /tier2, /tier3    — existing LLM proxy (ported from vanilla)
  ├── /api/auth/anonymous       — create anonymous user + session
  ├── /api/auth/passkey/*       — register/login WebAuthn (SimpleWebAuthn v13)
  ├── /api/auth/email/*         — magic-link issue + verify (Resend)
  ├── /api/auth/logout
  ├── /api/me                   — session hydration
  ├── /api/logbook              — list, create, patch, delete entries
  ├── /api/logbook/:id/thumb    — PUT JPEG; GET (cached) returns from R2
  ├── /api/account/export       — JSON dump
  └── /api/account/delete       — cascading delete
  Bindings:
    DB (D1), THUMBS (R2), LLM_CACHE (KV — existing),
    AUTH_CHALLENGES (KV — new, 5min TTL), AUTH_LIMITER (Rate Limit)
  Secrets: ANTHROPIC_API_KEY (existing), SESSION_SECRET, RESEND_API_KEY
```

#### Why extend the existing Worker rather than add a new one

Single deployment, shared CORS allowlist, one secret store, one `wrangler.toml`. The current `worker/src/index.js` is ~180 lines of vanilla; porting it into Hono routes in the same pass costs ~30 minutes and removes duplicate CORS handling.

#### Cross-origin / cookie strategy

Game on `personalspace.fun`, API on `api.personalspace.fun`. These are **same-site** (shared eTLD+1 = `personalspace.fun`). Browsers treat cross-subdomain requests as same-site for cookie purposes, so:

```
Set-Cookie: ps_session=<signed>; Domain=.personalspace.fun;
            Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
```

`SameSite=Lax` is sufficient. `SameSite=None` is **not** required (that's only needed for genuine cross-site, e.g. workers.dev → personalspace.fun). Choosing `Lax` avoids browser third-party-cookie restrictions that increasingly target `None`.

WebAuthn `rpID = "personalspace.fun"`. Credentials registered on the game origin are usable from both subdomains.

#### Local dev cookie strategy

Vite (`127.0.0.1:5173`) and `wrangler dev` (`localhost:8787`) are different origins, breaking cookies in dev. Solution: configure Vite to proxy `/api/*` and `/tierN` to the local Worker, so the browser sees same-origin in dev. No bearer-token fallback needed.

```js
// vite.config.js
server: {
  proxy: {
    '/api':   { target: 'http://127.0.0.1:8787', changeOrigin: true },
    '/tier1': 'http://127.0.0.1:8787',
    '/tier2': 'http://127.0.0.1:8787',
    '/tier3': 'http://127.0.0.1:8787',
  },
},
```

### D1 schema (migration `0001_init.sql`)

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- UUIDv7
  email       TEXT UNIQUE,                -- nullable; set once user provides one
  anonymous   INTEGER NOT NULL DEFAULT 1, -- 0/1
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE passkeys (
  id              TEXT PRIMARY KEY,        -- credentialID base64url
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      BLOB NOT NULL,
  counter         INTEGER NOT NULL,
  transports      TEXT,                    -- JSON array
  device_type     TEXT,
  backed_up       INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,           -- random 32 bytes b64url
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE email_tokens (
  token_hash   TEXT PRIMARY KEY,           -- sha256(raw token)
  email        TEXT NOT NULL,
  user_id      TEXT,                       -- nullable: token may pre-claim a future user
  purpose      TEXT NOT NULL,              -- 'login' | 'verify'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);
CREATE INDEX idx_email_tokens_email ON email_tokens(email);

CREATE TABLE entries (
  id            TEXT PRIMARY KEY,          -- UUIDv7 (client-generated for idempotency)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  galaxy_seed   INTEGER NOT NULL,          -- TUNING.PLANET_SEED at claim time
  cell_x        INTEGER NOT NULL,
  cell_y        INTEGER NOT NULL,
  cell_z        INTEGER NOT NULL,
  planet_index  INTEGER NOT NULL,
  planet_seed   INTEGER NOT NULL,          -- redundant w/ above but useful for KV lookup
  planet_name   TEXT NOT NULL,
  biome         TEXT,
  palette       TEXT,                      -- JSON
  landmarks     TEXT,                      -- JSON array
  lore          TEXT,                      -- nullable until Tier 3 returns
  lore_status   TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ready' | 'failed'
  thumbnail_key TEXT,                      -- R2 key, nullable until upload completes
  stat_time_to_land_ms INTEGER,
  stat_top_speed REAL,
  stat_crashes  INTEGER,
  stat_distance_m REAL,
  legacy        INTEGER NOT NULL DEFAULT 0, -- 1 = migrated from localStorage, missing identity fields ok
  claimed_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index)
);
CREATE INDEX idx_entries_user ON entries(user_id);
CREATE INDEX idx_entries_user_claimed ON entries(user_id, claimed_at DESC);
```

The `UNIQUE` constraint is the **planet identity tuple** — this is the dedupe key everywhere (client outbox, server insert, cross-device merge). Legacy entries set `cell_x=cell_y=cell_z=-2147483648, planet_index=-1` so they don't collide with real entries; UI groups them under "Before the galaxy".

### Implementation Phases

#### Phase 1: Foundation — schema, Worker scaffolding, auth (no game changes)

Deliverables:
- `worker/migrations/0001_init.sql` (above) applied to local + remote D1.
- `worker/wrangler.toml`: add D1, R2, AUTH_CHALLENGES KV, Rate Limit binding, `nodejs_compat` flag, `SESSION_SECRET` + `RESEND_API_KEY` via `wrangler secret put`.
- Port existing `worker/src/index.js` to Hono. Existing `/tier1/2/3` handlers become `app.post('/tierN', ...)`. CORS via `hono/cors`. Single file is fine; split per-resource if it grows past ~400 lines.
- Auth endpoints:
  - `POST /api/auth/anonymous` → creates a `users` row with `anonymous=1`, returns session cookie. Rate-limited per-IP (5/min).
  - `POST /api/auth/passkey/register/options` + `/verify` — SimpleWebAuthn server, challenge stored in `AUTH_CHALLENGES` KV with 5-min TTL keyed by session id.
  - `POST /api/auth/passkey/login/options` + `/verify`.
  - `POST /api/auth/email/request` — sends magic link via Resend; rate-limited per-email (3/hour) + per-IP (10/hour).
  - `GET /api/auth/email/verify?token=...` — validates token, creates/upgrades user, sets session cookie, redirects to `/`.
  - `POST /api/auth/logout` — deletes session row, clears cookie.
  - `GET /api/me` — returns `{ user: { id, email, anonymous } }` or 401.
- Hono middleware: cookie session, attaches `c.set('user', ...)` for `/api/*` routes; `/api/auth/*` and `/api/me` allow anonymous, others require non-null user.

Success criteria:
- `curl -c /tmp/c -X POST .../api/auth/anonymous` returns 200 and a cookie; `curl -b /tmp/c .../api/me` returns the same user.
- Existing `/tier1/2/3` endpoints continue to work (regression-tested by playing the game against the new Worker).

Estimated effort: ~1 day.

#### Phase 2: Logbook entries — server side

Deliverables:
- `POST /api/logbook` — body `{ id, galaxy_seed, cell_x, cell_y, cell_z, planet_index, planet_seed, planet_name, biome, palette, landmarks?, lore?, claimed_at }`. Client-generated `id` is the idempotency key. Inserts; on UNIQUE conflict returns existing row's `id` with 200.
- `PATCH /api/logbook/:id` — body `{ lore?, lore_status?, landmarks?, stat_*? }`. Used to backfill Tier 3 lore + stats post-claim.
- `GET /api/logbook` — list current user's entries, newest first. Includes a derived `thumbnail_url` field pointing to `/api/logbook/:id/thumb`.
- `PUT /api/logbook/:id/thumb` — accepts `image/jpeg`, max 150KB. Validates magic bytes. Stores at R2 key `thumbs/{user_id}/{entry_id}.jpg` with `cacheControl: 'public, max-age=31536000, immutable'`. Updates `entries.thumbnail_key`. Rate-limited per-user (20/hour).
- `GET /api/logbook/:id/thumb` — reads from R2, returns with caching headers. Worker-fronted (not direct R2 URL) so we can authenticate and rotate keys.
- `DELETE /api/logbook/:id` — soft-delete (or hard, decide during build; soft-delete keeps R2 cleanup deferrable).
- `GET /api/account/export` and `POST /api/account/delete` — GDPR-style affordances.

Success criteria:
- POST then PATCH a representative entry; GET returns the merged result.
- PUT a 50KB JPEG and re-GET the entry; `thumbnail_url` resolves with the image.
- Two POSTs with the same identity tuple return the same `id` (idempotent).

Estimated effort: ~1 day.

#### Phase 3: Client logbook store, outbox, sync

Deliverables:
- `src/logbook/LogbookStore.js` — IndexedDB-backed (use `idb-keyval` or a tiny hand-roll; ~50 lines either way). Schema: `entries` object store keyed by `id`; secondary index on `(galaxy_seed, cell_x, cell_y, cell_z, planet_index)` for dedupe.
- `src/logbook/LogbookSync.js` — flusher loop: on app start, on focus, after each new entry, after network reconnect. Tracks per-entry `sync_state: 'new' | 'syncing' | 'synced' | 'failed'` and retry counts with exponential backoff. POSTs new entries, PATCHes lore arrivals, PUTs pending thumbnails. Conflict handling: server returns existing `id` → mark local as `synced`.
- Refactor `src/ui/Logbook.js` to render from `LogbookStore`, not its old localStorage array. Keep slide-out panel structure. Add per-entry click → detail view with thumbnail + full lore + landmarks + stats.
- One-time migration on first load if `localStorage['paper-airplane:logbook:v1']` exists: insert each as a `legacy=true` entry, then delete the localStorage key.

Success criteria:
- Offline: claim a planet, fully play; reload; entry is still there with lore.
- Online: claim a planet, force-quit the tab during the POST; reload connected; sync resolves to one entry, not zero or two.
- Two-tab test: open the game in tab A and tab B (same user), claim in A; tab B shows the entry after focus.

Estimated effort: ~1.5 days.

#### Phase 4: Claim flow rewiring + flight stats + thumbnail capture

Deliverables:
- `src/game/FlightStats.js` — tracks per-attempt and per-flight metrics. Hooks in `src/main.js`:
  - Reset per-attempt at every spawn/respawn (`main.js:173, 205, 234`).
  - Update top speed each fixed step from `plane.velocity().length()`.
  - Integrate distance from `velocity * dt` (rebase-invariant per `Plane.translate`).
  - Crashes counter incremented in the collision handler (`main.js:300-321`).
  - Per-attempt stamp `flightStartAt = performance.now()` on spawn; on claim, `now - flightStartAt` is `stat_time_to_land_ms`.
  - Decision (folded from SpecFlow #14): keep **per-attempt stats only**, not a per-flight history. Crash-respawn resets the attempt's clock and distance. This matches the player's intuition of "the flight that landed."
- `src/logbook/ThumbnailCapture.js` — offscreen `WebGLRenderTarget` snapshotter. At claim:
  1. Wait until plane is `state === 'grounded'` and `|velocity| < 1 m/s` continuously for 0.5s (the "settle window"), OR fall back to immediate-on-claim if settle window doesn't resolve within 4s.
  2. Render the active scene to a 512×512 target with the live camera. Read pixels into a 2D canvas, encode via `canvas.toBlob('image/jpeg', 0.7)`.
  3. Hand the blob to LogbookSync, which queues the PUT.
  - Renderer set to `preserveDrawingBuffer: true` at construction (`main.js:27-28`) so the offscreen path also works as a fallback against the live canvas if the render target capture errors.
- **Rewire the claim flow** (`src/main.js:359-385`). Two changes:
  - On claim, write the entry with current planet identity + stats + `lore=null, lore_status='pending'` immediately.
  - Move `llm.land()` invocation off the per-planet Planet object and key by `entry.id`. The resolve handler PATCHes the entry. This survives system despawn (SpecFlow #3) — the entry is owned by the LogbookStore, not the Planet instance.
- HUD landmark text continues to display Tier 2/3 results live; only the persistence layer changes.

Success criteria:
- Land, fly away 40km (cull radius is 35km — forces system despawn), wait for Tier 3 to resolve, return: logbook detail shows the lore.
- Crash-respawn 3 times before landing successfully: entry shows 3 crashes, time-to-land = time-of-final-attempt.
- Land sideways at speed: thumbnail is the "settled" framing, not the ground-roll blur. (If settle window times out, accept whatever framing we got — better than nothing.)

Estimated effort: ~2 days.

#### Phase 5: Auth UI, upsell, account management

Deliverables:
- Auth modal reusing the pause-menu modal pattern (`index.html:51-58, 77-88`, wired in `main.js:441-456`). Two tabs: "Passkey" and "Email link". If `!window.PublicKeyCredential`, hide the passkey tab.
- Account drawer (mirror logbook drawer): shows signed-in email/anonymous status, "Add passkey", "Add email", "Export data", "Delete account", "Sign out".
- Upsell trigger (SpecFlow #13): after the **3rd claim** on an anonymous account, the claim toast adds a "Save your logbook →" CTA that opens the auth modal. Snooze stored locally; doesn't re-prompt for 7 days.
- Privacy disclosure: a tiny `/privacy` route on Pages (static HTML) listing what's stored. Linked from the auth modal and account drawer.
- Recovery floor (SpecFlow #7): before flipping `anonymous=0`, server enforces "at least one credential" (passkey OR verified email). Client UI mirrors this — first sign-up screen requires both a passkey *or* a verified email before completing.

Success criteria:
- Anonymous user plays, gets 3rd-claim upsell, signs up via passkey, sees their three entries still there.
- Sign out → entries still visible (local cache); sign in on a fresh browser → same entries appear after sync.
- Lost passkey, has email → magic link gets them back in.

Estimated effort: ~1 day.

#### Phase 6: Polish, abuse guards, infra

Deliverables:
- Per-user soft cap: warn at 500 entries, hard 422 at 2000 (SpecFlow #10).
- Tier 3 lore length capped at 2KB server-side.
- Anonymous-user GC: nightly cron (or Worker scheduled trigger) deletes `users` rows with `anonymous=1, claim_count=0, created_at < now - 30d`.
- "Offline" status pill in the logbook drawer (SpecFlow #12) — turns on when a sync attempt fails with network error, off when next attempt succeeds.
- Update `plan.md` to mark Task 17 as superseded by this plan; link in the Phase 2 table.

Estimated effort: ~0.5 day.

### Implementation order — total estimated effort

~7 days end-to-end if everything goes smoothly. Phases 1–3 are server- and infra-heavy with no game changes; Phase 4 is the game-side reshuffle and the highest-risk single change because it touches the live claim path. Phase 5–6 are UI/polish.

## Alternative Approaches Considered

- **localStorage only + JSON export/import.** Cheaper, no infra. Rejected: doesn't deliver the cross-device-memoir product intent, and we still need to fix the `seed`-only dedupe bug.
- **OAuth (Google/GitHub).** Familiar. Rejected: couples a deliberately whimsical hobby game to corporate identity; passkeys give a cleaner UX once you have one.
- **Lucia for auth.** Was the go-to in 2024. Rejected: author stepped away, Lucia v3 effectively unmaintained in 2026. SimpleWebAuthn + hand-rolled session in ~80 lines of Hono is simpler.
- **MailChannels free for magic links.** Rejected: ended Aug 2024 for Workers.
- **Cloudflare Email Service.** Native Worker binding, no API key, but requires Workers Paid. Defer; revisit when we go Paid for other reasons. Resend's 3k/mo free tier covers us into the thousands of MAU.
- **Presigned R2 PUT from browser.** Saves Worker bandwidth. Rejected at ~50KB scale: Worker-proxied PUT is one fewer round trip, gives us validation + magic-byte checks, and avoids the well-documented R2 presigned-PUT + browser CORS Content-Type signing footgun.
- **localStorage outbox.** Rejected: 5MB quota; thumbnails would blow it inside ~100 claims.
- **Server-side merge on first sign-in (instead of anonymous-from-day-one).** Rejected: dual codepath (anon → cloud-on-sign-up vs cloud-from-start), more migration logic, harder to test. Anonymous-from-day-one keeps the storage path uniform; sign-up is just a metadata flip.

## System-Wide Impact

### Interaction graph

Claim trigger fires (`main.js:367`) →
  `landingZone.markClaimed()` (LandingZone.js:225) →
  `toast.show('CLAIMED', ...)` (HUD) →
  **`LogbookStore.create(entry)`** — writes IDB with `lore_status='pending'` →
    `LogbookSync` picks it up, POSTs `/api/logbook` → server inserts entries row → R2 thumbnail PUT chained →
  **`ThumbnailCapture.capture(scene, camera, entry.id)`** — schedules settle-window capture →
    on settle: PUT `/api/logbook/:id/thumb` → R2 put + entries.thumbnail_key updated
  **`llm.land(entry.id, planet)`** — Tier 3 lore request →
    on resolve: PATCH `/api/logbook/:id` `{ lore, landmarks, lore_status: 'ready' }` →
    on reject after 3 retries: PATCH `{ lore_status: 'failed' }`

Three independent async chains. The entry exists after step 1; everything else backfills.

### Error & failure propagation

- **Network down at claim:** entry stays in IDB with `sync_state='new'`. LogbookSync retries with exponential backoff (5s → 30s → 5min → hourly). UI shows the entry; the cloud is unaware.
- **Tier 3 LLM fails:** `lore_status='failed'`. UI shows "lore lost to time" in the detail view. Cron job (Phase 6+) can retry failed lores by re-firing `llm.land`.
- **R2 PUT fails:** thumbnail blob stays in IDB (`thumb_blob`), retried by sync. Server-side entry exists without thumbnail_key. UI shows a default placeholder (planet-color tinted gradient).
- **Session expired:** every fetch hits 401 → AuthClient transitions to signed-out UI, but **does not blow away IDB**. Player keeps seeing their entries; sync resumes after re-auth.
- **D1 down (Cloudflare incident):** server returns 5xx. Sync retries. Game and local logbook fully functional.
- **Concurrent claim from two tabs:** both POST with their locally-generated UUIDs. Server's UNIQUE on identity tuple causes the second to return the first's `id`. Both clients reconcile to the same canonical id; the IDB row in the loser tab is rewritten with the winner's id.

### State lifecycle risks

- **Despawn before lore returns** (SpecFlow #3 / latent today): solved by moving `llm.land` ownership to the entry, not the Planet.
- **Claim re-fires after system despawn/respawn** (`LandingZone.claimed` is sticky-per-instance only, `main.js:359-362`): server dedupe catches it. Also: change the client's *local* dedupe key in `LogbookStore.create` from `seed` to the full identity tuple in the same PR, fixing SpecFlow #15.
- **Anonymous user on Device B + later sign-in collision** (SpecFlow #5): `/api/auth/merge` endpoint runs once on first authenticated request after sign-in. Server-side: pulls anon user's entries, INSERT ... ON CONFLICT DO NOTHING into authenticated user's namespace, then deletes anon user. Client's IDB is rewritten with the canonical entry ids returned by the merge.
- **Migration of legacy localStorage entries**: `legacy=true` rows use sentinel identity tuple to avoid colliding with real entries; UI surfaces them in a dedicated section.

### API surface parity

The browser game is the only client. The existing `/tier1/2/3` LLM proxy endpoints are unchanged in shape; they just gain Hono routing.

### Integration test scenarios

1. **Claim → despawn → lore-late.** Claim planet, throttle away to >35km (system despawns), wait until Tier 3 resolves, return: entry detail shows the lore.
2. **Offline claim → online flush.** Disable network, claim 2 planets, re-enable: both entries POST successfully and appear server-side.
3. **Cross-device dedupe.** Sign in on Browser A, claim planet X. Sign in on Browser B (same user), claim same planet X (same seed/cell). Server has one entry; both browsers reconcile to it.
4. **Anonymous → sign-up upgrade.** Play anonymous, get 3 entries. Sign up via passkey. Same 3 entries visible (no migration ceremony — they were always on the same `user_id`).
5. **Crash-during-thumbnail-upload.** Claim planet, kill tab mid-PUT. Reload: thumbnail PUT retries; entry remains intact with eventually-correct thumbnail.

## Acceptance Criteria

### Functional Requirements

- [ ] Existing `/tier1/2/3` LLM proxy endpoints work unchanged after Hono port (no behavior delta).
- [ ] Player starts the game with no account; an anonymous user is provisioned silently on first launch.
- [ ] Every claim writes one entry to the local IDB store within the same animation frame as the toast.
- [ ] Tier 3 lore arrival PATCHes the entry; if Tier 3 never returns, entry persists with `lore_status='failed'` after 3 retries.
- [ ] Thumbnail is captured during a settle window (≤1 m/s, 0.5s, max 4s wait) and uploaded via Worker; max 150KB JPEG enforced server-side.
- [ ] Local entry dedupe uses the full identity tuple, not seed alone (fixes latent bug in `src/ui/Logbook.js:17`).
- [ ] Server dedupe enforces the same tuple via `UNIQUE(user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index)`.
- [ ] Sign-up via passkey works on a passkey-capable device; email magic link works as recovery + fallback.
- [ ] `!window.PublicKeyCredential` clients are not shown the passkey UI and can sign up via email only.
- [ ] Sign-up flow refuses to flip `anonymous=0` unless at least one credential (passkey OR verified email) is on file.
- [ ] Upsell triggers exactly once on the 3rd anonymous claim; 7-day snooze on dismissal.
- [ ] localStorage logbook from prior versions imports as `legacy=true` on first load; original key removed after.
- [ ] Logbook detail view shows: thumbnail, full lore (or "lore lost to time" if failed), landmarks, all four flight stats.
- [ ] Account drawer offers: passkey enroll, email add, sign-out, JSON export, account delete.
- [ ] `/privacy` page lists every stored field.

### Non-Functional Requirements

- [ ] Game playable offline; logbook degrades gracefully (queue + "offline" pill).
- [ ] Every cloud call has a 3s timeout; failures never block gameplay.
- [ ] Thumbnail capture must not visibly flicker or stall the live canvas (use offscreen render target).
- [ ] All cloud endpoints (except `/tier*` and `/api/auth/anonymous`) require a session.
- [ ] Rate limits: anonymous create 5/min/IP, email request 3/hour/email + 10/hour/IP, thumbnail PUT 20/hour/user.
- [ ] D1 + R2 use the free tier (game's scale will stay well inside limits).
- [ ] Passkey UX matches platform conventions (TouchID / Windows Hello prompts unmodified).

### Quality Gates

- [ ] Local dev round-trip works through Vite proxy (no cookie hacks).
- [ ] All 5 integration test scenarios above pass against `wrangler dev` + local D1.
- [ ] Game playthrough on the deployed Worker shows no console errors and no regressions in existing claim/landing flow.
- [ ] No `console.warn`/`console.error` in normal gameplay paths.

## Success Metrics

- 0 lost claims (every claim that fires the toast results in a logbook entry).
- 100% of entries that complete Tier 3 capture lore.
- Thumbnail attach rate ≥ 95% (allow a 5% miss for browser quirks / settle-timeout fallback).
- 3rd-claim upsell conversion observable (number of anonymous → authenticated upgrades).

## Dependencies & Prerequisites

- Cloudflare account: D1, R2, KV (existing), Rate Limit binding (free tier OK).
- Resend account + verified `personalspace.fun` sender domain (or skip email entirely in v1 and ship passkey-only; revisit if recovery becomes an issue).
- `simplewebauthn` packages: `@simplewebauthn/server` v13.x, `@simplewebauthn/browser` v13.x.
- `hono` v4.x.
- `idb-keyval` v6.x (or hand-roll a 30-line IDB wrapper).
- Wrangler `compatibility_flags = ["nodejs_compat"]` added.
- Secrets to set: `SESSION_SECRET`, `RESEND_API_KEY`.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Passkey UX regressions on Safari/iOS | Med | Med | Manual test on iOS Safari + macOS Safari; magic-link fallback always available |
| WebAuthn rpID/origin misconfig blocks login | Low | High | Test on a Pages preview deploy before flipping main; lock rpID to apex domain only |
| Resend deliverability (spam folder) | Med | Low | Configure DKIM + SPF; warn user "check spam"; passkey-primary means most users never need email |
| IDB quota exhaustion (player with 5000+ entries) | Low | Med | Soft cap 500 / hard cap 2000 server-side; client refuses to enqueue past hard cap |
| Cloudflare D1 outage | Low | Low | Local IDB is source of truth; outage = sync delay, not data loss |
| Thumbnail capture costs FPS | Med | Low | Offscreen render target + capture only at settle window (not every frame); profile in dev |
| Game playable on `pages.dev` preview deploys breaks passkeys | High | Low | Document: passkeys work only on `personalspace.fun`; previews are anonymous-only |
| Local dev cookies break for contributors | Med | Low | Document Vite proxy setup in README |
| Existing logbook users see migration UI confusion | Low | Low | Migration is silent + idempotent; legacy entries clearly labeled |

## Resource Requirements

- Solo dev, ~7 days. No external collaborators required.
- Costs: Resend free tier, D1 free tier (500MB), R2 free tier (10GB), Workers Free plan continues to suffice.

## Future Considerations

- **Cloudflare Email Service migration** when we go Workers Paid for other reasons.
- **Lore re-roll button** — let players regenerate lore for a planet they don't like. Costs an API call; rate-limit per-user.
- **Logbook export to PDF/PNG** — a "year-in-review"-style coffee-table-book render of all entries with their thumbnails.
- **Optional revisit-by-coords** — if the product decision reverses, the identity tuple is already stored. Future me will thank present me.
- **Public shareable entry pages** — `personalspace.fun/log/:public_id` renders a single entry's thumbnail + lore + stats. Opt-in per entry.
- **Multi-galaxy support** — `TUNING.PLANET_SEED` becomes per-user / per-run. `galaxy_seed` is already first-class in the schema.

## Documentation Plan

- README: add a "Cloud logbook" section with auth flow + local dev instructions.
- `plan.md`: replace Task 17 row with "☑ superseded by [this plan]". Add a Phase 2.5 note linking to this plan.
- New `docs/auth.md` describing the passkey + email-link flow at a level a contributor can grok.
- New `docs/data-model.md` showing the D1 schema + R2 key layout.

## Sources & References

### Internal references

- `src/main.js:359-385` — current claim sweep; the rewire site
- `src/main.js:27-28` — `WebGLRenderer` construction; needs `preserveDrawingBuffer: true`
- `src/main.js:300-321` — collision handler; crash count hook
- `src/main.js:173, 205, 234` — spawn/respawn sites; per-attempt stats reset hooks
- `src/main.js:441-456` — pause menu modal wiring; template for auth modal
- `src/ui/Logbook.js:17` — buggy dedupe-by-seed (replace with identity-tuple key)
- `src/ui/Logbook.js:39-43` — current entry shape + slide-out markup
- `src/ui/Toast.js`, `src/ui/HUD.js` — UX patterns to mirror
- `src/world/LandingZone.js:224-232` — `markClaimed` + `isLanded`; emit point for entry creation
- `src/world/Galaxy.js:50-70, 162` — cell-key + `systemSeed` derivation
- `src/world/SolarSystem.js:66` — `hashSeeds(systemSeed, i+1)` → `planet.seed`
- `src/world/Origin.js:34` — `toGalaxy(renderPos)` → galaxy coord for cell-key resolution
- `src/world/Planet.js:9-10` — `seed` field
- `src/llm/LLMClient.js:28, 32-65` — existing fetch pattern (AbortController + timeout + dedupe); mirror in AuthClient
- `worker/src/index.js` (vanilla) — to be ported into Hono
- `worker/wrangler.toml:6-8` — existing `api.personalspace.fun` custom domain route
- `index.html:38-58, 75-88` — drawer + modal patterns to reuse
- `plan.md:62` — superseded Task 17 row
- `plan.md:129-133` — open questions this plan answers

### External references

- [Cloudflare D1 docs](https://developers.cloudflare.com/d1/) — bindings, migrations, limits
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/) — for any future direct browser uploads
- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Workers Rate Limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers nodejs_compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Hono CORS](https://hono.dev/docs/middleware/builtin/cors) and [cookie helper](https://hono.dev/docs/helpers/cookie)
- [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server) and [browser](https://simplewebauthn.dev/docs/packages/browser)
- [Resend + Workers tutorial](https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/)
- [MailChannels EOL notice](https://blog.mailchannels.com/important-update-mailchannels-email-sending-api-for-cloudflare-workers-to-be-terminated/) — context for not using it
- [SameSite cookie behavior across subdomains](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite)

### Related work

- `plan.md` Task 15 (floating-origin) — distance integration must use velocity, not position deltas
- `plan.md` Task 16 (galaxy streaming) — cull radius drives the despawn-before-lore problem this plan solves
