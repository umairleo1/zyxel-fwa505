// Derived insights the router's own UI doesn't provide: reliability, signal
// quality distribution, usage, devices and prioritised recommendations.
import { RSRP_CUTS, SINR_CUTS, WIFI_CUTS, wifiQuality } from '@zyxel-insight/shared/quality';
import { mergeSpans, pct } from '../lib/util.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
// An hour of 5 s samples: below this an average says more about the moment than the period.
const MIN_SAMPLES = 720;
// Advice from the hour-of-day profile needs each hour seen on several days, or one bad
// evening reads as a pattern.
const PROFILE_MIN_DAYS = 3;
const PROFILE_MIN_SAMPLES = 60;
// Usage projections need this much history to mean anything.
const PROJECTION_MIN_MS = 2 * DAY;

/**
 * Everything on the Insights page except the audit. Aggregation happens in SQLite.
 * `hourlyTraffic` is the period's traffic summary in 1 h buckets; `month` the current
 * month's ({ totals, firstSampleTs, monthStart, monthEnd }).
 */
export function computeInsights({ db, from, to, state, traffic, hourlyTraffic, month, devices, stations, openOutages = [] }) {
  const cov = db.metricCoverage(from, to);
  // Time before Insight's first sample isn't "unmonitored": Insight didn't exist yet.
  const firstSample = db.firstMetricTs();
  const since = firstSample == null ? to : Math.max(from, firstSample);

  // Reliability
  const reboots = db.reboots(from, to);
  const outages = [...openOutages, ...db.outages(from, to)];
  // Router-unreachable and mobile-data outages can overlap: count the time once.
  const downMs = mergeSpans(outages.map((o) => ({ start: Math.max(o.start_ts, from), end: Math.min(o.end_ts, to) }))).reduce(
    (s, o) => s + o.end - o.start,
    0,
  );
  const covered = cov.covered;
  const wan = outages.filter((o) => o.kind === 'wan');
  const stalls = outages.filter((o) => o.kind === 'internet');
  const secIn = (list) => Math.round(list.reduce((s, o) => s + Math.min(o.end_ts, to) - Math.max(o.start_ts, from), 0) / 1000);
  const reliability = {
    monitoredSince: firstSample,
    startedInPeriod: firstSample != null && firstSample > from,
    coveragePct: to > since ? Math.min(100, pct(covered, to - since)) : null,
    availabilityPct: covered ? Math.max(0, Math.min(100, pct(covered - Math.min(downMs, covered), covered))) : null,
    reboots: reboots.length,
    unexpectedReboots: reboots.filter((r) => r.kind !== 'expected').length,
    outages: outages.length,
    routerOutages: outages.length - wan.length - stalls.length,
    wanOutages: wan.length,
    wanDownSec: secIn(wan),
    internetStalls: stalls.length,
    internetStallSec: secIn(stalls),
    longestStallSec: stalls.length ? Math.round(Math.max(...stalls.map((o) => o.end_ts - o.start_ts)) / 1000) : 0,
    wanReasons: countBy(wan.map((o) => (o.reason ?? 'unknown').replace(/ \(.*\)$/, ''))),
    downtimeSec: Math.round(downMs / 1000),
    longestOutageSec: outages.length ? Math.round(Math.max(...outages.map((o) => o.end_ts - o.start_ts)) / 1000) : 0,
    recentReboots: reboots.slice(0, 10),
    recentOutages: outages.slice(0, 10),
  };

  // Signal
  const m = (col, cuts) => db.metricStats(col, from, to, cuts) ?? { stats: null, dist: null };
  const lteRsrp = m('lte_rsrp', RSRP_CUTS);
  const lteSinr = m('lte_sinr', SINR_CUTS);
  const nrRsrp = m('nr_rsrp', RSRP_CUTS);
  const nrSinr = m('nr_sinr', SINR_CUTS);
  const signal = {
    lte: { rsrp: lteRsrp.stats, sinr: lteSinr.stats, rsrpDist: lteRsrp.dist, sinrDist: lteSinr.dist },
    nr: {
      rsrp: nrRsrp.stats,
      sinr: nrSinr.stats,
      rsrpDist: nrRsrp.dist,
      sinrDist: nrSinr.dist,
      availabilityPct: pct(cov.nrSamples, cov.samples),
    },
    handovers: db.countEvents('cell', from),
    comboChanges: db.countEvents('carriers', from),
    distinctCells: cov.cells,
    combos: cov.combos.map((c) => ({ combo: c.combo, pct: pct(c.n, cov.samples) })),
  };

  const system = db.systemStats(from, to);
  const hourly = hourlyProfile(db.hourlySignal(from, to), hourlyTraffic?.series ?? []);

  // Devices. The ones present when Insight first looked aren't new, just newly seen.
  const dev = devices ?? [];
  const seededAt = Number(db.getMeta('devicesSeededAt')) || (dev.length ? Math.min(...dev.map((d) => d.first_seen)) : null);
  // Anything below "Good" on the shared Wi-Fi scale, so advice and badges agree.
  const weak = (stations ?? []).filter((s) => s.rssi < WIFI_CUTS[1]);
  const devicesSummary = {
    known: dev.length,
    online: dev.filter((d) => d.online).length,
    newInRange: dev.filter((d) => d.first_seen >= from && (seededAt == null || d.first_seen > seededAt)).length,
    firstSeenAt: seededAt,
    weakWifi: weak.map((s) => ({ mac: s.mac, band: s.band, rssi: s.rssi, name: dev.find((d) => d.mac === s.mac)?.name ?? null })),
    dhcpChatter: db.dhcpByMac(from).map((r) => ({ ...r, name: dev.find((d) => d.mac === r.mac)?.name ?? null })),
  };

  const usage = traffic
    ? {
        totals: traffic.totals,
        peak: traffic.peak,
        days: traffic.days,
        month: month ? projectMonth({ used: month.totals.rx + month.totals.tx, ...month, now: to }) : null,
      }
    : null;

  return {
    from,
    to,
    reliability,
    signal,
    system,
    hourly,
    devices: devicesSummary,
    usage,
    // Band advice compares bands on the network in use only (see storage/bands.js).
    recommendations: recommend({
      state,
      signal,
      reliability,
      system,
      devicesSummary,
      bands: db.bandsSeen({ plmn: state?.router?.signal?.plmn ?? undefined }),
      hourly,
    }),
  };
}

const countBy = (xs) => Object.entries(xs.reduce((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {})).map(([reason, n]) => ({ reason, n }));

/**
 * Pure: this month's usage so far and where it's heading at the rate seen since data
 * for the month begins (the month start, or Insight's first sample if later). No
 * projection until there are PROJECTION_MIN_MS of it.
 */
export function projectMonth({ used, firstSampleTs, monthStart, monthEnd, now }) {
  const dataStart = Math.max(monthStart, firstSampleTs ?? now);
  const elapsed = now - dataStart;
  const projected = elapsed >= PROJECTION_MIN_MS ? Math.round(used + (used / elapsed) * Math.max(0, monthEnd - now)) : null;
  return { used, since: dataStart, monthEnd, projected, basisDays: Math.round((elapsed / DAY) * 10) / 10 };
}

/**
 * Pure: 24 rows (hour 0-23) joining the SQL signal profile with throughput from 1 h
 * traffic buckets: average and peak download per local hour. `reliable` marks hours
 * with enough samples on enough days to compare.
 */
export function hourlyProfile(signalRows, trafficSeries) {
  const byHour = new Map(signalRows.map((r) => [r.hour, r]));
  const tput = Array.from({ length: 24 }, () => ({ sum: 0, n: 0, peak: 0 }));
  for (const p of trafficSeries) {
    const h = tput[new Date(p.t).getHours()];
    h.sum += p.rxBps;
    h.n++;
    h.peak = Math.max(h.peak, p.rxBps);
  }
  return Array.from({ length: 24 }, (_, hour) => {
    const s = byHour.get(hour);
    const t = tput[hour];
    return {
      hour,
      lteSinr: s?.lte_sinr ?? null,
      nrSinr: s?.nr_sinr ?? null,
      avgDownBps: t.n ? Math.round(t.sum / t.n) : null,
      peakDownBps: t.n ? Math.round(t.peak) : null,
      samples: s?.n ?? 0,
      days: s?.days ?? 0,
      reliable: !!s && s.days >= PROFILE_MIN_DAYS && s.n >= PROFILE_MIN_SAMPLES,
    };
  });
}

const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const enough = (stats) => (stats?.n ?? 0) >= MIN_SAMPLES;

function recommend({ state, signal, reliability, system, devicesSummary, bands, hourly }) {
  const recs = [];

  // Mobile data drops: the router answered, the internet didn't.
  if (reliability.wanOutages >= 2 || reliability.wanDownSec >= 600) {
    const why = reliability.wanReasons.map((r) => `${r.reason}${r.n > 1 ? ` ×${r.n}` : ''}`).join(', ');
    recs.push({
      severity: 'warn',
      title: `${reliability.wanOutages} mobile data drop${reliability.wanOutages === 1 ? '' : 's'} (${formatSec(reliability.wanDownSec)} without internet)`,
      detail: `The router stayed up but lost its connection: ${why}.`,
      action:
        'Check the dashboard timeline: drops with weak signal around them point to placement or an antenna; drops with good signal are on the network side, so report the times to your provider.',
    });
  }
  // Internet stalls: the router said mobile data was up, but nothing got through.
  if (reliability.internetStalls >= 2 || reliability.internetStallSec >= 300) {
    const n = reliability.internetStalls;
    recs.push({
      severity: 'warn',
      title: `${n} internet stall${n === 1 ? '' : 's'} (${formatSec(reliability.internetStallSec)}, longest ${formatSec(reliability.longestStallSec)})`,
      detail: 'The router reported mobile data as connected while no traffic got through, so it never logged a drop.',
      action:
        'Each stall records the signal when it began. Stalls with low SINR (below ~3 dB) point to placement or an antenna, or to locking the stronger band; stalls with good signal are congestion or the network, so report the times to your provider.',
    });
  }
  if (reliability.routerOutages >= 2) {
    recs.push({
      severity: 'info',
      title: `The router stopped answering ${reliability.routerOutages} times`,
      detail: 'Insight lost contact with it over your local network.',
      action:
        "If the internet went down at the same time, check the router's power and its uptime for restarts; if only Insight lost it, check this computer's own network connection.",
    });
  }

  // Band balance, from each band's history rather than one reading: the primary flips
  // between bands, so a single snapshot makes this advice come and go.
  const lte = (bands ?? []).filter((b) => b.rat === 'LTE' && b.avgRsrp != null && b.seconds >= 3600);
  const usual = [...lte].sort((a, b) => b.primarySeconds - a.primarySeconds)[0];
  const stronger = usual && lte.filter((b) => b.band !== usual.band).sort((a, b) => b.avgRsrp - a.avgRsrp)[0];
  if (usual?.primarySeconds > 0 && stronger && stronger.avgRsrp - usual.avgRsrp >= 8) {
    const gap = Math.round(stronger.avgRsrp - usual.avgRsrp);
    recs.push({
      severity: 'info',
      title: `${stronger.band} averages ${gap} dB stronger than ${usual.band}, your usual primary`,
      detail: `${usual.band} ${usual.avgRsrp} dBm vs ${stronger.band} ${stronger.avgRsrp} dBm on average while each was in use. The network picks the primary, often for capacity rather than strength; a weak primary mostly costs upload speed and stability.`,
      action: `If uploads are slow or the connection unstable, try ${stronger.band} as your only 4G band (every 5G band stays on), run a speed test, and keep it only if it's better.`,
      // The page offers this as a Radio control trial (or names the router's own setting when that's off).
      tryBand: stronger.band,
    });
  }

  const lteAvg = signal.lte.rsrp?.avg;
  if (enough(signal.lte.rsrp) && lteAvg <= -106) {
    recs.push({
      severity: 'warn',
      title: `Weak LTE signal (average ${lteAvg} dBm)`,
      detail: `${signal.lte.rsrpDist.poor}% of samples were 2 bars or fewer on the router's scale (≤ −106 dBm).`,
      action: 'Move the router near a window or higher up, facing the nearest mast; an external antenna can add 5–10 dB.',
    });
  }

  // Signal quality on both legs: on a fixed router, SINR is what sets the speed.
  const quality = [
    ['LTE', signal.lte.sinr],
    ['5G', signal.nr.sinr],
  ].filter(([, s]) => enough(s) && s.avg < 8);
  if (quality.length) {
    recs.push({
      severity: quality.some(([, s]) => s.avg < 3) ? 'warn' : 'info',
      title: `Signal quality limits speed (average SINR ${quality.map(([leg, s]) => `${leg} ${s.avg} dB`).join(', ')})`,
      detail:
        'Strength is fine, but interference from neighbouring cells keeps SINR low, and SINR is what sets the speed a cell can give you. Below about 10 dB the modem has to use slower, more robust coding.',
      action:
        "Small moves matter: try the router 1–2 m away, higher up or rotated, and watch the SINR chart (it updates every 5 s). A directional antenna pointed at your mast helps most where there's interference.",
    });
  }

  if (signal.nr.availabilityPct != null && signal.nr.availabilityPct < 90 && enough(signal.nr.rsrp)) {
    recs.push({
      severity: 'info',
      title: `5G was available ${signal.nr.availabilityPct}% of the time`,
      detail: 'The 5G NSA leg drops in and out; speeds fall back to LTE only.',
      action: 'Check the signal chart for when it drops; placement nearer a window usually helps 5G (n78) most.',
    });
  }

  // Busy-hour dip: neighbouring cells carry more traffic in the evening, which shows up
  // as interference (lower SINR) even for a router that doesn't move.
  const dip = busyHourDip(hourly);
  if (dip) {
    recs.push({
      severity: 'info',
      title: `${dip.leg} signal quality dips around ${hh(dip.worst.hour)} (${dip.worstSinr} dB vs ${dip.bestSinr} dB at ${hh(dip.best.hour)})`,
      detail: `Seen across ${dip.days} days. A regular dip at the same time of day usually means neighbouring cells are busier, which raises interference and slows speeds even though nothing changed at your end.`,
      action:
        "It isn't fixable at home, but you can plan around it: big downloads and updates outside those hours. If evenings are unusable, tell your provider the times.",
    });
  }

  const perDay = (n) => n / Math.max(1, state?.rangeDays ?? 1);
  if (perDay(signal.handovers) > 20) {
    recs.push({
      severity: 'info',
      title: `${signal.handovers} cell changes in this period`,
      detail: 'Frequent handovers for a fixed router usually mean two cells are almost equally strong.',
      action: 'A position that clearly favours one cell (or a directional antenna) makes the connection steadier.',
    });
  }
  if (reliability.unexpectedReboots >= 2) {
    recs.push({
      severity: 'fail',
      title: `${reliability.unexpectedReboots} reboots with no logged reason`,
      detail: "If you didn't restart it yourself, repeated restarts usually point to power problems or overheating.",
      action: 'Check the power adapter/socket, give the router airflow, and keep firmware up to date.',
    });
  }
  if (system.mem?.avg != null && system.mem.avg > 85) {
    recs.push({
      severity: 'warn',
      title: `High memory use (average ${system.mem.avg}%)`,
      detail: 'Sustained memory pressure can cause slowdowns or restarts.',
      action: 'A scheduled weekly reboot can help if you see instability.',
    });
  }
  for (const w of devicesSummary.weakWifi) {
    const poor = wifiQuality(w.rssi) === 'Poor';
    recs.push({
      severity: poor ? 'warn' : 'info',
      title: `${w.name ?? w.mac} has ${poor ? 'poor' : 'only fair'} Wi-Fi (${w.rssi} dBm on ${w.band})`,
      detail: poor
        ? 'Below −75 dBm throughput drops sharply and the device may disconnect.'
        : 'Below −67 dBm video calls and streaming can stutter; browsing is fine.',
      action:
        w.band === '5GHz'
          ? 'Move it closer, or let it use 2.4 GHz which reaches further.'
          : 'Move it closer to the router or add a mesh point.',
    });
  }
  // Judged since Insight started, so a new install doesn't read as a monitoring problem.
  if (reliability.coveragePct != null && reliability.coveragePct < 60) {
    recs.push({
      severity: 'info',
      title: `Insight watched ${reliability.coveragePct}% of the time${reliability.startedInPeriod ? ' since it started' : ''}`,
      detail: 'The rest was spent with this computer asleep or Insight stopped, so outages and drops then went unseen.',
      action: 'Run Insight on an always-on machine (a Raspberry Pi works) for complete history.',
    });
  }
  // Most severe first; stable, so equal ones keep the order above.
  const rank = { fail: 0, warn: 1, info: 2 };
  return recs.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Pure: the leg (5G first, it's usually the faster one) whose reliable hours differ
 * most in average SINR, if by 3 dB or more. Null without enough history.
 */
export function busyHourDip(hourly, minDb = 3) {
  for (const [leg, key] of [
    ['5G', 'nrSinr'],
    ['LTE', 'lteSinr'],
  ]) {
    const hours = hourly.filter((h) => h.reliable && h[key] != null);
    if (hours.length < 12) continue; // half the day at least, or "best" and "worst" mean little
    const worst = hours.reduce((a, b) => (b[key] < a[key] ? b : a));
    const best = hours.reduce((a, b) => (b[key] > a[key] ? b : a));
    if (best[key] - worst[key] >= minDb) {
      return { leg, worst, best, worstSinr: worst[key], bestSinr: best[key], days: Math.min(...hours.map((h) => h.days)) };
    }
  }
  return null;
}

function formatSec(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.round((sec / 3600) * 10) / 10} h`;
}
