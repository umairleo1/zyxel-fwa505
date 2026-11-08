import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlacement, summariseReadings } from '../../src/speed/placement.js';

const reading = (fetchedAt, sinr, combo = 'B3 + n78') => ({
  fetchedAt,
  signal: { lte: { rsrp: -90 }, nr: { rsrp: -96 } },
  carriers: {
    combo,
    carriers: [
      { band: 'B3', bandwidth: 20, sinr: sinr + 6 },
      { band: 'n78', bandwidth: 40, sinr },
    ],
  },
});

test('a spot is the median of its readings, with the most common combination', () => {
  const s = summariseReadings([reading(1, 4), reading(2, 6, 'B7 + n78'), reading(3, 50), reading(4, 5)]);
  assert.equal(s.samples, 4);
  assert.equal(s.combo, 'B3 + n78');
  assert.equal(s.lteRsrp, -90);
  // The outlier (50 dB) doesn't drag the median.
  assert.ok(s.sinr < 10, `sinr ${s.sinr}`);
  assert.ok(s.score > 0 && s.capacity > 0);
});

function harness({ phase = 'ok' } = {}) {
  let t = 0;
  let n = 0;
  const saved = [];
  const boosts = [];
  const collector = {
    state: { phase, router: reading(0, 8) },
    boost: (ms) => boosts.push(ms),
  };
  const db = { insertSpot: (s) => saved.push(s) && saved.length, spots: () => saved, deleteSpot: (id) => (saved[id - 1] ? 1 : 0) };
  // Each 1 s poll sees a new router read every other time, like a 2 s boosted collector.
  const sleep = async (ms) => {
    t += ms;
    if (++n % 2 === 0) collector.state.router = reading(t, 8);
  };
  const placement = createPlacement({ db, collector, now: () => t, sleep });
  return { placement, saved, boosts };
}

test('capturing a spot boosts readings, counts each router read once and saves it', async () => {
  const h = harness();
  const spot = await h.placement.capture({ name: '  Landing window ', seconds: 10 });
  assert.equal(spot.name, 'Landing window');
  assert.equal(spot.samples, 5, 'one per distinct router read, not per poll');
  assert.equal(h.saved.length, 1);
  assert.ok(h.boosts[0] >= 10_000);
  assert.equal(h.placement.state.capturing, null);
});

test('bad captures are refused', async () => {
  const h = harness();
  await assert.rejects(h.placement.capture({ name: '', seconds: 20 }), /Name the spot/);
  await assert.rejects(h.placement.capture({ name: 'x', seconds: 5 }), /10 to 60/);
  await assert.rejects(harness({ phase: 'backoff' }).placement.capture({ name: 'x', seconds: 20 }), (e) => e.status === 409);
  assert.throws(() => h.placement.boost(999), /1 to 300/);
  assert.throws(
    () => h.placement.remove(7),
    (e) => e.status === 404,
  );
});

test('spots are listed for the network in use; spots from other networks are counted, not mixed in', () => {
  const rows = [
    { id: 1, name: 'Window', plmn: '23430' },
    { id: 2, name: 'Hall', plmn: '23415' },
    { id: 3, name: 'Old', plmn: null }, // from before spots recorded their network
  ];
  const placement = createPlacement({ db: { spots: () => rows }, collector: { state: {} } });
  const ee = placement.spots('23430');
  assert.deepEqual(
    ee.spots.map((s) => s.name),
    ['Window', 'Old'],
  );
  assert.equal(ee.otherNetworks, 1);
  assert.equal(placement.spots(null).spots.length, 3);
  assert.equal(summariseReadings([{ ...reading(1, 5), signal: { plmn: '23415' } }]).plmn, '23415');
});
