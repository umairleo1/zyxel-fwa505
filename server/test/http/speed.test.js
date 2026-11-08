import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDeps, serve } from './helpers.js';

const W = { 'x-insight-request': '1' };

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: fakeDeps({
      db: {
        speedTests: () => [
          { ts: 1, trigger: 'manual', state: 'ok', downMbps: 100, upMbps: 20, idleMs: 40, plmn: '23430' },
          { ts: 2, trigger: 'manual', state: 'ok', downMbps: 300, upMbps: 50, idleMs: 30, plmn: '23415' },
        ],
        bandNetwork: (plmn) => ({ plmn: plmn ?? '23430', operator: 'EE' }),
      },
      speed: {
        state: { running: null },
        run: async (o) => (calls.push(['run', o]), { id: 1, state: 'ok' }),
        cancel: () => (calls.push(['cancel']), { running: null }),
      },
      optimiser: {
        running: false,
        state: { running: null },
        plan: async () => ({ baseline: { key: 'b' }, arms: [] }),
        history: () => [],
        start: async (o) => (calls.push(['start', o]), { running: { id: 1 } }),
        cancel: () => ({ running: null }),
      },
      placement: {
        state: { capturing: null },
        spots: (plmn) => (calls.push(['spots', plmn]), { spots: [], otherNetworks: 0 }),
        boost: (s) => (calls.push(['boost', s]), { remainingMs: s * 1000 }),
        capture: async (o) => (calls.push(['capture', o]), { id: 1, ...o }),
        remove: (id) => ({ deleted: id }),
      },
      ...over,
    }),
  };
}

test('speed history comes with a diagnosis; runs and cancels need the CSRF header', async () => {
  const { deps: d, calls } = deps();
  const s = await serve(d);
  try {
    const got = JSON.parse((await s.request('/api/speed')).body);
    // Only the network in use: another SIM's results would skew the diagnosis.
    assert.equal(got.tests.length, 1);
    assert.equal(got.otherNetworks, 1);
    assert.deepEqual(got.network, { plmn: '23430', operator: 'EE' });
    assert.equal(got.diagnosis.summary.ok, 1);
    assert.equal((await s.request('/api/speed/run', { method: 'POST' })).status, 403);
    assert.equal((await s.request('/api/speed/run', { method: 'POST', headers: W })).status, 200);
    assert.deepEqual(calls[0], ['run', { trigger: 'manual' }]);
  } finally {
    await s.close();
  }
});

test('the optimiser and placement routes pass their input through', async () => {
  const { deps: d, calls } = deps();
  const s = await serve(d);
  try {
    const placement = JSON.parse((await s.request('/api/placement')).body);
    assert.equal(placement.network.plmn, '23430');
    assert.deepEqual(calls.at(-1), ['spots', '23430']);
    const plan = JSON.parse((await s.request('/api/speed/optimiser')).body);
    assert.equal(plan.plan.baseline.key, 'b');
    await s.request('/api/speed/optimiser', { method: 'POST', headers: W, body: { rounds: 2, arms: ['x'] } });
    assert.deepEqual(calls.at(-1), ['start', { rounds: 2, arms: ['x'] }]);
    await s.request('/api/placement/boost', { method: 'POST', headers: W, body: { seconds: 60 } });
    assert.deepEqual(calls.at(-1), ['boost', 60]);
    await s.request('/api/placement/spots', { method: 'POST', headers: W, body: { name: 'Hall', seconds: 20 } });
    assert.deepEqual(calls.at(-1), ['capture', { name: 'Hall', seconds: 20 }]);
    assert.equal(JSON.parse((await s.request('/api/placement/spots/3', { method: 'DELETE', headers: W })).body).deleted, 3);
  } finally {
    await s.close();
  }
});

test('while the optimiser runs, nothing else may change bands, the collector or the router', async () => {
  const { deps: d } = deps();
  d.optimiser.running = true;
  d.radio = { get: async () => ({}), apply: async () => ({}) };
  const s = await serve(d);
  try {
    const put = await s.request('/api/radio', { method: 'PUT', headers: W, body: { bands: 'Auto' } });
    assert.equal(put.status, 409);
    assert.match(JSON.parse(put.body).error, /optimiser is running/);
    assert.equal((await s.request('/api/collector/pause', { method: 'POST', headers: W })).status, 409);
    assert.equal((await s.request('/api/radio')).status, 200, 'reads still work');
  } finally {
    await s.close();
  }
});
