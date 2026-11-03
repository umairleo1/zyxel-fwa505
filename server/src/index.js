// Composition root: build the services, wire them together, start, and shut down cleanly.
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './storage/db.js';
import { RouterClient } from './router/client.js';
import { createRouterData } from './router/data.js';
import { Collector } from './collector/collector.js';
import { startSamplers } from './collector/samplers.js';
import { startSyslog } from './ingest/syslog.js';
import { startSnmpTraps } from './ingest/snmp.js';
import { createEventHub } from './events/hub.js';
import { createStatus } from './status.js';
import { createApp } from './http/app.js';

if (!config.routerPassword) {
  console.error('ROUTER_PASSWORD is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const hub = createEventHub();
const db = openDb(config.dbPath, {
  onLogs: (batch) => hub.logs(batch),
  onMetric: () => hub.broadcast('metrics', { at: Date.now() }),
});
const client = new RouterClient({ baseUrl: config.routerUrl, username: config.routerUser, password: config.routerPassword });
const collector = new Collector({ client, db, pollIntervalSec: config.pollIntervalSec, statusIntervalSec: config.statusIntervalSec });
const routerData = createRouterData({ client, collector });
const syslog = startSyslog({ host: config.syslogHost, port: config.syslogPort, db });
const snmp = startSnmpTraps({
  host: config.snmpTrapHost,
  port: config.snmpTrapPort,
  community: config.snmpCommunity,
  db,
  // A trap means something just changed (reboot, link drop): fetch fresh status and logs now.
  onTrap: () => collector.pollNow(),
});
const samplers = startSamplers({ routerData, db, emit: (what) => hub.broadcast(what, { at: Date.now() }) });
const statusPayload = createStatus({ config, collector, syslog, snmp, client });

// Status changes on every poll and every syslog/trap packet: push at most once per second.
const pushStatus = hub.throttled('status', statusPayload, 1000);
collector.on('change', pushStatus);
hub.onLogs(pushStatus);
collector.start();

// Retention: trim old rows shortly after start, then hourly.
function prune() {
  try {
    const removed = db.prune(config.retention);
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    if (total) console.info(`[db] pruned ${total} old rows`, removed);
  } catch (e) {
    console.error('[db] prune failed', e);
  }
}
setTimeout(prune, 30_000).unref();
setInterval(prune, 3600e3).unref();

const app = createApp({
  db,
  hub,
  collector,
  routerData,
  statusPayload,
  staticDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
});
const server = app.listen(config.httpPort, config.httpHost, (err) => {
  if (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${config.httpPort} is already in use by another program. Set PORT in .env to a free port.`
        : `HTTP server failed: ${err.message}`,
    );
    shutdown(1);
    return;
  }
  console.info(`[http] Zyxel Insight on http://${config.httpHost}:${config.httpPort} (router ${config.routerUrl})`);
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info('Shutting down: logging out of the router');
  hub.close();
  server.close();
  syslog.close();
  snmp.close();
  samplers.stop();
  await collector.stop();
  db.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
