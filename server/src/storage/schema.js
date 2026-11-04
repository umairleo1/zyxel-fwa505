import { backfillBands, setRunStarts } from './bands.js';

/** Create tables/indexes and apply additive migrations. Idempotent. */
export function migrate(db) {
  const hadBands = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bands'").get();
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY,
      ts          INTEGER NOT NULL,
      source      TEXT NOT NULL,      -- router-system | router-security | syslog | snmp | insight
      host        TEXT,
      category    TEXT,
      facility    TEXT,
      level       TEXT,
      message     TEXT NOT NULL,
      raw         TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS logs_source_id ON logs (source, id);
    CREATE INDEX IF NOT EXISTS logs_facility_ts ON logs (facility, ts);

    CREATE TABLE IF NOT EXISTS metrics (
      ts       INTEGER PRIMARY KEY,
      uptime   INTEGER,
      lte_rsrp REAL, lte_rsrq REAL, lte_sinr REAL, lte_rssi REAL,
      nr_rsrp  REAL, nr_rsrq  REAL, nr_sinr  REAL, nr_rssi  REAL
    );

    CREATE TABLE IF NOT EXISTS traffic (ts INTEGER PRIMARY KEY, wan_rx INTEGER, wan_tx INTEGER, lan_rx INTEGER, lan_tx INTEGER);
    CREATE TABLE IF NOT EXISTS system_samples (ts INTEGER PRIMARY KEY, cpu REAL, mem_total INTEGER, mem_free INTEGER);

    CREATE TABLE IF NOT EXISTS devices (
      mac TEXT PRIMARY KEY, name TEXT, ip TEXT, conn TEXT, icon TEXT,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS station_samples (ts INTEGER NOT NULL, mac TEXT NOT NULL, band TEXT, rssi INTEGER, snr INTEGER, rate INTEGER);
    CREATE INDEX IF NOT EXISTS station_mac_ts ON station_samples (mac, ts);
    CREATE INDEX IF NOT EXISTS station_ts ON station_samples (ts);

    CREATE TABLE IF NOT EXISTS reboots (boot_ts INTEGER PRIMARY KEY, detected_at INTEGER, kind TEXT, reason TEXT, last_seen_before INTEGER);
    CREATE TABLE IF NOT EXISTS outages (start_ts INTEGER PRIMARY KEY, end_ts INTEGER, reason TEXT);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    -- Every band and cell the router has used (see storage/bands.js). Sums, not samples.
    CREATE TABLE IF NOT EXISTS bands (
      band TEXT PRIMARY KEY, rat TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      run_start INTEGER,
      seconds REAL NOT NULL DEFAULT 0, primary_seconds REAL NOT NULL DEFAULT 0, best_rsrp REAL,
      rsrp_sum REAL NOT NULL DEFAULT 0, rsrp_n INTEGER NOT NULL DEFAULT 0,
      sinr_sum REAL NOT NULL DEFAULT 0, sinr_n INTEGER NOT NULL DEFAULT 0, max_bw REAL
    );
    CREATE TABLE IF NOT EXISTS band_cells (
      band TEXT NOT NULL, pci INTEGER NOT NULL, channel INTEGER,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, best_rsrp REAL,
      PRIMARY KEY (band, pci)
    );
  `);

  // Columns added after the first release.
  const metricCols = new Set(
    db
      .prepare('PRAGMA table_info(metrics)')
      .all()
      .map((c) => c.name),
  );
  for (const [col, type] of [
    ['combo', 'TEXT'],
    ['cell', 'TEXT'],
  ]) {
    if (!metricCols.has(col)) db.exec(`ALTER TABLE metrics ADD COLUMN ${col} ${type}`);
  }

  // bands tables created before session tracking lack run_start.
  const addedRunStart = hadBands && !db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('bands', 'run_start');
  if (addedRunStart) db.exec('ALTER TABLE bands ADD COLUMN run_start INTEGER');

  // combo/cell must exist before the backfill reads them. Keyed on the table being
  // empty rather than new, so a backfill that failed (and rolled back) runs again.
  // Derived data only: a failure must not stop Insight starting (it retries next start).
  try {
    if (!db.prepare('SELECT 1 FROM bands LIMIT 1').get()) backfillBands(db);
    else if (addedRunStart) setRunStarts(db);
  } catch (e) {
    console.error('[db] band history backfill failed; will retry on next start', e);
  }
}
