import { CATALOG, LIVE_IDS } from './catalog.js';
import { maskSecrets } from './secrets.js';

/**
 * Cached, single-flight access to catalog endpoints over the collector's
 * router session. Only reads from the router while the collector is healthy:
 * paused/halted means hands off, and during backoff (router unreachable, login
 * refused, another session active) the samplers and pages must not log in on
 * their own and burn the router's 3-attempt lockout budget.
 */
const READABLE = new Set(['ok', 'starting']);

export function createRouterData({ client, collector, liveTtlMs = 15_000, configTtlMs = 5 * 60_000 }) {
  const cache = new Map(); // path -> { at, raw }
  const inflight = new Map();
  // Every successful router read (collector, samplers, pages) lands in one cache,
  // so a page asking for `status` right after the collector polled it costs nothing.
  client.onResponse = (path, raw) => cache.set(path, { at: Date.now(), raw });
  const ttlFor = (id) => (LIVE_IDS.has(id) ? liveTtlMs : configTtlMs);

  // Own keys only: "constructor" or "toString" must not resolve to a catalog entry.
  const known = (id) => typeof id === 'string' && Object.hasOwn(CATALOG, id);

  async function fetchPath(path, maxAgeMs) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit;
    const phase = collector.state.phase;
    if (!READABLE.has(phase)) {
      if (hit) return { ...hit, stale: true };
      const why = {
        paused: 'Collector is paused; resume it to read live router data',
        halted: 'Router login is halted',
        backoff: 'Router is unavailable; waiting for the collector to reconnect',
      };
      const e = new Error(why[phase] ?? `Collector is ${phase}`);
      e.status = 409;
      throw e;
    }
    if (!inflight.has(path)) {
      inflight.set(
        path,
        client
          .getJson(path)
          .then(() => cache.get(path)) // filled by client.onResponse
          .finally(() => inflight.delete(path)),
      );
    }
    return inflight.get(path);
  }

  return {
    has: (id) => known(id),
    ids: () => Object.keys(CATALOG),

    /** Unwrapped, unmasked data for server-side use (audits, samplers). */
    async raw(id, maxAgeMs = ttlFor(id)) {
      const def = known(id) ? CATALOG[id] : null;
      if (!def) throw Object.assign(new Error(`Unknown endpoint ${id}`), { status: 404 });
      const entry = await fetchPath(def.path, maxAgeMs);
      return { at: entry.at, stale: !!entry.stale, data: def.unwrap(entry.raw) };
    },

    /** Masked data for the browser. */
    async public(id, maxAgeMs = ttlFor(id)) {
      const r = await this.raw(id, maxAgeMs);
      return { id, fetchedAt: r.at, stale: r.stale, data: maskSecrets(r.data) };
    },
  };
}
