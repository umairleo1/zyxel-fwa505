// Derived insights the router's own UI doesn't provide: reliability, signal
// quality distribution, usage, devices and prioritised recommendations.
import { RSRP_CUTS, SINR_CUTS, WIFI_CUTS, wifiQuality } from '@zyxel-insight/shared/quality';
import { pct } from '../lib/util.js';

/** Everything on the Insights page except the audit. Aggregation happens in SQLite. */
export function computeInsights({ db, from, to, state, traffic, devices, stations }) {
  const span = to - from;
  const cov = db.metricCoverage(from, to);

  // Reliability
  const reboots = db.reboots(from, to);
  const outages = db.outages(from, to);
  const downMs = outages.reduce((s, o) => s + Math.min(o.end_ts, to) - Math.max(o.start_ts, from), 0);
  const covered = cov.covered;
  const reliability = {
    coveragePct: pct(covered, span),
    availabilityPct: covered ? Math.max(0, Math.min(100, pct(covered - Math.min(downMs, covered), covered))) : null,
    reboots: reboots.length,
    unexpectedReboots: reboots.filter((r) => r.kind !== 'expected').length,
    outages: outages.length,
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

  // Devices
  const dev = devices ?? [];
  // Anything below "Good" on the shared Wi-Fi scale, so advice and badges agree.
  const weak = (stations ?? []).filter((s) => s.rssi < WIFI_CUTS[1]);
  const devicesSummary = {
    known: dev.length,
    online: dev.filter((d) => d.online).length,
    newInRange: dev.filter((d) => d.first_seen >= from).length,
    weakWifi: weak.map((s) => ({ mac: s.mac, band: s.band, rssi: s.rssi, name: dev.find((d) => d.mac === s.mac)?.name ?? null })),
    dhcpChatter: db.dhcpByMac(from).map((r) => ({ ...r, name: dev.find((d) => d.mac === r.mac)?.name ?? null })),
  };

  return {
    from,
    to,
    reliability,
    signal,
    system,
    devices: devicesSummary,
    usage: traffic ? { totals: traffic.totals, peak: traffic.peak, days: traffic.days } : null,
    recommendations: recommend({ state, signal, reliability, system, devicesSummary }),
  };
}

function recommend({ state, signal, reliability, system, devicesSummary }) {
  const recs = [];
  const carriers = state?.router?.carriers?.carriers ?? [];
  const pcc = carriers.find((c) => c.role === 'primary');
  const best = carriers.filter((c) => c.rat === 'LTE' && c.role === 'secondary' && c.rsrp != null).sort((a, b) => b.rsrp - a.rsrp)[0];
  if (pcc?.rsrp != null && best && best.rsrp - pcc.rsrp >= 8) {
    recs.push({
      severity: 'warn',
      title: `${best.band} is ${best.rsrp - pcc.rsrp} dB stronger than your primary ${pcc.band}`,
      detail: `Primary ${pcc.band} at ${pcc.rsrp} dBm vs ${best.band} at ${best.rsrp} dBm right now. The network picks the primary; a weak primary limits uplink and stability.`,
      action: `If this persists, try a band preference/lock that favours ${best.band} (Network Setting → Broadband → Band), then compare speeds.`,
    });
  }
  const lteAvg = signal.lte.rsrp?.avg;
  if (lteAvg != null && lteAvg <= -106) {
    recs.push({
      severity: 'warn',
      title: `Weak LTE signal (average ${lteAvg} dBm)`,
      detail: `${signal.lte.rsrpDist.poor}% of samples were 2 bars or fewer on the router's scale (≤ −106 dBm).`,
      action: 'Move the router near a window or higher up, facing the nearest mast; an external antenna can add 5–10 dB.',
    });
  }
  const sinrAvg = signal.lte.sinr?.avg;
  if (sinrAvg != null && sinrAvg < 5) {
    recs.push({
      severity: 'warn',
      title: `Low signal quality (average SINR ${sinrAvg} dB)`,
      detail: 'Interference from neighbouring cells limits speed even when signal strength is fine.',
      action: 'Repositioning by even 1–2 m or rotating the router often changes SINR noticeably; watch the SINR chart while you move it.',
    });
  }
  if (signal.nr.availabilityPct != null && signal.nr.availabilityPct < 90 && signal.nr.rsrp) {
    recs.push({
      severity: 'info',
      title: `5G was available ${signal.nr.availabilityPct}% of the time`,
      detail: 'The 5G NSA leg drops in and out; speeds fall back to LTE only.',
      action: 'Check the signal chart for when it drops; placement nearer a window usually helps 5G (n78) most.',
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
  if (reliability.coveragePct != null && reliability.coveragePct < 60) {
    recs.push({
      severity: 'info',
      title: `Insight only monitored ${reliability.coveragePct}% of this period`,
      detail: 'Gaps happen while this computer sleeps or Insight is stopped.',
      action: 'Run Insight on an always-on machine for complete history.',
    });
  }
  return recs;
}
