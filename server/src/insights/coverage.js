// When was Insight actually watching? Every chart over time shares one answer, so a
// gap reads the same on the dashboard, the Cellular, Traffic and System pages.
import { subtractSpans } from '../lib/util.js';

// Shortest stretch without signal samples that counts as "not monitored". Samples come
// every status interval; the floor covers the once-a-minute status refresh and jitter.
export const unmonitoredMinMs = (statusMs) => Math.max(3 * statusMs, 120_000);
// A router outage starts at the last success and the sample gap at the last sample, a
// poll or so apart: cutting one out of the other leaves slivers this short to drop.
const sliverMs = (statusMs) => Math.max(30_000, 2 * statusMs);

/**
 * Pure: sample gaps that a router outage doesn't explain, clipped to [from, to].
 * `gaps` are already longer than the threshold; what remains of one after cutting out
 * router outages is kept unless it's an edge sliver. Only router-unreachable outages
 * leave gaps, since signal keeps arriving while just the mobile data is down.
 */
export function unmonitoredSpans({ from, to, gaps, routerOutages, statusMs = 0 }) {
  return subtractSpans(
    gaps.map((g) => ({ start: Math.max(g.start, from), end: Math.min(g.end, to) })),
    routerOutages,
    sliverMs(statusMs),
  );
}

/** Outages still in progress across the services that track them (collector: router, wan; internet check). */
export const openOutages = ({ collector, internet }) => [...(collector?.openOutages?.() ?? []), ...(internet?.openOutages() ?? [])];

/** Stored outages in [from, to] plus those still open (not stored until they end). */
export function outagesIn(db, { from, to, openOutages = [] }) {
  return [...openOutages.filter((o) => o.end_ts >= from && o.start_ts <= to), ...db.outages(from, to)];
}

/**
 * For charts other than the timeline: not-monitored spans and router-unreachable
 * spans, both clipped to the window, oldest first.
 */
export function coverageFor(db, { from, to, statusMs, openOutages }) {
  const routerOutages = outagesIn(db, { from, to, openOutages })
    .filter((o) => (o.kind ?? 'router') === 'router')
    .map((o) => ({ start: Math.max(o.start_ts, from), end: Math.min(o.end_ts, to), reason: o.reason ?? null }))
    .filter((o) => o.end > o.start)
    .sort((a, b) => a.start - b.start);
  const minGapMs = unmonitoredMinMs(statusMs);
  return {
    unmonitored: unmonitoredSpans({ from, to, gaps: db.sampleGaps(from, to, minGapMs), routerOutages, statusMs }),
    outages: routerOutages,
  };
}
