import { addDays, isSameDay } from './format.js';

/**
 * Today's usage from the daily buckets ({ day, rx, tx }, oldest first). The newest
 * bucket is only today's once today has a sample; before that it's yesterday's, and
 * today's usage is zero. null while there's no data at all.
 */
export function usageToday(days, now = Date.now()) {
  if (!days) return null;
  const last = days.at(-1);
  return last && isSameDay(last.day, now) ? last : { day: now, rx: 0, tx: 0 };
}

// A day watched less than this gets a "partly monitored" note on the usage chart.
export const FULL_DAY_SHARE = 0.95;

/**
 * Hours of a local day that Insight watched, from the API's coverage spans (not
 * monitored + router unreachable; they don't overlap). Only the part of the day
 * inside [windowFrom, now] is judged, since nothing is known outside the fetch.
 * Returns { watchedH, totalH, share } or null when none of the day is in the window.
 */
export function dayCoverage(day, coverage, { windowFrom = -Infinity, now = Date.now() } = {}) {
  const start = Math.max(day, windowFrom);
  const end = Math.min(addDays(day, 1), now);
  if (end <= start) return null;
  const spans = [...(coverage?.unmonitored ?? []), ...(coverage?.outages ?? [])];
  const missing = spans.reduce((a, s) => a + Math.max(0, Math.min(s.end, end) - Math.max(s.start, start)), 0);
  const hours = (ms) => Math.round(ms / 3600e3);
  return { watchedH: hours(end - start - missing), totalH: hours(end - start), share: 1 - missing / (end - start) };
}
