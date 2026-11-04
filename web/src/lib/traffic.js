import { isSameDay } from './format.js';

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
