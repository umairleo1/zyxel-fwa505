import { bucketExpr, transaction } from './sql.js';

const round1 = (x) => Math.round(x * 10) / 10;

/** Periodic samples: WAN/LAN byte counters, CPU/memory, per-client Wi-Fi signal and the internet check. */
export function samplesRepo(db, sql) {
  return {
    insertTraffic: (t) =>
      sql('INSERT OR REPLACE INTO traffic (ts, wan_rx, wan_tx, lan_rx, lan_tx) VALUES (?, ?, ?, ?, ?)').run(
        t.ts,
        t.wan_rx,
        t.wan_tx,
        t.lan_rx,
        t.lan_tx,
      ),
    traffic: (from, to) =>
      sql('SELECT ts, wan_rx, wan_tx, lan_rx, lan_tx FROM traffic WHERE ts >= ? AND ts <= ? ORDER BY ts').all(from, to),

    insertSystem: (s) =>
      sql('INSERT OR REPLACE INTO system_samples (ts, cpu, mem_total, mem_free) VALUES (?, ?, ?, ?)').run(
        s.ts,
        s.cpu,
        s.mem_total,
        s.mem_free,
      ),
    system: (from, to) =>
      sql('SELECT ts, cpu, mem_total, mem_free FROM system_samples WHERE ts >= ? AND ts <= ? ORDER BY ts').all(from, to),
    systemStats(from, to) {
      const one = (expr) => {
        const r = sql(
          `SELECT COUNT(v) AS n, AVG(v) AS avg, MIN(v) AS min, MAX(v) AS max FROM (SELECT ${expr} AS v FROM system_samples WHERE ts >= ? AND ts <= ?)`,
        ).get(from, to);
        return r.n ? { n: r.n, avg: round1(r.avg), min: round1(r.min), max: round1(r.max) } : null;
      };
      return { cpu: one('cpu'), mem: one('CASE WHEN mem_total > 0 THEN 100.0 * (mem_total - mem_free) / mem_total END') };
    },

    insertInternetSample: (s) =>
      sql('INSERT OR REPLACE INTO internet_samples (ts, rounds, failed, local, rtt_sum, rtt_n, rtt_max) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        s.ts,
        s.rounds,
        s.failed,
        s.local,
        s.rtt_sum,
        s.rtt_n,
        s.rtt_max,
      ),
    /** Internet check per bucket: mean and peak connect time, and the share of judged rounds that failed. */
    internetSamples: ({ from, to }, bucketMs) =>
      sql(`SELECT ${bucketExpr} AS t,
          ROUND(SUM(rtt_sum) / NULLIF(SUM(rtt_n), 0)) AS rtt_avg,
          MAX(rtt_max) AS rtt_max,
          SUM(rounds) AS rounds,
          SUM(failed) AS failed,
          ROUND(100.0 * SUM(failed) / NULLIF(SUM(rounds) - SUM(local), 0), 1) AS failed_pct
        FROM internet_samples WHERE ts >= ? AND ts <= ? GROUP BY t ORDER BY t`).all(bucketMs, bucketMs, from, to),

    insertStations(ts, rows) {
      const stmt = sql('INSERT INTO station_samples (ts, mac, band, rssi, snr, rate) VALUES (?, ?, ?, ?, ?, ?)');
      transaction(db, () => {
        for (const r of rows) stmt.run(ts, r.mac, r.band, r.rssi, r.snr, r.rateMbps);
      });
    },
    latestStations: (since) =>
      sql(`SELECT s.* FROM station_samples s
        JOIN (SELECT mac, MAX(ts) AS ts FROM station_samples WHERE ts >= ? GROUP BY mac) l ON s.mac = l.mac AND s.ts = l.ts`).all(since),
    stationHistory: (mac, from) =>
      sql('SELECT ts, band, rssi, snr, rate FROM station_samples WHERE mac = ? AND ts >= ? ORDER BY ts').all(mac, from),
  };
}
