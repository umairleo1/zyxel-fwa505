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
