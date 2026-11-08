import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-speed-')), 'test.db');

test('speed tests round-trip in camelCase, newest first, and by experiment', () => {
  const db = openDb(tmpFile());
  db.insertSpeedTest({ ts: 1000, trigger: 'manual', state: 'ok', downMbps: 120.5, upMbps: 22, combo: 'B3 + n78', nrSinr: 6 });
  const id = db.insertExperiment({ startedAt: 2000, state: 'running', plan: { arms: [{ key: 'a' }] } });
  db.insertSpeedTest({ ts: 3000, trigger: 'optimiser', experimentId: id, arm: 'a', state: 'failed', error: 'no connection' });
  const all = db.speedTests({ from: 0, to: 5000 });
  assert.deepEqual(
    all.map((t) => t.ts),
    [3000, 1000],
  );
  assert.equal(all[1].downMbps, 120.5);
  assert.equal(all[1].nrSinr, 6);
  assert.equal(db.speedTestsForExperiment(id)[0].error, 'no connection');
  assert.equal(db.lastSpeedTest('manual').ts, 1000);
  db.close();
});

test('experiments keep their plan and verdict as JSON', () => {
  const db = openDb(tmpFile());
  const id = db.insertExperiment({ startedAt: 1, state: 'running', plan: { rounds: 2 } });
  db.updateExperiment(id, { finishedAt: 9, state: 'complete', result: { winner: 'x' } });
  const e = db.experiment(id);
  assert.equal(e.state, 'complete');
  assert.equal(e.plan.rounds, 2);
  assert.equal(e.result.winner, 'x');
  assert.equal(db.experiments(5).length, 1);
  db.close();
});

test('placement spots are saved and deleted; old speed tests are pruned', () => {
  const db = openDb(tmpFile());
  const id = db.insertSpot({
    ts: 1,
    name: 'Window',
    samples: 10,
    score: 61,
    capacity: 180,
    sinr: 13.2,
    lteRsrp: -88,
    nrRsrp: -94,
    combo: 'B3 + n78',
  });
  assert.equal(db.spots()[0].lteRsrp, -88);
  assert.equal(db.deleteSpot(id), 1);
  assert.equal(db.spots().length, 0);

  const now = 1000 * 86400e3;
  db.insertSpeedTest({ ts: now - 500 * 86400e3, trigger: 'manual', state: 'ok' });
  db.insertSpeedTest({ ts: now - 1 * 86400e3, trigger: 'manual', state: 'ok' });
  const removed = db.prune({ speedDays: 400 }, now);
  assert.equal(removed.speed_tests, 1);
  assert.equal(removed.logs, undefined, 'tables without a window are left alone');
  db.close();
});
