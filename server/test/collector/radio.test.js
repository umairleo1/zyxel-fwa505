import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSignal } from '../../src/collector/radio.js';

// Field names as returned by a real FWA505 (V1.71(ACKO.0)C0).
const cell = {
  Status: 'Up',
  CurrentAccessTechnology: 'NR5G-NSA',
  NetworkInUse: 'Current_EE_NR5G-NSA_23430',
  RSSI: -92,
  X_ZYXEL_CurrentBand: 'B7',
  X_ZYXEL_CellID: 1234567,
  X_ZYXEL_PhyCellID: 274,
  X_ZYXEL_DownlinkBandwidth: '20M',
  X_ZYXEL_RSRP: -105,
  X_ZYXEL_RSRQ: -12,
  X_ZYXEL_SINR: 3,
};
const nr = { Enable: true, PhyCellID: 1006, Band: 'N78', DownlinkBandwidth: '40M', RSSI: -84, RSRP: -97, RSRQ: -12, SINR: 4 };

test('summarises LTE anchor and 5G NSA leg', () => {
  const s = summarizeSignal(cell, nr);
  assert.equal(s.operator, 'EE');
  assert.equal(s.plmn, '23430');
  assert.equal(s.tech, 'NR5G-NSA');
  assert.deepEqual(s.lte, { band: 'B7', cellId: 1234567, pci: 274, bandwidth: '20M', rsrp: -105, rsrq: -12, sinr: 3, rssi: -92 });
  assert.equal(s.nr.band, 'N78');
  assert.equal(s.nr.rsrp, -97);
});

test('treats an idle 5G leg as absent', () => {
  assert.equal(summarizeSignal(cell, { ...nr, RSRP: 0 }).nr, null);
  assert.equal(summarizeSignal(cell, null).nr, null);
  assert.equal(summarizeSignal(null, nr), null);
});
