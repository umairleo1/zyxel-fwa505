import { Router } from 'express';
import { sendError } from '../params.js';

/** The Radio page: band selection. Writes go through the CSRF guard like every other non-GET. */
export function radioRoutes({ radio }) {
  const r = Router();
  if (!radio) return r;

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      sendError(res, e);
    }
  };

  r.get(
    '/radio',
    handle(() => radio.get()),
  );
  // { technology, bands: 'Auto' | ['B3', 'n78', ...] }: starts (or changes) a trial.
  r.put(
    '/radio',
    handle((req) => radio.apply(req.body ?? {})),
  );
  r.post(
    '/radio/keep',
    handle(() => radio.keep()),
  );
  r.post(
    '/radio/revert',
    handle(() => radio.revert()),
  );
  r.post(
    '/radio/automatic',
    handle(() => radio.automatic()),
  );

  return r;
}
