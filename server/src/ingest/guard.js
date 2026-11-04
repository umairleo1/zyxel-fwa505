// Abuse limits for the UDP listeners. They bind to all interfaces (the router must
// reach them) and UDP has no handshake, so anyone on the LAN could otherwise fill
// the log database or flood the console.
import dns from 'node:dns/promises';
import net from 'node:net';

// Rows stored per minute. The FWA505 writes a few lines a minute even when busy;
// a boot burst stays well under these.
export const SYSLOG_ROWS_PER_MIN = 600;
export const TRAPS_PER_MIN = 60;

/** "::ffff:192.168.1.1" -> "192.168.1.1", lowercase IPv6. */
export const normalizeIp = (a) =>
  String(a ?? '')
    .toLowerCase()
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

const isLoopbackIp = (a) => a === '::1' || /^127\./.test(a);

/**
 * Source filter: allows(address) is true for loopback, any listed IP, and the
 * addresses `names` resolve to (resolved in the background; until then only
 * literal IPs pass). "*" in the list allows everyone.
 */
export function createSourceFilter(entries, { lookup = (h) => dns.lookup(h, { all: true }), log = console } = {}) {
  const ips = new Set();
  const any = entries.includes('*');
  const ready = Promise.all(
    entries
      .filter((e) => e !== '*')
      .map(async (e) => {
        if (net.isIP(e)) return ips.add(normalizeIp(e));
        try {
          for (const { address } of await lookup(e)) ips.add(normalizeIp(address));
        } catch (err) {
          log.warn(`[ingest] could not resolve allowed source ${e}: ${err.message}`);
        }
      }),
  );
  return {
    ready,
    ips,
    allows(address) {
      const a = normalizeIp(address);
      return any || isLoopbackIp(a) || ips.has(a);
    },
  };
}

/** The default allowlist: the router named in ROUTER_URL. */
export function defaultSources(routerUrl) {
  try {
    return [new URL(routerUrl).hostname.replace(/^\[|\]$/g, '')];
  } catch {
    return [];
  }
}

/** Fixed one-minute window: take() is false once `perMin` is used up. */
export function createRateLimit(perMin, now = () => Date.now()) {
  let windowStart = -Infinity;
  let used = 0;
  return {
    take() {
      const t = now();
      if (t - windowStart >= 60e3) {
        windowStart = t;
        used = 0;
      }
      if (used >= perMin) return false;
      used++;
      return true;
    },
  };
}

/**
 * warn(reason, message): logs at most once per `ms` per reason, with a count of
 * what was suppressed since, so a flood can't flood the journal too.
 */
export function createWarnThrottle(log = console, ms = 60e3, now = () => Date.now()) {
  const seen = new Map(); // reason -> { at, suppressed }
  return (reason, message) => {
    const t = now();
    const s = seen.get(reason);
    if (s && t - s.at < ms) {
      s.suppressed++;
      return;
    }
    const extra = s?.suppressed ? ` (${s.suppressed} similar suppressed)` : '';
    seen.set(reason, { at: t, suppressed: 0 });
    log.warn(`${message}${extra}`);
  };
}
