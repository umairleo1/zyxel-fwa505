import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, rankCorrelation } from '../../src/speed/diagnose.js';

const HOUR = 3600e3;
// ts encodes the hour directly so tests don't depend on the machine's time zone.
const hourOf = (ts) => Math.floor(ts / HOUR) % 24;
const at = (day, hour) => (day * 24 + hour) * HOUR;
const ok = (ts, down, extra = {}) => ({
  ts,
  trigger: 'schedule',
  state: 'ok',
  downMbps: down,
  upMbps: 20,
  idleMs: 40,
  loadedDownMs: 60,
  loadedUpMs: 60,
  nrSinr: 12,
  combo: 'B3 + n78',
  ...extra,
});

test('rank correlation handles ties and needs five pairs', () => {
  assert.equal(
    rankCorrelation([
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
      [5, 50],
    ]),
    1,
  );
  assert.equal(
    rankCorrelation([
      [1, 50],
      [2, 40],
      [3, 30],
      [4, 20],
      [5, 10],
    ]),
    -1,
  );
  assert.equal(rankCorrelation([[1, 1]]), null);
});

test('too few tests says so instead of guessing', () => {
  const d = diagnose([ok(at(0, 9), 100)], { hourOf });
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].kind, 'data');
});

test('optimiser tests are left out of the diagnosis', () => {
  const d = diagnose([ok(at(0, 9), 100), ok(at(0, 10), 300, { trigger: 'optimiser' })], { hourOf });
  assert.equal(d.summary.tests, 1);
});

test('bufferbloat is found and the SQM shaping figures come from measured speed', () => {
  const tests = [0, 1, 2, 3].map((d) => ok(at(d, 12), 100, { loadedDownMs: 340 }));
  const f = diagnose(tests, { hourOf }).findings.find((x) => x.kind === 'bufferbloat');
  assert.ok(f);
  assert.equal(f.severity, 'warn');
  assert.match(f.title, /300 ms.*grade D/);
  assert.match(f.action, /85 Mbps down and 17 Mbps up/);
});

test('slow evenings with steady signal read as a busy mast', () => {
  const tests = [];
  for (let d = 0; d < 3; d++) {
    tests.push(ok(at(d, 3), 150), ok(at(d, 20), 60));
  }
  const f = diagnose(tests, { hourOf }).findings.find((x) => x.kind === 'congestion');
  assert.ok(f, 'congestion found');
  assert.match(f.title, /Slower in the evening: 60 Mbps vs 150 Mbps in the night/);
});

test('low signal quality points to placement', () => {
  const tests = [0, 1, 2, 3].map((d) => ok(at(d, 12), 40, { nrSinr: 2 }));
  const f = diagnose(tests, { hourOf }).findings.find((x) => x.kind === 'radio');
  assert.equal(f.severity, 'warn');
  assert.match(f.action, /Placement page/);
});

test('a faster band combination is reported once there are enough tests of each', () => {
  const tests = [];
  for (let d = 0; d < 3; d++) tests.push(ok(at(d, 12), 150, { combo: 'B3 + n78+n78' }), ok(at(d, 13), 90, { combo: 'B7+B3 + n78+n1' }));
  const f = diagnose(tests, { hourOf }).findings.find((x) => x.kind === 'setup');
  assert.match(f.title, /B3 \+ n78\+n78 tested faster than B7\+B3 \+ n78\+n1/);
});

test('consistent results with good latency give a clean bill', () => {
  const tests = [0, 1, 2, 3].map((d) => ok(at(d, 12), 120));
  const d = diagnose(tests, { hourOf });
  assert.equal(d.findings[0].kind, 'ok');
  assert.equal(d.summary.grade, 'A');
  assert.equal(d.byHour[12].n, 4);
});
