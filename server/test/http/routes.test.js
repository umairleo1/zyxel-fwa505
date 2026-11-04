import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreshGate, MAX_ROUTER_IDS, MAX_SSE_CLIENTS } from '../../src/http/limits.js';
import { healthOf } from '../../src/http/health.js';
import { fakeDeps, serve } from './helpers.js';

test('fresh gate allows once per window per key', () => {
  let now = 0;
  const gate = createFreshGate(10e3, () => now);
  assert.ok(gate.allow('a'));
  assert.ok(!gate.allow('a'));
  assert.ok(gate.allow('b'));
  now = 10e3;
  assert.ok(gate.allow('a'));
});

test('/api/router caps ids and honours fresh at most once per 10 s per id', async (t) => {
  const calls = [];
  const routerData = { has: () => true, public: async (id, maxAge) => (calls.push([id, maxAge]), { id }) };
  const s = await serve(fakeDeps({ routerData }));
  t.after(s.close);
  const many = Array.from({ length: MAX_ROUTER_IDS + 1 }, (_, i) => `id${i}`).join(',');
  assert.equal((await s.request(`/api/router?ids=${many}`)).status, 400);
  assert.equal(calls.length, 0);

  await s.request('/api/router?ids=status,lan&fresh=1');
  await s.request('/api/router?ids=status&fresh=1');
  await s.request('/api/router/lan?fresh=1');
  assert.deepEqual(calls, [
    ['status', 0],
    ['lan', 0],
    ['status', undefined],
    ['lan', undefined],
  ]);
});

test('SSE connections are capped', async (t) => {
  const hub = { size: MAX_SSE_CLIENTS, subscribe: (_req, res) => res.end() };
  const s = await serve(fakeDeps({ hub }));
  t.after(s.close);
  assert.equal((await s.request('/api/events')).status, 503);
  hub.size = 0;
  assert.equal((await s.request('/api/events')).status, 200);
});

test('health: ok, paused, halted and stale', () => {
  const now = 1_000_000_000;
  const opts = { statusIntervalSec: 5, startedAt: now - 3600e3, now };
  assert.deepEqual(
    [
      healthOf({ phase: 'ok', lastSuccessAt: now - 10e3 }, opts),
      healthOf({ phase: 'paused', lastSuccessAt: now - 3600e3 }, opts),
      healthOf({ phase: 'halted', lastSuccessAt: now - 1e3 }, opts),
      healthOf({ phase: 'backoff', lastSuccessAt: now - 181e3 }, opts), // 3 × 60 s
      healthOf({ phase: 'backoff', lastSuccessAt: now - 60e3 }, opts),
      healthOf({ phase: 'starting', lastSuccessAt: null }, { ...opts, startedAt: now - 5e3 }),
    ].map((h) => [h.code, h.body.status]),
    [
      [200, 'ok'],
      [200, 'paused'],
      [503, 'halted'],
      [503, 'stale'],
      [200, 'backoff'],
      [200, 'starting'],
    ],
  );
  // Longer status intervals stretch the threshold.
  assert.equal(healthOf({ phase: 'ok', lastSuccessAt: now - 500e3 }, { ...opts, statusIntervalSec: 200 }).code, 200);
});

test('/api/health returns 503 when halted', async (t) => {
  const collector = { state: { phase: 'halted', lastSuccessAt: null } };
  const s = await serve(fakeDeps({ collector }));
  t.after(s.close);
  const res = await s.request('/api/health');
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).status, 'halted');
});
