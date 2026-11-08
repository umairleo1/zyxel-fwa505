import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeedService, radioContext, recentWanMbps } from '../../src/speed/service.js';

const router = {
  signal: { tech: 'NR5G-NSA', lte: { rsrp: -90, sinr: 12 }, nr: { rsrp: -96, sinr: 5 } },
  carriers: {
    combo: 'B3 + n78',
    carriers: [
      { band: 'B3', bandwidth: 20, sinr: 12 },
      { band: 'n78', bandwidth: 40, sinr: 5 },
    ],
  },
  cellwan: { INTF_Cell_ID: 1234567, INTF_PhyCell_ID: 391 },
  wan: { up: true },
};

function harness({ result = { downMbps: 100, upMbps: 20, idleMs: 40 }, fail = null, traffic = [], everyHours = 0, state = {} } = {}) {
  let t = 1_000_000;
  const rows = [];
  const log = [];
  const db = {
    insertSpeedTest: (r) => rows.push(r) && rows.length,
    insertMany: (r) => log.push(...r.map((x) => x.message)),
    traffic: () => traffic,
    lastSpeedTest: () => null,
  };
  const collector = { state: { phase: 'ok', router, ...state } };
  const calls = [];
  const measure = async (opts) => {
    calls.push(opts);
    opts.onProgress({ phase: 'download', mbps: 50 });
    if (fail) throw fail;
    return result;
  };
  const radio = { trial: null };
  let blocked = null;
  const speed = createSpeedService({
    db,
    collector,
    radio,
    options: { downUrl: 'x', everyHours },
    measure,
    isBlocked: () => blocked,
    now: () => t,
    random: () => 0.5,
  });
  return { speed, rows, log, calls, radio, collector, block: (r) => (blocked = r), advance: (ms) => (t += ms) };
}

test('radio context is taken from the collector read', () => {
  const c = radioContext(router);
  assert.equal(c.tech, 'NR5G-NSA');
  assert.equal(c.combo, 'B3 + n78');
  assert.equal(c.cell, '1234567/391');
  assert.equal(c.nrSinr, 5);
  assert.ok(c.capacity > 0);
  assert.equal(radioContext(null).combo, null);
});

test('recent WAN throughput uses the last two counter samples', () => {
  const rows = [
    { ts: 0, wan_rx: 0, wan_tx: 0 },
    { ts: 30_000, wan_rx: 37_500_000, wan_tx: 1_000_000 }, // 10 Mbps down
  ];
  assert.equal(recentWanMbps(rows), 10);
  assert.equal(recentWanMbps(rows.slice(1)), null);
});

test('a test is stored with its radio context and progress is exposed', async () => {
  const h = harness();
  const row = await h.speed.run();
  assert.equal(h.rows.length, 1);
  assert.equal(row.state, 'ok');
  assert.equal(row.trigger, 'manual');
  assert.equal(row.combo, 'B3 + n78');
  assert.equal(row.downMbps, 100);
  assert.equal(h.speed.running, false);
  assert.match(h.log[0], /100 Mbps down/);
});

test('only one test at a time, and nothing manual while the optimiser owns the radio', async () => {
  const h = harness();
  const first = h.speed.run();
  await assert.rejects(h.speed.run(), (e) => e.status === 409);
  await first;
  h.block('the optimiser is running');
  await assert.rejects(h.speed.run(), /Wait until the optimiser finishes/);
  // The optimiser's own tests are allowed.
  await h.speed.run({ trigger: 'optimiser', experimentId: 3, arm: 'a' });
  assert.equal(h.rows.at(-1).experimentId, 3);
});

test('a failed test is stored as failed and reported', async () => {
  const h = harness({ fail: new Error('Download failed: timeout') });
  await assert.rejects(h.speed.run(), (e) => e.status === 502);
  assert.equal(h.rows[0].state, 'failed');
  assert.match(h.rows[0].error, /timeout/);
});

test('the schedule skips a busy line, a band trial or a down connection, and retries later', async () => {
  const busy = [
    { ts: 0, wan_rx: 0, wan_tx: 0 },
    { ts: 30_000, wan_rx: 75_000_000, wan_tx: 0 }, // 20 Mbps of other traffic
  ];
  const h = harness({ everyHours: 3, traffic: busy });
  h.speed.start();
  h.speed.stop();
  h.advance(6 * 60_000); // past the first delay
  await h.speed.tickForTest();
  assert.equal(h.rows.length, 0);
  assert.match(h.speed.state.schedule.lastSkip.reason, /line is busy/);

  const t = harness({ everyHours: 3 });
  t.speed.start();
  t.speed.stop();
  t.advance(6 * 60_000);
  t.radio.trial = { until: 1 };
  await t.speed.tickForTest();
  assert.match(t.speed.state.schedule.lastSkip.reason, /band trial/);
  t.radio.trial = null;
  t.collector.state.router = { ...router, wan: { up: false } };
  t.advance(11 * 60_000);
  await t.speed.tickForTest();
  assert.match(t.speed.state.schedule.lastSkip.reason, /mobile data is down/);
  t.collector.state.router = router;
  t.advance(11 * 60_000);
  await t.speed.tickForTest();
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].trigger, 'schedule');
  assert.equal(t.speed.state.schedule.lastSkip, null);
});

test('without a schedule nothing runs by itself', async () => {
  const h = harness();
  h.speed.start();
  h.advance(48 * 3600e3);
  await h.speed.tickForTest();
  assert.equal(h.rows.length, 0);
  assert.equal(h.speed.state.schedule.nextAt, null);
});
