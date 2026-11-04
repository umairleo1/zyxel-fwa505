import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { logsRoutes } from './routes/logs.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { routerDataRoutes } from './routes/routerData.js';
import { insightsRoutes } from './routes/insights.js';
import { liveRoutes } from './routes/live.js';
import { basicAuth, csrfGuard, hostGuard, isLoopback, liveAllowedHostnames, securityHeaders } from './security.js';

/**
 * Build the Express app. deps: { db, hub, collector, routerData, statusPayload, staticDir?,
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
  api.use(logsRoutes(deps));
  api.use(telemetryRoutes(deps));
  api.use(routerDataRoutes(deps));
  api.use(insightsRoutes(deps));
  api.use(liveRoutes(deps));
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // Serve the built frontend if present (npm run build), with SPA fallback.
  if (deps.staticDir && fs.existsSync(deps.staticDir)) {
    app.use(express.static(deps.staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(deps.staticDir, 'index.html')));
  }
  return app;
}
