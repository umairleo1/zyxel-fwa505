import { Router } from 'express';

/** Status snapshot, Server-Sent Events stream and collector controls. */
export function liveRoutes({ hub, collector, statusPayload }) {
  const r = Router();

  r.get('/status', (_req, res) => res.json(statusPayload()));

  // SSE: status snapshots plus "new logs / metrics / traffic / devices" notifications.
  r.get('/events', (req, res) => hub.subscribe(req, res, { status: statusPayload() }));

  r.post('/collector/:action', async (req, res) => {
    const { action } = req.params;
    if (action === 'pause') await collector.pause();
    else if (action === 'resume' || action === 'retry') collector.resume();
    else return res.status(400).json({ error: `Unknown action ${action}` });
    res.json(collector.state);
  });

  return r;
}
