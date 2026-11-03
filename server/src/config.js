import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Relative paths in .env are relative to the project root, wherever the server is started from.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

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
  httpHost: env.HOST || '127.0.0.1',
  httpPort: num(env.PORT, 4400),
  retention: {
    logsDays: num(env.RETAIN_LOGS_DAYS, 180),
    metricsDays: num(env.RETAIN_SIGNAL_DAYS, 90), // 5 s samples: ~17k rows/day
    stationDays: num(env.RETAIN_WIFI_DAYS, 30),
    systemDays: 365,
    trafficDays: 400,
  },
  dbPath: path.resolve(ROOT, env.DB_PATH || 'server/data/insight.db'),
};
