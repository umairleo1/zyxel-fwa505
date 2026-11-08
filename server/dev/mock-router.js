// Fake FWA505 for development: same endpoints and response shapes as the real
// router (GET_LOG sliding window of 100 lines, entity-escaped JSON, cookie auth).
// Password is "mock". Run: npm run mock -w server
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { decodeGsm } from '@zyxel-insight/shared/sms';
import { createControlMock } from './control-mock.js';

const PORT = Number(process.env.MOCK_PORT || 8081);
// MOCK_WAN_DROP=90/600: mobile data drops for 90 s out of every 600 s (the router stays
// reachable but loses its WAN address, like a dropped PDN session). Off by default.
const [WAN_DOWN_SEC, WAN_CYCLE_SEC] = (process.env.MOCK_WAN_DROP ?? '').split('/').map(Number);
const wanDown = () => WAN_CYCLE_SEC > 0 && (Date.now() / 1000) % WAN_CYCLE_SEC < WAN_DOWN_SEC;
const PASSWORD = 'mock';
const sessions = new Map();
let bootAt = Date.now() - 3 * 86400 * 1000;
// After POST /cgi-bin/Reboot the router stops answering until this time, then boots afresh.
let downUntil = 0;
const REBOOT_SEC = Number(process.env.MOCK_REBOOT_SEC ?? 45);
const system = [];
const security = [];
const controls = createControlMock({
  sessions,
  // High control restarts take as long as a reboot, after answering for a moment like the real router.
  rebootMs: REBOOT_SEC * 1000,
  lingerMs: 2000,
  onRestart: (_kind, ms) => {
    downUntil = Date.now() + ms;
    bootAt = downUntil;
  },
});

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = (d = new Date()) => `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${d.toTimeString().slice(0, 8)}`;
// Real response shapes captured (read-only) from an FWA505, with identifiers scrubbed.
const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = (pathAndQuery) => {
  const file = new URL(`${pathAndQuery.replace(/^\/cgi-bin\//, '').replace(/[^\w]+/g, '_')}.json`, FIXTURES);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
// Band selection (cellwan_band): starts as captured, changes with PUTs.
const band = clone(fixture('/cgi-bin/DAL?oid=cellwan_band').Object[0]);
const counters = {
  lanRx: 377876434,
  lanTx: 621956085,
  wanRx: 28536600991,
  wanTx: 929411497,
};
setInterval(() => {
  // ~4 Mbps down / 0.4 Mbps up average, bursty
  if (wanDown()) return; // nothing moves without a connection
  const burst = Math.random() < 0.15 ? 12 : 1;
  counters.wanRx += Math.round(500_000 * burst * Math.random() * 2);
  counters.wanTx += Math.round(50_000 * burst * Math.random() * 2);
  counters.lanRx = counters.lanRx + Math.round(counters.wanTx * 0.0001);
  counters.lanTx = counters.lanTx + Math.round(counters.wanRx * 0.0001);
}, 1000);

const jitter = (n) => Math.round((Math.random() * 2 - 1) * n);

// Speed-test endpoints (SPEEDTEST_DOWN_URL / SPEEDTEST_UP_URL point here under dev:mock), so
// the Speed page and the optimiser work offline. Throughput depends on the band selection like
// a real cell might: a B3-only anchor does better than the default B7, SA worse, ±15 % noise.
function mockMbps() {
  const pref = band.INTF_Preferred_Bands;
  const sa = band.INTF_Preferred_Access_Technology === 'NR5G-SA';
  const base = sa ? 70 : pref !== 'Auto' && !pref.includes('B7') ? 170 : 120;
  return { down: base * (1 + (Math.random() * 2 - 1) * 0.15), up: (sa ? 12 : 22) * (1 + (Math.random() * 2 - 1) * 0.15) };
}
// One shared byte budget per direction, refilled every 20 ms: parallel streams split the rate.
const pacer = { down: 0, up: 0 };
setInterval(() => {
  const { down, up } = mockMbps();
  pacer.down = Math.min(pacer.down + (down * 1e6) / 8 / 50, 4e6);
  pacer.up = Math.min(pacer.up + (up * 1e6) / 8 / 50, 1e6);
}, 20);
const PIECE = Buffer.alloc(16 * 1024);
function speedDown(req, res, bytes) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes });
  let left = bytes;
  const timer = setInterval(() => {
    while (left > 0 && pacer.down >= PIECE.length) {
      const n = Math.min(PIECE.length, left);
      pacer.down -= n;
      left -= n;
      if (!res.write(n === PIECE.length ? PIECE : PIECE.subarray(0, n))) break;
    }
    if (left <= 0) {
      clearInterval(timer);
      res.end();
    }
  }, 10);
  res.on('close', () => clearInterval(timer));
}
function speedUp(req, res) {
  // Read only as fast as the uplink "carries": pausing the request applies TCP back-pressure.
  req.on('data', (chunk) => {
    pacer.up -= chunk.length;
    if (pacer.up < 0) {
      req.pause();
      setTimeout(() => req.resume(), Math.ceil((-pacer.up / 1e6) * 1000));
    }
  });
  req.on('end', () => send(res, 200, { ok: true }));
}
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

// ── SMS (cellwan_sms), shaped like the real router's: one list holding received (State
// 0 unread / 1 read) and sent (State 2) messages; GSM text as unpacked hex septets. ──
const sms = [];
let smsSeq = 0;
const smsStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())},${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00`;
};
// Plain ASCII letters, digits and most punctuation sit at their ASCII codes in the GSM alphabet.
const asciiGsm = (text) => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('');
const ucs2 = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()).join('');
// Like the real FWA505: a multi-part text is one entry over several SIM slots, listed
// as "6,7," (a single-part one is a plain number).
function takeSlots(parts) {
  const slots = Array.from({ length: Math.max(1, parts) }, () => ++smsSeq);
  return slots.length === 1 ? slots[0] : `${slots.join(',')},`;
}
const slotsUsed = () => sms.reduce((n, m) => n + String(m.ObjIndex).split(',').filter(Boolean).length, 0);
function addSms({ from, text, agoMs = 0, state = 0, unicode = false, alpha = false }) {
  const parts = unicode ? Math.ceil(text.length / (text.length > 70 ? 67 : 70)) : Math.ceil(text.length / (text.length > 160 ? 153 : 160));
  sms.push({
    ObjIndex: takeSlots(parts),
    State: state,
    FromType: alpha ? 208 : from.startsWith('+') ? 145 : 129,
    From: alpha ? asciiGsm(from) : from,
    CharacterSet: unicode ? 2 : 0,
    Content: unicode ? ucs2(text) : asciiGsm(text),
    // The real router leaves sent messages undated.
    TimeStamp: state === 2 ? '' : smsStamp(new Date(Date.now() - agoMs)),
  });
  sms.splice(0, Math.max(0, sms.length - 50)); // the SIM holds 50
}
addSms({ from: '+447700900123', text: 'Hi! Are you home tonight?', agoMs: 25 * 3600e3, state: 1 });
addSms({ from: '+447700900123', text: 'Yes, after 8', agoMs: 24.8 * 3600e3, state: 2 });
addSms({
  from: 'EE',
  alpha: true,
  text: 'Your monthly allowance renews tomorrow. Text USAGE to 150 to check.',
  agoMs: 3 * 3600e3,
  state: 1,
});
addSms({ from: '+447700900456', unicode: true, text: 'Salām! Parcel arrives at 6 😀', agoMs: 20 * 60e3 });
addSms({
  from: 'EE',
  alpha: true,
  agoMs: 2 * 3600e3,
  state: 1,
  text: 'Your bill is ready. This month you used 3.2GB of 30GB data, 41 of unlimited minutes and 12 texts. Your next payment of 18.00 GBP will be taken on 1 December. Thanks for being with us.',
});
// Something new now and then, so the unread badge and live refresh can be seen working.
setInterval(() => addSms({ from: '+447700900456', text: `Reminder ${smsSeq}: the parcel is out for delivery` }), 7 * 60e3);

/** What a sent message would read as, from the parts the UI posts (UDH and fill bit removed). */
function outboxText(o) {
  if (o.SMS_CharacterSet === 'UCS2')
    return { unicode: true, text: (o.SMS_Content.match(/.{4}/g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join('') };
  const parts = o.SMS_Content_divData ?? [o.SMS_Content];
  const multi = parts.length > 1;
  const septets = parts.flatMap((hex, i) => {
    const body = multi ? hex.slice(12) : hex;
    const count = (o.SMS_Content_divLen?.[i] ?? 0) - (multi ? 7 : 0);
    const bytes = (body.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
    const out = [];
    for (let bit = multi ? 1 : 0; out.length < count; bit += 7) {
      const v = ((bytes[bit >> 3] | ((bytes[(bit >> 3) + 1] ?? 0) << 8)) >> (bit & 7)) & 0x7f;
      out.push(v);
    }
    return out;
  });
  return { unicode: false, text: decodeGsm(septets.map((v) => v.toString(16).padStart(2, '0')).join('')) };
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b ? JSON.parse(b) : {}));
  });

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
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = /Authentication=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const authed = cookie && sessions.has(cookie);
    console.log(`${req.method} ${url.pathname}${url.search} ${authed ? '(authed)' : ''}`);
    // Restarting: no web server, so connections just fail, as with the real router.
    if (Date.now() < downUntil) return req.socket.destroy();
    if (url.pathname === '/__down') return speedDown(req, res, Math.min(Number(url.searchParams.get('bytes')) || 1e6, 100e6));
    if (url.pathname === '/__up' && req.method === 'POST') return speedUp(req, res);

    try {
      if (await controls.handleAuth(req, res)) return;
      if (await controls.handle(req, res)) return;
    } catch {
      if (!res.headersSent) send(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
      return;
    }
    if (!authed) return send(res, 401, { result: 'Unauthorized' });
    if (url.pathname === '/cgi-bin/UserLogout') {
      sessions.delete(cookie);
      return send(res, 200, { result: 'ZCFG_SUCCESS' });
    }
    if (url.pathname === '/cgi-bin/Reboot' && req.method === 'POST') {
      if (!url.searchParams.get('sessionkey')) return send(res, 401, { result: 'Invalid session key' });
      send(res, 200, { result: 'ZCFG_SUCCESS' });
      sessions.clear();
      downUntil = Date.now() + REBOOT_SEC * 1000;
      bootAt = downUntil;
      // A log line once it's back up (wording made up: the real one isn't captured yet).
      setTimeout(() => system.push(`[System] ${stamp()} syslog.notice System reboot by user`), REBOOT_SEC * 1000);
      console.log(`[mock] rebooting: back in ${REBOOT_SEC} s`);
      return;
    }
    if (url.pathname === '/cgi-bin/Log' && url.searchParams.get('action') === 'GET_LOG') {
      const lines = url.searchParams.get('iid')?.startsWith('[2') ? security : system;
      return sendEscaped(res, { 0: { Ret: 'ZCFG_SUCCESS', Oid: 'RDM_OID_LOG_CLASSIFY', Iid: url.searchParams.get('iid'), result: lines } });
    }
    const oid = url.searchParams.get('oid');
    if (url.pathname === '/cgi-bin/DAL' && oid === 'cellwan_sms') {
      if (req.method === 'GET') {
        return sendEscaped(res, {
          result: 'ZCFG_SUCCESS',
          Object: [{ SMS_Enable: true, SMS_UsedSpace: slotsUsed(), SMS_TotalSpace: 50, SMS_Inbox: sms }],
        });
      }
      // Like the real router, writes carry the session key on the URL.
      if (!url.searchParams.get('sessionkey')) return send(res, 401, { result: 'Invalid session key' });
      if (req.method === 'DELETE') {
        const ids = new Set(
          String(url.searchParams.get('objIndex') ?? '')
            .split(',')
            .map(Number),
        );
        const slotsOfEntry = (m) => String(m.ObjIndex).split(',').filter(Boolean).map(Number);
        for (let i = sms.length - 1; i >= 0; i--) if (slotsOfEntry(sms[i]).some((n) => ids.has(n))) sms.splice(i, 1);
        return send(res, 200, { result: 'ZCFG_SUCCESS' });
      }
      readBody(req).then((b) => {
        if (req.method === 'PUT' && b.setSmsState === 1) {
          const m = sms.find((x) => x.ObjIndex === b.SMS_InboxObjId);
          if (m && m.State === 0) m.State = 1;
        } else if (req.method === 'POST') {
          const { text, unicode } = outboxText(b);
          sms.push({
            ObjIndex: takeSlots((b.SMS_Content_divData ?? [b.SMS_Content]).length),
            State: 2,
            FromType: 129,
            From: b.SMS_To,
            CharacterSet: unicode ? 2 : 1,
            Content: unicode ? ucs2(text) : text,
            TimeStamp: '', // like the real FWA505: sent messages carry no time
          });
          console.log(`[mock] SMS to ${b.SMS_To}: ${JSON.stringify(text)}`);
        }
        // Sending takes the modem a moment.
        setTimeout(() => send(res, 200, { result: 'ZCFG_SUCCESS' }), req.method === 'POST' ? 800 : 100);
      });
      return;
    }
    if (url.pathname === '/cgi-bin/DAL' && oid === 'cellwan_band') {
      if (req.method === 'GET') return sendEscaped(res, { result: 'ZCFG_SUCCESS', Object: [band] });
      if (req.method !== 'PUT' || !url.searchParams.get('sessionkey')) return send(res, 401, { result: 'Invalid session key' });
      readBody(req).then((b) => {
        band.INTF_Preferred_Access_Technology = b.INTF_Preferred_Access_Technology ?? band.INTF_Preferred_Access_Technology;
        band.INTF_Preferred_Bands = b.INTF_Preferred_Bands ?? band.INTF_Preferred_Bands;
        // Re-registers on the first allowed LTE band, like a modem picking a new anchor.
        const allowed = band.INTF_Preferred_Bands === 'Auto' ? ['B7'] : band.INTF_Preferred_Bands.split(',');
        band.INTF_Current_Band = allowed.includes('B7') ? 'B7' : (allowed.find((x) => x.startsWith('B')) ?? band.INTF_Current_Band);
        console.log(`[mock] band selection: ${band.INTF_Preferred_Access_Technology} / ${band.INTF_Preferred_Bands}`);
        setTimeout(() => send(res, 200, { result: 'ZCFG_SUCCESS' }), 600);
      });
      return;
    }
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
      o.SMSInfo = [{ InBoxStatus: 0, SMSNew: sms.some((m) => m.State === 0) }];
      if (wanDown()) {
        const wan = o.WanLanInfo.find((w) => w.X_ZYXEL_DefaultGatewayIface);
        Object.assign(wan, { Status: 'Down', IPv4Address: [], IPv6Address: [] });
      }
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
