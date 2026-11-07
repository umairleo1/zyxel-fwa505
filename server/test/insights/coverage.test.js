import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageFor, unmonitoredMinMs } from '../../src/insights/coverage.js';
import { fakeDeps, serve } from '../http/helpers.js';

const fakeDb = (over = {}) => ({
  sampleGaps: () => [{ start: 0, end: 600_000 }],
  outages: () => [
    { start_ts: 100_000, end_ts: 200_000, kind: 'router', reason: 'timeout' },
    { start_ts: 300_000, end_ts: 400_000, kind: 'wan', reason: 'No WAN IP address' },
  ],
  ...over,
});

test('coverage: gaps minus router outages; mobile-data drops leave no gap', () => {
  const c = coverageFor(fakeDb(), { from: 0, to: 1_000_000, statusMs: 5_000, openOutages: [] });
  assert.deepEqual(c.outages, [{ start: 100_000, end: 200_000, reason: 'timeout' }]);
  assert.deepEqual(c.unmonitored, [
    { start: 0, end: 100_000 },
    { start: 200_000, end: 600_000 },
  ]);
});

test('coverage includes router outages still open in the collector', () => {
  const open = [{ kind: 'router', start_ts: 500_000, end_ts: 650_000, reason: 'network', ongoing: true }];
  const c = coverageFor(fakeDb({ outages: () => [] }), { from: 0, to: 1_000_000, statusMs: 5_000, openOutages: open });
  assert.deepEqual(c.outages, [{ start: 500_000, end: 650_000, reason: 'network' }]);
  assert.deepEqual(c.unmonitored, [{ start: 0, end: 500_000 }]);
});

test('the not-monitored threshold follows the status interval, never under 2 min', () => {
  assert.equal(unmonitoredMinMs(5_000), 120_000);
  assert.equal(unmonitoredMinMs(60_000), 180_000);
});

test('/api/metrics, /api/traffic and /api/system carry coverage', async (t) => {
  const db = {
    ...fakeDeps().db,
    ...fakeDb(),
    metrics: () => [],
    traffic: () => [],
    system: () => [],
    internetSamples: () => [],
    reboots: () => [],
  };
  const s = await serve(fakeDeps({ db, collector: { state: { phase: 'ok' }, statusMs: 5_000, openOutages: () => [] } }));
  t.after(s.close);
  for (const path of ['/api/metrics', '/api/traffic', '/api/system']) {
    const body = JSON.parse((await s.request(`${path}?from=0&to=1000000`)).body);
    assert.deepEqual(Object.keys(body.coverage), ['unmonitored', 'outages'], path);
    assert.equal(body.coverage.unmonitored.length, 2, path);
  }
});

test('edge slivers scale with the status interval', () => {
  // Status every 60 s: the gap runs up to a poll past each edge of the outage.
  const db = fakeDb({
    sampleGaps: () => [{ start: 40_000, end: 260_000 }],
    outages: () => [{ start_ts: 90_000, end_ts: 200_000, kind: 'router', reason: null }],
  });
  assert.deepEqual(coverageFor(db, { from: 0, to: 1_000_000, statusMs: 60_000, openOutages: [] }).unmonitored, []);
  assert.equal(coverageFor(db, { from: 0, to: 1_000_000, statusMs: 5_000, openOutages: [] }).unmonitored.length, 2);
});
