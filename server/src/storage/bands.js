import { transaction } from './sql.js';

// Every band and cell the router has used. The router only reports the carriers
// in use right now, so this is the only record of what the local masts offer.
// One row per band and per (band, PCI), updated in place: the tables stay tiny
// and are never pruned.

// A gap longer than this between status reads is downtime, not time on a band.
const MAX_GAP_MS = 30e3;
// Samples are folded in memory and written once a minute (fewer SD-card writes).
const FLUSH_MS = 60_000;
const round1 = (x) => Math.round(x * 10) / 10;

/** Bands in a combination label such as "B7+B3 + n78+n1", in carrier order. */
export const comboBands = (combo) =>
  (combo ?? '')
    .split('+')
    .map((b) => b.trim())
    .filter(Boolean);

// One write covers a batch of samples [:first_ts, :last_ts] for a band.
// run_start: when the band's current (or last) session began.
//   :restart_at  a new session began inside the batch (after its first sample);
//   :continued   for the batch's first sample: 1 = band was in the sample before,
//                0 = it wasn't, null = unknown (first read after a restart), in which
//                case a recent last_seen means the session carried on.
const BAND_UPSERT = `INSERT INTO bands (band, rat, first_seen, last_seen, run_start, seconds, primary_seconds, best_rsrp, rsrp_sum, rsrp_n, sinr_sum, sinr_n, max_bw)
  VALUES (:band, :rat, :first_ts, :last_ts, COALESCE(:restart_at, :first_ts), :seconds, :primary_seconds, :rsrp, COALESCE(:rsrp_sum, 0), :rsrp_n, COALESCE(:sinr_sum, 0), :sinr_n, :bw)
  ON CONFLICT (band) DO UPDATE SET
    run_start = CASE
      WHEN :restart_at IS NOT NULL THEN :restart_at
      WHEN :continued = 1 THEN COALESCE(run_start, :first_ts)
      WHEN :continued IS NULL AND :first_ts - last_seen <= ${MAX_GAP_MS} THEN COALESCE(run_start, :first_ts)
      ELSE :first_ts END,
    first_seen = MIN(first_seen, excluded.first_seen),
    last_seen = MAX(last_seen, excluded.last_seen),
    seconds = seconds + excluded.seconds,
    primary_seconds = primary_seconds + excluded.primary_seconds,
    best_rsrp = COALESCE(MAX(best_rsrp, excluded.best_rsrp), best_rsrp, excluded.best_rsrp),
    rsrp_sum = rsrp_sum + excluded.rsrp_sum, rsrp_n = rsrp_n + excluded.rsrp_n,
    sinr_sum = sinr_sum + excluded.sinr_sum, sinr_n = sinr_n + excluded.sinr_n,
    max_bw = COALESCE(MAX(max_bw, excluded.max_bw), max_bw, excluded.max_bw)`;

const CELL_UPSERT = `INSERT INTO band_cells (band, pci, channel, first_seen, last_seen, best_rsrp)
  VALUES (:band, :pci, :channel, :first_ts, :last_ts, :rsrp)
  ON CONFLICT (band, pci) DO UPDATE SET
    channel = COALESCE(excluded.channel, channel),
    first_seen = MIN(first_seen, excluded.first_seen),
    last_seen = MAX(last_seen, excluded.last_seen),
    best_rsrp = COALESCE(MAX(best_rsrp, excluded.best_rsrp), best_rsrp, excluded.best_rsrp)`;

/** Fold one sample of carriers into per-band rows; `seconds` counts each band once per sample. */
function bandRows(carriers, ts, seconds, prevBands) {
  const byBand = new Map();
  for (const c of carriers) {
    if (!c.band) continue;
    const isPrimary = c.role === 'primary' || c.role === 'nr-anchor';
    let row = byBand.get(c.band);
    if (!row) {
      row = {
        band: c.band,
        rat: c.rat,
        first_ts: ts,
        last_ts: ts,
        restart_at: null,
        continued: prevBands ? Number(prevBands.has(c.band)) : null,
        seconds,
        primary_seconds: 0,
        rsrp: null,
        rsrp_sum: null,
        rsrp_n: 0,
        sinr_sum: null,
        sinr_n: 0,
        bw: null,
      };
      byBand.set(c.band, row);
    }
    if (isPrimary) row.primary_seconds = seconds;
    if (c.rsrp != null) {
      row.rsrp = Math.max(row.rsrp ?? -Infinity, c.rsrp);
      row.rsrp_sum = (row.rsrp_sum ?? 0) + c.rsrp;
      row.rsrp_n += 1;
    }
    if (c.sinr != null) {
      row.sinr_sum = (row.sinr_sum ?? 0) + c.sinr;
      row.sinr_n += 1;
    }
    if (c.bandwidth != null) row.bw = Math.max(row.bw ?? 0, c.bandwidth);
  }
  return [...byBand.values()];
}

/** Fold a later sample's row into the batch row for the same band. */
function mergeBand(into, row) {
  into.last_ts = row.last_ts;
  if (row.continued === 0) into.restart_at = row.first_ts; // left and came back within the batch
  into.seconds += row.seconds;
  into.primary_seconds += row.primary_seconds;
  if (row.rsrp != null) into.rsrp = Math.max(into.rsrp ?? -Infinity, row.rsrp);
  if (row.rsrp_sum != null) into.rsrp_sum = (into.rsrp_sum ?? 0) + row.rsrp_sum;
  into.rsrp_n += row.rsrp_n;
  if (row.sinr_sum != null) into.sinr_sum = (into.sinr_sum ?? 0) + row.sinr_sum;
  into.sinr_n += row.sinr_n;
  if (row.bw != null) into.bw = Math.max(into.bw ?? 0, row.bw);
}

export function bandsRepo(db, sql) {
  let lastAt = null;
  let prevBands = null; // bands in the previous sample, unknown until the first one
  const pendingBands = new Map(); // band -> batch row
  const pendingCells = new Map(); // "band/pci" -> batch row
  let batchStart = null;

  function flushBands() {
    if (!pendingBands.size && !pendingCells.size) return;
    transaction(db, () => {
      for (const row of pendingBands.values()) sql(BAND_UPSERT).run(row);
      for (const row of pendingCells.values()) sql(CELL_UPSERT).run(row);
    });
    pendingBands.clear();
    pendingCells.clear();
    batchStart = null;
  }

  return {
    flushBands,

    /** Record the carriers in use at `ts` (one status read; an empty list ends all sessions). */
    recordCarriers(ts, carriers) {
      const gap = lastAt != null && ts > lastAt ? ts - lastAt : null;
      const seconds = gap == null ? 0 : Math.min(gap, MAX_GAP_MS) / 1000;
      // After a long gap nobody knows what happened in between, so sessions restart.
      const prev = gap != null && gap > MAX_GAP_MS ? new Set() : prevBands;
      lastAt = ts;
      prevBands = new Set(carriers.map((c) => c.band).filter(Boolean));
      for (const row of bandRows(carriers, ts, seconds, prev)) {
        const into = pendingBands.get(row.band);
        if (into) mergeBand(into, row);
        else pendingBands.set(row.band, row);
      }
      for (const c of carriers) {
        if (!c.band || c.pci == null || c.pci < 0) continue;
        const key = `${c.band}/${c.pci}`;
        const cell = pendingCells.get(key);
        if (!cell)
          pendingCells.set(key, { band: c.band, pci: c.pci, channel: c.channel ?? null, first_ts: ts, last_ts: ts, rsrp: c.rsrp ?? null });
        else {
          cell.last_ts = ts;
          cell.channel = c.channel ?? cell.channel;
          if (c.rsrp != null) cell.rsrp = Math.max(cell.rsrp ?? -Infinity, c.rsrp);
        }
      }
      batchStart ??= ts;
      if (ts - batchStart >= FLUSH_MS || ts < batchStart) flushBands();
    },

    /** Every band seen, most recent first, each with the cells (PCIs) seen on it. */
    bandsSeen() {
      flushBands();
      const cells = sql('SELECT band, pci, channel, first_seen, last_seen, best_rsrp FROM band_cells ORDER BY last_seen DESC').all();
      return sql('SELECT * FROM bands ORDER BY last_seen DESC, seconds DESC')
        .all()
        .map((b) => ({
          band: b.band,
          rat: b.rat,
          firstSeen: b.first_seen,
          lastSeen: b.last_seen,
          // Current session if the band is in use; otherwise how long its last one lasted.
          runStart: b.run_start,
          lastRunSeconds: b.run_start != null ? Math.round((b.last_seen - b.run_start) / 1000) : null,
          seconds: Math.round(b.seconds),
          primarySeconds: Math.round(b.primary_seconds),
          bestRsrp: b.best_rsrp,
          avgRsrp: b.rsrp_n ? round1(b.rsrp_sum / b.rsrp_n) : null,
          avgSinr: b.sinr_n ? round1(b.sinr_sum / b.sinr_n) : null,
          maxBandwidth: b.max_bw,
          cells: cells
            .filter((c) => c.band === b.band)
            .map((c) => ({ pci: c.pci, channel: c.channel, firstSeen: c.first_seen, lastSeen: c.last_seen, bestRsrp: c.best_rsrp })),
        }));
    },
  };
}

/**
 * Seed the band tables from signal history recorded before they existed. Metrics
 * keep only the combination label, the serving cell and the primary LTE / 5G
 * readings, so those readings go to the first LTE and first 5G band of each combo.
 */
export function backfillBands(db) {
  const groups = db
    .prepare(
      `SELECT combo, cell, MIN(ts) AS first, MAX(ts) AS last, SUM(gap) / 1000.0 AS seconds,
        MAX(lte_rsrp) AS lte_best, SUM(lte_rsrp) AS lte_rsrp_sum, COUNT(lte_rsrp) AS lte_rsrp_n,
        SUM(lte_sinr) AS lte_sinr_sum, COUNT(lte_sinr) AS lte_sinr_n,
        MAX(nr_rsrp) AS nr_best, SUM(nr_rsrp) AS nr_rsrp_sum, COUNT(nr_rsrp) AS nr_rsrp_n,
        SUM(nr_sinr) AS nr_sinr_sum, COUNT(nr_sinr) AS nr_sinr_n
      FROM (SELECT *, MIN(COALESCE(ts - LAG(ts) OVER (ORDER BY ts), 0), ${MAX_GAP_MS}) AS gap FROM metrics)
      WHERE combo IS NOT NULL AND combo != ''
      GROUP BY combo, cell`,
    )
    .all();
  const band = db.prepare(BAND_UPSERT);
  const cell = db.prepare(CELL_UPSERT);
  transaction(db, () => {
    for (const g of groups) {
      const bands = [...new Set(comboBands(g.combo))];
      const firstLte = bands.find((b) => !b.startsWith('n'));
      const firstNr = bands.find((b) => b.startsWith('n'));
      for (const b of bands) {
        const leg = b === firstLte ? 'lte' : b === firstNr ? 'nr' : null;
        // Sessions are rebuilt in order by setRunStarts() below; these groups aren't chronological.
        const base = {
          band: b,
          rat: b.startsWith('n') ? 'NR' : 'LTE',
          continued: 1,
          restart_at: null,
          first_ts: g.first,
          last_ts: g.last,
          seconds: g.seconds,
          primary_seconds: leg ? g.seconds : 0,
          bw: null,
        };
        const signal = leg
          ? {
              rsrp: g[`${leg}_best`],
              rsrp_sum: g[`${leg}_rsrp_sum`],
              rsrp_n: g[`${leg}_rsrp_n`],
              sinr_sum: g[`${leg}_sinr_sum`],
              sinr_n: g[`${leg}_sinr_n`],
            }
          : { rsrp: null, rsrp_sum: null, rsrp_n: 0, sinr_sum: null, sinr_n: 0 };
        band.run({ ...base, ...signal });
      }
      // The serving cell key is "<cell id>/<pci>" and belongs to the primary LTE band.
      const pci = Number(String(g.cell ?? '').split('/')[1]);
      if (firstLte && Number.isInteger(pci) && pci >= 0) {
        cell.run({ band: firstLte, pci, channel: null, first_ts: g.first, last_ts: g.last, rsrp: g.lte_best });
      }
    }
  });
  setRunStarts(db);
}

/** Rebuild each band's session start from signal history: the latest unbroken run of samples containing it. */
export function setRunStarts(db) {
  const start = new Map();
  let prev = new Set();
  let prevTs = null;
  for (const m of db.prepare('SELECT ts, combo FROM metrics ORDER BY ts').iterate()) {
    const bands = new Set(comboBands(m.combo));
    const gapOk = prevTs != null && m.ts - prevTs <= MAX_GAP_MS;
    for (const b of bands) if (!(gapOk && prev.has(b))) start.set(b, m.ts);
    prev = bands;
    prevTs = m.ts;
  }
  const update = db.prepare('UPDATE bands SET run_start = ? WHERE band = ?');
  transaction(db, () => {
    for (const [band, ts] of start) update.run(ts, band);
  });
}
