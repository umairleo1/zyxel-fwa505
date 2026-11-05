import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpans, subtractSpans } from '../../src/lib/util.js';

const span = (start, end) => ({ start, end });

test('mergeSpans unions overlapping and touching spans', () => {
  assert.deepEqual(mergeSpans([span(5, 8), span(0, 2), span(1, 3), span(3, 4), span(9, 9)]), [span(0, 4), span(5, 8)]);
  assert.deepEqual(mergeSpans([]), []);
});

test('subtractSpans cuts holes out and drops slivers', () => {
  assert.deepEqual(subtractSpans([span(0, 100)], [span(20, 30), span(25, 40), span(90, 120)]), [span(0, 20), span(40, 90)]);
  assert.deepEqual(subtractSpans([span(0, 100)], [span(3, 97)], 5), [], 'pieces of 3 are under the minimum');
  assert.deepEqual(subtractSpans([{ start: 0, end: 10, tag: 'x' }], []), [{ start: 0, end: 10, tag: 'x' }], 'keeps other fields');
});
