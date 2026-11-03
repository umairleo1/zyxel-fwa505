import { findKey, scalars, toNumber } from '../lib/util.js';
import { summarizeCarriers } from './carriers.js';

/** Headline radio metrics from the router's CellIntfInfo / CellIntfZyNrNsaInfo objects. */
export function summarizeSignal(cell, nr) {
  if (!cell) return null;
  // NetworkInUse looks like "Current_EE_NR5G-NSA_23430"
  const operator = /^Current_(.+?)_[A-Z0-9-]+_\d+$/.exec(cell.NetworkInUse ?? '')?.[1] ?? cell.NetworkInUse ?? null;
  const nrActive = nr && nr.Enable !== false && toNumber(nr.RSRP) !== null && Number(nr.RSRP) !== 0;
  return {
    status: cell.Status ?? null,
    tech: cell.CurrentAccessTechnology ?? null,
    operator,
    plmn: /_(\d{5,6})$/.exec(cell.NetworkInUse ?? '')?.[1] ?? null,
    lte: {
      band: cell.X_ZYXEL_CurrentBand ?? null,
      cellId: cell.X_ZYXEL_CellID ?? null,
      pci: cell.X_ZYXEL_PhyCellID ?? null,
      bandwidth: cell.X_ZYXEL_DownlinkBandwidth ?? null,
      rsrp: toNumber(cell.X_ZYXEL_RSRP),
      rsrq: toNumber(cell.X_ZYXEL_RSRQ),
      sinr: toNumber(cell.X_ZYXEL_SINR),
      rssi: toNumber(cell.RSSI),
    },
    nr: nrActive
      ? {
          band: nr.Band ?? null,
          pci: nr.PhyCellID ?? null,
          bandwidth: nr.DownlinkBandwidth ?? null,
          rsrp: toNumber(nr.RSRP),
          rsrq: toNumber(nr.RSRQ),
          sinr: toNumber(nr.SINR),
          rssi: toNumber(nr.RSSI),
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
  }

  // Serving cell identity (LTE anchor); a change is a handover.
  const cellId = cellwan?.INTF_Cell_ID ?? cell?.X_ZYXEL_CellID ?? null;
  const servingCell =
    cellId == null ? null : { key: `${cellId}/${pcc?.pci ?? '?'}`, label: `${cellId} (PCI ${pcc?.pci ?? '?'}, ${pcc?.band ?? '?'})` };

  return { cell, nr, signal, carriers, servingCell };
}
