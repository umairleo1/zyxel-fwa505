// Connection timeline: marker vocabulary and the pure maths behind the dashboard chart.

/** Marker kinds from /api/timeline, most severe first (a cluster shows its most severe kind). */
export const MARKER_KINDS = {
  reboot: { label: 'Reboot', plural: 'reboots' },
  cell: { label: 'Cell change', plural: 'cell changes' },
  combo: { label: 'Band change', plural: 'band changes' },
};
const RANK = Object.keys(MARKER_KINDS);

/** Outage kinds from /api/timeline: what was down. All mean no internet; `tone` colours them. */
export const OUTAGE_KINDS = {
  router: {
    label: 'Router unreachable',
    one: 'router outage',
    many: 'router outages',
    detail: "The router didn't answer Insight",
    tone: 'critical',
  },
  wan: {
    label: 'No mobile data',
    one: 'mobile data drop',
    many: 'mobile data drops',
    detail: 'The router answered, but its mobile data connection was down',
    tone: 'warning',
  },
  internet: {
    label: 'Internet stalled',
    one: 'internet stall',
    many: 'internet stalls',
    detail: 'The router reported mobile data as up, but nothing got through to the internet',
    tone: 'warning',
  },
};
/** 'critical' | 'warning' for an outage kind; unknown kinds count as the most severe. */
export const outageTone = (kind) => OUTAGE_KINDS[kind]?.tone ?? 'critical';
export const UNMONITORED = {
  label: 'Not monitored',
  detail: "Insight wasn't collecting (not running, computer asleep, or paused), so it can't say what happened",
};

/**
 * Group markers that would overlap on screen. `xOf` maps ts to px; markers closer
 * than `minGap` px join the cluster to their left. Clusters sit at their members'
 * mean x and take the most severe member's kind. Input oldest first.
 */
export function clusterMarkers(markers, xOf, minGap = 12) {
  const clusters = [];
  for (const m of markers) {
    const mx = xOf(m.ts);
    const last = clusters.at(-1);
    if (last && mx - last.lastX < minGap) {
      last.items.push(m);
      last.sumX += mx;
      last.lastX = mx;
    } else {
      clusters.push({ items: [m], sumX: mx, lastX: mx });
    }
  }
  return clusters.map(({ items, sumX }) => {
    const kind = RANK.find((k) => items.some((m) => m.kind === k)) ?? items[0].kind;
    return {
      key: `${items[0].ts}-${items[0].kind}`,
      x: sumX / items.length,
      from: items[0].ts,
      to: items.at(-1).ts,
      kind,
      // An unexplained reboot is the one thing on this chart that needs attention.
      alert: items.some((m) => m.kind === 'reboot' && !m.expected),
      items,
    };
  });
}

const FOCUS_MIN_MS = 10 * 60e3;
const FOCUS_MAX_MS = 6 * 3600e3;

/**
 * Window to zoom into around [from, to] (a moment or a cluster's span): padded by
 * 1/24 of the current view, at least 10 min and at most 6 h wide in total, and
 * never past `now` since there is nothing to show there yet.
 */
export function focusWindow(from, to, view, now = Date.now()) {
  const pad = Math.min(FOCUS_MAX_MS / 2, Math.max(FOCUS_MIN_MS / 2, (view.to - view.from) / 24));
  const end = Math.min(now, to + pad);
  return { from: Math.min(from - pad, end - FOCUS_MIN_MS), to: end };
}

/** Span ({ start, end }) covering time t, if any: an outage or a not-monitored stretch. */
export const spanAt = (spans, t) => spans.find((o) => t >= o.start && t <= o.end) ?? null;

/** Total length in seconds of spans that may overlap, counting overlaps once. */
function unionSec(spans) {
  let total = 0;
  let reach = -Infinity;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const start = Math.max(s.start, reach);
    if (s.end > start) total += s.end - start;
    reach = Math.max(reach, s.end);
  }
  return Math.round(total / 1000);
}

/** Headline counts for the panel: outages per kind and downtime, unwatched time, then each marker kind. */
export function timelineSummary({ outages = [], markers = [], unmonitored = [] } = {}) {
  const counts = Object.fromEntries(RANK.map((k) => [k, 0]));
  for (const m of markers) if (m.kind in counts) counts[m.kind]++;
  const byKind = Object.fromEntries(Object.keys(OUTAGE_KINDS).map((k) => [k, 0]));
  for (const o of outages) byKind[o.kind in byKind ? o.kind : 'router']++;
  return {
    outages: outages.length,
    byKind,
    downSec: unionSec(outages),
    ongoing: outages.some((o) => o.ongoing),
    unmonitoredSec: unionSec(unmonitored),
    counts,
  };
}
