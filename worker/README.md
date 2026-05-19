# paper-airplane LLM Worker

Cloudflare Worker that proxies LLM calls for the paper-airplane game. Holds the Anthropic API key, enforces JSON schemas via tool-use, and caches responses in Workers KV so revisits to a planet return identical names/lore.

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

After `wrangler deploy` you'll see a URL like `https://paper-airplane-llm.<your-account>.workers.dev`. Copy it.

After deploy, copy the worker URL (e.g. `https://paper-airplane-llm.your-account.workers.dev`) and either:

- Append `?worker=https://...` to the game URL, or
- `localStorage.setItem('paper-airplane:worker', 'https://...')` in the dev console.

The game runs fine without a worker — it falls back to deterministic placeholder content.

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
