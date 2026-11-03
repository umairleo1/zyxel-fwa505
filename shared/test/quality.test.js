import test from 'node:test';
import assert from 'node:assert/strict';
import { rsrpBars, rsrpQuality, RSRP_CUTS, SINR_CUTS, sinrQuality } from '../quality.js';

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
