import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestions } from '../src/lib/radio.js';

const supported = ['B1', 'B3', 'B7', 'B20', 'n1', 'n78'];
const band = (b, avgRsrp, seconds = 3600) => [b.toUpperCase(), { band: b, avgRsrp, seconds }];

test('suggestions narrow the 4G side by measured strength and keep every 5G band', () => {
  const history = new Map([band('B3', -89), band('B7', -103), band('B20', -92), band('B1', -120, 30)]);
  const out = suggestions({ supported, history, inUse: new Set(['B7', 'B3', 'N78', 'N1']) });
  assert.deepEqual(out[0].bands, ['B3', 'n1', 'n78']);
  assert.match(out[0].why, /3 dB above B20/);
  assert.deepEqual(out[1].bands, ['B3', 'B20', 'n1', 'n78'], 'within 6 dB of the best; B7 left out');
  assert.deepEqual(out[2].bands, ['B3', 'B7', 'n1', 'n78'], 'the carriers in use now');
});

test('no suggestions without enough history', () => {
  assert.deepEqual(suggestions({ supported, history: new Map([band('B3', -89)]), inUse: new Set() }), []);
});
