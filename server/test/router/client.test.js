import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RouterClient } from '../../src/router/client.js';

test('retries a GET once when the router drops the connection', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/cgi-bin/DAL') && hits++ === 0) return req.socket.destroy(); // -> "socket hang up"
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'ZCFG_SUCCESS', Object: [{ DeviceInfo: { UpTime: 5 } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new RouterClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, username: 'a', password: 'b' });
  client.sessionKey = 'k'; // skip login
  const data = await client.getStatus();
  assert.equal(data.Object[0].DeviceInfo.UpTime, 5);
  assert.equal(hits, 2);
  server.close();
});

test('refuses destructive calls', async () => {
  const client = new RouterClient({ baseUrl: 'http://127.0.0.1:1', username: 'a', password: 'b' });
  client.sessionKey = 'k';
  await assert.rejects(client.getJson('/cgi-bin/Log?action=DEL_LOG'), /read-only/);
});

test('load snapshot reports busy share of the minute and queue wait', async () => {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'ZCFG_SUCCESS', Object: [{}] }));
    }, 60);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new RouterClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, username: 'a', password: 'b', requestGapMs: 0 });
  client.sessionKey = 'k';
  await Promise.all([client.getStatus(), client.getCellwanStatus()]);
  const load = client.loadSnapshot();
  assert.equal(load.perMinute, 2);
  // ~120 ms of router time in a window that is only as long as the client has existed.
  assert.ok(load.busyPct > 50 && load.busyPct <= 100, `busyPct ${load.busyPct}`);
  assert.equal(load.queued, 0);
  assert.ok(load.queueWaitMs.max >= 50, 'the second request waited for the first');
  server.close();
});

/** Fake router whose /UserLogin replies come from `logins` in order; counts attempts. */
async function fakeRouter(logins) {
  const seen = { logins: 0, gets: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/getRSAPublickKey') return res.end('{}');
    if (req.url === '/UserLogin') {
      const [status, body] = logins[Math.min(seen.logins++, logins.length - 1)];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    if (req.url.startsWith('/cgi-bin/UserLogout')) return res.end('{}');
    seen.gets++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'ZCFG_SUCCESS', Object: [{}] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new RouterClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, username: 'a', password: 'b', requestGapMs: 0 });
  return { client, seen, close: () => server.close() };
}

test('never makes a third login attempt inside the lockout window, whatever the router replies', async () => {
  // An unfamiliar 200 reply (no session key, no recognisable wording) is still a failed attempt.
  const r = await fakeRouter([[200, { result: 'ZCFG_UNKNOWN' }]]);
  await assert.rejects(r.client.getStatus(), (e) => e.kind === 'http');
  await assert.rejects(r.client.getStatus(), (e) => e.kind === 'auth'); // second failure: treat as a bad password
  r.client.resume(); // the user presses Retry
  await assert.rejects(r.client.getStatus(), (e) => e.kind === 'auth' && /not trying again/.test(e.message));
  assert.equal(r.seen.logins, 2, 'a third attempt would lock the account');
  r.close();
});

test('a wrong password blocks further logins until resume', async () => {
  const r = await fakeRouter([[200, { result: 'Invalid password' }]]);
  await assert.rejects(r.client.getStatus(), (e) => e.kind === 'auth');
  await assert.rejects(r.client.getStatus(), (e) => e.kind === 'auth');
  assert.equal(r.seen.logins, 1, 'the block answers without asking the router again');
  r.close();
});

test('a duplicated-login reply backs off without counting as a password failure', async () => {
  const r = await fakeRouter([[200, { result: 'Duplicate login' }]]);
  await assert.rejects(r.client.getStatus(), (e) => e.kind === 'duplicate');
  await assert.rejects(r.client.getStatus(), (e) => e.kind === 'duplicate');
  assert.equal(r.seen.logins, 1);
  assert.equal(r.client.failedLogins.length, 0);
  r.close();
});

test('suspend stops queued requests from logging back in', async () => {
  const r = await fakeRouter([[200, { sessionkey: 'k1' }]]);
  try {
    await r.client.getStatus(); // logged in
    const running = r.client.getStatus(); // starts at once
    const queued = r.client.getStatus(); // waits behind it
    r.client.suspend(); // Pause
    await running; // already in flight: allowed to finish
    await assert.rejects(queued, (e) => e.kind === 'paused' && e.status === 409);
    await r.client.logout();
    await assert.rejects(r.client.getStatus(), (e) => e.kind === 'paused');
    assert.equal(r.seen.logins, 1, 'nothing logged back in while paused');
    r.client.resume();
    await r.client.getStatus();
    assert.equal(r.seen.logins, 2);
  } finally {
    r.close();
  }
});

test('certificate pin: first use pins, a change is refused and can be accepted', async () => {
  const { checkPinnedCertificate } = await import('../../src/router/client.js');
  assert.deepEqual(checkPinnedCertificate(null, 'AA'), { error: null, pin: 'AA' });
  assert.deepEqual(checkPinnedCertificate('AA', 'AA'), { error: null });
  const changed = checkPinnedCertificate('AA', 'BB');
  assert.equal(changed.error.kind, 'tls');
  assert.equal(changed.pending, 'BB');
  assert.equal(checkPinnedCertificate('AA', undefined).error.kind, 'tls');
});

test('a router presenting a different certificate never receives the password', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const https = await import('node:https');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-tls-'));
  const makeCert = (name) => {
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=router',
          '-keyout',
          path.join(dir, `${name}.key`),
          '-out',
          path.join(dir, `${name}.crt`),
        ],
        { stdio: 'ignore' },
      );
      return { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert: fs.readFileSync(path.join(dir, `${name}.crt`)) };
    } catch {
      return null;
    }
  };
  const a = makeCert('a');
  const b = makeCert('b');
  if (!a || !b) return t.skip('openssl not available');

  let loginBodies = 0;
  const handler = (req, res) => {
    if (req.url === '/UserLogin') loginBodies++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/UserLogin' ? { sessionkey: 'k' } : { result: 'ZCFG_SUCCESS', Object: [{}] }));
  };
  let server = https.createServer(a, handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const client = new RouterClient({ baseUrl: `https://127.0.0.1:${port}`, username: 'a', password: 'b', requestGapMs: 0 });
  await client.getStatus(); // pins certificate a
  assert.equal(loginBodies, 1);

  // Same address, different certificate: as if someone intercepted the connection.
  await new Promise((r) => server.close(r));
  server = https.createServer(b, handler);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  client.sessionKey = null; // force a fresh login
  await assert.rejects(client.getStatus(), (e) => e.kind === 'tls' && /certificate changed/.test(e.message));
  assert.equal(loginBodies, 1, 'the password must not be sent to the new certificate');

  client.resume({ trustNewCertificate: true }); // user confirms they reset the router
  await client.getStatus();
  assert.equal(loginBodies, 2);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Fake router that records every request; replies ZCFG_SUCCESS (or drops the socket when told). */
async function recordingRouter({ drop = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (drop) return req.socket.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'ZCFG_SUCCESS' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('SMS writes are refused unless enabled', async (t) => {
  const r = await recordingRouter();
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b' });
  client.sessionKey = 'k';
  await assert.rejects(client.smsWrite('POST', { body: { SMS_To: '1' } }), /disabled/);
  assert.equal(r.seen.length, 0);
});

test('an SMS send goes to cellwan_sms with the session key, as the router UI sends it', async (t) => {
  const r = await recordingRouter();
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowSms: true, requestGapMs: 0 });
  client.sessionKey = 'k1';
  await client.smsWrite('POST', { query: { timedelay: 1 }, body: { SMS_To: '447700900123' } });
  await client.smsWrite('DELETE', { query: { objIndex: '3,4' } });
  assert.deepEqual(
    r.seen.map((s) => [s.method, s.url, s.body]),
    [
      ['POST', '/cgi-bin/DAL?oid=cellwan_sms&timedelay=1&sessionkey=k1', { SMS_To: '447700900123' }],
      ['DELETE', '/cgi-bin/DAL?oid=cellwan_sms&objIndex=3%2C4&sessionkey=k1', null],
    ],
  );
});

test('the SMS exception cannot be pointed at anything else', async (t) => {
  const r = await recordingRouter();
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowSms: true, requestGapMs: 0 });
  client.sessionKey = 'k';
  await assert.rejects(client.smsWrite('PUT', { query: { oid: 'firewall' } }), /read-only/);
  await assert.rejects(client.smsWrite('POST', { query: { action: 'DEL_LOG' } }), /read-only/);
  await assert.rejects(client.smsWrite('PATCH'), /read-only/);
  assert.equal(r.seen.length, 0, 'nothing reached the router');
});

test('a dropped connection during an SMS send is not retried (it could send twice)', async (t) => {
  const r = await recordingRouter({ drop: true });
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowSms: true, requestGapMs: 0 });
  client.sessionKey = 'k';
  await assert.rejects(client.smsWrite('POST', { body: {} }), /socket hang up|ECONNRESET/);
  assert.equal(r.seen.length, 1);
});

test('band selection writes are refused unless enabled', async (t) => {
  const r = await recordingRouter();
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowSms: true });
  client.sessionKey = 'k';
  await assert.rejects(client.bandWrite({ INTF_Preferred_Bands: 'B3,n78' }), /disabled/);
  assert.equal(r.seen.length, 0);
});

test('a band selection is a PUT to cellwan_band and nothing else', async (t) => {
  const r = await recordingRouter();
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowBandSelection: true, requestGapMs: 0 });
  client.sessionKey = 'k1';
  await client.bandWrite({ INTF_Preferred_Bands: 'B3,n78' });
  assert.deepEqual(
    r.seen.map((s) => [s.method, s.url, s.body]),
    [['PUT', '/cgi-bin/DAL?oid=cellwan_band&sessionkey=k1', { INTF_Preferred_Bands: 'B3,n78' }]],
  );
  // Enabling band control doesn't open SMS, or any other setting.
  await assert.rejects(client.smsWrite('POST', { body: {} }), /disabled/);
  assert.equal(r.seen.length, 1);
});

test('a restart is refused unless enabled', async (t) => {
  const r = await recordingRouter();
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowSms: true, allowBandSelection: true });
  client.sessionKey = 'k';
  await assert.rejects(client.reboot(), /disabled/);
  assert.equal(r.seen.length, 0);
});

test('a restart is a POST to /cgi-bin/Reboot with only the session key, and ends the session', async (t) => {
  const r = await recordingRouter();
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowReboot: true, requestGapMs: 0 });
  client.sessionKey = 'k1';
  await client.reboot();
  assert.deepEqual(
    r.seen.map((s) => [s.method, s.url, s.body]),
    [['POST', '/cgi-bin/Reboot?sessionkey=k1', null]],
  );
  assert.equal(client.hasSession, false);
  // Enabling restart opens nothing else.
  await assert.rejects(client.bandWrite({}), /disabled/);
  await assert.rejects(client.smsWrite('POST', { body: {} }), /disabled/);
});

test('a dropped connection during a restart is not retried', async (t) => {
  const r = await recordingRouter({ drop: true });
  t.after(r.close);
  const client = new RouterClient({ baseUrl: r.url, username: 'a', password: 'b', allowReboot: true, requestGapMs: 0 });
  client.sessionKey = 'k';
  await assert.rejects(client.reboot(), /socket hang up|ECONNRESET/);
  assert.equal(r.seen.length, 1);
});

test('a router still starting up (5xx on login) never counts as a failed password', async () => {
  const r = await fakeRouter([[503, { result: 'Service Unavailable' }]]);
  for (let k = 0; k < 3; k++) await assert.rejects(r.client.getStatus(), (e) => e.kind === 'network');
  assert.equal(r.client.failedLogins.length, 0);
  assert.equal(r.seen.logins, 3);
  r.close();
});
