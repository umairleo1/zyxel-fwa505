// Query-string parsing shared by all routes.

export const list = (v) =>
  v
    ? String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

export const int = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

/** { from, to } from ?from=&to= (epoch ms), defaulting to the last `defaultSpanMs`. */
export function timeRange(query, defaultSpanMs = 86400e3) {
  const to = int(query.to) ?? Date.now();
  const from = int(query.from) ?? to - defaultSpanMs;
  return { from, to };
}

// Bucket sizes that read well on an axis.
const NICE_BUCKETS = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3];
/** Smallest nice bucket that gives at most `target` buckets over the span. */
export const bucketFor = (spanMs, target) => NICE_BUCKETS.find((b) => spanMs / b <= target) ?? NICE_BUCKETS.at(-1);

/** Log filters from the query string. */
export const logFilters = (query) => ({
  q: query.q ? String(query.q) : undefined,
  sources: list(query.source),
  levels: list(query.level),
  facilities: list(query.facility),
  categories: list(query.category),
  from: int(query.from),
  to: int(query.to),
});

/** "ts:id" keyset cursor. */
export function parseCursor(v) {
  if (!v) return undefined;
  const [ts, id] = String(v).split(':').map(Number);
  return Number.isFinite(ts) && Number.isFinite(id) ? { ts, id } : undefined;
}

export const sendError = (res, e) => res.status(e.status ?? 502).json({ error: e.message, kind: e.kind ?? null });
