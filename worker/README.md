# Personal Space Worker

Cloudflare Worker that powers the LLM proxy *and* the cloud-backed logbook. Single deployment, single domain (`api.personalspace.fun`), one CORS allowlist. Hono router on top of D1 + R2 + KV + the Rate Limit binding.

## What it does

- **LLM proxy** — `POST /concept`, `/tier2/direct` (alias `/tier2`), `/tier2/pick`, `/tier3`. Holds the Anthropic API key, enforces JSON output via tool-use, caches responses in KV by `(tier, seed, normalizedContext)` so revisits return identical content. Session-gated, rate-limited, and behind a daily spend breaker (see [Spend guard](#spend-guard)).
- **Auth** — passkey (WebAuthn) primary, email magic-link recovery. Anonymous-user creation on first contact so the game has a session before the player decides to sign up. Cookie-based sessions (HMAC-signed id, `Domain=.personalspace.fun`, `SameSite=Lax`).
- **Logbook** — entry CRUD + thumbnail upload/download. Idempotent inserts on the planet identity tuple.
- **Account** — JSON export (GDPR-style) and cascading delete.
- **Cron** — daily anonymous-user GC + expired-session purge.

## Setup (one-time)

```bash
cd worker
npm install

# 1. Auth
wrangler login

# 2. Create resources and paste the IDs into wrangler.toml
wrangler d1 create personal-space
#   [[d1_databases]] binding="DB" database_name="personal-space" database_id="..."
wrangler kv namespace create AUTH_CHALLENGES
#   [[kv_namespaces]] binding="AUTH_CHALLENGES" id="..."
wrangler r2 bucket create personal-space-thumbs
#   bucket_name = "personal-space-thumbs"   (already in wrangler.toml)

# 3. Apply migrations
npm run migrate:local      # for `wrangler dev`
npm run migrate:remote     # for production

# 4. Secrets
wrangler secret put ANTHROPIC_API_KEY     # LLM proxy
wrangler secret put SESSION_SECRET        # 32+ random bytes, e.g.
                                          # `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
wrangler secret put RESEND_API_KEY        # magic-link sender

# 5. Deploy
wrangler deploy
```

The `LLM_CACHE` KV namespace from the original LLM-only worker is reused — its id stays in `wrangler.toml`.

### Email setup (Resend)

Magic links go through [Resend](https://resend.com/). After signing up:

1. Verify the `personalspace.fun` sender domain in Resend's dashboard.
2. Add the DKIM + SPF DNS records Resend gives you. Since the DNS is already in Cloudflare, this is two clicks.
3. Confirm the verified `from` address matches `RESEND_FROM` in `wrangler.toml` (defaults to `noreply@personalspace.fun`).
4. `wrangler secret put RESEND_API_KEY` with the key from Resend.

Resend's free tier (3k/mo) covers thousands of MAU. Cloudflare Email Service is a future migration path once the project is on the Workers Paid plan.

## Local dev

```
npm run dev   # wrangler dev --port 8787
```

The game's Vite dev server (`npm run dev` at the repo root) proxies `/api/*` and `/tier*` to `localhost:8787`, so the browser sees same-origin requests and cookies flow naturally without `SameSite=None` hacks.

Local secrets live in `worker/.dev.vars` (gitignored). Set at least:

```
SESSION_SECRET=<random>
RESEND_API_KEY=re_local_placeholder      # any string; emails won't actually send locally
ANTHROPIC_API_KEY=...                    # only needed if you want LLM calls in dev
```

Local D1 + R2 + KV are file-backed in `.wrangler/state/` — you can `rm -rf` it to start fresh.

## Endpoints

### LLM proxy

| Route | Model | Body | Returns |
| --- | --- | --- | --- |
| `POST /concept` | `claude-haiku-5-5` | `{ system_seed, planet_index, radius }` | the planet concept |
| `POST /tier2/direct` (alias `/tier2`) | `claude-sonnet-4-6` | `{ seed, context: { radius, tier, concept } }` | full planet meta + creative direction |
| `POST /tier2/pick` | `claude-haiku-5-5` | `{ seed, direction, shortlist, shortlist_meta }` | asset ids per slot |
| `POST /tier3` | `claude-sonnet-4-6` | `{ seed, context: { name, biome, landmarks, concept, tier, mounted } }` | surface lore + landmark blurbs |
| `GET /assets/search?q=` | (Poly Pizza) | | CC0 search results |

`/concept` ignores any client `seed`/`context` and derives both from `(system_seed, planet_index)` with `shared/planet-dice.js`. The other contexts are reduced to an allowlist with length caps (`src/lib/llm-context.js`) before they reach the prompt or the cache key. Responses carry `x-cache: hit|miss`. `/tier1` was removed (the concept call replaced it).

### Spend guard

Every route above runs behind `llmGuard` (`src/lib/llm-guard.js`):

1. **Auth.** A valid session cookie (every visitor gets an anonymous one from `POST /api/auth/anonymous`), or an `x-dev-key` header equal to the `DEV_LLM_KEY` secret (honoured only when that secret is set and at least 16 characters). Otherwise `401 {error:'unauthenticated'}`.
2. **Rate limits.** `LLM_LIMITER` (60/min per user or dev key) and `LLM_IP_LIMITER` (120/min per IP). Over either: `429 {error:'rate_limited'}`, `retry-after: 60`.
3. **Body cap.** Over 16 KB: `413`.

Then, per request: a KV cache hit is always served (it costs nothing). Only on a miss does the worker check the **daily budget**: once the UTC day's spend in `llm_usage` reaches `DAILY_BUDGET_USD` (`wrangler.toml`, default `3.70`), uncached calls answer `503 {error:'budget_exhausted', degraded:true}` with `retry-after` set to the seconds until UTC midnight. The client treats any non-2xx as "use the offline generator", so the player gets a quieter planet, never an error. Unset or `<= 0` disables the breaker.

Every Anthropic response's `usage` is priced (`src/lib/budget.js`, `PRICES`) and upserted into D1 `llm_usage` (one row per day × route × model: calls, cache hits, errors, token counts, `cost_usd`). Each isolate re-reads the day's total every 30 s and adds its own spend immediately, so a burst can overshoot by up to ~30 s of traffic per isolate. If D1 is unreachable the breaker fails **open**; the hard backstop is the monthly spend limit on the API key's workspace in the Anthropic Console.

**Deploying it (owner):**

```bash
cd worker
npx wrangler d1 migrations apply personal-space --remote   # creates llm_usage (0003)
npx wrangler deploy
npx wrangler secret put DEV_LLM_KEY                        # optional; >= 16 chars, for scripts/benches
```

The client must send the session cookie (`credentials: 'include'`) and the new `/concept` body, or every LLM call falls back offline.

**Reading usage:**

```bash
npm run usage          # per day / route / model, newest first (60 rows)
npm run usage:today    # today's total (UTC)
```

or directly: `SELECT SUM(cost_usd) FROM llm_usage WHERE day = 'YYYY-MM-DD'`.

**Local testing without spend:** `node test/mock-anthropic.mjs` serves canned Messages responses on port 8799; point the worker at it with `npx wrangler dev --port 8797 --var ANTHROPIC_API_URL:http://127.0.0.1:8799/v1/messages --var ANTHROPIC_API_KEY:test`.

### Auth

| Route | Notes |
| --- | --- |
| `POST /api/auth/anonymous` | Mints an anonymous user + session cookie. Per-IP rate-limited. |
| `GET  /api/auth/me` | Current user, or 401. |
| `POST /api/auth/logout` | Drops session row + clears cookie. |
| `POST /api/auth/passkey/register/options` | WebAuthn registration ceremony. Requires session. |
| `POST /api/auth/passkey/register/verify` | Persists the credential. |
| `POST /api/auth/passkey/login/options` | Discoverable login. No session required. |
| `POST /api/auth/passkey/login/verify` | Verifies + creates session. Anonymous → known merge happens here. |
| `POST /api/auth/email/request` | Issues a magic link via Resend. Per-email + per-IP rate-limited. |
| `GET  /api/auth/email/verify?token=...` | Endpoint the email link points at. Sets session cookie, 302s to game with `?signin=ok`. |
| `POST /api/auth/email/verify` | Same but JSON; used by an in-page paste flow. |

### Logbook

| Route | Notes |
| --- | --- |
| `GET  /api/logbook` | All entries for the current user, newest first. |
| `POST /api/logbook` | Upsert by `(user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index)`. Idempotent — duplicate POST returns canonical id with `canonical: true`. |
| `PATCH /api/logbook/:id` | Backfill lore + landmarks + stats. |
| `DELETE /api/logbook/:id` | Drop one entry; best-effort cleans the R2 thumbnail. |
| `PUT /api/logbook/:id/thumb` | `image/jpeg` body. Magic-byte check + 150KB cap. |
| `GET /api/logbook/:id/thumb` | Reads from R2 with `Cache-Control: immutable`. |

### Account

| Route | Notes |
| --- | --- |
| `GET  /api/account/export` | JSON dump (downloadable). |
| `POST /api/account/delete` | CASCADE deletes the user; cleans up R2 thumbnails. |

## Bindings

| Binding | Resource | Used for |
| --- | --- | --- |
| `DB` | D1 (`personal-space`) | users, sessions, passkeys, email_tokens, entries |
| `THUMBS` | R2 (`personal-space-thumbs`) | logbook entry thumbnails |
| `LLM_CACHE` | KV | LLM response cache (existing) |
| `AUTH_CHALLENGES` | KV | short-lived WebAuthn challenges (5-min TTL) |
| `AUTH_LIMITER` | Rate Limit | per-IP cap on `/api/auth/*` |
| `EMAIL_LIMITER` | Rate Limit | per-email cap on magic-link requests |
| `THUMB_LIMITER` | Rate Limit | per-user cap on thumbnail uploads |
| `LLM_LIMITER` | Rate Limit | per-user (or dev key) cap on LLM routes + `/assets/search` |
| `LLM_IP_LIMITER` | Rate Limit | per-IP cap on the same routes |
| `ANTHROPIC_API_KEY` | Secret | LLM proxy |
| `SESSION_SECRET` | Secret | HMAC over session ids |
| `RESEND_API_KEY` | Secret | magic-link sender |
| `DEV_LLM_KEY` | Secret (optional) | `x-dev-key` access to the LLM routes |
| `DAILY_BUDGET_USD` | Var | daily LLM spend breaker |
| `ANTHROPIC_API_URL` | Var (optional) | Messages endpoint override, for local mocks |

The Rate Limit binding's `period` is restricted to 10 or 60 seconds; longer windows would need a Durable Object token bucket. The current per-minute limits comfortably catch abuse; revisit if hot-path abuse shows up.

## Schema

Accounts and logbook live in `worker/migrations/0001_init.sql` (plus `0002_user_position.sql`); the LLM spend ledger `llm_usage` is `0003_llm_usage.sql`:

- `users (id, email, anonymous, created_at, last_seen_at, claim_count)`
- `sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)`
- `passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at, last_used_at)`
- `email_tokens (token_hash, email, user_id, purpose, created_at, expires_at, used_at)`
- `entries (id, user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index, planet_seed, planet_name, biome, palette, landmarks, lore, lore_status, thumbnail_key, stat_*, legacy, claimed_at, updated_at)` with `UNIQUE (user_id, galaxy_seed, cell_x, cell_y, cell_z, planet_index)` as the canonical dedupe key.

Add a new migration with `wrangler d1 migrations create personal-space <name>`.

## Cron

`wrangler.toml` declares `crons = ["0 3 * * *"]`. The `scheduled` handler in `src/index.js` runs daily at 03:00 UTC and:

1. Deletes anonymous users with `claim_count = 0` older than 30 days (CASCADE clears their rows).
2. Purges expired session rows.

Trigger a one-off run for testing with `wrangler dev --test-scheduled` and then `curl http://localhost:8787/__scheduled`.

## CORS / origin allowlist

`ALLOWED_ORIGINS` in `wrangler.toml` is comma-separated. Hono's CORS middleware echoes the specific matched origin (not `*`) and sets `Access-Control-Allow-Credentials: true`. Add any new deployed origin or local dev URL there.
