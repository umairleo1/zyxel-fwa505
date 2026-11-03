import { bucketExpr } from './sql.js';

export const METRIC_COLS = ['lte_rsrp', 'lte_rsrq', 'lte_sinr', 'lte_rssi', 'nr_rsrp', 'nr_rsrq', 'nr_sinr', 'nr_rssi'];
const round1 = (x) => Math.round(x * 10) / 10;

/** Exact statistics from a value histogram [{ v, c }] sorted by v. */
export function histogramStats(hist, cuts) {
  const n = hist.reduce((a, h) => a + h.c, 0);
  if (!n) return null;
  const sum = hist.reduce((a, h) => a + h.v * h.c, 0);
  const quantile = (q) => {
    const target = Math.floor(q * (n - 1));
    let acc = 0;
    for (const h of hist) if ((acc += h.c) > target) return h.v;
    return hist.at(-1).v;
  };
  const share = (pred) => round1((hist.filter((h) => pred(h.v)).reduce((a, h) => a + h.c, 0) / n) * 100);
  const [excellent, good, fair] = cuts;
  return {
    stats: { n, avg: round1(sum / n), min: hist[0].v, max: hist.at(-1).v, p10: quantile(0.1), p90: quantile(0.9) },
    dist: {
      excellent: share((v) => v >= excellent),
      good: share((v) => v >= good && v < excellent),
      fair: share((v) => v >= fair && v < good),
      poor: share((v) => v < fair),
    },
  };
}

export function metricsRepo(sql, hooks) {
  const insert = () =>
    sql(`INSERT OR REPLACE INTO metrics (ts, uptime, combo, cell, ${METRIC_COLS.join(', ')})
      VALUES (:ts, :uptime, :combo, :cell, ${METRIC_COLS.map((c) => `:${c}`).join(', ')})`);

  return {
    insertMetric(m) {
      insert().run({
        ts: m.ts,
        uptime: m.uptime ?? null,
        combo: m.combo ?? null,
        cell: m.cell ?? null,
        ...Object.fromEntries(METRIC_COLS.map((c) => [c, m[c] ?? null])),
      });
      hooks.onMetric?.(m);
    },

    /** Signal samples averaged into buckets so long ranges stay light. */
    metrics: ({ from, to }, bucketMs) =>
      sql(`SELECT ${bucketExpr} AS t, ${METRIC_COLS.map((c) => `ROUND(AVG(${c}), 1) AS ${c}`).join(', ')}
        FROM metrics WHERE ts >= ? AND ts <= ? GROUP BY t ORDER BY t`).all(bucketMs, bucketMs, from ?? 0, to ?? Date.now()),

    /**
     * Distribution statistics for one column. Readings are whole dB(m) values, so a
     * single GROUP BY pass yields an exact histogram (~60 rows) instead of loading
     * every sample (~500k for 30 days) into JavaScript.
     */
    metricStats(col, from, to, cuts) {
      if (!METRIC_COLS.includes(col)) throw new Error(`Unknown metric column ${col}`);
      const hist = sql(
        `SELECT ${col} AS v, COUNT(*) AS c FROM metrics WHERE ts >= ? AND ts <= ? AND ${col} IS NOT NULL GROUP BY v ORDER BY v`,
      ).all(from, to);
      return histogramStats(hist, cuts);
    },

    /** One pass: samples, minutes with data (coverage), 5G samples, distinct cells; plus combo shares. */
    metricCoverage(from, to) {
      const c = sql(`SELECT COUNT(*) AS n, COUNT(nr_rsrp) AS nr, COUNT(DISTINCT cell) AS cells, COUNT(DISTINCT ts / 60000) AS minutes
        FROM metrics WHERE ts >= ? AND ts <= ?`).get(from, to);
      const combos = sql(
        'SELECT combo, COUNT(*) AS n FROM metrics WHERE ts >= ? AND ts <= ? AND combo IS NOT NULL GROUP BY combo ORDER BY n DESC LIMIT 8',
      ).all(from, to);
      return { samples: c.n, covered: c.minutes * 60_000, combos, cells: c.cells, nrSamples: c.nr };
    },
  };
}
