import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TZ = 'Europe/London';
const { dayCoverage, usageToday } = await import('../src/lib/traffic.js');
const { seriesSummary } = await import('../src/components/charts/svg.js');

test('usageToday is zero until today has a sample', () => {
  const now = Date.UTC(2026, 10, 3, 9);
  const yesterday = { day: Date.UTC(2026, 10, 2), rx: 5, tx: 1 };
  const today = { day: Date.UTC(2026, 10, 3), rx: 7, tx: 2 };
  assert.equal(usageToday(null, now), null);
  assert.deepEqual(usageToday([yesterday], now), { day: now, rx: 0, tx: 0 });
  assert.equal(usageToday([yesterday, today], now), today);
  assert.deepEqual(usageToday([], now), { day: now, rx: 0, tx: 0 });
});

test('dayCoverage: hours of a local day Insight watched', () => {
  const day = Date.UTC(2026, 10, 3); // midnight in London (GMT in November)
  const h = 3600e3;
  const coverage = { unmonitored: [{ start: day - 2 * h, end: day + 7 * h }], outages: [{ start: day + 12 * h, end: day + 13 * h }] };
  const near = (c, watchedH, totalH) => {
    assert.deepEqual([c.watchedH, c.totalH], [watchedH, totalH]);
    assert.ok(Math.abs(c.share - watchedH / totalH) < 1e-9);
  };
  near(dayCoverage(day, coverage, { now: day + 48 * h }), 16, 24);
  // Today so far: judged up to now only.
  near(dayCoverage(day, coverage, { now: day + 10 * h }), 3, 10);
  // Before the fetched window nothing is known, so it isn't counted either way.
  assert.equal(dayCoverage(day, coverage, { windowFrom: day + 6 * h, now: day + 48 * h }).totalH, 18);
  assert.equal(dayCoverage(day, coverage, { windowFrom: day + 30 * h, now: day + 48 * h }), null);
  assert.equal(dayCoverage(day, null, { now: day + 48 * h }).share, 1);
});

test('seriesSummary gives latest/min/max per series', () => {
  const points = [
    { t: 1, a: 3, b: null },
    { t: 2, a: 1, b: Number.NaN },
    { t: 3, a: 2, b: null },
  ];
  const series = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
  ];
  assert.equal(
    seriesSummary(points, series, (v) => `${v}%`),
    'A: latest 2%, min 1%, max 3%; B: no data',
  );
});
