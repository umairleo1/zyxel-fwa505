import os from 'node:os';
import { maskSecrets } from './router/secrets.js';

// Hardware/SIM identifiers stay visible: the Cellular and System pages show them on
// purpose, and the dashboard sits behind its own login.
const KEEP_IDENTIFIERS = /imei|imsi|iccid|serial/i;

/** Collector state with the router's scalars (DeviceInfo, cellwan) masked like every other router read. */
export const publicCollectorState = (state) =>
  state.router ? { ...state, router: maskSecrets(state.router, { keep: KEEP_IDENTIFIERS }) } : state;

/** This machine's LAN address, so the UI can show what to enter in the router's syslog/SNMP settings. */
export function lanIp(routerUrl) {
  const routerHost = routerUrl.replace(/^\w+:\/\/([^/:]+).*$/, '$1');
  const prefix = `${routerHost.split('.').slice(0, 3).join('.')}.`;
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal);
  return (addrs.find((a) => a.address.startsWith(prefix)) ?? addrs[0])?.address ?? null;
}

/** Snapshot of everything the UI's health indicators need. */
export function createStatus({
  config,
  collector,
  syslog,
  snmp,
  client,
  sms,
  radio,
  reboot,
  control,
  zconsole,
  internet = null,
  speed = null,
  optimiser = null,
}) {
  return () => ({
    routerUrl: config.routerUrl,
    lanIp: lanIp(config.routerUrl),
    pollIntervalSec: config.pollIntervalSec,
    statusIntervalSec: config.statusIntervalSec,
    smsEnabled: config.smsEnabled,
    // Unread texts on the SIM (null until first checked): the sidebar badge.
    smsUnread: config.smsEnabled ? (sms?.unread ?? null) : null,
    radioEnabled: config.radioControlEnabled,
    // A band selection on trial: { until } (it reverts then unless kept), or null.
    radioTrial: config.radioControlEnabled ? (radio?.trial ?? null) : null,
    rebootEnabled: config.rebootEnabled,
    controlEnabled: config.controlEnabled,
    controlOperation: control?.operation ?? null,
    zconsole: zconsole?.state ?? null,
    // When Insight last asked the router to restart (ms), or null.
    restartRequestedAt: config.rebootEnabled ? (reboot?.lastAt ?? null) : null,
    collector: publicCollectorState(collector.state),
    // Internet check (null when disabled): phase, last round-trip, and the stall in progress if any.
    internet: internet?.state ?? null,
    // Speed test in progress and the schedule (null when SPEEDTEST_ENABLED=false).
    speed: speed?.state ?? null,
    // Optimiser run in progress and the last one (null without band control or speed tests).
    optimiser: optimiser?.state ?? null,
    syslog: syslog.state,
    snmp: snmp.state,
    routerLoad: client.loadSnapshot(),
  });
}
