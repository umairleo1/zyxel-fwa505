import test from 'node:test';
import assert from 'node:assert/strict';
import { wifiQuality, WIFI_CUTS, rsrpBars, rsrpQuality, RSRP_CUTS, SINR_CUTS, sinrQuality } from '../quality.js';

test('RSRP bars match the router UI thresholds', () => {
  assert.deepEqual([-80, -95, -96, -100, -104, -106, -111, -112, -125, -126, -140].map(rsrpBars), [5, 4, 4, 3, 3, 2, 2, 1, 1, 0, 0]);
  assert.equal(rsrpQuality(-104), 'Fair');
});

test('SQL cut points agree with the rating functions', () => {
  const [ex, good, fair] = RSRP_CUTS;
  assert.equal(rsrpQuality(ex), 'Excellent');
  assert.equal(rsrpQuality(ex - 1), 'Good');
  assert.equal(rsrpQuality(good), 'Good');
  assert.equal(rsrpQuality(good - 1), 'Fair');
  assert.equal(rsrpQuality(fair), 'Fair');
  assert.equal(rsrpQuality(fair - 1), 'Poor');
  const [sEx, sGood, sFair] = SINR_CUTS;
  assert.deepEqual([sEx, sGood, sFair, sFair - 1].map(sinrQuality), ['Excellent', 'Good', 'Fair', 'Poor']);
});

test('Wi-Fi scale follows design guidance: -67 dBm minimum for calls and video', () => {
  assert.deepEqual(WIFI_CUTS, [-50, -67, -75]);
  const cases = {
    [-30]: 'Excellent',
    [-50]: 'Excellent',
    [-51]: 'Good',
    [-67]: 'Good',
    [-68]: 'Fair',
    [-75]: 'Fair',
    [-76]: 'Poor',
    [-90]: 'Poor',
  };
  for (const [dbm, label] of Object.entries(cases)) assert.equal(wifiQuality(Number(dbm)), label, dbm);
  assert.equal(wifiQuality(null), null);
});
