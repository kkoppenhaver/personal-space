# Personal Space LLM Worker

Cloudflare Worker that proxies LLM calls for Personal Space. Holds the Anthropic API key, enforces JSON schemas via tool-use, and caches responses in Workers KV so revisits to a planet return identical names/lore.

## Setup

```
cd worker
wrangler login                         # opens browser; OAuth into your CF account
wrangler kv namespace create LLM_CACHE
# Wrangler prints something like:
#   [[kv_namespaces]]
#   binding = "LLM_CACHE"
#   id = "abc123..."
# Paste those 3 lines into wrangler.toml (replacing the commented-out block)
wrangler secret put ANTHROPIC_API_KEY
# paste your Anthropic API key when prompted (input is hidden)
wrangler deploy
```

Production deploys hit `https://api.personalspace.fun` via the custom-domain route in `wrangler.toml`. Workers Builds (Cloudflare's GitHub integration) handles `git push` deploys.

The game runs fine without a worker — it falls back to deterministic placeholder content. In dev you can override the production URL with `?worker=http://localhost:8787` or `localStorage.setItem('paper-airplane:worker', 'https://...')`.

## Endpoints

- `POST /tier1` → Haiku — `{ teaser }`
- `POST /tier2` → Sonnet — full planet meta
- `POST /tier3` → Sonnet (more tokens) — surface lore + landmark blurbs

All take `{ seed, context }`. Cache key includes a hash of `context` so identical inputs return identical cached output.

## Local dev

```
wrangler dev --port 8787
# then in the game URL: ?worker=http://localhost:8787
```

## CORS / origin allowlist

`wrangler.toml` defines `ALLOWED_ORIGINS` (comma-separated). Add your deployed game origin and any local dev URLs.
