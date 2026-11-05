// The dashboard's connection timeline: WAN throughput with the moments that explain
// it (outages, reboots, handovers, band-combination changes) on one time axis, and
// the stretches Insight wasn't watching, so they don't pass for quiet ones.
import { summarizeTraffic } from '../collector/samplers.js';
import { outagesIn, unmonitoredMinMs, unmonitoredSpans } from './coverage.js';

// Insight's own change events (see collector.js), by log facility.
const CHANGE_FACILITIES = { cell: 'cell', carriers: 'combo' };
// Enough for a month of a fixed router; a flapping cell beyond this is summarised, not drawn.
export const MAX_MARKERS = 300;

/**
 * Pure: throughput summary + reliability rows + change events -> timeline payload.
 * Outages (stored and still open) are clipped to the window; markers are oldest first,
 * the newest kept when capped (`truncated`). `events` may hold one row over the cap, so
 * the flag is exact. `gaps` are spans without signal samples: the ones a router outage
 * doesn't explain are `unmonitored`.
 */
export function buildTimeline({ from, to, traffic, outages, reboots, events, gaps = [], statusMs = 0, maxMarkers = MAX_MARKERS }) {
  const markers = [
    ...reboots.map((r) => ({
      ts: r.boot_ts,
      kind: 'reboot',
      expected: r.kind === 'expected',
      message: r.reason ? `Router rebooted (${r.reason})` : 'Router rebooted (no reason in the router log)',
    })),
    ...events
      .filter((e) => e.facility in CHANGE_FACILITIES)
      .map((e) => ({ ts: e.ts, kind: CHANGE_FACILITIES[e.facility], message: e.message })),
  ]
    .filter((m) => m.ts >= from && m.ts <= to)
    .sort((a, b) => a.ts - b.ts);

  const spans = outages
    .map((o) => ({
      start: Math.max(o.start_ts, from),
      end: Math.min(o.end_ts, to),
      kind: o.kind ?? 'router',
      reason: o.reason ?? null,
      ongoing: !!o.ongoing,
    }))
    .filter((o) => o.end > o.start)
    .sort((a, b) => a.start - b.start);
  const unmonitored = unmonitoredSpans({ from, to, gaps, routerOutages: spans.filter((o) => o.kind === 'router'), statusMs });

  return {
    from,
    to,
    bucketMs: traffic.bucketMs,
    series: traffic.series,
    peak: traffic.peak,
    outages: spans,
    unmonitored,
    markers: markers.slice(-maxMarkers),
    truncated: markers.length > maxMarkers,
  };
}

/**
 * Reads everything the timeline needs for [from, to] from the store, plus outages the
 * collector still has open (`openOutages`, ongoing ones aren't stored until they end).
 */
export function timelineFor(db, { from, to, bucketMs, trafficPadMs, statusMs, openOutages = [] }) {
  return buildTimeline({
    from,
    to,
    traffic: summarizeTraffic(db.traffic(from - trafficPadMs, to), { from, to, bucketMs }),
    outages: outagesIn(db, { from, to, openOutages }),
    gaps: db.sampleGaps(from, to, unmonitoredMinMs(statusMs)),
    statusMs,
    reboots: db.reboots(from, to),
    // query() returns up to limit + 1 rows (newest first), which is what makes `truncated` exact.
    events: db.query({ sources: ['insight'], facilities: Object.keys(CHANGE_FACILITIES), from, to }, MAX_MARKERS),
  });
}
