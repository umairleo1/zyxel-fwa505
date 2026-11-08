/** Speed tests (each with the radio state it ran under), optimiser runs and saved placement spots. */

const TEST_COLUMNS = [
  'ts',
  'trigger',
  'experiment_id',
  'arm',
  'state',
  'error',
  'down_mbps',
  'up_mbps',
  'idle_ms',
  'jitter_ms',
  'loaded_down_ms',
  'loaded_up_ms',
  'bytes_down',
  'bytes_up',
  'duration_ms',
  'tech',
  'combo',
  'cell',
  'bands_pref',
  'lte_rsrp',
  'lte_sinr',
  'nr_rsrp',
  'nr_sinr',
  'capacity',
  'plmn',
];

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const toCamel = (row) => (row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])) : null);
const json = (v) => {
  try {
    return v == null ? null : JSON.parse(v);
  } catch {
    return null;
  }
};
const experimentRow = (r) =>
  r && { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, state: r.state, plan: json(r.plan), result: json(r.result) };

export function speedRepo(sql) {
  return {
    /** Store one test; `t` uses the column names in camelCase. Returns its id. */
    insertSpeedTest(t) {
      const values = TEST_COLUMNS.map((c) => t[camel(c)] ?? null);
      const res = sql(`INSERT INTO speed_tests (${TEST_COLUMNS.join(', ')}) VALUES (${TEST_COLUMNS.map(() => '?').join(', ')})`).run(
        ...values,
      );
      return Number(res.lastInsertRowid);
    },
    /** Tests in [from, to], newest first. */
    speedTests: ({ from = 0, to = Date.now(), limit = 500 } = {}) =>
      sql('SELECT * FROM speed_tests WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?').all(from, to, limit).map(toCamel),
    speedTestsForExperiment: (id) => sql('SELECT * FROM speed_tests WHERE experiment_id = ? ORDER BY ts').all(id).map(toCamel),
    lastSpeedTest: (trigger) =>
      toCamel(
        trigger
          ? sql('SELECT * FROM speed_tests WHERE trigger = ? ORDER BY ts DESC LIMIT 1').get(trigger)
          : sql('SELECT * FROM speed_tests ORDER BY ts DESC LIMIT 1').get(),
      ),

    insertExperiment: ({ startedAt, state, plan }) =>
      Number(
        sql('INSERT INTO experiments (started_at, state, plan) VALUES (?, ?, ?)').run(startedAt, state, JSON.stringify(plan))
          .lastInsertRowid,
      ),
    updateExperiment: (id, { finishedAt = null, state, result = null }) =>
      sql('UPDATE experiments SET finished_at = ?, state = ?, result = ? WHERE id = ?').run(
        finishedAt,
        state,
        result == null ? null : JSON.stringify(result),
        id,
      ),
    experiment: (id) => experimentRow(sql('SELECT * FROM experiments WHERE id = ?').get(id)),
    experiments: (limit = 10) => sql('SELECT * FROM experiments ORDER BY started_at DESC LIMIT ?').all(limit).map(experimentRow),

    insertSpot: (s) =>
      Number(
        sql(
          'INSERT INTO placement_spots (ts, name, samples, score, capacity, sinr, lte_rsrp, nr_rsrp, combo, plmn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(s.ts, s.name, s.samples, s.score, s.capacity, s.sinr, s.lteRsrp, s.nrRsrp, s.combo, s.plmn ?? null).lastInsertRowid,
      ),
    spots: () => sql('SELECT * FROM placement_spots ORDER BY ts DESC').all().map(toCamel),
    deleteSpot: (id) => Number(sql('DELETE FROM placement_spots WHERE id = ?').run(id).changes),
  };
}
