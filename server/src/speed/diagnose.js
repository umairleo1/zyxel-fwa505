// What limits the speed, judged from speed tests and the radio state each ran under: the radio
// link (signal quality), a busy mast (slow at certain hours with steady signal), queueing
// (latency under load) or the band setup. Pure: tests in, findings out. Optimiser tests are
// left out: they deliberately try other setups, so they say nothing about the usual one.
import { addedLatency, bufferbloatGrade, median } from '@zyxel-insight/shared/speed';

const MIN_TESTS = 3;
const MIN_PER_GROUP = 2;
const SHAPE_SHARE = 0.85; // SQM shaped to this share of measured speed keeps the queue on your side
const BLOCKS = [
  { label: 'night (00–06)', from: 0 },
  { label: 'morning (06–12)', from: 6 },
  { label: 'afternoon (12–18)', from: 12 },
  { label: 'evening (18–24)', from: 18 },
];

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
/** The leg that carries most of the speed: 5G when it was there, else LTE. */
const sinrOf = (t) => t.nrSinr ?? t.lteSinr ?? null;

/** Spearman rank correlation of paired values, or null with fewer than 5 pairs. Pure. */
export function rankCorrelation(pairs) {
  const ps = pairs.filter(([a, b]) => a != null && b != null);
  if (ps.length < 5) return null;
  const ranks = (xs) => {
    const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2; // ties share their average rank
      i = j + 1;
    }
    return r;
  };
  const ra = ranks(ps.map((p) => p[0]));
  const rb = ranks(ps.map((p) => p[1]));
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? Math.round((num / Math.sqrt(da * db)) * 100) / 100 : null;
}

/** Medians for a group of tests. */
function stats(tests) {
  return {
    n: tests.length,
    downMbps: round1(median(tests.map((t) => t.downMbps))),
    upMbps: round1(median(tests.map((t) => t.upMbps))),
    sinr: round1(median(tests.map(sinrOf))),
  };
}

/**
 * tests: stored rows (any order). hourOf(ts) → local hour, injectable for tests.
 * Returns { summary, byHour, byCombo, findings: [{ severity, kind, title, detail, action }] }.
 */
export function diagnose(tests, { hourOf = (ts) => new Date(ts).getHours() } = {}) {
  const own = tests.filter((t) => t.trigger !== 'optimiser');
  const ok = own.filter((t) => t.state === 'ok' && t.downMbps != null);
  const failed = own.length - ok.length;
  const added = ok.map(addedLatency).filter((v) => v != null);
  const idle = median(ok.map((t) => t.idleMs));
  const addedMs = median(added);
  const downs = ok.map((t) => t.downMbps).sort((a, b) => a - b);
  const summary = {
    tests: own.length,
    ok: ok.length,
    failed,
    ...stats(ok),
    p10DownMbps: downs.length >= 5 ? round1(downs[Math.floor(downs.length * 0.1)]) : null,
    idleMs: round1(idle),
    addedMs: round1(addedMs),
    grade: idle == null || addedMs == null ? null : bufferbloatGrade(idle, idle + addedMs),
  };

  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const inHour = ok.filter((t) => hourOf(t.ts) === hour);
    return { hour, ...stats(inHour) };
  });
  const combos = new Map();
  for (const t of ok) {
    if (!t.combo) continue;
    if (!combos.has(t.combo)) combos.set(t.combo, []);
    combos.get(t.combo).push(t);
  }
  const byCombo = [...combos.entries()].map(([combo, ts]) => ({ combo, ...stats(ts) })).sort((a, b) => b.n - a.n);

  const findings = [];
  if (ok.length < MIN_TESTS) {
    findings.push({
      severity: 'info',
      kind: 'data',
      title: ok.length ? `Only ${ok.length} speed test${ok.length === 1 ? '' : 's'} so far` : 'No speed tests yet',
      detail: 'One test is a snapshot: radio conditions and how busy the mast is change through the day.',
      action:
        'Run a few tests at different times, or set SPEEDTEST_EVERY_HOURS so Insight builds the picture by itself (each test uses up to the data cap shown on the page).',
    });
    return { summary, byHour, byCombo, findings };
  }

  if (failed / own.length >= 0.2) {
    findings.push({
      severity: 'warn',
      kind: 'reliability',
      title: `${failed} of ${own.length} speed tests failed`,
      detail: 'A test fails when no data moves in one direction: the connection dropped or stalled while it ran.',
      action: 'Check the dashboard timeline around those times for outages, stalls and band changes.',
    });
  }

  // Queueing: the latency a busy line adds. Fixed on your side of the bottleneck, not by the router.
  if (addedMs != null && addedMs >= 60) {
    const down = Math.round((summary.downMbps ?? 0) * SHAPE_SHARE);
    const up = Math.round((summary.upMbps ?? 0) * SHAPE_SHARE * 10) / 10;
    findings.push({
      severity: addedMs >= 200 ? 'warn' : 'info',
      kind: 'bufferbloat',
      title: `Latency rises by about ${Math.round(addedMs)} ms under load (bufferbloat grade ${summary.grade})`,
      detail: `Idle latency is ${Math.round(idle)} ms, but a download or upload fills queues in the network, so calls and games lag whenever someone is using the line. More speed doesn't fix this; managing the queue does.`,
      action: `Put a router with SQM (CAKE or fq_codel, e.g. OpenWrt) between the FWA505 and your network, shaped to about ${down} Mbps down and ${up} Mbps up (${Math.round(SHAPE_SHARE * 100)}% of your typical speed). The FWA505 can't do it itself: its hardware NAT bypasses the queues SQM works on.`,
    });
  }

  // A busy mast: slow at some times of day while the signal stays the same.
  const blocks = BLOCKS.map((b) => ({ ...b, ...stats(ok.filter((t) => Math.floor(hourOf(t.ts) / 6) * 6 === b.from)) })).filter(
    (b) => b.n >= MIN_PER_GROUP,
  );
  if (blocks.length >= 2) {
    const best = blocks.reduce((a, b) => (b.downMbps > a.downMbps ? b : a));
    const worst = blocks.reduce((a, b) => (b.downMbps < a.downMbps ? b : a));
    if (best !== worst && worst.downMbps <= best.downMbps * 0.7) {
      const steady = best.sinr != null && worst.sinr != null && Math.abs(best.sinr - worst.sinr) < 3;
      findings.push({
        severity: 'info',
        kind: steady ? 'congestion' : 'time-of-day',
        title: `Slower in the ${worst.label.split(' ')[0]}: ${worst.downMbps} Mbps vs ${best.downMbps} Mbps in the ${best.label.split(' ')[0]}`,
        detail: steady
          ? `Signal quality was about the same at both times (${worst.sinr} vs ${best.sinr} dB SINR), so the cell itself is busier: other users share its capacity. No setting at your end changes that.`
          : `Signal quality also differs (${worst.sinr} vs ${best.sinr} dB SINR): busier neighbouring cells raise interference at those times.`,
        action: steady
          ? 'Schedule big downloads and backups outside those hours. If evenings are unusable, report the times to your provider.'
          : 'Plan heavy use outside those hours; a position or antenna that favours one cell reduces interference.',
      });
    }
  }

  // The radio link: speed that follows signal quality, or quality too low to go fast.
  const rho = rankCorrelation(ok.map((t) => [sinrOf(t), t.downMbps]));
  if ((summary.sinr != null && summary.sinr < 8) || (rho != null && rho >= 0.5 && ok.length >= 6)) {
    findings.push({
      severity: summary.sinr != null && summary.sinr < 3 ? 'warn' : 'info',
      kind: 'radio',
      title:
        summary.sinr != null && summary.sinr < 8
          ? `Signal quality limits speed (median SINR ${summary.sinr} dB during tests)`
          : `Speed follows signal quality (correlation ${rho})`,
      detail:
        'On a fixed router, SINR sets how fast each carrier can go: every few dB lets the modem use faster coding. Below about 10 dB it falls back to slow, robust modulation.',
      action:
        'Use the Placement page: move the router (higher, near a window, facing the mast, away from metal and other electronics) and compare spots by their score. Small moves can matter. An external or outdoor antenna helps most if no spot is good.',
    });
  }

  // The band setup: results that differ by combination.
  const comparable = byCombo.filter((c) => c.n >= MIN_PER_GROUP + 1);
  if (comparable.length >= 2) {
    const best = comparable.reduce((a, b) => (b.downMbps > a.downMbps ? b : a));
    const worst = comparable.reduce((a, b) => (b.downMbps < a.downMbps ? b : a));
    if (worst.downMbps > 0 && best.downMbps >= worst.downMbps * 1.25) {
      findings.push({
        severity: 'info',
        kind: 'setup',
        title: `${best.combo} tested faster than ${worst.combo} (${best.downMbps} vs ${worst.downMbps} Mbps)`,
        detail: `Medians over ${best.n} and ${worst.n} tests. The network picks the combination, but the bands you allow shape it.`,
        action:
          'Run the optimiser to test setups side by side; it compares them in the same rounds, which separates the setup from the time of day.',
      });
    }
  }

  if (summary.upMbps != null && summary.upMbps < 5) {
    findings.push({
      severity: 'info',
      kind: 'upload',
      title: `Upload is low (median ${summary.upMbps} Mbps)`,
      detail: 'On 5G NSA the upload often goes over the 4G anchor, so the anchor band and its signal set the upload speed.',
      action: 'The optimiser tries single-anchor setups; a stronger 4G anchor usually lifts upload most.',
    });
  }

  if (!findings.length) {
    findings.push({
      severity: 'good',
      kind: 'ok',
      title: `No clear limit found (median ${summary.downMbps} Mbps down, ${summary.upMbps} Mbps up)`,
      detail: 'Speed is consistent across times and setups, and latency holds under load.',
      action: 'Nothing to change. Re-run the optimiser now and then: networks change.',
    });
  }
  const rank = { warn: 0, info: 1, good: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { summary, byHour, byCombo, findings };
}
