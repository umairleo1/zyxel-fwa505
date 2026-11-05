/** Reboots (from uptime), outages (router unreachable or mobile data down) and small persistent key/value state. */
export function reliabilityRepo(sql) {
  return {
    insertReboot: (r) =>
      sql('INSERT OR REPLACE INTO reboots (boot_ts, detected_at, kind, reason, last_seen_before) VALUES (?, ?, ?, ?, ?)').run(
        r.boot_ts,
        r.detected_at,
        r.kind,
        r.reason,
        r.last_seen_before,
      ),
    reboots: (from, to = Date.now()) =>
      sql('SELECT * FROM reboots WHERE boot_ts >= ? AND boot_ts <= ? ORDER BY boot_ts DESC').all(from, to),
    insertOutage: (o) =>
      sql('INSERT OR REPLACE INTO outages (start_ts, end_ts, reason, kind) VALUES (?, ?, ?, ?)').run(
        o.start_ts,
        o.end_ts,
        o.reason,
        o.kind ?? 'router',
      ),
    outages: (from, to = Date.now()) =>
      sql('SELECT * FROM outages WHERE end_ts >= ? AND start_ts <= ? ORDER BY start_ts DESC').all(from, to),

    getMeta: (key) => sql('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    setMeta: (key, value) => sql('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value)),
  };
}
