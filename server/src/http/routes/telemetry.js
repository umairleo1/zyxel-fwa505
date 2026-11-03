import { Router } from 'express';
import { summarizeTraffic } from '../../collector/samplers.js';
import { bucketFor, timeRange } from '../params.js';

const RECENT_STATIONS_MS = 5 * 60e3;
// Pad the traffic query by one sample so the first bucket has a delta.
const TRAFFIC_PAD_MS = 120e3;

/** Time series collected by Insight: signal, traffic, CPU/memory, devices. */
export function telemetryRoutes({ db }) {
  const r = Router();

  r.get('/metrics', (req, res) => {
    const { from, to } = timeRange(req.query);
    const bucketMs = bucketFor(to - from, 240);
    res.json({ from, to, bucketMs, points: db.metrics({ from, to }, bucketMs) });
  });

  r.get('/traffic', (req, res) => {
    const { from, to } = timeRange(req.query);
    res.json(summarizeTraffic(db.traffic(from - TRAFFIC_PAD_MS, to), { from, to, bucketMs: bucketFor(to - from, 120) }));
  });

  r.get('/system', (req, res) => {
    const { from, to } = timeRange(req.query);
    res.json({ from, to, samples: db.system(from, to), reboots: db.reboots(from, to), outages: db.outages(from, to) });
  });

  r.get('/devices', (_req, res) => {
    const stations = new Map(db.latestStations(Date.now() - RECENT_STATIONS_MS).map((s) => [s.mac, s]));
    res.json({ devices: db.devices().map((d) => ({ ...d, online: !!d.online, wifi: stations.get(d.mac) ?? null })) });
  });

  r.get('/devices/:mac', (req, res) => {
    const mac = req.params.mac.toLowerCase();
    const device = db.device(mac);
    if (!device) return res.status(404).json({ error: 'Unknown device' });
    const { from } = timeRange(req.query);
    res.json({ device: { ...device, online: !!device.online }, history: db.stationHistory(mac, from) });
  });

  return r;
}

export { summarizeTraffic, TRAFFIC_PAD_MS, RECENT_STATIONS_MS };
