import { Router } from 'express';
import { bucketFor, int, logFilters, parseCursor } from '../params.js';
import { csvLine, writeAll } from '../csv.js';

const EXPORT_PAGE = 1000;

/**
 * CSV lines for every matching row, newest first, read in keyset pages: no SQLite
 * statement stays open while we wait for a slow client, and `to` is pinned so rows
 * arriving mid-export don't shift the pages.
 */
export function* exportLines(db, query, now = Date.now()) {
  const filters = { ...logFilters(query) };
  filters.to ??= now;
  yield 'time,source,host,category,facility,level,message\n';
  let cursor;
  for (;;) {
    const rows = db.query({ ...filters, cursor }, EXPORT_PAGE);
    const page = rows.slice(0, EXPORT_PAGE);
    for (const row of page) {
      yield csvLine([new Date(row.ts).toISOString(), row.source, row.host, row.category, row.facility, row.level, row.message]);
    }
    if (rows.length <= EXPORT_PAGE) return;
    const last = page.at(-1);
    cursor = { ts: last.ts, id: last.id };
  }
}

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

  r.get('/export.csv', async (req, res) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zyxel-insight-${stamp}.csv"`);
    if (await writeAll(res, exportLines(db, req.query))) res.end();
  });

  return r;
}
