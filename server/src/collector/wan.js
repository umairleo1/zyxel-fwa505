// Is the mobile data connection up? The router answering Insight on the LAN says
// nothing about the internet behind it, so this is judged separately.
import { findKey, scalars } from '../lib/util.js';
import { reading } from '../lib/readings.js';

const SIM_READY = /RDY|READY/i;
const NO_ADDRESS = new Set(['', '0.0.0.0', '::']);

/** WAN interfaces from the status object's WanLanInfo, or null when the firmware doesn't report it. */
function wanInterfaces(statusData) {
  const list = findKey(statusData, 'WanLanInfo');
  if (!Array.isArray(list)) return null;
  return list.filter((w) => w?.X_ZYXEL_Type === 'WAN' && w.Enable !== false);
}

const hasAddress = (w) =>
  [...(w.IPv4Address ?? []), ...(w.IPv6Address ?? [])].some((a) => a && a.Enable !== false && !NO_ADDRESS.has(String(a.IPAddress ?? '')));

/**
 * Mobile data state from the router's own view, most fundamental cause first:
 * SIM, then the cellular interface and its signal, then a WAN interface with an address. Pure.
 * `cellwan` is the 5 s cellwan_status object (null on firmware without it); the
 * status object refreshes once a minute. Returns { up: true | false | null, reason }.
 */
export function wanStatus(statusData, cellwan) {
  const sim = cellwan?.USIM_Status;
  if (sim && !SIM_READY.test(sim)) return { up: false, reason: `SIM not ready (${sim})` };

  const radio = cellwan?.INTF_Status ?? scalars(findKey(statusData, 'CellIntfInfo'))?.Status ?? null;
  if (radio && radio !== 'Up') return { up: false, reason: `Cellular interface ${radio.toLowerCase()}` };

  // The interface can stay "Up" while the modem has no measurement at all (it reports -128).
  if (cellwan && 'INTF_RSRP' in cellwan && reading('rsrp', cellwan.INTF_RSRP) == null) return { up: false, reason: 'No cellular signal' };

  const wans = wanInterfaces(statusData);
  if (wans) {
    if (wans.some((w) => w.Status === 'Up' && hasAddress(w))) return { up: true, reason: null };
    return { up: false, reason: 'No WAN IP address' };
  }
  return radio ? { up: true, reason: null } : { up: null, reason: null };
}
