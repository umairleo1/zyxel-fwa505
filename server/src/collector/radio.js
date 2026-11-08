import { findKey, scalars } from '../lib/util.js';
import { summarizeCarriers } from './carriers.js';
import { reading } from '../lib/readings.js';

/**
 * The serving network from the router's "network in use" text, e.g. "Current_EE_NR5G-NSA_23430"
 * → { operator: 'EE', plmn: '23430' }. The PLMN (MCC + MNC) identifies the network; the name is
 * for display. Pure; nulls when the text doesn't match.
 */
export function parseNetworkInUse(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return { operator: null, plmn: null };
  return {
    operator: /^Current_(.+?)_[A-Z0-9-]+_\d+$/.exec(s)?.[1] ?? s,
    plmn: /_(\d{5,6})$/.exec(s)?.[1] ?? null,
  };
}

/** Headline radio metrics from the router's CellIntfInfo / CellIntfZyNrNsaInfo objects. */
export function summarizeSignal(cell, nr) {
  if (!cell) return null;
  const { operator, plmn } = parseNetworkInUse(cell.NetworkInUse);
  const nrActive = nr && nr.Enable !== false && reading('rsrp', nr.RSRP) !== null && Number(nr.RSRP) !== 0;
  return {
    status: cell.Status ?? null,
    tech: cell.CurrentAccessTechnology ?? null,
    operator,
    plmn,
    lte: {
      band: cell.X_ZYXEL_CurrentBand ?? null,
      cellId: cell.X_ZYXEL_CellID ?? null,
      pci: cell.X_ZYXEL_PhyCellID ?? null,
      bandwidth: cell.X_ZYXEL_DownlinkBandwidth ?? null,
      rsrp: reading('rsrp', cell.X_ZYXEL_RSRP),
      rsrq: reading('rsrq', cell.X_ZYXEL_RSRQ),
      sinr: reading('sinr', cell.X_ZYXEL_SINR),
      rssi: reading('rssi', cell.RSSI),
    },
    nr: nrActive
      ? {
          band: nr.Band ?? null,
          pci: nr.PhyCellID ?? null,
          bandwidth: nr.DownlinkBandwidth ?? null,
          rsrp: reading('rsrp', nr.RSRP),
          rsrq: reading('rsrq', nr.RSRQ),
          sinr: reading('sinr', nr.SINR),
          rssi: reading('rssi', nr.RSSI),
        }
      : null,
  };
}

/**
 * Combine the slow `status` object (every minute) with the live `cellwan_status`
 * object (every poll) into one radio picture. Pure: no I/O, no state.
 */
export function interpretRadio(statusData, cellwan) {
  const cell = scalars(findKey(statusData, 'CellIntfInfo'));
  const nr = scalars(findKey(statusData, 'CellIntfZyNrNsaInfo'));
  const signal = summarizeSignal(cell, nr);
  const carriers = summarizeCarriers({ cell, nr, cellwan });
  const pcc = carriers.carriers.find((c) => c.role === 'primary');
  const nrLeg = carriers.carriers.find((c) => c.role === 'nr-anchor');

  if (signal) {
    // The live cellwan readings win over the minute-old status object.
    if (pcc)
      Object.assign(signal.lte, { band: pcc.band ?? signal.lte.band, rsrp: pcc.rsrp, rsrq: pcc.rsrq, sinr: pcc.sinr, rssi: pcc.rssi });
    signal.nr = nrLeg
      ? {
          band: nrLeg.band,
          pci: nrLeg.pci,
          bandwidth: nrLeg.bandwidth ? `${nrLeg.bandwidth}M` : null,
          rsrp: nrLeg.rsrp,
          rsrq: nrLeg.rsrq,
          sinr: nrLeg.sinr,
          rssi: nrLeg.rssi,
        }
      : null;
    if (cellwan?.INTF_Current_Access_Technology) signal.tech = cellwan.INTF_Current_Access_Technology;
    // The live object names the network too: a SIM swap shows on the next read, not a minute later.
    const live = parseNetworkInUse(cellwan?.INTF_Network_In_Use);
    if (live.plmn) Object.assign(signal, live);
  }

  // Serving cell identity (LTE anchor); a change is a handover.
  const cellId = cellwan?.INTF_Cell_ID ?? cell?.X_ZYXEL_CellID ?? null;
  const servingCell =
    cellId == null ? null : { key: `${cellId}/${pcc?.pci ?? '?'}`, label: `${cellId} (PCI ${pcc?.pci ?? '?'}, ${pcc?.band ?? '?'})` };

  return { cell, nr, signal, carriers, servingCell };
}
