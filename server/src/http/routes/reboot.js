import { Router } from 'express';
import { sendError } from '../params.js';

/** Restart the router (System page). A POST, so it goes through the CSRF guard like every other write. */
export function rebootRoutes({ reboot }) {
  const r = Router();
  if (!reboot) return r;

  r.post('/router/reboot', async (_req, res) => {
    try {
      res.json(await reboot.reboot());
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}
