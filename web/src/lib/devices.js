// Matching a device's connect/disconnect events in the log.
//
// Device events now always carry the MAC ("… (aa:bb:cc:dd:ee:ff) connected"), which
// is exact and survives renames. Events stored before that carry only the name. So the
// drawer searches for both and keeps an event if it names this device's MAC, or has
// no MAC at all and contains the name as a whole word ("Mac" ≠ "MacBook").

const MACS = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a log message is about `device` ({ mac, name }). */
export function isDeviceEvent(message, device) {
  const macs = (String(message).match(MACS) ?? []).map((m) => m.toLowerCase());
  if (macs.length) return macs.includes(device.mac.toLowerCase());
  if (!device.name) return false;
  return new RegExp(`(?<!\\w)${escapeRe(device.name)}(?!\\w)`, 'i').test(message);
}

/** Merge the MAC- and name-search results: this device's events only, newest first, no duplicates. */
export function deviceEvents(results, device, limit = 20) {
  const byId = new Map();
  for (const r of results) for (const e of r?.items ?? []) if (isDeviceEvent(e.message, device)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.ts - a.ts || b.id - a.id).slice(0, limit);
}
