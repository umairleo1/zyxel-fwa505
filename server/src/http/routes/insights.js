import { Router } from 'express';
import { runAudit } from '../../insights/audit.js';
import { computeInsights } from '../../insights/summary.js';
import { openOutages } from '../../insights/coverage.js';
import { summarizeTraffic, TRAFFIC_PAD_MS, RECENT_STATIONS_MS } from './telemetry.js';
import { bucketFor, timeRange } from '../params.js';
import { createFreshGate, INSIGHTS_FRESH_MS } from '../limits.js';

const AUDIT_TTL_MS = 5 * 60e3; // configuration rarely changes
const RESULT_TTL_MS = 30e3; // aggregates over days don't move within 30 s
const MAX_RESULTS = 20; // one entry per distinct span; bounded so odd ?from/?to can't grow it

export function insightsRoutes({ db, routerData, collector, internet }) {
  const r = Router();
  let audit = null;
  const results = new Map(); // span (minutes) -> { at, body }
  // `fresh` re-runs the audit (several router reads): honoured at most once per 30 s.
  const freshGate = createFreshGate(INSIGHTS_FRESH_MS);

  async function currentAudit(force) {
    if (audit && !force && Date.now() - audit.at < AUDIT_TTL_MS) return audit;
    try {
      audit = await runAudit((id) => routerData.raw(id, AUDIT_TTL_MS).then((x) => x.data));
    } catch (e) {
      audit ??= { checks: [], counts: {}, score: null, at: Date.now(), error: e.message };
    }
    return audit;
  }

  r.get('/insights', async (req, res) => {
    const { from, to } = timeRange(req.query, 7 * 86400e3);
    const key = Math.round((to - from) / 60e3);
    const fresh = !!req.query.fresh && freshGate.allow('insights');
    const hit = results.get(key);
    if (hit && !fresh && Date.now() - hit.at < RESULT_TTL_MS) return res.json(hit.body);

    const rows = db.traffic(from - TRAFFIC_PAD_MS, to);
    const traffic = summarizeTraffic(rows, { from, to, bucketMs: bucketFor(to - from, 120) });
    // Same samples in 1 h buckets, for the hour-of-day profile.
    const hourlyTraffic = summarizeTraffic(rows, { from, to, bucketMs: 3600e3 });
    // This calendar month (local time), for the usage projection.
    const now = new Date(to);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const monthRows = db.traffic(monthStart - TRAFFIC_PAD_MS, to);
    const month = {
      totals: summarizeTraffic(monthRows, { from: monthStart, to, bucketMs: 86400e3 }).totals,
      firstSampleTs: monthRows.find((r) => r.ts >= monthStart)?.ts ?? null,
      monthStart,
      monthEnd,
    };
    const stations = db.latestStations(Date.now() - RECENT_STATIONS_MS).map((s) => ({ mac: s.mac, band: s.band, rssi: s.rssi }));
    const insights = computeInsights({
      db,
      from,
      to,
      state: { ...collector.state, rangeDays: (to - from) / 86400e3 },
      traffic,
      hourlyTraffic,
      month,
      devices: db.devices(),
      stations,
      openOutages: openOutages({ collector, internet }),
    });
    const body = { ...insights, audit: await currentAudit(fresh) };
    results.delete(key);
    results.set(key, { at: Date.now(), body });
    if (results.size > MAX_RESULTS) results.delete(results.keys().next().value); // oldest first
    res.json(body);
  });

  return r;
}
