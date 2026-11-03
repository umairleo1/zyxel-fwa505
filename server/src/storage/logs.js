import { ERROR_LEVELS } from '@zyxel-insight/shared/severity';
import { bucketExpr, transaction } from './sql.js';

const quoteList = (xs) => xs.map((x) => `'${x}'`).join(',');

function buildWhere({ q, sources, levels, facilities, categories, from, to, cursor }) {
  const where = [];
  const params = [];
  const inList = (col, values) => {
    if (!values?.length) return;
    where.push(`${col} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  inList('source', sources);
  inList('level', levels);
  inList('facility', facilities);
  inList('category', categories);
  if (q) {
    where.push("(message LIKE ? ESCAPE '\\' OR raw LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (from) {
    where.push('ts >= ?');
    params.push(from);
  }
  if (to) {
    where.push('ts <= ?');
    params.push(to);
  }
  if (cursor) {
    where.push('(ts < ? OR (ts = ? AND id < ?))');
    params.push(cursor.ts, cursor.ts, cursor.id);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function logsRepo(db, sql, hooks) {
  return {
    /** Insert log rows in one transaction; notifies hooks.onLogs. */
    insertMany(rows) {
      if (!rows.length) return;
      const now = Date.now();
      const stmt = sql(`INSERT INTO logs (ts, source, host, category, facility, level, message, raw, received_at)
        VALUES (:ts, :source, :host, :category, :facility, :level, :message, :raw, :received_at)`);
      const maxId = transaction(db, () => {
        let id = 0;
        for (const r of rows) {
          id = stmt.run({
            ts: r.ts,
            source: r.source,
            host: r.host ?? null,
            category: r.category ?? null,
            facility: r.facility ?? null,
            level: r.level ?? null,
            message: r.message,
            raw: r.raw ?? r.message,
            received_at: now,
          }).lastInsertRowid;
        }
        return id;
      });
      hooks.onLogs?.({ count: rows.length, sources: [...new Set(rows.map((r) => r.source))], maxId: Number(maxId) });
    },

    /** The last `n` raw lines stored for a source, oldest first (to resume dedup after a restart). */
    lastRaw: (source, n) =>
      sql('SELECT raw FROM logs WHERE source = ? ORDER BY id DESC LIMIT ?')
        .all(source, n)
        .map((r) => r.raw)
        .reverse(),

    query(filters, limit = 200) {
      const { sql: where, params } = buildWhere(filters);
      return sql(
        `SELECT id, ts, source, host, category, facility, level, message, raw FROM logs ${where} ORDER BY ts DESC, id DESC LIMIT ?`,
      ).all(...params, limit + 1);
    },

    /** Log counts per time bucket, split into severity groups. */
    histogram(filters, bucketMs) {
      const { sql: where, params } = buildWhere(filters);
      return sql(`SELECT ${bucketExpr} AS t,
          SUM(level IN (${quoteList(ERROR_LEVELS)})) AS err,
          SUM(level = 'warning') AS warning,
          SUM(level = 'notice') AS notice,
          SUM(level IS NULL OR level IN ('info','debug')) AS info
        FROM logs ${where} GROUP BY t ORDER BY t`).all(bucketMs, bucketMs, ...params);
    },

    /** Count of matching rows plus first/last timestamp. */
    stats(filters) {
      const { sql: where, params } = buildWhere(filters);
      return sql(`SELECT COUNT(*) AS count, MIN(ts) AS first, MAX(ts) AS last FROM logs ${where}`).get(...params);
    },

    *iterate(filters) {
      const { sql: where, params } = buildWhere(filters);
      yield* sql(`SELECT ts, source, host, category, facility, level, message FROM logs ${where} ORDER BY ts DESC, id DESC`).iterate(
        ...params,
      );
    },

    /** Value counts for each filterable column within a time range. */
    facets({ from, to } = {}) {
      const { sql: where, params } = buildWhere({ from, to });
      const group = (col) =>
        sql(
          `SELECT ${col} AS value, COUNT(*) AS count FROM logs ${where ? `${where} AND` : 'WHERE'} ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC`,
        ).all(...params);
      const totals = sql('SELECT COUNT(*) AS count, MIN(ts) AS first, MAX(ts) AS last FROM logs').get();
      return { sources: group('source'), levels: group('level'), facilities: group('facility'), categories: group('category'), ...totals };
    },

    countEvents: (facility, from) =>
      sql("SELECT COUNT(*) AS n FROM logs WHERE source = 'insight' AND facility = ? AND ts >= ?").get(facility, from).n,

    /** Router log lines in a window (used to explain reboots). */
    logsBetween: (from, to) =>
      sql("SELECT ts, message FROM logs WHERE source != 'insight' AND ts >= ? AND ts <= ? ORDER BY ts").all(from, to),

    /** DHCPACKs per client MAC in the router log (at most the last 7 days). */
    dhcpByMac: (from) =>
      sql(`SELECT lower(substr(message, instr(message, ' to ') + 4, 17)) AS mac, COUNT(*) AS n FROM logs
        WHERE facility = 'dhcpd' AND ts >= ? AND message LIKE 'DHCPACK on % to %' GROUP BY mac ORDER BY n DESC LIMIT 20`).all(
        Math.max(from, Date.now() - 7 * 86400e3),
      ),
  };
}
