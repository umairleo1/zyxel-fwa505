// Request guards for the dashboard: Host allowlist, security headers, Basic auth and CSRF.
// Insight reads a router full of personal data, so even on a LAN only expected
// browsers on expected names may talk to it.
import crypto from 'node:crypto';
import os from 'node:os';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** "Host" or URL authority -> bare lowercase hostname ("[::1]:4400" -> "::1"). */
export function hostnameOf(host) {
  if (!host) return '';
  let h = String(host).trim().toLowerCase();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'));
  else if (h.split(':').length === 2) h = h.split(':')[0]; // name:port (a bare IPv6 has several colons)
  return h.replace(/\.$/, '').replace(/%.*$/, ''); // trailing dot, IPv6 zone id
}

/** True for 127.0.0.0/8, ::1, IPv4-mapped loopback and "localhost". */
export function isLoopback(addr) {
  const h = hostnameOf(addr).replace(/^::ffff:/, '');
  return LOOPBACK_NAMES.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Every name this machine may legitimately be reached by. */
export function allowedHostnames({ httpHost, extra = [], interfaces = os.networkInterfaces(), hostname = os.hostname() } = {}) {
  const set = new Set(LOOPBACK_NAMES);
  if (httpHost && httpHost !== '0.0.0.0' && httpHost !== '::') set.add(hostnameOf(httpHost));
  for (const a of Object.values(interfaces).flat()) if (a?.address) set.add(hostnameOf(a.address));
  if (hostname) {
    const h = hostname.toLowerCase();
    set.add(h);
    // macOS reports "name.local" already; other systems need the mDNS suffix added.
    set.add(h.endsWith('.local') ? h.slice(0, -6) : `${h}.local`);
  }
  for (const h of extra) set.add(hostnameOf(h));
  set.delete('');
  return set;
}

/** allowedHostnames(), recomputed at most once a minute so a new DHCP lease is picked up. */
export function liveAllowedHostnames(opts, ttlMs = 60e3) {
  let cached = null;
  let at = 0;
  return () => {
    if (!cached || Date.now() - at > ttlMs) {
      cached = allowedHostnames(opts);
      at = Date.now();
    }
    return cached;
  };
}

/**
 * Reject requests whose Host header is not one of ours. A DNS-rebinding page
 * reaches us with its own name in Host, so this runs before everything else.
 * `allowed` is a Set or a function returning one.
 */
export const hostGuard = (allowed) => (req, res, next) => {
  const set = typeof allowed === 'function' ? allowed() : allowed;
  if (set.has(hostnameOf(req.headers.host))) return next();
  res.status(421).type('text/plain').send('Unknown host name. Add it to ALLOWED_HOSTS if it is yours.\n');
};

// React sets style attributes (inline styles), and there are no inline scripts.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const securityHeaders = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** Password from an "Authorization: Basic ..." header (the username is ignored), or null. */
export function basicPassword(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i === -1 ? null : decoded.slice(i + 1);
}

/** Constant-time comparison: hashing first makes the lengths equal. */
export const passwordMatches = (given, expected) => given != null && crypto.timingSafeEqual(sha256(given), sha256(expected));

/**
 * HTTP Basic auth for everything (API, SSE, static files). Browsers prompt once
 * and resend the credentials on same-origin fetch/EventSource. `exempt(req)`
 * lets local monitoring reach /api/health without the password.
 */
export const basicAuth = ({ password, exempt = () => false }) => {
  if (!password) return (_req, _res, next) => next();
  return (req, res, next) => {
    if (exempt(req) || passwordMatches(basicPassword(req.headers.authorization), password)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Zyxel Insight", charset="UTF-8"');
    res.status(401).type('text/plain').send('Authentication required.\n');
  };
};

export const CSRF_HEADER = 'x-insight-request';

/**
 * State-changing requests must carry `X-Insight-Request: 1` (a cross-site form or
 * no-cors fetch cannot set it) and, if the browser sent Origin, come from our own host.
 */
export const csrfGuard = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers[CSRF_HEADER] !== '1') return res.status(403).json({ error: 'Missing X-Insight-Request header' });
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = null; // "null" or garbage: treated as cross-site
    }
    if (originHost !== String(req.headers.host ?? '').toLowerCase()) {
      return res.status(403).json({ error: 'Cross-origin request refused' });
    }
  }
  next();
};
