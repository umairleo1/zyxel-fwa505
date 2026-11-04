import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TZ = 'Europe/London';
const { appendPage, dayBreaks, highlightRe, splitMatches } = await import('../src/lib/logs.js');

const row = (id, ts = id) => ({ id, ts });

test('appendPage appends older rows and drops ids already shown', () => {
  const prev = [row(10), row(9), row(8)];
  const next = appendPage(prev, [row(8), row(7), row(7), row(6)]);
  assert.deepEqual(
    next.map((r) => r.id),
    [10, 9, 8, 7, 6],
  );
});

test('appendPage keeps the same array when nothing is new', () => {
  const prev = [row(2), row(1)];
  assert.equal(appendPage(prev, [row(1)]), prev);
  assert.equal(appendPage(prev, []), prev);
});

test('dayBreaks marks the first row of each local day', () => {
  const items = [
    row(4, Date.UTC(2026, 9, 26, 0, 30)), // Mon 00:30 GMT
    row(3, Date.UTC(2026, 9, 25, 23, 50)), // Sun 23:50 GMT
    row(2, Date.UTC(2026, 9, 24, 23, 10)), // Sun 00:10 BST
    row(1, Date.UTC(2026, 9, 24, 22, 50)), // Sat 23:50 BST
  ];
  assert.deepEqual([...dayBreaks(items)], [4, 3, 1]);
});

test('highlight regexp escapes the query and splits case-insensitively', () => {
  assert.equal(highlightRe(''), null);
  const re = highlightRe('a.b(');
  assert.deepEqual(splitMatches('xA.B(y a.b( z axb', re), ['x', 'A.B(', 'y ', 'a.b(', ' z axb']);
  // Reusable: a global regexp must not carry state between rows.
  assert.deepEqual(splitMatches('a.b(', re), ['', 'a.b(', '']);
  assert.deepEqual(splitMatches('plain', null), ['plain']);
});
