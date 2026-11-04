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
export function createStatus({ config, collector, syslog, snmp, client }) {
  return () => ({
    routerUrl: config.routerUrl,
    lanIp: lanIp(config.routerUrl),
    pollIntervalSec: config.pollIntervalSec,
    statusIntervalSec: config.statusIntervalSec,
    collector: publicCollectorState(collector.state),
    syslog: syslog.state,
    snmp: snmp.state,
    routerLoad: client.loadSnapshot(),
  });
}
