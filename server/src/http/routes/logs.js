import { Router } from 'express';
import { bucketFor, int, logFilters, parseCursor } from '../params.js';

const csvCell = (v) => (v == null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Event log: paged search, severity histogram, facets and CSV export. */
export function logsRoutes({ db }) {
  const r = Router();

  r.get('/logs', (req, res) => {
    const limit = Math.min(Math.max(int(req.query.limit) ?? 200, 1), 1000);
    const cursor = parseCursor(req.query.cursor);
    const filters = logFilters(req.query);
    const rows = db.query({ ...filters, cursor }, limit);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    res.json({
      items,
      nextCursor: rows.length > limit && last ? `${last.ts}:${last.id}` : null,
      total: cursor ? undefined : db.stats(filters).count,
    });
  });

  r.get('/histogram', (req, res) => {
    const filters = logFilters(req.query);
    const to = filters.to ?? Date.now();
    const from = filters.from ?? db.stats({}).first ?? to - 86400e3;
    const bucketMs = bucketFor(to - from, 72);
    const byT = new Map(db.histogram({ ...filters, from, to }, bucketMs).map((row) => [row.t, row]));
    // Fill empty buckets so the x-axis is continuous.
    const buckets = [];
    for (let t = Math.floor(from / bucketMs) * bucketMs; t <= to; t += bucketMs) {
      buckets.push(byT.get(t) ?? { t, err: 0, warning: 0, notice: 0, info: 0 });
    }
    res.json({ from, to, bucketMs, buckets });
  });

  r.get('/facets', (req, res) => res.json(db.facets({ from: int(req.query.from), to: int(req.query.to) })));

  r.get('/export.csv', (req, res) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zyxel-insight-${stamp}.csv"`);
    res.write('time,source,host,category,facility,level,message\n');
    for (const row of db.iterate(logFilters(req.query))) {
      res.write(
        `${[new Date(row.ts).toISOString(), row.source, row.host, row.category, row.facility, row.level, row.message].map(csvCell).join(',')}\n`,
      );
    }
    res.end();
  });

  return r;
}
