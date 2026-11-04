import { Router } from 'express';
import { list, sendError } from '../params.js';
import { createFreshGate, MAX_ROUTER_IDS, ROUTER_FRESH_MS } from '../limits.js';

/**
 * Read-only router endpoints (allowlisted, secrets masked). `?fresh=1` bypasses the
 * cache, but at most once per 10 s per endpoint so a refresh loop can't hammer the router.
 */
export function routerDataRoutes({ routerData }) {
  const r = Router();
  const gate = createFreshGate(ROUTER_FRESH_MS);
  // Only known ids reach the gate, so its map stays bounded.
  const maxAge = (req, id) => (req.query.fresh && routerData.has(id) && gate.allow(id) ? 0 : undefined);

  r.get('/router', async (req, res) => {
    const ids = [...new Set(list(req.query.ids) ?? [])];
    if (ids.length > MAX_ROUTER_IDS) return res.status(400).json({ error: `At most ${MAX_ROUTER_IDS} ids per request` });
    const out = {};
    for (const id of ids) {
      try {
        out[id] = await routerData.public(id, maxAge(req, id));
      } catch (e) {
        out[id] = { id, error: e.message, status: e.status ?? 502 };
      }
    }
    res.json(out);
  });

  r.get('/router/:id', async (req, res) => {
    try {
      res.json(await routerData.public(req.params.id, maxAge(req, req.params.id)));
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}
