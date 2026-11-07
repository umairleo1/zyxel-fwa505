import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { busyHourDip, computeInsights, hourlyProfile, projectMonth } from '../../src/insights/summary.js';

const H = 3600e3;
const D = 24 * H;
const fresh = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-summary-')), 's.db'));
const run = (db, over = {}) =>
  computeInsights({ db, from: 0, to: 7 * D, state: { rangeDays: 7 }, traffic: null, devices: [], stations: [], ...over });
const titles = (r) => r.recommendations.map((x) => x.title);

test("coverage counts from Insight's first sample, not the start of the period", () => {
  const db = fresh();
  // Insight started 1 day before the end of a 7-day period and watched all of it.
  for (let ts = 6 * D; ts <= 7 * D; ts += 30e3) db.insertMetric({ ts, lte_rsrp: -95, lte_sinr: 12 });
  const r = run(db);
  db.close();
  assert.equal(r.reliability.startedInPeriod, true);
  assert.ok(r.reliability.coveragePct > 95, `got ${r.reliability.coveragePct}%`);
  assert.ok(!titles(r).some((t) => /watched/.test(t)), 'no "monitor more" nag for a new install');
});

test('devices present when Insight first looked are not "new"', () => {
  const db = fresh();
  db.setMeta('devicesSeededAt', 5 * D);
  const devices = [
    { mac: 'a', first_seen: 5 * D, online: 1 },
    { mac: 'b', first_seen: 5 * D, online: 1 },
    { mac: 'c', first_seen: 6 * D, online: 1 }, // joined later
  ];
  const r = run(db, { devices });
  db.close();
  assert.equal(r.devices.newInRange, 1);
});

test('quality advice covers 5G too, and needs an hour of samples', () => {
  const db = fresh();
  for (let ts = 0; ts < 2 * H; ts += 5e3) db.insertMetric({ ts, lte_rsrp: -95, lte_sinr: 12, nr_rsrp: -95, nr_sinr: 5.4 });
  const r = run(db);
  assert.ok(titles(r).includes('Signal quality limits speed (average SINR 5G 5.4 dB)'), titles(r).join(' | '));

  const short = fresh();
  for (let ts = 0; ts < 10 * 60e3; ts += 5e3) short.insertMetric({ ts, lte_rsrp: -95, lte_sinr: 1 });
  assert.ok(!titles(run(short)).some((t) => /quality/.test(t)), 'ten minutes is a moment, not a pattern');
  db.close();
  short.close();
});

test("band advice uses each band's history, not one reading", () => {
  const db = fresh();
  // Two hours on B7 as primary with B3 as a secondary, a reading every 30 s.
  for (let ts = 0; ts <= 2 * H; ts += 30e3) {
    db.recordCarriers(ts, [
      { role: 'primary', rat: 'LTE', band: 'B7', rsrp: -104 },
      { role: 'secondary', rat: 'LTE', band: 'B3', rsrp: -89 },
    ]);
  }
  const r = run(db);
  db.close();
  assert.ok(
    titles(r).some((t) => /^B3 averages 15 dB stronger than B7, your usual primary$/.test(t)),
    titles(r).join(' | '),
  );
});

test('mobile data drops become a recommendation with their causes', () => {
  const db = fresh();
  db.insertOutage({ start_ts: H, end_ts: H + 120e3, reason: 'No WAN IP address', kind: 'wan' });
  db.insertOutage({ start_ts: 2 * H, end_ts: 2 * H + 60e3, reason: 'No cellular signal', kind: 'wan' });
  db.insertOutage({ start_ts: 3 * H, end_ts: 3 * H + 60e3, reason: 'No WAN IP address (Insight stopped)', kind: 'wan' });
  const r = run(db);
  db.close();
  const rec = r.recommendations.find((x) => /mobile data drop/.test(x.title));
  assert.equal(rec.title, '3 mobile data drops (4 min without internet)');
  assert.match(rec.detail, /No WAN IP address ×2, No cellular signal/);
});

test('internet stalls are counted apart from router outages and become a recommendation', () => {
  const db = fresh();
  db.insertOutage({ start_ts: H, end_ts: H + 150e3, reason: 'No reply from 1.1.1.1 or 8.8.8.8 (router reachable)', kind: 'internet' });
  db.insertOutage({
    start_ts: 2 * H,
    end_ts: 2 * H + 30e3,
    reason: 'No reply from 1.1.1.1 or 8.8.8.8 (router reachable)',
    kind: 'internet',
  });
  db.insertOutage({ start_ts: 3 * H, end_ts: 3 * H + 60e3, reason: 'network', kind: 'router' });
  const r = run(db);
  db.close();
  assert.equal(r.reliability.internetStalls, 2);
  assert.equal(r.reliability.internetStallSec, 180);
  assert.equal(r.reliability.longestStallSec, 150);
  assert.equal(r.reliability.routerOutages, 1);
  assert.ok(titles(r).includes('2 internet stalls (3 min, longest 3 min)'), titles(r).join(' | '));
});

test('projectMonth: none before two days of data, then the rate so far', () => {
  const month = { monthStart: 0, monthEnd: 30 * D };
  assert.equal(projectMonth({ used: 1e9, firstSampleTs: 0, now: D, ...month }).projected, null);
  const p = projectMonth({ used: 10e9, firstSampleTs: 0, now: 10 * D, ...month });
  assert.equal(p.projected, 30e9);
  // Insight started mid-month: the rate is from its first sample.
  assert.equal(projectMonth({ used: 4e9, firstSampleTs: 20 * D, now: 24 * D, ...month }).projected, 10e9);
});

test('hourly profile and the busy-hour dip need several days of every hour', () => {
  const rows = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    nr_sinr: hour >= 19 && hour <= 22 ? 3 : 8,
    lte_sinr: 10,
    n: 500,
    days: 5,
  }));
  const profile = hourlyProfile(rows, [{ t: new Date(2026, 10, 3, 20).getTime(), rxBps: 5e6 }]);
  assert.equal(profile[20].avgDownBps, 5e6);
  assert.equal(profile.length, 24);
  const dip = busyHourDip(profile);
  assert.deepEqual([dip.leg, dip.worst.hour, dip.worstSinr, dip.bestSinr], ['5G', 19, 3, 8]);

  const twoDays = hourlyProfile(
    rows.map((r) => ({ ...r, days: 2 })),
    [],
  );
  assert.equal(busyHourDip(twoDays), null, 'two evenings are not a pattern');
});
