import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { logsRoutes } from './routes/logs.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { routerDataRoutes } from './routes/routerData.js';
import { insightsRoutes } from './routes/insights.js';
import { liveRoutes } from './routes/live.js';
import { smsRoutes } from './routes/sms.js';
import { radioRoutes } from './routes/radio.js';
import { rebootRoutes } from './routes/reboot.js';
import { controlRoutes } from './routes/control.js';
import { basicAuth, csrfGuard, hostGuard, isLoopback, liveAllowedHostnames, securityHeaders } from './security.js';

/**
 * Build the Express app. deps: { db, hub, collector, internet?, routerData, statusPayload, staticDir?,
 * statusIntervalSec?, security?: { password?, allowedHosts?: Set<string> | () => Set<string> } }
 */
export function createApp(deps) {
  const { password = '', allowedHosts = liveAllowedHostnames() } = deps.security ?? {};
  const app = express();
  app.disable('x-powered-by');

  // Order matters: headers (so refusals carry them too), then the Host check
  // (anti DNS-rebinding) before any route, static file or SSE, then auth and CSRF.
  app.use(securityHeaders);
  app.use(hostGuard(allowedHosts));
  app.use(
    basicAuth({
      password,
      // systemd/monitoring on this machine may probe health without the password.
      exempt: (req) => req.method === 'GET' && req.path === '/api/health' && isLoopback(req.socket.remoteAddress),
    }),
  );
  app.use(csrfGuard);
  app.use(express.json({ limit: '16kb' }));

  const api = express.Router();
  // Settings changes and radio trials must not race maintenance or diagnostics.
  api.use((req, res, next) => {
    const held = deps.collector.state.maintenance;
    const conflicting = /^\/(sms|radio|collector)(\/|$)|^\/router\/reboot$/.test(req.path);
    if (conflicting && (held || (deps.control?.busy && req.method !== 'GET'))) {
      return res.status(409).json({ error: 'A High control operation is running; wait for it to finish' });
    }
    next();
  });
  api.use(controlRoutes(deps));
  api.use(logsRoutes(deps));
  api.use(telemetryRoutes(deps));
  api.use(routerDataRoutes(deps));
  api.use(insightsRoutes(deps));
  api.use(liveRoutes(deps));
  api.use(smsRoutes(deps));
  api.use(radioRoutes(deps));
  api.use(rebootRoutes(deps));
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // Serve the built frontend if present (npm run build), with SPA fallback.
  if (deps.staticDir && fs.existsSync(deps.staticDir)) {
    app.use(express.static(deps.staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(deps.staticDir, 'index.html')));
  }
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const tooLarge = error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : (error.status ?? 500)).json({
      error: tooLarge
        ? 'The file or request exceeds the allowed size.'
        : error.type === 'entity.parse.failed'
          ? 'Invalid JSON request.'
          : 'The request could not be processed.',
    });
  });
  return app;
}
