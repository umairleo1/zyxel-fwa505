export function devicesRepo(sql) {
  return {
    devices: () => sql('SELECT * FROM devices ORDER BY online DESC, last_seen DESC').all(),
    device: (mac) => sql('SELECT * FROM devices WHERE mac = ?').get(mac),
    /** Insert or update; null fields keep their previous value, last_seen only moves while online. */
    upsertDevice: (d) =>
      sql(`INSERT INTO devices (mac, name, ip, conn, icon, first_seen, last_seen, online) VALUES (:mac, :name, :ip, :conn, :icon, :ts, :ts, :online)
        ON CONFLICT(mac) DO UPDATE SET name = COALESCE(:name, name), ip = COALESCE(:ip, ip), conn = COALESCE(:conn, conn), icon = COALESCE(:icon, icon),
          last_seen = CASE WHEN :online THEN :ts ELSE last_seen END, online = :online`).run({ ...d, online: d.online ? 1 : 0 }),
  };
}
