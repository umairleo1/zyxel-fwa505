import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { logsRoutes } from './routes/logs.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { routerDataRoutes } from './routes/routerData.js';
import { insightsRoutes } from './routes/insights.js';
import { liveRoutes } from './routes/live.js';

/** Build the Express app. deps: { db, hub, collector, routerData, statusPayload, staticDir? } */
export function createApp(deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

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
