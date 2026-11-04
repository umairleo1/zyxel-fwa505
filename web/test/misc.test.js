import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TZ = 'Europe/London';
const { usageToday } = await import('../src/lib/traffic.js');
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
