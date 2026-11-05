import { Router } from 'express';
import { list as listParam, sendError } from '../params.js';

/** The Messages tab. Writes go through the CSRF guard like every other non-GET. */
export function smsRoutes({ sms }) {
  const r = Router();
  if (!sms) return r;

  r.get('/sms', async (_req, res) => {
    try {
      res.json(await sms.list());
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post('/sms', async (req, res) => {
    try {
      const { to, text } = req.body ?? {};
      res.json(await sms.send(String(to ?? ''), String(text ?? '')));
    } catch (e) {
      sendError(res, e);
    }
  });

  // Your own number for the page heading. Saved in Insight's database, never on the router.
  r.get('/sms/own-number', async (_req, res) => {
    try {
      res.json(await sms.ownNumber());
    } catch (e) {
      sendError(res, e);
    }
  });

  r.put('/sms/own-number', async (req, res) => {
    try {
      res.json(await sms.setOwnNumber(req.body?.number ?? ''));
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post('/sms/:id/read', async (req, res) => {
    try {
      await sms.markRead(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.delete('/sms', async (req, res) => {
    try {
      await sms.remove((listParam(req.query.ids) ?? []).map(Number));
      res.json({ ok: true });
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}
