import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './schema.js';
import { statementCache } from './sql.js';
import { logsRepo } from './logs.js';
import { metricsRepo } from './metrics.js';
import { samplesRepo } from './samples.js';
import { devicesRepo } from './devices.js';
import { reliabilityRepo } from './reliability.js';
import { prune } from './retention.js';

/**
 * Open (and migrate) the SQLite store and return one facade over all repositories.
 * hooks: { onLogs({ count, sources, maxId }), onMetric(sample) } fire after committed writes.
 */
export function openDb(file, hooks = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  migrate(db);
  const sql = statementCache(db);
  return {
    ...logsRepo(db, sql, hooks),
    ...metricsRepo(sql, hooks),
    ...samplesRepo(db, sql),
    ...devicesRepo(sql),
    ...reliabilityRepo(sql),
    prune: (retention, now) => prune(db, sql, retention, now),
    close: () => db.close(),
  };
}
