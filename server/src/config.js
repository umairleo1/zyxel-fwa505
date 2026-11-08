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
  // Internet check: a TCP handshake to the first target every interval (others only when
  // it fails). ~250 bytes per round, so 1 s costs ~0.7 GB of mobile data a month. 0 disables.
  internetProbeIntervalSec: num(env.INTERNET_PROBE_INTERVAL_SEC, 1),
  internetProbeTimeoutMs: num(env.INTERNET_PROBE_TIMEOUT_MS, 1500),
  internetProbeTargets: csv(env.INTERNET_PROBE_TARGETS || '1.1.1.1:443,8.8.8.8:443'),
  syslogPort: num(env.SYSLOG_PORT, 5514),
  syslogHost: env.SYSLOG_HOST || '0.0.0.0',
  snmpTrapPort: num(env.SNMP_TRAP_PORT, 1162),
  snmpTrapHost: env.SNMP_TRAP_HOST || '0.0.0.0',
  // Z-console redirects kernel/console output over TCP, separately from UDP syslog.
  zconsolePort: num(env.ZCONSOLE_PORT, 5515), // 0 disables the receiver
  zconsoleHost: env.ZCONSOLE_HOST || '0.0.0.0',
  snmpCommunity: env.SNMP_COMMUNITY || '', // empty = accept any community
  // Comma-separated IPs/hostnames allowed to send syslog and SNMP traps. Empty =
  // the router's own address (from ROUTER_URL); loopback is always allowed; "*" = anyone.
  ingestAllowedSources: csv(env.INGEST_ALLOWED_SOURCES),
  httpHost: env.HOST || '127.0.0.1',
  httpPort: num(env.PORT, 4400),
  // HTTP Basic password for the dashboard (any username). Required when HOST is not loopback.
  dashboardPassword: env.DASHBOARD_PASSWORD || '',
  // The Messages tab reads, sends and deletes SMS on the router's SIM: the one place
  // Insight writes to the router. SMS_ENABLED=false makes Insight fully read-only again.
  smsEnabled: !/^(0|false|no|off)$/i.test(env.SMS_ENABLED ?? ''),
  // The Radio page changes the router's preferred network mode and bands (cellwan_band),
  // always as a trial that reverts unless kept. RADIO_CONTROL_ENABLED=false turns it off.
  radioControlEnabled: !/^(0|false|no|off)$/i.test(env.RADIO_CONTROL_ENABLED ?? ''),
  // The System page can restart the router, as its own Maintenance → Reboot does.
  // REBOOT_ENABLED=false removes the button and the router path.
  rebootEnabled: !/^(0|false|no|off)$/i.test(env.REBOOT_ENABLED ?? ''),
  controlEnabled: !/^(0|false|no|off)$/i.test(env.HIGH_CONTROL_ENABLED ?? ''),
  // Speed tests run from this machine through the router (see speed/measure.js), so they work
  // with any router account and during band trials. They use mobile data only when run: by
  // hand, by the optimiser, or every SPEEDTEST_EVERY_HOURS (0 = no schedule).
  speedtestEnabled: !/^(0|false|no|off)$/i.test(env.SPEEDTEST_ENABLED ?? ''),
  speedtest: {
    downUrl: env.SPEEDTEST_DOWN_URL || 'https://speed.cloudflare.com/__down?bytes={bytes}',
    upUrl: env.SPEEDTEST_UP_URL || 'https://speed.cloudflare.com/__up',
    // Latency is a TCP handshake time, like the internet check; empty = its first target.
    latencyTarget: env.SPEEDTEST_LATENCY_TARGET || '',
    downSec: num(env.SPEEDTEST_DOWNLOAD_SEC, 8),
    upSec: num(env.SPEEDTEST_UPLOAD_SEC, 6),
    streams: num(env.SPEEDTEST_STREAMS, 4),
    maxMb: num(env.SPEEDTEST_MAX_MB, 300), // per test: the transfer stops early at this much data
    everyHours: num(env.SPEEDTEST_EVERY_HOURS, 0),
    // A scheduled test waits while other traffic is above this, so it measures the line, not a share of it.
    busyMbps: num(env.SPEEDTEST_BUSY_MBPS, 5),
  },
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
    internetDays: num(env.RETAIN_INTERNET_DAYS, 90), // one row a minute
    speedDays: num(env.RETAIN_SPEED_DAYS, 400), // a few rows a day at most
  },
  dbPath: path.resolve(ROOT, env.DB_PATH || 'server/data/insight.db'),
};
