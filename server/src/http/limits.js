// Caps that keep a browser (or a script with the password) from turning the
// dashboard into a load generator against the router.

export const MAX_ROUTER_IDS = 30; // the busiest page asks for ~10
export const ROUTER_FRESH_MS = 10e3;
export const INSIGHTS_FRESH_MS = 30e3;
export const MAX_SSE_CLIENTS = 20;

/**
 * allow(key) is true at most once per `ms` for each key; callers serve the
 * cached value otherwise. Keys must come from a bounded set.
 */
export function createFreshGate(ms, now = () => Date.now()) {
  const last = new Map();
  return {
    allow(key) {
      const t = now();
      if (t - (last.get(key) ?? -Infinity) < ms) return false;
      last.set(key, t);
      return true;
    },
  };
}
