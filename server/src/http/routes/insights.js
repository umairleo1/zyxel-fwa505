import { Router } from 'express';
import { runAudit } from '../../insights/audit.js';
import { computeInsights } from '../../insights/summary.js';
import { summarizeTraffic, TRAFFIC_PAD_MS, RECENT_STATIONS_MS } from './telemetry.js';
import { bucketFor, timeRange } from '../params.js';

const AUDIT_TTL_MS = 5 * 60e3; // configuration rarely changes
const RESULT_TTL_MS = 30e3; // aggregates over days don't move within 30 s

export function insightsRoutes({ db, routerData, collector }) {
  const r = Router();
  let audit = null;
  const results = new Map(); // span (minutes) -> { at, body }

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
    const hit = results.get(key);
    if (hit && !req.query.fresh && Date.now() - hit.at < RESULT_TTL_MS) return res.json(hit.body);

    const traffic = summarizeTraffic(db.traffic(from - TRAFFIC_PAD_MS, to), { from, to, bucketMs: bucketFor(to - from, 120) });
    const stations = db.latestStations(Date.now() - RECENT_STATIONS_MS).map((s) => ({ mac: s.mac, band: s.band, rssi: s.rssi }));
    const insights = computeInsights({
      db,
      from,
      to,
      state: { ...collector.state, rangeDays: (to - from) / 86400e3 },
      traffic,
      devices: db.devices(),
      stations,
    });
    const body = { ...insights, audit: await currentAudit(!!req.query.fresh) };
    results.set(key, { at: Date.now(), body });
    res.json(body);
  });

  return r;
}
