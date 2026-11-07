import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
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
// The restart path (see #isRebootWrite): what the router's Maintenance → Reboot page POSTs.
const REBOOT_PATH = '/cgi-bin/Reboot';
const CONTROL_READS = new Set([
  'periodic_FOTA_config',
  'online_fw_info',
  'zconsole',
  'wan',
  'user_account',
  'login_privilege',
  'PINGTEST',
  'IPERFTEST',
  'backupRestore_config',
]);
const CONTROL_WRITES = {
  periodic_FOTA_config: ['PUT'],
  zconsole: ['PUT'],
  wan: ['PUT', 'POST'],
  user_account: ['PUT', 'POST', 'DELETE'],
  login_privilege: ['PUT'],
  PINGTEST: ['PUT'],
  IPERFTEST: ['PUT'],
  backupRestore_config: ['PUT'],
};
const CONTROL_ACTIONS = {
  firmwareCheck: ['GET', '/cgi-bin/Online_Firmware_Upgrade'],
  firmwareInstall: ['GET', '/cgi-bin/Online_Firmware_Upgrade?action=online'],
  romdSave: ['POST', '/cgi-bin/ROMD?action=save'],
  romdClear: ['POST', '/cgi-bin/ROMD?action=clean'],
  partialReset: ['POST', '/cgi-bin/Backup_Restore?action=PartialReset'],
};
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_JSON_BYTES = 1024 * 1024;

function safeDownloadName(value, fallback = 'router-configuration.rom') {
  const name = String(value ?? '')
    .split(/[\\/]/)
    .at(-1)
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .replace(/[";]/g, '')
    .trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 120) : fallback;
}

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
    allowReboot = false,
    allowControl = false,
  }) {
    this.base = new URL(baseUrl);
    this.mod = this.base.protocol === 'https:' ? https : http;
    // The exceptions to read-only, each only when enabled: SMS writes (see #isSmsWrite),
    // the band selection (see #isBandWrite) and a restart (see #isRebootWrite).
    this.allowSms = allowSms;
    this.allowBandSelection = allowBandSelection;
    this.allowReboot = allowReboot;
    this.allowControl = allowControl;
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
    this.loginLevel = null;
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
    this.loginLevel = null;
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
      this.loginLevel = ['high', 'medium', 'low'].includes(data.loginLevel) ? data.loginLevel : null;
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
    // A web server that is still starting (after a restart or firmware install) answers 5xx:
    // the password was never checked, so it isn't a failed attempt.
    if (res.status >= 500) return new RouterError('network', `Router not ready to log in (HTTP ${res.status})`, res.status);
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
    this.loginLevel = null;
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

  /** The third write, also only when enabled: a restart, a POST with the session key and nothing else. */
  #isRebootWrite(method, url) {
    return (
      this.allowReboot &&
      method === 'POST' &&
      url.pathname === REBOOT_PATH &&
      [...url.searchParams.keys()].every((k) => k === 'sessionkey') &&
      url.searchParams.getAll('sessionkey').length === 1
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

  /**
   * Restart the router, as its Maintenance → Reboot page does. High priority, and never
   * retried on a dropped connection: the router may already be going down. Its session
   * ends with the restart, so it's dropped here and the next request logs in afresh.
   */
  reboot() {
    return this.#serial(async () => {
      if (!this.allowReboot) throw new RouterError('http', 'Restart is disabled (REBOOT_ENABLED=false)');
      if (this.suspended) throw this.#paused();
      if (!this.hasSession) await this.#login();
      const send = () => this.#send('POST', `${REBOOT_PATH}?${new URLSearchParams({ sessionkey: this.sessionKey })}`);
      let res = await send();
      if (res.status === 401 || res.status === 403) {
        // Refused, not performed: safe to log in and ask once more.
        await this.#login();
        res = await send();
      }
      const data = tryJson(res.text);
      if (res.status !== 200) throw new RouterError('http', `Restart: HTTP ${res.status}`, res.status);
      if (data?.result && data.result !== 'ZCFG_SUCCESS') {
        throw new RouterError('http', `Restart refused by the router: ${data.ReplyMsg || data.result}`);
      }
      this.sessionKey = null;
      this.cookies.clear();
      return data ?? {};
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

  #requireControl() {
    if (!this.allowControl) throw new RouterError('permission', 'Router controls are disabled', 403);
    if (this.suspended) throw this.#paused();
  }

  async #controlSession() {
    this.#requireControl();
    if (!this.hasSession) await this.#login();
  }

  #controlStatus(res, label) {
    if (res.status === 403) throw new RouterError('permission', `Router denied ${label} for this account`, 403);
    if (res.status === 401) {
      this.sessionKey = null;
      this.loginLevel = null;
      throw new RouterError('session', `Router session expired during ${label}; the operation was not retried`, 401);
    }
    if (res.status !== 200) throw new RouterError('http', `${label}: router HTTP ${res.status}`, res.status === 404 ? 404 : 502);
  }

  async #controlJson(method, path, body, { safe = false, dal = false, timeoutMs = 30_000, requireSuccess = method !== 'GET' } = {}) {
    const options = { control: true, timeoutMs, maxBytes: MAX_CONTROL_JSON_BYTES };
    let res = safe ? await this.#request(method, path, body, options) : await this.#send(method, path, body, options);
    // As for ordinary reads: an expired session answers 401 or 403, and a read is safe to repeat once.
    if (safe && (res.status === 401 || res.status === 403)) {
      await this.#login();
      res = await this.#request(method, path, body, options);
    }
    this.#controlStatus(res, 'control request');
    const data = tryJson(res.text);
    if (!data || typeof data !== 'object') throw new RouterError('http', 'Router returned an invalid control response', 502);
    const result = data.result ?? data.Ret;
    if (requireSuccess && result === undefined) throw new RouterError('http', 'Router did not confirm the control operation', 502);
    if (result !== undefined && result !== 'ZCFG_SUCCESS') {
      const permission = /permission|privilege|denied|not.authori[sz]ed|forbidden/i.test(`${result} ${data.ReplyMsg ?? ''}`);
      const invalid = /INVALID|PARAMETER/.test(String(result));
      throw new RouterError(
        permission ? 'permission' : 'http',
        permission ? 'Router denied this control operation' : `Router refused the operation (${String(result).slice(0, 80)})`,
        permission ? 403 : invalid ? 400 : 502,
      );
    }
    if (dal && (!Array.isArray(data.Object) || result !== 'ZCFG_SUCCESS'))
      throw new RouterError('http', 'Router returned an invalid DAL response', 502);
    return method === 'GET' ? unescapeDeep(data) : data;
  }

  /** Session privilege and public firmware flags. Credentials and account records are never included. */
  controlInfo() {
    return this.#serial(async () => {
      await this.#controlSession();
      const levelReply = await this.#controlJson('GET', '/cgi-bin/loginAccountLevel', undefined, { safe: true });
      const level = levelReply?.[0]?.level;
      if (!['high', 'medium', 'low'].includes(level)) throw new RouterError('http', 'Router returned an unknown account level', 502);
      this.loginLevel = level;
      const flags = await this.#controlJson('GET', '/getWebGuiFlag', undefined, { safe: true });
      const customization = await this.#controlJson('GET', '/getCustomizationData', undefined, { safe: true });
      const basic = await this.#controlJson('GET', '/getBasicInformation', undefined, { safe: true });
      return {
        level,
        flags: { ...flags, ...customization },
        device: { ModelName: basic.ModelName, SoftwareVersion: basic.SoftwareVersion },
      };
    });
  }

  controlRead(oid) {
    return this.#serial(async () => {
      this.#requireControl();
      if (!CONTROL_READS.has(oid)) throw new RouterError('http', 'Unsupported router control read', 400);
      await this.#controlSession();
      return this.#controlJson('GET', `/cgi-bin/DAL?${new URLSearchParams({ oid })}`, undefined, { safe: true, dal: true });
    });
  }

  /** Deliberately narrow DAL transport. Authorization and field validation also live in the control service. */
  controlWrite(oid, method, body) {
    return this.#serial(async () => {
      this.#requireControl();
      if (!Object.hasOwn(CONTROL_WRITES, oid) || !CONTROL_WRITES[oid].includes(method))
        throw new RouterError('http', 'Unsupported router control write', 400);
      if (!body || typeof body !== 'object' || Buffer.byteLength(JSON.stringify(body)) > MAX_CONTROL_JSON_BYTES)
        throw new RouterError('http', 'Invalid router control body', 400);
      await this.#controlSession();
      const query = new URLSearchParams({ oid, sessionkey: this.sessionKey });
      if (method === 'DELETE') {
        if (oid !== 'user_account' || typeof body.Username !== 'string' || Object.keys(body).some((k) => k !== 'Username'))
          throw new RouterError('http', 'An account deletion requires only its username', 400);
        query.set('Username', body.Username);
        body = undefined;
      }
      return this.#controlJson(method, `/cgi-bin/DAL?${query}`, body);
    }, 'high');
  }

  controlAction(name) {
    return this.#serial(async () => {
      this.#requireControl();
      const action = Object.hasOwn(CONTROL_ACTIONS, name) ? CONTROL_ACTIONS[name] : null;
      if (!action) throw new RouterError('http', 'Unsupported router control action', 400);
      await this.#controlSession();
      const [method, path] = action;
      const url = new URL(path, this.base);
      if (method !== 'GET') url.searchParams.set('sessionkey', this.sessionKey);
      const data = await this.#controlJson(method, `${url.pathname}${url.search}`, undefined, {
        timeoutMs: name === 'firmwareInstall' ? 300_000 : 30_000,
      });
      if (name === 'firmwareInstall' || name === 'partialReset') {
        this.sessionKey = null;
        this.loginLevel = null;
        this.cookies.clear();
      }
      return data;
    }, 'high');
  }

  /** A ROM-D selection flag and its export form one queue job and are never retried. */
  controlDownload(kind) {
    return this.#serial(async () => {
      this.#requireControl();
      if (!['configuration', 'romd'].includes(kind)) throw new RouterError('http', 'Unsupported configuration download', 400);
      await this.#controlSession();
      if (kind === 'romd') {
        const tag = await this.#controlJson('GET', '/tagRomdBackupFlag');
        if (Number(tag.Recv_tagRomdBackupFlag) !== 1) throw new RouterError('http', 'Router did not select ROM-D for export', 502);
      }
      const path = `/cgi-bin/Backup_Restore?${new URLSearchParams({ action: 'Backup', sessionkey: this.sessionKey })}`;
      const res = await this.#send('GET', path, undefined, { control: true, timeoutMs: 30_000, maxBytes: MAX_CONFIG_BYTES });
      this.#controlStatus(res, 'configuration download');
      const type = String(res.headers['content-type'] ?? 'application/octet-stream').split(';')[0];
      if (!res.body.length || /html/i.test(type) || /^\s*(?:<!doctype|<html|<form)/i.test(res.text))
        throw new RouterError('http', 'Router returned a login page or empty configuration download', 502);
      const json = tryJson(res.text);
      if (json && (json.result || json.Ret))
        throw new RouterError('http', 'Router returned a status response instead of a configuration file', 502);
      const disposition = String(res.headers['content-disposition'] ?? '');
      let name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)/i.exec(disposition)?.[1];
      try {
        name = decodeURIComponent(name ?? '');
      } catch {
        name = '';
      }
      return {
        body: res.body,
        filename: safeDownloadName(name, kind === 'romd' ? 'router-defaults.rom' : 'router-configuration.rom'),
        contentType: type,
      };
    }, 'high');
  }

  controlRestore(buffer, filename = 'configuration.rom') {
    return this.#serial(async () => {
      this.#requireControl();
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CONFIG_BYTES)
        throw new RouterError('http', 'Configuration upload must contain between 1 byte and 16 MiB', 400);
      await this.#controlSession();
      const boundary = `insight-${randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="mtenRestoreCfg"; filename="${safeDownloadName(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const path = `/cgi-bin/Backup_Restore?${new URLSearchParams({ action: 'Restore', sessionkey: this.sessionKey })}`;
      const res = await this.#send('POST', path, undefined, {
        control: true,
        rawBody: body,
        contentType: `multipart/form-data; boundary=${boundary}`,
        timeoutMs: 120_000,
        maxBytes: MAX_CONTROL_JSON_BYTES,
      });
      this.#controlStatus(res, 'configuration restore');
      const data = tryJson(res.text);
      if (data && (data.result ?? data.Ret) !== 'ZCFG_SUCCESS')
        throw new RouterError('http', 'Router refused the configuration restore', 502);
      if (!data && res.text.trim() && !/ZCFG_SUCCESS/.test(res.text))
        throw new RouterError('http', 'Router returned an unexpected restore response', 502);
      this.sessionKey = null;
      this.loginLevel = null;
      this.cookies.clear();
      return data ?? { result: 'ZCFG_SUCCESS' };
    }, 'high');
  }

  /**
   * Whether the router's web server answers at all, without logging in: used to watch a
   * restart go down and come back without spending login attempts on a half-started router.
   */
  probe() {
    return this.#serial(async () => {
      if (this.suspended) return false;
      try {
        const res = await this.#send('GET', '/getRSAPublickKey', undefined, { timeoutMs: 5_000 });
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'high');
  }

  diagnosticResult() {
    return this.#serial(async () => {
      await this.#controlSession();
      const data = await this.#controlJson('GET', '/cgi-bin/Diagnostic_Result', undefined, { safe: true });
      if (!Array.isArray(data) || typeof data[0]?.result !== 'string')
        throw new RouterError('http', 'Router returned an invalid diagnostic result', 502);
      return data;
    });
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

  async #request(method, path, json, options) {
    try {
      return await this.#send(method, path, json, options);
    } catch (e) {
      // A reset connection is safe to retry once for reads.
      if (method !== 'GET' || !/socket hang up|ECONNRESET|EPIPE/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1000));
      return this.#send(method, path, json, options);
    }
  }

  #send(method, path, json, options) {
    const started = Date.now();
    this.inFlightSince = started;
    return this.#sendRaw(method, path, json, options).then(
      (res) => {
        this.inFlightSince = null;
        this.#record(path, Date.now() - started, res.body.length, res.status < 400);
        return res;
      },
      (err) => {
        this.inFlightSince = null;
        this.#record(path, Date.now() - started, 0, false);
        throw err;
      },
    );
  }

  #isControlRequest(method, url) {
    if (!this.allowControl || url.origin !== this.base.origin) return false;
    const keys = [...url.searchParams.keys()];
    if (url.pathname === '/cgi-bin/DAL') {
      const oid = url.searchParams.get('oid');
      return (
        url.searchParams.getAll('oid').length === 1 &&
        keys.every((k) => ['oid', 'sessionkey', 'Username'].includes(k)) &&
        (method === 'GET' ? CONTROL_READS.has(oid) : Object.hasOwn(CONTROL_WRITES, oid) && CONTROL_WRITES[oid].includes(method))
      );
    }
    if (
      method === 'GET' &&
      [
        '/cgi-bin/loginAccountLevel',
        '/getWebGuiFlag',
        '/getCustomizationData',
        '/getBasicInformation',
        '/cgi-bin/Diagnostic_Result',
        '/tagRomdBackupFlag',
      ].includes(url.pathname)
    )
      return keys.length === 0;
    if (url.pathname === '/cgi-bin/Backup_Restore')
      return (
        keys.every((k) => ['action', 'sessionkey'].includes(k)) &&
        (method === 'GET'
          ? url.searchParams.get('action') === 'Backup'
          : method === 'POST' && ['Restore', 'PartialReset'].includes(url.searchParams.get('action')))
      );
    return Object.values(CONTROL_ACTIONS).some(([m, p]) => {
      const native = new URL(p, this.base);
      return (
        m === method &&
        native.pathname === url.pathname &&
        (native.searchParams.get('action') ?? '') === (url.searchParams.get('action') ?? '') &&
        keys.every((k) => ['action', 'sessionkey'].includes(k))
      );
    });
  }

  #sendRaw(method, path, json, options = {}) {
    const url = new URL(path, this.base);
    const actionGet = [
      '/cgi-bin/Online_Firmware_Upgrade',
      '/cgi-bin/Backup_Restore',
      '/tagRomdBackupFlag',
      '/tagRestoreDefaultFlag',
      '/tagPartialRestoreDefaultFlag',
    ].includes(url.pathname);
    const allowed =
      (method === 'GET' && !actionGet) ||
      path === '/UserLogin' ||
      url.pathname === '/cgi-bin/UserLogout' ||
      this.#isSmsWrite(method, url) ||
      this.#isBandWrite(method, url) ||
      this.#isRebootWrite(method, url) ||
      (options.control && this.#isControlRequest(method, url));
    if (!allowed || /DEL_LOG/i.test(url.search)) {
      return Promise.reject(new Error(`Refusing ${method} ${url.pathname}${url.search}: Insight is read-only`));
    }
    const body = options.rawBody ?? (json === undefined ? undefined : JSON.stringify(json));
    const headers = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'If-Modified-Since': 'Thu, 01 Jun 1970 00:00:00 GMT',
    };
    if (body) {
      headers['Content-Type'] = options.contentType ?? 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 15_000;
      const req = this.mod.request(url, { method, headers, agent: this.agent, timeout: timeoutMs }, (res) => {
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
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > (options.maxBytes ?? MAX_CONFIG_BYTES)) {
            res.destroy();
            req.destroy(new RouterError('http', 'Router response exceeded the size limit', 502));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, text: body.toString('utf8'), body, headers: res.headers });
        });
        res.on('error', (e) => reject(new RouterError('network', e.message)));
      });
      req.on('timeout', () => req.destroy(new Error(`Timed out after ${Math.ceil(timeoutMs / 1000)} s`)));
      req.on('error', (e) => reject(e instanceof RouterError ? e : new RouterError('network', `${method} ${url.pathname}: ${e.message}`)));
      if (body) req.write(body);
      req.end();
    });
  }
}
