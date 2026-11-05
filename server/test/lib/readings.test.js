import test from 'node:test';
import assert from 'node:assert/strict';
import { reading } from '../../src/lib/readings.js';

test('modem "no measurement" values and impossible readings are not readings', () => {
  assert.equal(reading('rsrp', -128), null);
  assert.equal(reading('sinr', -128), null);
  assert.equal(reading('rsrq', '-128'), null);
  assert.equal(reading('rsrp', -140), null, 'padding rows');
  assert.equal(reading('sinr', 55), null, 'above any real SINR');
  assert.equal(reading('rsrp', ''), null);
});

test('real readings pass through, including strings', () => {
  assert.equal(reading('rsrp', -103), -103);
  assert.equal(reading('rsrp', '-87'), -87);
  assert.equal(reading('sinr', -5), -5);
  assert.equal(reading('rsrq', -11), -11);
  assert.equal(reading('rssi', -70), -70);
});
