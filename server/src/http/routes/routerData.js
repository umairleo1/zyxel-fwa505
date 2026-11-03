import { Router } from 'express';
import { list, sendError } from '../params.js';

/** Read-only router endpoints (allowlisted, secrets masked). `?fresh=1` bypasses the cache. */
export function routerDataRoutes({ routerData }) {
  const r = Router();
  const maxAge = (req) => (req.query.fresh ? 0 : undefined);

  r.get('/router', async (req, res) => {
    const out = {};
    for (const id of list(req.query.ids) ?? []) {
      try {
        out[id] = await routerData.public(id, maxAge(req));
      } catch (e) {
        out[id] = { id, error: e.message, status: e.status ?? 502 };
      }
    }
    res.json(out);
  });

  r.get('/router/:id', async (req, res) => {
    try {
      res.json(await routerData.public(req.params.id, maxAge(req)));
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}
