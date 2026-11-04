import { Router } from 'express';
import { healthOf } from '../health.js';
import { MAX_SSE_CLIENTS } from '../limits.js';
import { publicCollectorState } from '../../status.js';

/** Status snapshot, health check, Server-Sent Events stream and collector controls. */
export function liveRoutes({ hub, collector, statusPayload, statusIntervalSec = 5, startedAt = Date.now() }) {
  const r = Router();

  r.get('/status', (_req, res) => res.json(statusPayload()));

  r.get('/health', (_req, res) => {
    const { code, body } = healthOf(collector.state, { statusIntervalSec, startedAt });
    res.status(code).json(body);
  });

  // SSE: status snapshots plus "new logs / metrics / traffic / devices" notifications.
  // Each stream holds a socket open for good, so cap them.
  r.get('/events', (req, res) => {
    if (hub.size >= MAX_SSE_CLIENTS) return res.status(503).json({ error: 'Too many live connections' });
    hub.subscribe(req, res, { status: statusPayload() });
  });

  r.post('/collector/:action', async (req, res) => {
    const { action } = req.params;
    if (action === 'pause') await collector.pause();
    else if (action === 'resume' || action === 'retry') collector.resume();
    else return res.status(400).json({ error: `Unknown action ${action}` });
    res.json(publicCollectorState(collector.state));
  });

  return r;
}
