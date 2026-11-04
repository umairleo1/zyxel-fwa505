import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/storage/db.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'insight-db-'));
const metric = (ts) => ({ ts, uptime: 1, lte_rsrp: -90, nr_rsrp: -95, combo: 'B3 + n78', cell: '1/2' });

test('signal samples are buffered, but every read sees them', () => {
  const file = path.join(tmpDir(), 'a.db');
  const pushed = [];
  const db = openDb(file, { onMetric: (m) => pushed.push(m.ts) });
  db.insertMetric(metric(1_000));
  db.insertMetric(metric(6_000));
  assert.deepEqual(pushed, [1_000, 6_000], 'live updates are not delayed by the buffer');

  const peek = new DatabaseSync(file, { readOnly: true });
  assert.equal(peek.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 0, 'not written yet');
  assert.equal(db.metricCoverage(0, 10_000).samples, 2, 'a read flushes first');
  assert.equal(peek.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 2);
  peek.close();
  db.close();
});

test('the buffer is written once it spans a minute, and on close', () => {
  const file = path.join(tmpDir(), 'b.db');
  const db = openDb(file);
  const count = () => {
    const peek = new DatabaseSync(file, { readOnly: true });
    const n = peek.prepare('SELECT COUNT(*) AS n FROM metrics').get().n;
    peek.close();
    return n;
  };
  for (let t = 0; t < 60_000; t += 5_000) db.insertMetric(metric(t));
  assert.equal(count(), 0);
  db.insertMetric(metric(60_000));
  assert.equal(count(), 13);
  db.insertMetric(metric(65_000));
  db.close();
  assert.equal(count(), 14, 'close flushes what is left');
});

test('backup writes a consistent copy including unflushed samples, and never overwrites', async () => {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'live.db'));
  db.insertMetric(metric(1_000));
  const target = path.join(dir, 'backups', 'insight-2026-11-04.db');
  await db.backup(target);
  const copy = new DatabaseSync(target, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 1);
  copy.close();
  await assert.rejects(db.backup(target), /already exists/);
  db.close();
});

test('nested batches join one transaction and roll back together', () => {
  const db = openDb(path.join(tmpDir(), 'n.db'));
  assert.throws(() =>
    db.batch(() => {
      db.upsertDevice({ mac: 'aa', name: 'x', ip: null, conn: null, icon: null, ts: 1, online: true });
      db.insertStations(1, [{ mac: 'aa', band: '5G', rssi: -50, snr: 30, rateMbps: 100 }]); // its own transaction, nested
      throw new Error('boom');
    }),
  );
  assert.equal(db.devices().length, 0, 'the device write was rolled back with the rest');
  db.close();
});

test('the band backfill failing does not stop the database opening', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'f.db');
  const raw = new DatabaseSync(file);
  // A metrics table whose combo column breaks the backfill's window query.
  raw.exec('CREATE TABLE metrics (ts INTEGER PRIMARY KEY, combo TEXT, cell TEXT, lte_rsrp REAL)');
  raw.exec("INSERT INTO metrics VALUES (1, 'B3', '1/2', -90)");
  raw.close();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const db = openDb(file);
    db.close();
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /backfill failed/.test(e)));
});
