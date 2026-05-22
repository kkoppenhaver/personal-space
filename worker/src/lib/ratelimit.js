// Thin wrapper over the Workers Rate Limit binding. The bindings are declared
// in wrangler.toml; this module just normalizes the call sites and provides a
// no-op fallback when the binding isn't present (e.g., in some preview envs).

export async function rateLimit(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return { success: true };
  try {
    return await binding.limit({ key });
  } catch {
    return { success: true }; // never fail-closed on the limiter itself
  }
}
