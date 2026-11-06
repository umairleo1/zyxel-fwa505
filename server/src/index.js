// Composition root: build the services, wire them together, start, and shut down cleanly.
import fs from 'node:fs';
import path from 'node:path';
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
import { isLoopback, liveAllowedHostnames } from './http/security.js';
import { createSourceFilter, defaultSources } from './ingest/guard.js';
import { createSmsService } from './sms/service.js';
import { createRadioService } from './radio/service.js';
import { createRebootService } from './router/reboot.js';
import { findKey } from './lib/util.js';

if (!config.routerPassword) {
  console.error('ROUTER_PASSWORD is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!isLoopback(config.httpHost) && !config.dashboardPassword) {
  console.error(
    `HOST=${config.httpHost} exposes the dashboard (and your router's data) to the network. ` +
      'Set DASHBOARD_PASSWORD in .env, or set HOST=127.0.0.1.',
  );
  process.exit(1);
}

const hub = createEventHub();
const db = openDb(config.dbPath, {
  onLogs: (batch) => hub.logs(batch),
  onMetric: () => hub.broadcast('metrics', { at: Date.now() }),
});
const client = new RouterClient({
  baseUrl: config.routerUrl,
  username: config.routerUser,
  password: config.routerPassword,
  // Trust-on-first-use pin of the router's self-signed certificate, kept across restarts.
  certPin: { get: () => db.getMeta('routerCertSha256'), set: (fp) => db.setMeta('routerCertSha256', fp) },
  allowSms: config.smsEnabled,
  allowBandSelection: config.radioControlEnabled,
  allowReboot: config.rebootEnabled,
});
// collector is created below; isReady only runs once the service is started.
const sms = createSmsService({
  client,
  db,
  enabled: config.smsEnabled,
  // Only while the router is being read and someone has Insight open: no one to show a badge to otherwise.
  isReady: () => collector.state.phase === 'ok' && hub.size > 0,
  // The router has a field for the SIM's own number, but most SIMs leave it empty.
  simNumber: async () => {
    const live = collector.state.router?.cellwan?.USIM_MSISDN;
    if (live) return live;
    const info = await routerData.raw('cardpage_status', 3600e3);
    return findKey(info.data, 'CellIntfSimfInfo')?.MSISDN || null;
  },
  onUnread: () => pushStatus(),
});
const radio = createRadioService({ client, db, enabled: config.radioControlEnabled, onChange: () => pushStatus() });
const collector = new Collector({ client, db, pollIntervalSec: config.pollIntervalSec, statusIntervalSec: config.statusIntervalSec });
const routerData = createRouterData({ client, collector });
const reboot = createRebootService({ client, db, collector, enabled: config.rebootEnabled, onChange: () => pushStatus() });
// Only the router (plus loopback) may feed the log, unless INGEST_ALLOWED_SOURCES says otherwise.
const sources = createSourceFilter(config.ingestAllowedSources.length ? config.ingestAllowedSources : defaultSources(config.routerUrl));
const syslog = startSyslog({ host: config.syslogHost, port: config.syslogPort, db, allows: sources.allows });
const snmp = startSnmpTraps({
  host: config.snmpTrapHost,
  port: config.snmpTrapPort,
  community: config.snmpCommunity,
  db,
  allows: sources.allows,
  // A trap means something just changed (reboot, link drop): fetch fresh status and logs now.
  onTrap: () => collector.pollNow(),
});
const samplers = startSamplers({ routerData, db, emit: (what) => hub.broadcast(what, { at: Date.now() }) });
const statusPayload = createStatus({ config, collector, syslog, snmp, client, sms, radio, reboot });

// Status changes on every poll and every syslog/trap packet: push at most once per second.
const pushStatus = hub.throttled('status', statusPayload, 1000);
collector.on('change', pushStatus);
hub.onLogs(pushStatus);
collector.start();
sms.start();
radio.start();

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

// Backup every BACKUP_EVERY_DAYS: <DB dir>/backups/insight-YYYY-MM-DD.db, newest BACKUP_KEEP
// kept. Checked hourly (and 10 min after start), so a sleeping machine catches up on wake.
const backupDir = path.join(path.dirname(config.dbPath), 'backups');
const BACKUP_NAME = /^insight-\d{4}-\d{2}-\d{2}\.db$/;
/** True when the newest backup is at least BACKUP_EVERY_DAYS calendar days older than `day`. */
function backupDue(day) {
  let newest;
  try {
    newest = fs
      .readdirSync(backupDir)
      .filter((f) => BACKUP_NAME.test(f))
      .sort()
      .at(-1);
  } catch {
    return true; // no backup folder yet
  }
  if (!newest) return true;
  const days = (Date.parse(`${day}T00:00Z`) - Date.parse(`${newest.slice(8, 18)}T00:00Z`)) / 86400e3;
  return Math.round(days) >= config.backupEveryDays;
}

async function backup() {
  if (typeof db.backup !== 'function' || !(config.backupKeep > 0)) return;
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const file = path.join(backupDir, `insight-${day}.db`);
  if (fs.existsSync(file) || !backupDue(day)) return;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    await db.backup(file);
    console.info(`[db] backup written to ${file}`);
  } catch (e) {
    console.error('[db] backup failed', e);
    try {
      fs.rmSync(file, { force: true }); // VACUUM INTO may leave a partial file; retry next hour
    } catch {
      // nothing to clean up
    }
    return;
  }
  try {
    const old = fs
      .readdirSync(backupDir)
      .filter((f) => BACKUP_NAME.test(f))
      .sort()
      .reverse()
      .slice(config.backupKeep);
    for (const f of old) fs.rmSync(path.join(backupDir, f), { force: true });
  } catch (e) {
    console.error('[db] removing old backups failed', e);
  }
}
setTimeout(backup, 10 * 60e3).unref();
setInterval(backup, 3600e3).unref();

const app = createApp({
  db,
  hub,
  collector,
  routerData,
  sms: config.smsEnabled ? sms : null,
  radio: config.radioControlEnabled ? radio : null,
  reboot: config.rebootEnabled ? reboot : null,
  statusPayload,
  statusIntervalSec: config.statusIntervalSec,
  security: {
    password: config.dashboardPassword,
    allowedHosts: liveAllowedHostnames({ httpHost: config.httpHost, extra: config.allowedHosts }),
  },
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
  if (!config.dashboardPassword) console.info('[http] no DASHBOARD_PASSWORD set: anyone on this machine can open the dashboard');
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info('Shutting down: logging out of the router');
  // A hung logout must not keep a broken process alive (systemd restarts us on exit 1).
  setTimeout(() => {
    console.error('Shutdown took longer than 10 s, exiting anyway');
    process.exit(code || 1);
  }, 10_000).unref();
  try {
    hub.close();
    server.close();
    syslog.close();
    snmp.close();
    samplers.stop();
    sms.stop();
    radio.stop();
    await collector.stop();
    db.close();
  } catch (e) {
    console.error('Error during shutdown', e);
    code ||= 1;
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
// Unknown state after an unexpected error: log out cleanly and exit non-zero so the supervisor restarts us.
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandled promise rejection', e);
  shutdown(1);
});
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaught exception', e);
  shutdown(1);
});
