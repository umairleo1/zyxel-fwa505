import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { buildTimeline, timelineFor } from '../../src/insights/timeline.js';

const traffic = { bucketMs: 60e3, series: [{ t: 0, rxBps: 1, txBps: 2 }], peak: { rx: 1, tx: 2 } };
const base = { from: 1_000, to: 10_000, traffic, outages: [], reboots: [], events: [] };

test('timeline merges reboots and change events in time order', () => {
  const t = buildTimeline({
    ...base,
    reboots: [
      { boot_ts: 8_000, kind: 'unexplained', reason: null },
      { boot_ts: 3_000, kind: 'expected', reason: 'Firmware upgrade' },
    ],
    events: [
      { ts: 5_000, facility: 'carriers', message: 'Band combination changed: B3 → B3 + n78' },
      { ts: 2_000, facility: 'cell', message: 'Serving cell changed: a → b' },
      { ts: 4_000, facility: 'collector', message: 'not a change event' },
    ],
  });
  assert.deepEqual(
    t.markers.map((m) => [m.ts, m.kind]),
    [
      [2_000, 'cell'],
      [3_000, 'reboot'],
      [5_000, 'combo'],
      [8_000, 'reboot'],
    ],
  );
  assert.equal(t.markers[1].expected, true);
  assert.equal(t.markers[1].message, 'Router rebooted (Firmware upgrade)');
  assert.equal(t.markers[3].expected, false);
  assert.equal(t.truncated, false);
  assert.deepEqual(t.series, traffic.series);
});

test('timeline clips outages to the window and drops markers outside it', () => {
  const t = buildTimeline({
    ...base,
    outages: [
      { start_ts: 9_000, end_ts: 12_000, reason: 'timeout' },
      { start_ts: 500, end_ts: 2_000, reason: null },
      { start_ts: 100, end_ts: 900, reason: null }, // ended before the window
    ],
    reboots: [{ boot_ts: 500, kind: 'expected', reason: null }],
  });
  assert.deepEqual(t.outages, [
    { start: 1_000, end: 2_000, kind: 'router', reason: null, ongoing: false },
    { start: 9_000, end: 10_000, kind: 'router', reason: 'timeout', ongoing: false },
  ]);
  assert.deepEqual(t.markers, []);
});

test('timeline keeps the newest markers when capped', () => {
  const events = [1_000, 2_000, 3_000, 4_000].map((ts) => ({ ts, facility: 'cell', message: String(ts) }));
  const t = buildTimeline({ ...base, events, maxMarkers: 3 });
  assert.deepEqual(
    t.markers.map((m) => m.ts),
    [2_000, 3_000, 4_000],
  );
  assert.equal(t.truncated, true);
});

test('timelineFor reads the window from the store', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-timeline-')), 't.db'));
  const now = 1_700_000_000_000;
  // 1 MB down / 0.5 MB up per 30 s sample.
  for (let i = 0; i < 6; i++) db.insertTraffic({ ts: now + i * 30e3, wan_rx: i * 1e6, wan_tx: i * 5e5, lan_rx: 0, lan_tx: 0 });
  db.insertOutage({ start_ts: now + 40e3, end_ts: now + 70e3, reason: 'timeout' });
  db.insertReboot({ boot_ts: now + 80e3, detected_at: now + 90e3, kind: 'unexplained', reason: null, last_seen_before: null });
  db.insertMany([
    { ts: now + 60e3, source: 'insight', facility: 'cell', level: 'notice', message: 'Serving cell changed: a → b' },
    { ts: now + 61e3, source: 'router-system', facility: 'cell', level: 'notice', message: 'router line, not ours' },
  ]);

  const t = timelineFor(db, { from: now, to: now + 150e3, bucketMs: 60e3, trafficPadMs: 0, statusMs: 5e3 });
  db.close();
  assert.ok(t.series.length > 0);
  assert.ok(t.series.every((p) => Math.abs(p.rxBps - (1e6 * 8) / 30) < 1e-6));
  assert.deepEqual(t.outages, [{ start: now + 40e3, end: now + 70e3, kind: 'router', reason: 'timeout', ongoing: false }]);
  assert.deepEqual(
    t.markers.map((m) => m.kind),
    ['cell', 'reboot'],
  );
});

test('gaps a router outage explains are not "unmonitored"', () => {
  const m = 60e3;
  const t = buildTimeline({
    ...base,
    from: 0,
    to: 100 * m,
    outages: [
      { start_ts: 20 * m, end_ts: 30 * m, kind: 'router', reason: 'timeout' },
      { start_ts: 60 * m, end_ts: 70 * m, kind: 'wan', reason: 'No WAN IP address' },
    ],
    // Insight stopped from 10 to 50 min; the router was also down for part of it.
    gaps: [
      { start: 10 * m, end: 50 * m },
      { start: 21 * m, end: 29 * m }, // entirely inside the router outage
      { start: 80 * m, end: 80 * m + 20e3 }, // what's left is a sliver at a poll boundary
    ],
  });
  assert.deepEqual(
    t.unmonitored.map((u) => [u.start / m, u.end / m]),
    [
      [10, 20],
      [30, 50],
    ],
  );
  assert.deepEqual(
    t.outages.map((o) => o.kind),
    ['router', 'wan'],
  );
});

test('timelineFor adds outages still open in the collector, and gaps in the samples', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-timeline-')), 'g.db'));
  const t0 = 1_700_000_000_000;
  const metric = (ts) => db.insertMetric({ ts, uptime: 1, lte_rsrp: -90 });
  for (let ts = t0; ts <= t0 + 60e3; ts += 5e3) metric(ts); // watching for a minute
  for (let ts = t0 + 3_660e3; ts <= t0 + 3_720e3; ts += 5e3) metric(ts); // then back an hour later
  const open = [{ kind: 'wan', start_ts: t0 + 3_700e3, end_ts: t0 + 3_720e3, reason: 'No WAN IP address', ongoing: true }];

  const t = timelineFor(db, { from: t0, to: t0 + 3_720e3, bucketMs: 60e3, trafficPadMs: 0, statusMs: 5e3, openOutages: open });
  db.close();
  assert.deepEqual(t.unmonitored, [{ start: t0 + 60e3, end: t0 + 3_660e3 }]);
  assert.deepEqual(t.outages, [{ start: t0 + 3_700e3, end: t0 + 3_720e3, kind: 'wan', reason: 'No WAN IP address', ongoing: true }]);
});
