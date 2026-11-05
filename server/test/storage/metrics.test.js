import test from 'node:test';
import assert from 'node:assert/strict';
import { histogramStats } from '../../src/storage/metrics.js';

test('histogram statistics are exact', () => {
  // values -110 x10, -100 x30, -90 x60
  const s = histogramStats(
    [
      { v: -110, c: 10 },
      { v: -100, c: 30 },
      { v: -90, c: 60 },
    ],
    [-94, -99, -105],
  );
  assert.deepEqual(s.stats, { n: 100, avg: -95, min: -110, max: -90, p10: -110, p90: -90 }); // 10th of 100 sorted values is the last -110
  assert.deepEqual(s.dist, { excellent: 60, good: 0, fair: 30, poor: 10 });
  assert.equal(histogramStats([], [0, 0, 0]), null);
});

test('half-dB readings give a tidy histogram and rounded statistics', () => {
  const s = histogramStats(
    [
      { v: -10.5, c: 2 },
      { v: -10, c: 1 },
      { v: 1 / 3, c: 1 }, // not from a modem, but must not leak 16 digits into the UI
    ],
    [20, 13, 0],
  );
  assert.deepEqual([s.stats.min, s.stats.max], [-10.5, 0.3]);
});
