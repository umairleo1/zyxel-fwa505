import express, { Router } from 'express';
import { sendError } from '../params.js';

/** Router actions stay behind the app's authentication, host and CSRF guards. */
export function controlRoutes({ control }) {
  const r = Router();
  if (!control) return r;
  const json = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      sendError(res, e);
    }
  };
  r.get(
    '/control',
    json(() => control.snapshot()),
  );
  r.post(
    '/control/refresh',
    json(() => control.refresh()),
  );
  r.post(
    '/control/operation/acknowledge',
    json((req) => control.acknowledge(req.body?.id, req.body?.confirm)),
  );
  r.post(
    '/control/firmware/check',
    json(() => control.firmwareCheck()),
  );
  r.put(
    '/control/firmware/settings',
    json((req) => control.firmwareSettings(req.body?.patch)),
  );
  r.post(
    '/control/firmware/install',
    json((req) => control.firmwareInstall(req.body?.confirm)),
  );
  r.post('/control/backup/:kind', async (req, res) => {
    try {
      const file = await control.backup(req.params.kind);
      const filename = String(file.filename ?? 'router-backup.rom')
        .replace(/[^A-Za-z0-9_. -]/g, '_')
        .slice(0, 128);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.type(file.contentType || 'application/octet-stream').send(file.body);
    } catch (e) {
      sendError(res, e);
    }
  });
  r.post(
    '/control/restore',
    express.raw({ type: 'application/octet-stream', limit: '8mb' }),
    json((req) => {
      let filename;
      try {
        filename = decodeURIComponent(req.get('X-Filename') ?? '');
      } catch {
        throw Object.assign(new Error('Invalid backup filename.'), { status: 400, kind: 'validation' });
      }
      return control.restore(req.body, filename, req.get('X-Confirm'));
    }),
  );
  r.post(
    '/control/romd/:action',
    json((req) => control.romd(req.params.action, req.body?.confirm)),
  );
  r.post(
    '/control/reset/partial',
    json((req) => control.partialReset(req.body?.confirm, req.body?.keep)),
  );
  r.put(
    '/control/zconsole',
    json((req) => control.zconsole(req.body?.patch)),
  );
  r.post(
    '/control/diagnostics',
    json((req) => control.diagnostics(req.body)),
  );
  r.put(
    '/control/wan/:index',
    json((req) => control.wan(req.params.index, req.body?.patch, req.body?.confirm)),
  );
  r.post(
    '/control/wan',
    json((req) => control.createWan(req.body?.patch, req.body?.confirm)),
  );
  r.post(
    '/control/accounts',
    json((req) => control.createAccount(req.body?.account)),
  );
  r.put(
    '/control/accounts/:index',
    json((req) => control.account(req.params.index, req.body?.patch)),
  );
  r.delete(
    '/control/accounts/:index',
    json((req) => control.deleteAccount(req.params.index, req.body?.confirm)),
  );
  r.put(
    '/control/privileges/:index',
    json((req) => control.privileges(req.params.index, req.body?.patch)),
  );
  return r;
}
