const TABLES = [
  ['logs', 'logsDays'],
  ['metrics', 'metricsDays'],
  ['station_samples', 'stationDays'],
  ['system_samples', 'systemDays'],
  ['traffic', 'trafficDays'],
  ['internet_samples', 'internetDays'],
  ['speed_tests', 'speedDays'],
];

/** Delete rows older than each table's retention window. Returns rows removed per table. */
export function prune(db, sql, retention, now = Date.now()) {
  const removed = {};
  for (const [table, key] of TABLES) {
    if (retention[key] == null) continue; // no window given: keep everything
    removed[table] = Number(sql(`DELETE FROM ${table} WHERE ts < ?`).run(now - retention[key] * 86400e3).changes);
  }
  db.exec('PRAGMA optimize');
  return removed;
}
