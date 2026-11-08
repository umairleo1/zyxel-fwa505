import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO } from '@zyxel-insight/shared/radio';
import { createOptimiser, planCandidates, verdict } from '../../src/speed/optimiser.js';
import { createRadioService } from '../../src/radio/service.js';

const supported = { technologies: ['Auto', 'NR5G-SA', 'NR5G-NSA', 'LTE'], bands: ['B1', 'B3', 'B7', 'n1', 'n78'] };
const history = [
  { band: 'B3', rat: 'LTE', seconds: 90_000, avgRsrp: -90, avgSinr: 12 },
  { band: 'B7', rat: 'LTE', seconds: 160_000, avgRsrp: -103, avgSinr: 7 },
  { band: 'B1', rat: 'LTE', seconds: 4_000, avgRsrp: -94, avgSinr: 9 },
  { band: 'n78', rat: 'NR', seconds: 250_000, avgRsrp: -96, avgSinr: 5.3 },
  { band: 'n1', rat: 'NR', seconds: 120_000, avgRsrp: -99, avgSinr: 1.5 },
];

test('the plan tries strong single anchors, strong-only 4G, dropping weak 5G and SA', () => {
  const plan = planCandidates({ supported, current: { technology: 'NR5G-NSA', bands: AUTO }, history });
  assert.equal(plan.baseline.label, 'Current setting');
  const labels = plan.arms.map((a) => a.label);
  assert.deepEqual(labels, [
    'Only B3 as the 4G anchor',
    'Only B1 as the 4G anchor',
    'Strong 4G only (B3+B1)',
    'Without weaker 5G (n1)',
    '5G standalone (SA)',
  ]);
  assert.deepEqual(plan.arms[0].selection, { technology: 'NR5G-NSA', bands: ['B3', 'n1', 'n78'] });
  assert.deepEqual(plan.arms[3].selection.bands, ['B1', 'B3', 'B7', 'n78']);
  assert.ok(new Set(plan.arms.map((a) => a.key)).size === plan.arms.length, 'keys are unique');
});

test('a custom current setting is compared with automatic first; arms never repeat the baseline', () => {
  const current = { technology: 'NR5G-NSA', bands: ['B3', 'n1', 'n78'] };
  const plan = planCandidates({ supported, current, history, maxArms: 3 });
  assert.equal(plan.arms[0].label, 'Automatic');
  assert.equal(plan.arms.length, 3);
  assert.ok(!plan.arms.some((a) => a.key === plan.baseline.key));
});

test('with no history the bands serving now are used as anchors', () => {
  const plan = planCandidates({ supported, current: { technology: 'Auto', bands: AUTO }, history: [], inUse: ['B7', 'n78'] });
  assert.deepEqual(
    plan.arms.map((a) => a.label),
    ['Only B7 as the 4G anchor', '5G standalone (SA)'],
  );
});

const t = (round, arm, down, extra = {}) => ({
  round,
  arm,
  state: 'ok',
  downMbps: down,
  upMbps: 20,
  idleMs: 40,
  loadedDownMs: 80,
  ...extra,
});

test('a clear, consistent gain wins; a small or one-off gain does not', () => {
  const tests = [t(0, 'base', 100), t(0, 'a', 140), t(0, 'b', 104), t(1, 'base', 90), t(1, 'a', 126), t(1, 'b', 120)];
  const v = verdict({ baselineKey: 'base', armKeys: ['a', 'b'], tests });
  assert.equal(v.winner, 'a');
  assert.equal(v.arms[0].gain, 0.4);
  assert.equal(v.arms[0].wins, 2);
  assert.match(v.reason, /40% faster/);
  // b alone in round 0: +4 %, under the 10 % margin.
  const small = verdict({ baselineKey: 'base', armKeys: ['b'], tests: tests.filter((x) => x.arm !== 'a' && x.round === 0) });
  assert.equal(small.winner, null);
  assert.match(small.reason, /Keep what you have/);
});

test('a faster download that costs upload, latency or reliability does not win', () => {
  const tests = [t(0, 'base', 100), t(0, 'a', 150, { upMbps: 8 }), t(0, 'c', 150, { loadedDownMs: 400 }), t(0, 'd', 150)];
  tests.push({ round: 1, arm: 'base', ...t(1, 'base', 100) }, t(1, 'a', 150, { upMbps: 8 }), t(1, 'c', 150, { loadedDownMs: 400 }));
  tests.push({ round: 1, arm: 'd', state: 'failed', error: 'no connection' });
  const v = verdict({ baselineKey: 'base', armKeys: ['a', 'c', 'd'], tests });
  assert.equal(v.winner, null);
  assert.equal(v.arms.find((a) => a.key === 'd').failed, 1);
});

/** A real radio service over a fake router, a fake speed test that depends on the bands, and a settled collector. */
function harness({ speeds = { Auto: 100, 'B3,n1,n78': 150 }, onTest = () => {} } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const sleep = async (ms) => {
    clock += ms;
  };
  const routerObj = {
    INTF_Supported_Access_Technologies: supported.technologies.join(','),
    INTF_Preferred_Access_Technology: 'NR5G-NSA',
    INTF_Current_Access_Technology: 'NR5G-NSA',
    INTF_Supported_Bands: supported.bands.join(','),
    INTF_Preferred_Bands: 'Auto',
    INTF_Current_Band: 'B7',
  };
  const writes = [];
  const seenFor = []; // networks band history was asked for
  const meta = {};
  const experiments = new Map();
  const tests = [];
  const db = {
    insertMany: () => {},
    getMeta: (k) => meta[k] ?? null,
    setMeta: (k, v) => (meta[k] = v),
    bandNetwork: (plmn) => ({ plmn: plmn ?? '23430', operator: 'EE' }),
    bandsSeen: ({ plmn } = {}) => (seenFor.push(plmn), plmn === '23430' ? history : []),
    insertExperiment: (e) => (experiments.set(experiments.size + 1, { id: experiments.size + 1, ...e }), experiments.size),
    updateExperiment: (id, patch) => Object.assign(experiments.get(id), patch),
    experiment: (id) => experiments.get(id),
    experiments: () => [...experiments.values()].reverse(),
    insertSpeedTest: (r) => tests.push(r) && tests.length,
    speedTestsForExperiment: (id) => tests.filter((x) => x.experimentId === id),
  };
  const client = {
    getJson: async () => ({ result: 'ZCFG_SUCCESS', Object: [{ ...routerObj }] }),
    bandWrite: async (body) => {
      writes.push(body.INTF_Preferred_Bands);
      Object.assign(routerObj, body);
    },
  };
  const radio = createRadioService({ client, db, enabled: true, now });
  const collector = {
    state: { phase: 'ok', router: { wan: { up: true }, carriers: { combo: 'B3 + n78', carriers: [] } } },
    boost: () => 0,
  };
  let n = 0;
  const speed = {
    running: false,
    async run({ arm, experimentId }) {
      onTest(++n);
      const down = speeds[routerObj.INTF_Preferred_Bands] ?? 90;
      const row = {
        ts: now(),
        trigger: 'optimiser',
        arm,
        experimentId,
        state: 'ok',
        downMbps: down,
        upMbps: 20,
        idleMs: 40,
        loadedDownMs: 70,
      };
      tests.push(row);
      return row;
    },
  };
  const settle = { minMs: 20_000, stableMs: 10_000, maxMs: 90_000, pollMs: 2_000 };
  const optimiser = createOptimiser({ radio, speed, collector, db, now, sleep, settle, log: { warn() {} } });
  const finished = async () => {
    while (optimiser.running) await new Promise((r) => setImmediate(r));
  };
  return { optimiser, radio, routerObj, writes, experiments, tests, collector, seenFor, finished, cancel: () => optimiser.cancel() };
}

test('a run tests every arm against the baseline each round, finds the winner and ends on the starting setting', async () => {
  const h = harness();
  const plan = await h.optimiser.plan();
  const b3 = plan.arms.find((a) => a.label === 'Only B3 as the 4G anchor');
  await h.optimiser.start({ rounds: 2, arms: [b3.key, plan.arms.at(-1).key] });
  await h.finished();
  const e = h.experiments.get(1);
  assert.equal(e.state, 'complete');
  assert.equal(e.result.winner, b3.key);
  assert.equal(h.tests.length, 6, '2 rounds × (baseline + 2 arms)');
  assert.equal(h.routerObj.INTF_Preferred_Bands, 'Auto', 'back where it started');
  assert.equal(h.routerObj.INTF_Preferred_Access_Technology, 'NR5G-NSA');
  assert.equal(h.radio.trial, null, 'no trial left behind');
});

test('cancelling stops the run, restores the setting and gives no verdict', async () => {
  const h = harness({ onTest: (n) => n === 2 && h.cancel() });
  await h.optimiser.start({ rounds: 3 });
  await h.finished();
  const e = h.experiments.get(1);
  assert.equal(e.state, 'cancelled');
  assert.equal(e.result.winner, null);
  assert.equal(h.routerObj.INTF_Preferred_Bands, 'Auto');
  assert.equal(h.radio.trial, null);
});

test('a setting with no stable connection is recorded as failed, not tested', async () => {
  const h = harness();
  const plan = await h.optimiser.plan();
  const sa = plan.arms.find((a) => a.label.startsWith('5G standalone'));
  const original = h.collector.state.router;
  // While SA is selected, mobile data never comes up.
  Object.defineProperty(h.collector.state, 'router', {
    get: () => (h.routerObj.INTF_Preferred_Access_Technology === 'NR5G-SA' ? { wan: { up: false }, carriers: { combo: null } } : original),
  });
  await h.optimiser.start({ rounds: 1, arms: [sa.key] });
  await h.finished();
  const failed = h.tests.find((x) => x.arm === sa.key);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /No stable connection/);
  assert.equal(h.experiments.get(1).result.winner, null);
  assert.equal(h.routerObj.INTF_Preferred_Access_Technology, 'NR5G-NSA', 'restored after the failed arm');
});

test('a run is refused during a band trial, with bad input, or while running', async () => {
  const h = harness();
  await h.radio.apply({ technology: 'NR5G-NSA', bands: ['B3', 'n78'] });
  await assert.rejects(h.optimiser.start(), /Keep or revert the band trial/);
  await h.radio.revert();
  await assert.rejects(h.optimiser.start({ rounds: 9 }), /Rounds must be/);
  await assert.rejects(h.optimiser.start({ arms: ['nope'] }), /plan changed/);
  await h.optimiser.start({ rounds: 1 });
  await assert.rejects(h.optimiser.start({ rounds: 1 }), (e) => e.status === 409);
  await h.finished();
});

test("the plan ranks bands from the current network's history only; a new network falls back to the bands in use", async () => {
  const h = harness();
  h.collector.state.router = { ...h.collector.state.router, signal: { plmn: '23430' } };
  const plan = await h.optimiser.plan();
  assert.equal(h.seenFor.at(-1), '23430');
  assert.equal(plan.network.historyBands, history.length);
  assert.ok(plan.arms.some((a) => a.label === 'Only B3 as the 4G anchor'));

  // A new SIM: no history on 23415, so its anchors come from the carriers serving now.
  h.collector.state.router = {
    wan: { up: true },
    signal: { plmn: '23415' },
    carriers: { combo: 'B20 + n78', carriers: [{ band: 'B20' }, { band: 'n78' }] },
  };
  h.routerObj.INTF_Supported_Bands = 'B1,B3,B7,B20,n1,n78';
  const fresh = await h.optimiser.plan();
  assert.equal(h.seenFor.at(-1), '23415');
  assert.equal(fresh.network.historyBands, 0);
  assert.deepEqual(
    fresh.arms.map((a) => a.label),
    ['Only B20 as the 4G anchor', '5G standalone (SA)'],
  );
});
