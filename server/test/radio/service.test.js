import test from 'node:test';
import assert from 'node:assert/strict';
import { createRadioService, MIN_GAP_MS, normaliseBand, TRIAL_MS } from '../../src/radio/service.js';

// cellwan_band as the FWA505 (V1.71) reports it.
const initial = {
  INTF_Supported_Access_Technologies: 'Auto,NR5G-SA,NR5G-NSA,LTE',
  INTF_Preferred_Access_Technology: 'NR5G-NSA',
  INTF_Current_Access_Technology: 'NR5G-NSA',
  INTF_Supported_Bands: 'B1,B3,B7,n1,n78',
  INTF_Preferred_Bands: 'Auto',
  INTF_Current_Band: 'B7',
};

function harness({ enabled = true, meta = {} } = {}) {
  let t = 1_000_000;
  const router = { ...initial };
  const writes = [];
  const log = [];
  const client = {
    getJson: async () => ({ result: 'ZCFG_SUCCESS', Object: [{ ...router }] }),
    bandWrite: async (body) => {
      writes.push(body);
      Object.assign(router, body);
      return { result: 'ZCFG_SUCCESS' };
    },
  };
  const db = {
    insertMany: (rows) => log.push(...rows.map((r) => r.message)),
    getMeta: (k) => meta[k] ?? null,
    setMeta: (k, v) => (meta[k] = v),
  };
  const radio = createRadioService({ client, db, enabled, now: () => t });
  return { radio, router, writes, log, meta, advance: (ms) => (t += ms) };
}

test('normaliseBand splits supported values and parses the preference', () => {
  const s = normaliseBand({ ...initial, INTF_Preferred_Bands: 'B3,n78' });
  assert.deepEqual(s.technology.supported, ['Auto', 'NR5G-SA', 'NR5G-NSA', 'LTE']);
  assert.deepEqual(s.bands.preferred, ['B3', 'n78']);
  assert.equal(s.bands.current, 'B7');
});

test('a change is written as the whole object, starts a trial and is logged', async () => {
  const h = harness();
  const state = await h.radio.apply({ technology: 'NR5G-NSA', bands: ['n78', 'B3', 'n1'] });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].INTF_Preferred_Bands, 'B3,n1,n78');
  assert.equal(h.writes[0].INTF_Supported_Bands, initial.INTF_Supported_Bands, 'the rest of the object goes back unchanged');
  assert.deepEqual(state.trial.previous, { technology: 'NR5G-NSA', bands: 'Auto' });
  assert.equal(state.trial.until, 1_000_000 + TRIAL_MS);
  assert.match(h.log[0], /Band selection set to B3 \+ all 5G.*reverts in 5 min/);
  assert.ok(JSON.parse(h.meta.radioTrial).until, 'the trial survives a restart');
});

test('an invalid selection never reaches the router', async () => {
  const h = harness();
  await assert.rejects(h.radio.apply({ technology: 'NR5G-NSA', bands: ['B3'] }), (e) => e.status === 400);
  await assert.rejects(h.radio.apply({ technology: 'LTE', bands: ['firewall'] }), /Not supported/);
  assert.equal(h.writes.length, 0);
});

test('changes are spaced so the modem can re-register; reverting never waits', async () => {
  const h = harness();
  await h.radio.apply({ technology: 'NR5G-NSA', bands: ['B3', 'n78'] });
  await assert.rejects(h.radio.apply({ technology: 'NR5G-NSA', bands: ['B1', 'n78'] }), (e) => e.status === 429);
  await h.radio.revert();
  assert.equal(h.router.INTF_Preferred_Bands, 'Auto');
  h.advance(MIN_GAP_MS);
  await h.radio.apply({ technology: 'NR5G-NSA', bands: ['B1', 'n78'] });
  assert.equal(h.writes.length, 3);
});

test('a second change in a trial still reverts to where it started', async () => {
  const h = harness();
  await h.radio.apply({ technology: 'NR5G-NSA', bands: ['B3', 'n78'] });
  h.advance(MIN_GAP_MS);
  const s = await h.radio.apply({ technology: 'LTE', bands: ['B3'] });
  assert.deepEqual(s.trial.previous, { technology: 'NR5G-NSA', bands: 'Auto' });
  await h.radio.revert();
  assert.equal(h.router.INTF_Preferred_Access_Technology, 'NR5G-NSA');
  assert.equal(h.router.INTF_Preferred_Bands, 'Auto');
});

test('keep ends the trial; automatic resets the bands', async () => {
  const h = harness();
  await h.radio.apply({ technology: 'NR5G-NSA', bands: ['B3', 'n78'] });
  const kept = await h.radio.keep();
  assert.equal(kept.trial, null);
  assert.equal(h.meta.radioTrial, '');
  const auto = await h.radio.automatic();
  assert.equal(auto.bands.preferred, 'Auto');
  assert.equal(h.router.INTF_Preferred_Access_Technology, 'NR5G-NSA', 'network mode left alone');
  assert.match(h.log.at(-1), /reset to automatic/);
});

test('an overdue trial from before a restart is reverted on start', async () => {
  const meta = { radioTrial: JSON.stringify({ previous: { technology: 'NR5G-NSA', bands: ['B1', 'n1'] }, until: 1 }) };
  const h = harness({ meta });
  h.radio.start();
  await new Promise((r) => setTimeout(r, 10));
  h.radio.stop();
  assert.equal(h.router.INTF_Preferred_Bands, 'B1,n1');
  assert.match(h.log[0], /trial not kept: restored/);
  assert.equal(h.meta.radioTrial, '');
});

test('disabled: every call is refused', async () => {
  const h = harness({ enabled: false });
  await assert.rejects(h.radio.get(), (e) => e.status === 404);
  await assert.rejects(h.radio.apply({ bands: 'Auto' }), /disabled/);
  assert.equal(h.writes.length, 0);
});
