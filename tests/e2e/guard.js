// Shared browser-test plumbing: offline guard + error collection.
//
// THE CONSOLE-ERROR ALLOWLIST LIVES HERE. Every entry needs a reason; remove
// entries when their cause is fixed.

// Never reach a real LLM, the production worker, or Poly Pizza from a test.
const FORBIDDEN_HOSTS = [
  /(^|\.)personalspace\.fun$/,
  /(^|\.)anthropic\.com$/,
  /(^|\.)poly\.pizza$/,
];

// The MiniLM embedding model (AssetRetriever → transformers.js) downloads
// ~22 MB from the Hugging Face hub (+ LFS/xet CDNs) and the ORT wasm from
// jsDelivr. Blocked so tests are fast and deterministic.
const MODEL_HOSTS = [
  /(^|\.)huggingface\.co$/,
  /(^|\.)hf\.co$/,
  /^cdn\.jsdelivr\.net$/,
];

/**
 * Console errors that are known, understood noise. Matched against
 * "<message text> @ <source url>" so a resource error is only allowed for
 * the URLs it is expected on (a 404 for a GLB still fails the test).
 */
export const CONSOLE_ERROR_ALLOWLIST = [
  // No worker in offline mode: /api/* (auth, logbook sync) hits vite
  // preview, which answers 404 (GET/POST) or 501 (PATCH after a claim).
  /^Failed to load resource: the server responded with a status of (404|501) .* @ http:\/\/127\.0\.0\.1:\d+\/api\//,
  // The blocked embedding-model hosts (MODEL_HOSTS above).
  /^Failed to load resource: net::ERR_FAILED @ https:\/\/([^/]*\.)?(huggingface\.co|hf\.co)\//,
  /^Failed to load resource: net::ERR_FAILED @ https:\/\/cdn\.jsdelivr\.net\//,
  // TODO(Phase 1a): remove — 100 Kenney GLBs reference a colormap.png that is
  // not shipped (roadmap finding 1). Phase 1a bakes colours at import.
  /^THREE\.GLTFLoader: Couldn't load texture .*Textures\/colormap\.png @ /,
  /^Failed to load resource: .* @ http:\/\/127\.0\.0\.1:\d+\/assets\/bundled\/kenney\/.*\/Textures\/colormap\.png$/, // TODO(Phase 1a): same
];

/**
 * Install the offline guard and start collecting page errors + console
 * errors. Returns a handle whose `unexpected()` lists anything not on the
 * allowlist, and `forbidden` lists any request the guard had to abort.
 */
export async function armPage(page, { blockModel = true } = {}) {
  const state = { pageErrors: [], consoleErrors: [], forbidden: [], modelBlocked: 0 };

  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (FORBIDDEN_HOSTS.some((re) => re.test(url.hostname))) {
      state.forbidden.push(url.href);
      return route.abort('blockedbyclient');
    }
    if (blockModel && MODEL_HOSTS.some((re) => re.test(url.hostname))) {
      state.modelBlocked++;
      return route.abort('failed');
    }
    return route.continue();
  });

  page.on('pageerror', (err) => state.pageErrors.push(String(err?.stack || err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') state.consoleErrors.push(`${msg.text()} @ ${msg.location()?.url || ''}`);
  });

  return {
    state,
    unexpectedConsoleErrors() {
      return state.consoleErrors.filter((t) => !CONSOLE_ERROR_ALLOWLIST.some((re) => re.test(t)));
    },
  };
}
