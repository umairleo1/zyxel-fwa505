import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLatency, bufferbloatGrade, capacityIndex, median, placementScore, spectralEfficiency, weightedSinr } from '../speed.js';

test('median ignores missing values and averages the middle pair', () => {
  assert.equal(median([3, null, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, undefined, NaN]), null);
  assert.equal(median([]), null);
});

test('spectral efficiency rises with SINR, is zero when unusable and capped at 256-QAM', () => {
  assert.equal(spectralEfficiency(null), 0);
  assert.equal(spectralEfficiency(-15), 0);
  assert.ok(spectralEfficiency(0) > 0);
  assert.ok(spectralEfficiency(10) > spectralEfficiency(5));
  assert.equal(spectralEfficiency(60), 7.4);
});

test('capacity index adds bandwidth × efficiency over measured carriers only', () => {
  const carriers = [
    { band: 'B3', bandwidth: 20, sinr: 12 },
    { band: 'n78', bandwidth: 40, sinr: 5 },
    { band: 'n1', bandwidth: 20, sinr: null }, // not measured: no contribution
  ];
  const expected = Math.round(20 * spectralEfficiency(12) + 40 * spectralEfficiency(5));
  assert.equal(capacityIndex(carriers), expected);
  assert.equal(capacityIndex([{ bandwidth: null, sinr: 10 }]), null);
  assert.equal(capacityIndex(undefined), null);
  // An extra carrier at the same quality raises capacity: why spots are ranked by it.
  assert.ok(capacityIndex([...carriers, { bandwidth: 40, sinr: 5 }]) > capacityIndex(carriers));
});

test('weighted SINR and placement score weight carriers by bandwidth', () => {
  const carriers = [
    { bandwidth: 20, sinr: 16 },
    { bandwidth: 40, sinr: 4 },
  ];
  assert.equal(weightedSinr(carriers), 8);
  assert.equal(placementScore(carriers), 43);
  assert.equal(placementScore([{ bandwidth: 20, sinr: -20 }]), 0);
  assert.equal(placementScore([{ bandwidth: 20, sinr: 40 }]), 100);
  assert.equal(placementScore([]), null);
});

test('bufferbloat grades follow the usual added-latency scale', () => {
  assert.equal(bufferbloatGrade(40, 42), 'A+');
  assert.equal(bufferbloatGrade(40, 60), 'A');
  assert.equal(bufferbloatGrade(40, 95), 'B');
  assert.equal(bufferbloatGrade(40, 200), 'C');
  assert.equal(bufferbloatGrade(40, 400), 'D');
  assert.equal(bufferbloatGrade(40, 900), 'F');
  assert.equal(bufferbloatGrade(null, 50), null);
});

test('added latency takes the worse loaded phase', () => {
  assert.equal(addedLatency({ idleMs: 40, loadedDownMs: 90, loadedUpMs: 140 }), 100);
  assert.equal(addedLatency({ idleMs: 40, loadedDownMs: 30, loadedUpMs: null }), 0);
  assert.equal(addedLatency({ idleMs: null, loadedDownMs: 90 }), null);
});
