import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createRateLimit, createSourceFilter, createWarnThrottle, defaultSources, normalizeIp } from '../../src/ingest/guard.js';
import { createUdpListener } from '../../src/ingest/udp.js';

const quiet = { info() {}, warn() {}, error() {} };

test('defaultSources takes the router host from ROUTER_URL', () => {
  assert.deepEqual(defaultSources('https://192.168.1.1'), ['192.168.1.1']);
  assert.deepEqual(defaultSources('http://router.lan:8080'), ['router.lan']);
  assert.deepEqual(defaultSources('http://[fd00::1]'), ['fd00::1']);
  assert.deepEqual(defaultSources('not a url'), []);
});

test('source filter: listed IPs, resolved names and loopback only', async () => {
  const f = createSourceFilter(['192.168.1.1', 'router.lan'], {
    lookup: async () => [{ address: '192.168.1.2' }],
    log: quiet,
  });
  await f.ready;
  assert.ok(f.allows('192.168.1.1'));
  assert.ok(f.allows('::ffff:192.168.1.1'));
  assert.ok(f.allows('192.168.1.2'));
  assert.ok(f.allows('127.0.0.1'));
  assert.ok(f.allows('::1'));
  assert.ok(!f.allows('192.168.1.66'));
  assert.equal(normalizeIp('::FFFF:10.0.0.1'), '10.0.0.1');

  const failing = createSourceFilter(['nope.invalid'], { lookup: async () => Promise.reject(new Error('ENOTFOUND')), log: quiet });
  await failing.ready;
  assert.ok(!failing.allows('10.0.0.1'));
  assert.ok(createSourceFilter(['*'], { log: quiet }).allows('10.9.9.9'));
});

test('rate limit: fixed one-minute window', () => {
  let now = 0;
  const rl = createRateLimit(2, () => now);
  assert.deepEqual([rl.take(), rl.take(), rl.take()], [true, true, false]);
  now = 60e3;
  assert.ok(rl.take());
});

test('warn throttle: once per minute per reason, with a suppressed count', () => {
  let now = 0;
  const out = [];
  const warn = createWarnThrottle({ warn: (m) => out.push(m) }, 60e3, () => now);
  warn('a', 'first');
  warn('a', 'again');
  warn('b', 'other');
  now = 61e3;
  warn('a', 'later');
  assert.deepEqual(out, ['first', 'other', 'later (1 similar suppressed)']);
});

test('UDP listener counts denied and rate-limited packets', async (t) => {
  const seen = [];
  let allowed = true;
  const listener = createUdpListener({
    name: 'test',
    host: '127.0.0.1',
    port: 0,
    log: quiet,
    allows: () => allowed,
    rateLimit: createRateLimit(2),
    onMessage: (buf) => seen.push(buf.toString()),
  });
  t.after(() => listener.close());
  await new Promise((r) => listener.socket.once('listening', r));
  const { port } = listener.socket.address();
  const sender = dgram.createSocket('udp4');
  t.after(() => sender.close());
  const send = (msg) => new Promise((r) => sender.send(msg, port, '127.0.0.1', r));
  const settle = () => new Promise((r) => setTimeout(r, 50));

  allowed = false;
  await send('x');
  await settle();
  allowed = true;
  for (const m of ['a', 'b', 'c']) await send(m);
  await settle();
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(listener.state.denied, 1);
  assert.equal(listener.state.dropped, 1);
  assert.equal(listener.state.received, 2);
});
