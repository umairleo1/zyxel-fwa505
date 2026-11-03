import { CATALOG, LIVE_IDS } from './catalog.js';
import { maskSecrets } from './secrets.js';

/**
 * Cached, single-flight access to catalog endpoints over the collector's
 * router session. Never logs in while the collector is paused or halted, so
 * "Pause" really frees the router for its own admin page.
 */
export function createRouterData({ client, collector, liveTtlMs = 15_000, configTtlMs = 5 * 60_000 }) {
  const cache = new Map(); // path -> { at, raw }
  const inflight = new Map();
  // Every successful router read (collector, samplers, pages) lands in one cache,
  // so a page asking for `status` right after the collector polled it costs nothing.
  client.onResponse = (path, raw) => cache.set(path, { at: Date.now(), raw });
  const ttlFor = (id) => (LIVE_IDS.has(id) ? liveTtlMs : configTtlMs);

  async function fetchPath(path, maxAgeMs) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit;
    const phase = collector.state.phase;
    if (phase === 'paused' || phase === 'halted') {
      if (hit) return { ...hit, stale: true };
      const e = new Error(phase === 'paused' ? 'Collector is paused; resume it to read live router data' : 'Router login is halted');
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
    has: (id) => Object.hasOwn(CATALOG, id),
    ids: () => Object.keys(CATALOG),

    /** Unwrapped, unmasked data for server-side use (audits, samplers). */
    async raw(id, maxAgeMs = ttlFor(id)) {
      const def = CATALOG[id];
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
