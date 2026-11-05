import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterMarkers, focusWindow, spanAt, timelineSummary } from '../src/lib/timeline.js';

const x = (ts) => ts / 1000; // 1 px per second

test('clusterMarkers merges markers that would overlap and keeps the most severe kind', () => {
  const markers = [
    { ts: 0, kind: 'cell' },
    { ts: 5_000, kind: 'reboot', expected: true },
    { ts: 10_000, kind: 'combo' }, // 5 px after the previous one: same cluster
    { ts: 40_000, kind: 'combo' },
    { ts: 60_000, kind: 'reboot', expected: false },
  ];
  const c = clusterMarkers(markers, x, 12);
  assert.deepEqual(
    c.map((k) => [k.kind, k.items.length, k.x, k.alert]),
    [
      ['reboot', 3, 5, false],
      ['combo', 1, 40, false],
      ['reboot', 1, 60, true],
    ],
  );
  assert.deepEqual([c[0].from, c[0].to], [0, 10_000]);
  assert.deepEqual(clusterMarkers([], x), []);
});

test('focusWindow pads by 1/24 of the view within 10 min and 6 h, and stops at now', () => {
  const h = 3600e3;
  const now = 100 * h;
  // 24 h view: pad 1 h each side.
  assert.deepEqual(focusWindow(50 * h, 50 * h, { from: 0, to: 24 * h }, now), { from: 49 * h, to: 51 * h });
  // 1 h view: the 10 min minimum wins.
  assert.deepEqual(focusWindow(50 * h, 50 * h, { from: 0, to: h }, now), { from: 50 * h - 5 * 60e3, to: 50 * h + 5 * 60e3 });
  // 30 d view: the 6 h maximum wins.
  assert.deepEqual(focusWindow(50 * h, 50 * h, { from: 0, to: 720 * h }, now), { from: 47 * h, to: 53 * h });
  // A moment a minute ago: the window ends now and still spans 10 min.
  assert.deepEqual(focusWindow(now - 60e3, now - 60e3, { from: 0, to: h }, now), { from: now - 10 * 60e3, to: now });
});

test('spanAt and timelineSummary', () => {
  const outages = [
    { start: 1_000, end: 61_000, kind: 'router', reason: null },
    { start: 100_000, end: 130_000, kind: 'wan', reason: 'No WAN IP address' },
    { start: 120_000, end: 140_000, kind: 'router', reason: null, ongoing: true }, // overlaps the one before
  ];
  assert.equal(spanAt(outages, 500), null);
  assert.equal(spanAt(outages, 110_000), outages[1]);
  const s = timelineSummary({
    outages,
    unmonitored: [{ start: 200_000, end: 260_000 }],
    markers: [{ kind: 'cell' }, { kind: 'cell' }, { kind: 'reboot' }, { kind: 'unknown' }],
  });
  assert.deepEqual(s, {
    outages: 3,
    byKind: { router: 2, wan: 1 },
    downSec: 100, // 60 + 40, the 10 s overlap counted once
    ongoing: true,
    unmonitoredSec: 60,
    counts: { reboot: 1, cell: 2, combo: 0 },
  });
  assert.deepEqual(timelineSummary(), {
    outages: 0,
    byKind: { router: 0, wan: 0 },
    downSec: 0,
    ongoing: false,
    unmonitoredSec: 0,
    counts: { reboot: 0, cell: 0, combo: 0 },
  });
});
