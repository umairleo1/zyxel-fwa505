import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { RequestQueue } from './queue.js';

const LOAD_WINDOW_MS = 60_000;
// The router locks the admin account for 5 minutes after 3 wrong passwords. Never
// make a third attempt inside that window, whatever the router's replies look like.
const LOCKOUT_WINDOW_MS = 5 * 60_000;
const MAX_FAILED_LOGINS = 2;
// After "duplicated login" / "too many sessions", give the other session time to end.
const SESSION_CONFLICT_BACKOFF_MS = 5 * 60_000;
// Wording the router uses for a wrong password, when it doesn't answer 401/403.
const BAD_PASSWORD = /passw|incorrect|invalid|wrong|locked|denied|fail/i;
// Idle time between back-to-back requests, so the router's own admin page gets a turn.
const REQUEST_GAP_MS = 250;
// The SMS write path (see #isSmsWrite): these methods, and only these query parameters.
const SMS_METHODS = new Set(['POST', 'PUT', 'DELETE']);
const SMS_PARAMS = new Set(['oid', 'sessionkey', 'timedelay', 'objIndex']);
// The band-selection write path (see #isBandWrite): a PUT with nothing but these on the URL.
const BAND_PARAMS = new Set(['oid', 'sessionkey']);

export class RouterError extends Error {
  /** kind: network | auth | duplicate | max-sessions | session | http | tls | paused */
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// GET responses from the router are JSON with HTML entities escaped; the
// router's own UI undoes this before using them.
const unescapeHtml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const unescapeDeep = (v) =>
  typeof v === 'string'
    ? unescapeHtml(v)
    : Array.isArray(v)
      ? v.map(unescapeDeep)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unescapeDeep(x)]))
        : v;

const tryJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Trust-on-first-use check of the router's certificate fingerprint. Pure.
 * Returns { error } to refuse, { pin } to store a first fingerprint, and
 * { pending } (with the error) for a changed one the user may accept via Retry.
 */
export function checkPinnedCertificate(pinned, fingerprint) {
  if (!fingerprint) return { error: new RouterError('tls', 'Router presented no TLS certificate') };
  if (!pinned) return { error: null, pin: fingerprint };
  if (pinned === fingerprint) return { error: null };
  return {
    pending: fingerprint,
    error: new RouterError(
      'tls',
      `The router's TLS certificate changed (pinned …${pinned.slice(-14)}, now …${fingerprint.slice(-14)}). ` +
        'Something may be intercepting the connection. If you just reset or updated the router, press Retry to trust the new certificate.',
    ),
  };
}

/** Process-lifetime certificate pin, used when no persistent store is given. */
const memoryPin = () => {
  let value = null;
  return { get: () => value, set: (v) => (value = v) };
};

/** Drop entries older than the load window from the front of a time-ordered list. */
function trim(list, timeOf, now) {
  while (list.length && timeOf(list[0]) < now - LOAD_WINDOW_MS) list.shift();
}

/**
 * Read-only client for the FWA505 web API. The only non-GET calls it will make are
 * login, logout and, when enabled, SMS (cellwan_sms) and band selection (cellwan_band);
 * everything else is refused.
 */
export class RouterClient {
  /**
   * certPin: { get(), set(sha256) } store for the router's TLS certificate
   * fingerprint (trust on first use). Defaults to memory only.
   */
  constructor({
    baseUrl,
    username,
    password,
    requestGapMs = REQUEST_GAP_MS,
    certPin = memoryPin(),
    allowSms = false,
    allowBandSelection = false,
  }) {
    this.base = new URL(baseUrl);
    this.mod = this.base.protocol === 'https:' ? https : http;
    // The exceptions to read-only, each only when enabled: SMS writes (see #isSmsWrite)
    // and the band selection (see #isBandWrite).
    this.allowSms = allowSms;
    this.allowBandSelection = allowBandSelection;
    // No keep-alive: the router drops idle connections between our polls, and
    // reusing a dead socket fails with "socket hang up".
    this.agent = new this.mod.Agent({ keepAlive: false, rejectUnauthorized: false });
    // The router's certificate is self-signed, so CA validation can't work. Pin its
    // fingerprint instead: a different certificate means interception (or a reset
    // router) and halts the collector before the password is sent.
    this.certPin = certPin;
    this.pendingCert = null;
    if (this.mod === https) this.agent.createConnection = (options, oncreate) => this.#connectPinned(options, oncreate);
    // Login safety (see LOCKOUT_WINDOW_MS). suspended: paused by the user, no traffic at all.
    this.suspended = false;
    this.loginBlock = null; // { kind, message, until } after a refused login; until null = until resume()
    this.failedLogins = []; // timestamps of failed attempts
    this.username = username;
    this.password = password;
    this.cookies = new Map();
    this.sessionKey = null;
    // Requests run one at a time (see queue.js); the live signal read jumps the queue.
    this.queue = new RequestQueue({ gapMs: requestGapMs, onRun: ({ waitMs }) => this.#recordWait(waitMs) });
    /** Called with (path, parsedJson) after every successful GET, so caches can share results. */
    this.onResponse = null;
    // Load accounting: every request we make to the router is counted here.
    // recent: [startedAt, endedAt] per request; waits: [at, ms] per queued job (last minute each).
    this.stats = { since: Date.now(), requests: 0, bytes: 0, errors: 0, logins: 0, busyMs: 0, byPath: {}, recent: [], waits: [] };
    this.inFlightSince = null;
  }

  #recordWait(ms) {
    const now = Date.now();
    this.stats.waits.push([now, ms]);
    trim(this.stats.waits, (w) => w[0], now);
  }

  #record(path, ms, bytes, ok) {
    const key = path.replace(/^\/cgi-bin\//, '').replace(/([?&](iid|sessionkey)=)[^&]*/g, '$1…');
    const s = this.stats;
    s.requests++;
    s.bytes += bytes;
    if (!ok) s.errors++;
    const p = (s.byPath[key] ??= { count: 0, bytes: 0, totalMs: 0, maxMs: 0 });
    p.count++;
    p.bytes += bytes;
    p.totalMs += ms;
    p.maxMs = Math.max(p.maxMs, ms);
    s.busyMs += ms;
    const now = Date.now();
    s.recent.push([now - ms, now]);
    trim(s.recent, (r) => r[1], now);
  }

  /**
   * Load we put on the router. busyPct is the share of the last minute it spent
   * answering Insight: requests never overlap, so their durations add up exactly.
   */
  loadSnapshot() {
    const s = this.stats;
    const now = Date.now();
    trim(s.recent, (r) => r[1], now);
    trim(s.waits, (w) => w[0], now);
    const windowStart = now - LOAD_WINDOW_MS;
    const windowMs = Math.min(LOAD_WINDOW_MS, now - s.since) || 1;
    const spans = this.inFlightSince ? [...s.recent, [this.inFlightSince, now]] : s.recent;
    const busyInWindow = spans.reduce((a, [start, end]) => a + (end - Math.max(start, windowStart)), 0);
    const waitMs = s.waits.map((w) => w[1]);
    const mins = Math.max(1 / 60, (now - s.since) / 60_000);
    return {
      busyPct: Math.round((busyInWindow / windowMs) * 1000) / 10,
      avgBusyPct: Math.round((s.busyMs / (now - s.since || 1)) * 1000) / 10,
      queueWaitMs: waitMs.length ? { avg: Math.round(waitMs.reduce((a, b) => a + b, 0) / waitMs.length), max: Math.max(...waitMs) } : null,
      queued: this.queue.size,
      perMinute: s.recent.length,
      avgPerMinute: Math.round((s.requests / mins) * 10) / 10,
      requests: s.requests,
      bytes: s.bytes,
      errors: s.errors,
      logins: s.logins,
      since: s.since,
      avgMs: s.requests ? Math.round(Object.values(s.byPath).reduce((a, p) => a + p.totalMs, 0) / s.requests) : null,
      endpoints: Object.entries(s.byPath)
        .map(([path, p]) => ({
          path,
          count: p.count,
          perMinute: Math.round((p.count / mins) * 10) / 10,
          avgBytes: Math.round(p.bytes / p.count),
          avgMs: Math.round(p.totalMs / p.count),
          maxMs: p.maxMs,
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  #serial(fn, priority = 'normal') {
    return this.queue.run(fn, { priority });
  }

  get hasSession() {
    return this.sessionKey !== null;
  }

  /** Stop all router traffic (Pause): queued and new requests fail fast and nothing logs in again. */
  suspend() {
    this.suspended = true;
  }

  /**
   * Allow traffic again (Resume / Retry). Clears a block left by a refused login,
   * but not the failure history: the lockout guard still applies.
   * trustNewCertificate: accept the certificate that last failed the pin check.
   */
  resume({ trustNewCertificate = false } = {}) {
    this.suspended = false;
    this.loginBlock = null;
    if (trustNewCertificate && this.pendingCert) {
      this.certPin.set(this.pendingCert);
      this.pendingCert = null;
    }
  }

  #connectPinned(options, oncreate) {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    socket.once('secureConnect', () => {
      const err = this.#checkCertificate(socket.getPeerCertificate()?.fingerprint256);
      if (err) {
        socket.destroy();
        oncreate(err);
      } else oncreate(null, socket);
    });
    socket.once('error', (e) => oncreate(e)); // the agent ignores a second callback
  }

  #checkCertificate(fingerprint) {
    const { error, pin, pending } = checkPinnedCertificate(this.certPin.get(), fingerprint);
    if (pin) this.certPin.set(pin);
    if (pending) this.pendingCert = pending;
    return error;
  }

  #paused() {
    return new RouterError('paused', 'Collector is paused; router traffic is suspended', 409);
  }

  /** Refuse a login that could lock the account or that a previous reply already ruled out. */
  #checkLoginAllowed(now) {
    if (this.loginBlock && (this.loginBlock.until === null || now < this.loginBlock.until)) {
      throw new RouterError(this.loginBlock.kind, this.loginBlock.message);
    }
    this.loginBlock = null;
    this.failedLogins = this.failedLogins.filter((t) => t > now - LOCKOUT_WINDOW_MS);
    if (this.failedLogins.length >= MAX_FAILED_LOGINS) {
      const waitMin = Math.ceil((this.failedLogins[0] + LOCKOUT_WINDOW_MS - now) / 60_000);
      throw new RouterError(
        'auth',
        `${this.failedLogins.length} failed logins in the last 5 minutes; not trying again for ${waitMin} min so the router doesn't lock the account`,
      );
    }
  }

  login() {
    return this.#serial(() => this.#login());
  }

  async #login() {
    if (this.suspended) throw this.#paused();
    const now = Date.now();
    this.#checkLoginAllowed(now);
    this.stats.logins++;
    this.cookies.clear();
    this.sessionKey = null;
    // The UI fetches the RSA key first; payloads are only encrypted over plain
    // HTTP, but call it anyway to match the real login sequence.
    await this.#request('GET', '/getRSAPublickKey');
    const res = await this.#request('POST', '/UserLogin', {
      Input_Account: this.username,
      Input_Passwd: Buffer.from(this.password, 'utf8').toString('base64'),
      currLang: 'en',
      RememberPassword: 0,
      SHA512_password: false,
    });
    const data = tryJson(res.text);
    if (res.status === 200 && data?.sessionkey) {
      this.sessionKey = String(data.sessionkey);
      this.failedLogins = [];
      return data;
    }
    throw this.#loginFailure(res, data, now);
  }

  /** Classify a refused login and remember what it means for the next attempt. */
  #loginFailure(res, data, now) {
    const detail = data?.result || data?.ReplyMsg || res.text.slice(0, 200) || `HTTP ${res.status}`;
    const block = (kind, message, until) => {
      this.loginBlock = { kind, message, until };
      return new RouterError(kind, message, res.status);
    };
    // Another session holds the router: not a password problem, just wait it out.
    if (/Duplicate/i.test(res.text))
      return block('duplicate', `Router reports a duplicated login: ${detail}`, now + SESSION_CONFLICT_BACKOFF_MS);
    if (/Maxi?mum number/i.test(res.text))
      return block('max-sessions', `Router login limit reached: ${detail}`, now + SESSION_CONFLICT_BACKOFF_MS);
    // Anything else counts as a failed password attempt, even if the reply is unfamiliar.
    this.failedLogins.push(now);
    if (res.status === 401 || res.status === 403 || BAD_PASSWORD.test(detail) || this.failedLogins.length >= MAX_FAILED_LOGINS)
      return block('auth', `Login rejected: ${detail}`, null);
    return new RouterError('http', `Unexpected login response (HTTP ${res.status}): ${detail}`, res.status);
  }

  logout() {
    // High priority: Pause should free the router's session promptly.
    return this.#serial(() => this.#logout(), 'high');
  }

  async #logout() {
    if (!this.sessionKey) return;
    const key = this.sessionKey;
    this.sessionKey = null;
    try {
      await this.#request('POST', `/cgi-bin/UserLogout?sessionkey=${encodeURIComponent(key)}`);
    } finally {
      this.cookies.clear();
    }
  }

  /**
   * GET a cgi-bin JSON endpoint, logging in (once) if the session is missing or expired.
   * priority 'high' runs ahead of queued normal requests (used for the live signal read).
   */
  getJson(path, { priority = 'normal' } = {}) {
    return this.#serial(() => this.#getJson(path), priority);
  }

  async #getJson(path) {
    if (this.suspended) throw this.#paused();
    if (!this.hasSession) await this.#login();
    let res = await this.#request('GET', path);
    if (res.status === 401 || res.status === 403) {
      await this.#login();
      res = await this.#request('GET', path);
      if (res.status === 401 || res.status === 403)
        throw new RouterError('session', `Still unauthorised after re-login: ${path}`, res.status);
    }
    if (res.status !== 200) throw new RouterError('http', `HTTP ${res.status} for ${path}`, res.status);
    const parsed = tryJson(res.text);
    if (parsed === null) {
      // An HTML page instead of JSON usually means we were bounced to the login page.
      this.sessionKey = null;
      throw new RouterError('session', `Non-JSON response for ${path} (session probably expired)`, res.status);
    }
    const data = unescapeDeep(parsed);
    try {
      this.onResponse?.(path, data);
    } catch {
      // a cache listener must never break a router read
    }
    return data;
  }

  /**
   * The one write Insight makes, and only when enabled: SMS on the router's own
   * cellwan_sms endpoint (send = POST, mark read = PUT, delete = DELETE). Any other
   * path, or this one with any other oid, stays refused.
   */
  #isSmsWrite(method, url) {
    return (
      this.allowSms &&
      SMS_METHODS.has(method) &&
      url.pathname === '/cgi-bin/DAL' &&
      [...url.searchParams.keys()].every((k) => SMS_PARAMS.has(k)) &&
      url.searchParams.getAll('oid').length === 1 &&
      url.searchParams.get('oid') === 'cellwan_sms'
    );
  }

  /**
   * The other write, also only when enabled: the preferred access technology and bands
   * on cellwan_band, PUT as the router's own Broadband → Band page does. Nothing else on
   * the URL, so it can't be pointed at another setting.
   */
  #isBandWrite(method, url) {
    return (
      this.allowBandSelection &&
      method === 'PUT' &&
      url.pathname === '/cgi-bin/DAL' &&
      [...url.searchParams.keys()].every((k) => BAND_PARAMS.has(k)) &&
      url.searchParams.getAll('oid').length === 1 &&
      url.searchParams.get('oid') === 'cellwan_band'
    );
  }

  /**
   * An SMS write, as the router's UI sends it: session key (and `query`) on the URL,
   * `body` as JSON. High priority, never retried (a resend could send a text twice).
   * Resolves to the router's reply; anything but ZCFG_SUCCESS throws.
   */
  smsWrite(method, { query = {}, body } = {}) {
    return this.#serial(async () => {
      if (!this.allowSms) throw new RouterError('http', 'SMS is disabled (SMS_ENABLED=false)');
      return this.#dalWrite('SMS', method, { oid: 'cellwan_sms', ...query }, body);
    }, 'high');
  }

  /** Save the band selection: `body` is the whole cellwan_band object, as read, with the changes. */
  bandWrite(body) {
    return this.#serial(async () => {
      if (!this.allowBandSelection) throw new RouterError('http', 'Band control is disabled (RADIO_CONTROL_ENABLED=false)');
      return this.#dalWrite('Band selection', 'PUT', { oid: 'cellwan_band' }, body);
    }, 'high');
  }

  async #dalWrite(label, method, query, body) {
    if (this.suspended) throw this.#paused();
    if (!this.hasSession) await this.#login();
    const send = () => {
      const q = new URLSearchParams({ ...query, sessionkey: this.sessionKey });
      return this.#send(method, `/cgi-bin/DAL?${q}`, body);
    };
    let res = await send();
    if (res.status === 401 || res.status === 403) {
      // The write was refused, not performed, so it's safe to log in and try once more.
      await this.#login();
      res = await send();
    }
    const data = tryJson(res.text);
    if (res.status !== 200 || !data) throw new RouterError('http', `${label} ${method}: HTTP ${res.status}`, res.status);
    if (data.result !== 'ZCFG_SUCCESS') {
      throw new RouterError('http', `${label} ${method} refused by the router: ${data.ReplyMsg || data.result || 'unknown error'}`);
    }
    return data;
  }

  /** Lines of the router's native log. type: 'system' | 'security'. */
  async getLog(type) {
    const iid = type === 'security' ? '[2,0,0,0,0,0]' : '[1,0,0,0,0,0]';
    const data = await this.getJson(`/cgi-bin/Log?action=GET_LOG&oid=RDM_OID_LOG_CLASSIFY&iid=${encodeURIComponent(iid)}`);
    // Shape: {"0": {Ret, Oid, Iid, result: [lines]}}; be lenient about the wrapper.
    const entry = Array.isArray(data) ? data[0] : (data['0'] ?? data);
    const lines = entry?.result;
    if (!Array.isArray(lines)) throw new RouterError('http', `Unexpected GET_LOG shape for ${type} log`);
    return lines.map(String);
  }

  async getStatus() {
    return this.getJson('/cgi-bin/DAL?oid=status');
  }

  /** Cellular-only status (what the admin page's Cellular WAN view polls). Small and frequent, so it jumps the queue. */
  async getCellwanStatus() {
    const data = await this.getJson('/cgi-bin/DAL?oid=cellwan_status', { priority: 'high' });
    if (data?.result && data.result !== 'ZCFG_SUCCESS') throw new RouterError('http', `cellwan_status: ${data.result}`);
    return Array.isArray(data?.Object) ? data.Object[0] : data;
  }

  async #request(method, path, json) {
    try {
      return await this.#send(method, path, json);
    } catch (e) {
      // A reset connection is safe to retry once for reads.
      if (method !== 'GET' || !/socket hang up|ECONNRESET|EPIPE/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1000));
      return this.#send(method, path, json);
    }
  }

  #send(method, path, json) {
    const started = Date.now();
    this.inFlightSince = started;
    return this.#sendRaw(method, path, json).then(
      (res) => {
        this.inFlightSince = null;
        this.#record(path, Date.now() - started, res.text.length, res.status < 400);
        return res;
      },
      (err) => {
        this.inFlightSince = null;
        this.#record(path, Date.now() - started, 0, false);
        throw err;
      },
    );
  }

  #sendRaw(method, path, json) {
    const url = new URL(path, this.base);
    const allowed =
      method === 'GET' ||
      path === '/UserLogin' ||
      url.pathname === '/cgi-bin/UserLogout' ||
      this.#isSmsWrite(method, url) ||
      this.#isBandWrite(method, url);
    if (!allowed || /DEL_LOG/i.test(url.search)) {
      return Promise.reject(new Error(`Refusing ${method} ${url.pathname}${url.search}: Insight is read-only`));
    }
    const body = json === undefined ? undefined : JSON.stringify(json);
    const headers = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'If-Modified-Since': 'Thu, 01 Jun 1970 00:00:00 GMT',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    return new Promise((resolve, reject) => {
      const req = this.mod.request(url, { method, headers, agent: this.agent, timeout: 15_000 }, (res) => {
        for (const cookie of res.headers['set-cookie'] ?? []) {
          const pair = cookie.split(';')[0];
          const i = pair.indexOf('=');
          if (i <= 0) continue;
          const name = pair.slice(0, i).trim();
          const value = pair.slice(i + 1).trim();
          if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(cookie)) this.cookies.delete(name);
          else this.cookies.set(name, value);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => reject(new RouterError('network', e.message)));
      });
      req.on('timeout', () => req.destroy(new Error(`Timed out after 15 s`)));
      req.on('error', (e) => reject(e instanceof RouterError ? e : new RouterError('network', `${method} ${url.pathname}: ${e.message}`)));
      if (body) req.write(body);
      req.end();
    });
  }
}
