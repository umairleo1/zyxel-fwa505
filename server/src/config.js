import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Relative paths in .env are relative to the project root, wherever the server is started from.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const csv = (v) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  routerUrl: (env.ROUTER_URL || 'https://192.168.1.1').replace(/\/+$/, ''),
  routerUser: env.ROUTER_USER || 'admin',
  routerPassword: env.ROUTER_PASSWORD || '',
  pollIntervalSec: num(env.POLL_INTERVAL_SEC, 120),
  statusIntervalSec: num(env.STATUS_INTERVAL_SEC, 5),
  syslogPort: num(env.SYSLOG_PORT, 5514),
  syslogHost: env.SYSLOG_HOST || '0.0.0.0',
  snmpTrapPort: num(env.SNMP_TRAP_PORT, 1162),
  snmpTrapHost: env.SNMP_TRAP_HOST || '0.0.0.0',
  snmpCommunity: env.SNMP_COMMUNITY || '', // empty = accept any community
  // Comma-separated IPs/hostnames allowed to send syslog and SNMP traps. Empty =
  // the router's own address (from ROUTER_URL); loopback is always allowed; "*" = anyone.
  ingestAllowedSources: csv(env.INGEST_ALLOWED_SOURCES),
  httpHost: env.HOST || '127.0.0.1',
  httpPort: num(env.PORT, 4400),
  // HTTP Basic password for the dashboard (any username). Required when HOST is not loopback.
  dashboardPassword: env.DASHBOARD_PASSWORD || '',
  // Extra names the dashboard may be reached by (reverse proxy, DNS name), on top of
  // localhost, this machine's addresses and hostname.
  allowedHosts: csv(env.ALLOWED_HOSTS),
  backupKeep: num(env.BACKUP_KEEP, 4), // database copies kept; 0 disables backups
  // A backup copies the whole database (~100-300 MB at full retention): weekly keeps SD-card wear low.
  backupEveryDays: num(env.BACKUP_EVERY_DAYS, 7),
  retention: {
    logsDays: num(env.RETAIN_LOGS_DAYS, 180),
    metricsDays: num(env.RETAIN_SIGNAL_DAYS, 90), // 5 s samples: ~17k rows/day
    stationDays: num(env.RETAIN_WIFI_DAYS, 30),
    systemDays: 365,
    trafficDays: 400,
  },
  dbPath: path.resolve(ROOT, env.DB_PATH || 'server/data/insight.db'),
};
