import { transaction } from './sql.js';

// Every band and cell the router has used, per mobile network. The router only reports
// the carriers in use right now, so this is the only record of what the local masts offer.
// One row per (network, band) and per (network, band, PCI), updated in place: the tables
// stay tiny and are never pruned.
//
// History is kept per network (the serving PLMN, MCC+MNC) because bands mean different
// things on different networks: B3 on one operator is another mast, another channel and
// another load than B3 on the next. A new SIM starts with no history rather than inheriting
// the old network's, and the old one's is kept for if it comes back.
//
// Rows recorded before history was kept per network have plmn ''. They're attributed to a
// network once its cells are seen to match theirs (see LEGACY below), never by guessing.

// A gap longer than this between status reads is downtime, not time on a band.
const MAX_GAP_MS = 30e3;
// Samples are folded in memory and written once a minute (fewer SD-card writes).
const FLUSH_MS = 60_000;
const round1 = (x) => Math.round(x * 10) / 10;
// Network for rows recorded before history was kept per network, or with the network unknown.
export const UNKNOWN_NETWORK = '';

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
const BAND_UPSERT = `INSERT INTO bands (plmn, band, rat, first_seen, last_seen, run_start, seconds, primary_seconds, best_rsrp, rsrp_sum, rsrp_n, sinr_sum, sinr_n, max_bw)
  VALUES (:plmn, :band, :rat, :first_ts, :last_ts, COALESCE(:restart_at, :first_ts), :seconds, :primary_seconds, :rsrp, COALESCE(:rsrp_sum, 0), :rsrp_n, COALESCE(:sinr_sum, 0), :sinr_n, :bw)
  ON CONFLICT (plmn, band) DO UPDATE SET
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

const CELL_UPSERT = `INSERT INTO band_cells (plmn, band, pci, channel, first_seen, last_seen, best_rsrp)
  VALUES (:plmn, :band, :pci, :channel, :first_ts, :last_ts, :rsrp)
  ON CONFLICT (plmn, band, pci) DO UPDATE SET
    channel = COALESCE(excluded.channel, channel),
    first_seen = MIN(first_seen, excluded.first_seen),
    last_seen = MAX(last_seen, excluded.last_seen),
    best_rsrp = COALESCE(MAX(best_rsrp, excluded.best_rsrp), best_rsrp, excluded.best_rsrp)`;

const NETWORK_UPSERT = `INSERT INTO networks (plmn, operator, first_seen, last_seen) VALUES (:plmn, :operator, :first_ts, :last_ts)
  ON CONFLICT (plmn) DO UPDATE SET
    operator = COALESCE(excluded.operator, operator),
    first_seen = MIN(first_seen, excluded.first_seen),
    last_seen = MAX(last_seen, excluded.last_seen)`;

// Attributing legacy rows: a current carrier on the same band, PCI and channel as a legacy
// cell is the same cell (operators own different channels), so one such match is enough. Cells
// backfilled from old signal history have no channel; matching on band and PCI alone could be
// a coincidence (a PCI is one of 504/1008), so that takes two.
const LEGACY = {
  // Legacy rows merged into the network: sums add, the session follows whichever is later.
  mergeBands: `INSERT INTO bands (plmn, band, rat, first_seen, last_seen, run_start, seconds, primary_seconds, best_rsrp, rsrp_sum, rsrp_n, sinr_sum, sinr_n, max_bw)
    SELECT :plmn, band, rat, first_seen, last_seen, run_start, seconds, primary_seconds, best_rsrp, rsrp_sum, rsrp_n, sinr_sum, sinr_n, max_bw
    FROM bands WHERE plmn = ''
    ON CONFLICT (plmn, band) DO UPDATE SET
      run_start = CASE WHEN excluded.last_seen > last_seen THEN excluded.run_start ELSE run_start END,
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen),
      seconds = seconds + excluded.seconds,
      primary_seconds = primary_seconds + excluded.primary_seconds,
      best_rsrp = COALESCE(MAX(best_rsrp, excluded.best_rsrp), best_rsrp, excluded.best_rsrp),
      rsrp_sum = rsrp_sum + excluded.rsrp_sum, rsrp_n = rsrp_n + excluded.rsrp_n,
      sinr_sum = sinr_sum + excluded.sinr_sum, sinr_n = sinr_n + excluded.sinr_n,
      max_bw = COALESCE(MAX(max_bw, excluded.max_bw), max_bw, excluded.max_bw)`,
  mergeCells: `INSERT INTO band_cells (plmn, band, pci, channel, first_seen, last_seen, best_rsrp)
    SELECT :plmn, band, pci, channel, first_seen, last_seen, best_rsrp FROM band_cells WHERE plmn = ''
    ON CONFLICT (plmn, band, pci) DO UPDATE SET
      channel = COALESCE(channel, excluded.channel),
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen),
      best_rsrp = COALESCE(MAX(best_rsrp, excluded.best_rsrp), best_rsrp, excluded.best_rsrp)`,
};

/**
 * Pure: do these carriers show that legacy `cells` belong to their network? See LEGACY.
 * cells: [{ band, pci, channel }] with plmn ''; carriers: the current read.
 */
export function legacyMatches(cells, carriers) {
  let exact = 0;
  let loose = 0;
  for (const c of carriers) {
    if (!c.band || c.pci == null || c.pci < 0) continue;
    const cell = cells.find((x) => x.band === c.band && x.pci === c.pci);
    if (!cell) continue;
    if (cell.channel != null && c.channel != null) {
      if (cell.channel === c.channel) exact++;
    } else loose++;
  }
  return exact >= 1 || loose >= 2;
}

/** Fold one sample of carriers into per-band rows; `seconds` counts each band once per sample. */
function bandRows(carriers, ts, seconds, prevBands, plmn) {
  const byBand = new Map();
  for (const c of carriers) {
    if (!c.band) continue;
    const isPrimary = c.role === 'primary' || c.role === 'nr-anchor';
    let row = byBand.get(c.band);
    if (!row) {
      row = {
        plmn,
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
  let current = null; // network of the latest read that named one (this process)
  let lastPlmn = null; // network the previous read was recorded under
  let pendingNetwork = null; // { plmn, operator, first_ts, last_ts }
  const pendingBands = new Map(); // "plmn|band" -> batch row
  const pendingCells = new Map(); // "plmn|band/pci" -> batch row
  let batchStart = null;
  // Legacy rows left to attribute: checked once, then kept up to date here.
  let legacyLeft = null;
  let legacyCarriers = null; // the latest carriers on `current`, for matching at flush

  const hasLegacy = () => (legacyLeft ??= !!sql("SELECT 1 FROM bands WHERE plmn = '' LIMIT 1").get());

  /** Attribute legacy rows to `plmn` if its carriers match their cells. Returns true if it did. */
  function adoptLegacy(plmn, carriers) {
    if (!plmn || !carriers?.length || !hasLegacy()) return false;
    const cells = sql("SELECT band, pci, channel FROM band_cells WHERE plmn = ''").all();
    if (!legacyMatches(cells, carriers)) return false;
    transaction(db, () => {
      sql(LEGACY.mergeBands).run({ plmn });
      sql(LEGACY.mergeCells).run({ plmn });
      sql("DELETE FROM bands WHERE plmn = ''").run();
      sql("DELETE FROM band_cells WHERE plmn = ''").run();
    });
    legacyLeft = false;
    return true;
  }

  function flushBands() {
    if (pendingBands.size || pendingCells.size || pendingNetwork) {
      transaction(db, () => {
        for (const row of pendingBands.values()) sql(BAND_UPSERT).run(row);
        for (const row of pendingCells.values()) sql(CELL_UPSERT).run(row);
        if (pendingNetwork) sql(NETWORK_UPSERT).run(pendingNetwork);
      });
      pendingBands.clear();
      pendingCells.clear();
      pendingNetwork = null;
      batchStart = null;
    }
    // Once a minute at most: the cells to match against are written by now.
    if (current && legacyCarriers) {
      adoptLegacy(current, legacyCarriers);
      legacyCarriers = null;
    }
  }

  /** The network to report on: asked for, else the one in use, else the one seen last. */
  function networkFor(plmn) {
    if (plmn != null) return String(plmn);
    if (current) return current;
    return sql('SELECT plmn FROM bands ORDER BY last_seen DESC LIMIT 1').get()?.plmn ?? UNKNOWN_NETWORK;
  }

  return {
    flushBands,

    /**
     * Record the carriers in use at `ts` (one status read; an empty list ends all sessions).
     * network: { plmn, operator } serving them. A read that doesn't name the network belongs
     * to the one in use (the field is missing now and then); with none known yet, to ''.
     */
    recordCarriers(ts, carriers, network = null) {
      const named = network?.plmn ? String(network.plmn) : null;
      const plmn = named ?? current ?? UNKNOWN_NETWORK;
      // Recorded under a different network than the last read (a SIM swap, or the network
      // becoming known): its own history and sessions. Nothing carries over.
      if (lastPlmn != null && plmn !== lastPlmn) {
        flushBands();
        prevBands = null;
        lastAt = null;
      }
      lastPlmn = plmn;
      if (named) current = named;

      const gap = lastAt != null && ts > lastAt ? ts - lastAt : null;
      const seconds = gap == null ? 0 : Math.min(gap, MAX_GAP_MS) / 1000;
      // After a long gap nobody knows what happened in between, so sessions restart.
      const prev = gap != null && gap > MAX_GAP_MS ? new Set() : prevBands;
      lastAt = ts;
      prevBands = new Set(carriers.map((c) => c.band).filter(Boolean));
      for (const row of bandRows(carriers, ts, seconds, prev, plmn)) {
        const key = `${plmn}|${row.band}`;
        const into = pendingBands.get(key);
        if (into) mergeBand(into, row);
        else pendingBands.set(key, row);
      }
      for (const c of carriers) {
        if (!c.band || c.pci == null || c.pci < 0) continue;
        const key = `${plmn}|${c.band}/${c.pci}`;
        const cell = pendingCells.get(key);
        if (!cell)
          pendingCells.set(key, {
            plmn,
            band: c.band,
            pci: c.pci,
            channel: c.channel ?? null,
            first_ts: ts,
            last_ts: ts,
            rsrp: c.rsrp ?? null,
          });
        else {
          cell.last_ts = ts;
          cell.channel = c.channel ?? cell.channel;
          if (c.rsrp != null) cell.rsrp = Math.max(cell.rsrp ?? -Infinity, c.rsrp);
        }
      }
      if (named) {
        pendingNetwork ??= { plmn: named, operator: null, first_ts: ts, last_ts: ts };
        pendingNetwork.last_ts = ts;
        pendingNetwork.operator = network.operator ?? pendingNetwork.operator;
        if (carriers.length) legacyCarriers = carriers;
      }
      batchStart ??= ts;
      if (ts - batchStart >= FLUSH_MS || ts < batchStart) flushBands();
    },

    /**
     * Every band seen on one network, most recent first, each with the cells (PCIs) seen on it.
     * plmn: the network; default the one in use (or, before the first read, the one seen last).
     */
    bandsSeen({ plmn } = {}) {
      flushBands();
      const network = networkFor(plmn);
      const cells = sql(
        'SELECT band, pci, channel, first_seen, last_seen, best_rsrp FROM band_cells WHERE plmn = ? ORDER BY last_seen DESC',
      ).all(network);
      return sql('SELECT * FROM bands WHERE plmn = ? ORDER BY last_seen DESC, seconds DESC')
        .all(network)
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

    /** The network bandsSeen() reports on by default: { plmn, operator }. */
    bandNetwork(plmn) {
      flushBands();
      const network = networkFor(plmn);
      return { plmn: network, operator: sql('SELECT operator FROM networks WHERE plmn = ?').get(network)?.operator ?? null };
    },

    /** Every network with band history, most recent first; '' is history from before networks were told apart. */
    bandNetworks() {
      flushBands();
      return sql(
        `SELECT b.plmn, n.operator, COUNT(*) AS bands, ROUND(SUM(b.seconds)) AS seconds, MIN(b.first_seen) AS firstSeen, MAX(b.last_seen) AS lastSeen
         FROM bands b LEFT JOIN networks n ON n.plmn = b.plmn GROUP BY b.plmn ORDER BY lastSeen DESC`,
      ).all();
    },
  };
}

/**
 * Seed the band tables from signal history recorded before they existed. Metrics
 * keep only the combination label, the serving cell and the primary LTE / 5G
 * readings, so those readings go to the first LTE and first 5G band of each combo.
 * They don't name the network either: the rows are legacy ('') until attributed.
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
          plmn: UNKNOWN_NETWORK,
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
        cell.run({ plmn: UNKNOWN_NETWORK, band: firstLte, pci, channel: null, first_ts: g.first, last_ts: g.last, rsrp: g.lte_best });
      }
    }
  });
  setRunStarts(db);
}

/**
 * Rebuild each band's session start from signal history: the latest unbroken run of samples
 * containing it. Signal history doesn't name the network, so only legacy rows are touched.
 */
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
  const update = db.prepare("UPDATE bands SET run_start = ? WHERE band = ? AND plmn = ''");
  transaction(db, () => {
    for (const [band, ts] of start) update.run(ts, band);
  });
}
