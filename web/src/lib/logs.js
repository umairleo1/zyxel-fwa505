// Pure helpers for the paged event log (kept out of the component so they're testable).
import { startOfDay } from './format.js';

/**
 * Append an older page to the rows already shown. Rows already present are skipped:
 * cursor pages can overlap when new rows land between requests, and duplicate ids
 * would break React keys.
 */
export function appendPage(prev, items) {
  const seen = new Set(prev.map((r) => r.id));
  const fresh = items.filter((r) => !seen.has(r.id) && seen.add(r.id));
  return fresh.length ? [...prev, ...fresh] : prev;
}

/** Ids of rows that start a new local day (and so get a day divider above them). */
export function dayBreaks(items) {
  const breaks = new Set();
  let last = null;
  for (const r of items) {
    const day = startOfDay(r.ts);
    if (day !== last) breaks.add(r.id);
    last = day;
  }
  return breaks;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive matcher for search highlighting, or null for no search. Build once per query. */
export const highlightRe = (q) => (q ? new RegExp(`(${escapeRe(q)})`, 'ig') : null);

/** Split text into [plain, match, plain, match, ...]; odd indexes are matches. */
export const splitMatches = (text, re) => (re ? String(text).split(re) : [String(text)]);
