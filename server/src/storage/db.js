import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { migrate } from './schema.js';
import { statementCache, transaction } from './sql.js';
import { logsRepo } from './logs.js';
import { metricsRepo } from './metrics.js';
import { samplesRepo } from './samples.js';
import { devicesRepo } from './devices.js';
import { reliabilityRepo } from './reliability.js';
import { bandsRepo } from './bands.js';
import { prune } from './retention.js';

// Pages copied per backup step (4 KB each); the event loop runs between steps.
const BACKUP_PAGES_PER_STEP = 256;

/**
 * Open (and migrate) the SQLite store and return one facade over all repositories.
 * hooks: { onLogs({ count, sources, maxId }), onMetric(sample) } fire after committed writes.
 */
export function openDb(file, hooks = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  // WAL + NORMAL: commits no longer fsync (only checkpoints do). A power cut can
  // lose the last commits but never corrupts the database. Much kinder to SD cards.
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  const sql = statementCache(db);
  const metrics = metricsRepo(db, sql, hooks);
  const bands = bandsRepo(db, sql);
  const flush = () => {
    metrics.flushMetrics();
    bands.flushBands();
  };
  return {
    ...logsRepo(db, sql, hooks),
    ...metrics,
    ...samplesRepo(db, sql),
    ...devicesRepo(sql),
    ...reliabilityRepo(sql),
    ...bands,
    flush,
    /** Run several repository writes as one commit. */
    batch: (fn) => transaction(db, fn),
    prune: (retention, now) => prune(db, sql, retention, now),
    /**
     * Consistent copy of the whole database to `target`, safe while running.
     * Throws if the file already exists. Uses SQLite's online backup API in small
     * steps (Node >= 22.16) so the event loop keeps serving; VACUUM INTO otherwise.
     */
    async backup(target) {
      if (fs.existsSync(target)) throw new Error(`Backup target already exists: ${target}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      flush();
      if (typeof sqlite.backup === 'function') await sqlite.backup(db, target, { rate: BACKUP_PAGES_PER_STEP });
      else db.prepare('VACUUM INTO ?').run(target);
    },
    close() {
      try {
        flush();
      } finally {
        db.close();
      }
    },
  };
}
