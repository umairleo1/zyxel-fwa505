// Fake FWA505 for development: same endpoints and response shapes as the real
// router (GET_LOG sliding window of 100 lines, entity-escaped JSON, cookie auth).
// Password is "mock". Run: npm run mock -w server
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 8081);
const PASSWORD = 'mock';
const sessions = new Set();
const bootAt = Date.now() - 3 * 86400 * 1000;
const system = [];
const security = [];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = (d = new Date()) => `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${d.toTimeString().slice(0, 8)}`;
// Real response shapes captured (read-only) from an FWA505, with identifiers scrubbed.
const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = (pathAndQuery) => {
  const file = new URL(`${pathAndQuery.replace(/^\/cgi-bin\//, '').replace(/[^\w]+/g, '_')}.json`, FIXTURES);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const counters = {
  lanRx: 377876434,
  lanTx: 621956085,
  wanRx: 28536600991,
  wanTx: 929411497,
};
setInterval(() => {
  // ~4 Mbps down / 0.4 Mbps up average, bursty
  const burst = Math.random() < 0.15 ? 12 : 1;
  counters.wanRx += Math.round(500_000 * burst * Math.random() * 2);
  counters.wanTx += Math.round(50_000 * burst * Math.random() * 2);
  counters.lanRx = counters.lanRx + Math.round(counters.wanTx * 0.0001);
  counters.lanTx = counters.lanTx + Math.round(counters.wanRx * 0.0001);
}, 1000);

const jitter = (n) => Math.round((Math.random() * 2 - 1) * n);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const mac = () => Array.from({ length: 6 }, () => crypto.randomBytes(1).toString('hex')).join(':');

// at(i): timestamp for the i-th new line (default: now).
function addSystemLines(n, at = () => new Date()) {
  for (let i = 0; i < n; i++) {
    const when = at(i);
    const ip = `192.168.1.${10 + Math.floor(Math.random() * 40)}`;
    const line = pick([
      () => `[DHCP Server] ${stamp(when)} dhcpd.info DHCPACK on ${ip} to ${mac()} via br0`,
      () => `[DHCP Server] ${stamp(when)} dhcpd.info DHCPREQUEST for ${ip} from ${mac()} via br0`,
      () => `[DHCP Server] ${stamp(when)} dhcpd.info DHCPACK on ${ip} to ${mac()} via br0`,
      () => `[WWAN] ${stamp(when)} cellwan.notice RSRP changed to -${90 + Math.floor(Math.random() * 20)} dBm`,
      () => `[System] ${stamp(when)} httpd.warn Login attempt from 192.168.1.23 <admin> & "web"`,
      () => `[WWAN] ${stamp(when)} cellwan.err PDN connection dropped, reconnecting`,
    ])();
    system.push(line);
  }
  system.splice(0, Math.max(0, system.length - 100));
}
// Like the real router: the buffer holds the last 100 lines, roughly the past 8 hours.
addSystemLines(100, (i) => new Date(Date.now() - (100 - i) * 5 * 60e3));
security.push(`[Account] ${stamp(new Date(Date.now() - 3600_000))} httpd.notice Account admin login from 192.168.1.23`);
setInterval(() => addSystemLines(Math.floor(Math.random() * 3)), 60_000); // ~1 line/min

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
};
// The real router escapes string values; mirror that so the client's unescape path is exercised.
const sendEscaped = (res, obj) =>
  send(
    res,
    200,
    JSON.stringify(obj, (_k, v) => (typeof v === 'string' ? escape(v) : v)),
  );

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = /Authentication=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const authed = cookie && sessions.has(cookie);
    console.log(`${req.method} ${url.pathname}${url.search} ${authed ? '(authed)' : ''}`);

    if (url.pathname === '/getRSAPublickKey') return send(res, 200, { RSAPublicKey: 'None' });
    if (url.pathname === '/UserLogin' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const b = JSON.parse(body);
        if (Buffer.from(b.Input_Passwd, 'base64').toString() !== PASSWORD)
          return send(res, 401, { result: 'Invalid Username or Password' });
        const token = crypto.randomBytes(16).toString('hex');
        sessions.add(token);
        send(
          res,
          200,
          { sessionkey: crypto.randomInt(1e9), loginAccount: b.Input_Account, loginLevel: 'administrator' },
          { 'Set-Cookie': `Authentication=${token}; Path=/; HttpOnly; Secure` },
        );
      });
      return;
    }
    if (!authed) return send(res, 401, { result: 'Unauthorized' });
    if (url.pathname === '/cgi-bin/UserLogout') {
      sessions.delete(cookie);
      return send(res, 200, { result: 'ZCFG_SUCCESS' });
    }
    if (url.pathname === '/cgi-bin/Log' && url.searchParams.get('action') === 'GET_LOG') {
      const lines = url.searchParams.get('iid')?.startsWith('[2') ? security : system;
      return sendEscaped(res, { 0: { Ret: 'ZCFG_SUCCESS', Oid: 'RDM_OID_LOG_CLASSIFY', Iid: url.searchParams.get('iid'), result: lines } });
    }
    const oid = url.searchParams.get('oid');
    if (url.pathname === '/cgi-bin/DAL' && oid === 'cellwan_status') {
      const d = clone(fixture('/cgi-bin/DAL?oid=cellwan_status'));
      const o = d.Object[0];
      Object.assign(o, {
        INTF_RSRP: -103 + jitter(5),
        INTF_RSRQ: -10 + jitter(2),
        INTF_SINR: 8 + jitter(4),
        INTF_RSSI: -92 + jitter(3),
        NSA_RSRP: -95 + jitter(5),
        NSA_SINR: 7 + jitter(5),
      });
      o.SCC_Info[0].RSRP = -89 + jitter(3);
      // Every other minute the n1 carrier drops, to exercise combination-change events.
      if (Math.floor(Date.now() / 60e3) % 2) o.SCC_Info[1] = { ...o.SCC_Info[1], Enable: false };
      return send(res, 200, d);
    }
    if (url.pathname === '/cgi-bin/DAL' && oid === 'status') {
      const d = clone(fixture('/cgi-bin/DAL?oid=status'));
      const o = d.Object[0];
      o.DeviceInfo.UpTime = Math.floor((Date.now() - bootAt) / 1000);
      o.ProcessStatus.CPUUsage = Math.max(1, 4 + jitter(3));
      o.MemoryStatus.Free = 321244 + jitter(20000);
      return send(res, 200, d);
    }
    if (url.pathname === '/cgi-bin/DAL' && oid === 'Traffic_Status') {
      const d = clone(fixture('/cgi-bin/DAL?oid=Traffic_Status'));
      const st = d.Object[0].ipIfaceSt;
      Object.assign(st[0], { BytesReceived: counters.lanRx, BytesSent: counters.lanTx });
      Object.assign(st[1], { BytesReceived: counters.wanRx, BytesSent: counters.wanTx });
      return send(res, 200, d);
    }
    if (url.pathname === '/cgi-bin/WLANTable_handle') {
      return send(res, 200, [
        {
          result: `Address            Rate(Mbps)  RSSI   SNR  Level 02:00:00:00:00:03         144   ${-62 + jitter(3)}    28      4 `,
          result5: `Address            Rate(Mbps)  RSSI   SNR  Level 02:00:00:00:00:01        1080   ${-40 + jitter(3)}    51      5 02:00:00:00:00:02         288   ${-74 + jitter(3)}    16      3 `,
          resultEasyMesh: '',
        },
      ]);
    }
    // Everything else: the captured fixture, as-is.
    const fx = fixture(`${url.pathname}${url.search}`);
    if (fx) return send(res, 200, fx);
    send(res, 404, { result: 'Not found' });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock router on http://127.0.0.1:${PORT} (password "${PASSWORD}")`));
