import http from 'node:http';
import https from 'node:https';

export class RouterError extends Error {
  /** kind: network | auth | duplicate | max-sessions | session | http */
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
 * Read-only client for the FWA505 web API. The only non-GET calls it will
 * make are login and logout; everything else is refused.
 */
export class RouterClient {
  constructor({ baseUrl, username, password }) {
    this.base = new URL(baseUrl);
    this.mod = this.base.protocol === 'https:' ? https : http;
    // The router serves a self-signed cert; trust it for this agent only. No
    // keep-alive: the router drops idle connections between our once-a-minute
    // polls, and reusing a dead socket fails with "socket hang up".
    this.agent = new this.mod.Agent({ keepAlive: false, rejectUnauthorized: false });
    this.username = username;
    this.password = password;
    this.cookies = new Map();
    this.sessionKey = null;
    // Requests run one at a time: the router is a small device, and concurrent
    // logins from parallel callers would race each other.
    this.queue = Promise.resolve();
    /** Called with (path, parsedJson) after every successful GET, so caches can share results. */
    this.onResponse = null;
    // Load accounting: every request we make to the router is counted here.
    this.stats = { since: Date.now(), requests: 0, bytes: 0, errors: 0, logins: 0, byPath: {}, recent: [] };
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
    const now = Date.now();
    s.recent.push(now);
    while (s.recent.length && s.recent[0] < now - 60_000) s.recent.shift();
  }

  /** Requests in the last minute, plus lifetime totals per endpoint. */
  loadSnapshot() {
    const s = this.stats;
    const now = Date.now();
    while (s.recent.length && s.recent[0] < now - 60_000) s.recent.shift();
    const mins = Math.max(1 / 60, (now - s.since) / 60_000);
    return {
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

  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  get hasSession() {
    return this.sessionKey !== null;
  }

  login() {
    return this.#serial(() => this.#login());
  }

  async #login() {
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
      return data;
    }
    const detail = data?.result || data?.ReplyMsg || res.text.slice(0, 200) || `HTTP ${res.status}`;
    if (/Duplicate/i.test(res.text)) throw new RouterError('duplicate', `Router reports a duplicated login: ${detail}`, res.status);
    if (/Maxi?mum number/i.test(res.text)) throw new RouterError('max-sessions', `Router login limit reached: ${detail}`, res.status);
    if (res.status === 401 || res.status === 403) throw new RouterError('auth', `Login rejected: ${detail}`, res.status);
    throw new RouterError('http', `Unexpected login response (HTTP ${res.status}): ${detail}`, res.status);
  }

  logout() {
    return this.#serial(() => this.#logout());
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

  /** GET a cgi-bin JSON endpoint, logging in (once) if the session is missing or expired. */
  getJson(path) {
    return this.#serial(() => this.#getJson(path));
  }

  async #getJson(path) {
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

  /** Cellular-only status (what the admin page's Cellular WAN view polls). */
  async getCellwanStatus() {
    const data = await this.getJson('/cgi-bin/DAL?oid=cellwan_status');
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
    return this.#sendRaw(method, path, json).then(
      (res) => {
        this.#record(path, Date.now() - started, res.text.length, res.status < 400);
        return res;
      },
      (err) => {
        this.#record(path, Date.now() - started, 0, false);
        throw err;
      },
    );
  }

  #sendRaw(method, path, json) {
    const url = new URL(path, this.base);
    const allowed = method === 'GET' || path === '/UserLogin' || url.pathname === '/cgi-bin/UserLogout';
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
      req.on('error', (e) => reject(new RouterError('network', `${method} ${url.pathname}: ${e.message}`)));
      if (body) req.write(body);
      req.end();
    });
  }
}
