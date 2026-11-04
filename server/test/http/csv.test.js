import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { csvCell, writeAll } from '../../src/http/csv.js';
import { exportLines } from '../../src/http/routes/logs.js';

test('csvCell quotes and neutralises formulas', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  for (const s of ['+1', '-2', '@SUM(A1)', '\tx']) assert.equal(csvCell(s), `'${s}`);
  assert.equal(csvCell('\rx'), `"'\rx"`);
  assert.equal(csvCell('a=b'), 'a=b');
});

/** Fake response whose buffer is "full" after every `highWater` writes. */
function fakeRes(highWater) {
  const res = new EventEmitter();
  res.chunks = [];
  res.destroyed = false;
  res.writableEnded = false;
  res.write = (c) => {
    res.chunks.push(c);
    const full = res.chunks.length % highWater === 0;
    if (full) setImmediate(() => res.emit('drain'));
    return !full;
  };
  return res;
}

test('writeAll waits for drain and finishes', async () => {
  const res = fakeRes(2);
  const ok = await writeAll(res, ['a', 'b', 'c', 'd', 'e']);
  assert.ok(ok);
  assert.deepEqual(res.chunks, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('writeAll stops reading when the client disconnects', async () => {
  const res = new EventEmitter();
  res.chunks = [];
  res.write = (c) => {
    res.chunks.push(c);
    setImmediate(() => res.emit('close')); // buffer full, then the client goes away
    return false;
  };
  let produced = 0;
  function* lines() {
    for (;;) yield String(produced++);
  }
  assert.equal(await writeAll(res, lines()), false);
  assert.deepEqual(res.chunks, ['0']);
  assert.ok(produced <= 2);
});

test('exportLines pages through the log with a keyset cursor and pinned end', () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: 2500 - i, ts: 1e12 - i * 1000, source: 'syslog', message: `m${i}` }));
  const seen = [];
  const db = {
    query(filters, limit) {
      seen.push(filters);
      const start = filters.cursor ? rows.findIndex((r) => r.id === filters.cursor.id) + 1 : 0;
      return rows.slice(start, start + limit + 1);
    },
  };
  const lines = [...exportLines(db, { source: 'syslog' }, 42)];
  assert.equal(lines.length, 2501); // header + rows
  assert.equal(seen.length, 3);
  assert.ok(seen.every((f) => f.to === 42 && f.sources[0] === 'syslog'));
  assert.deepEqual(seen[1].cursor, { ts: rows[999].ts, id: rows[999].id });
});
