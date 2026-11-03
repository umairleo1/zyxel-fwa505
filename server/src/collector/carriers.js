// Normalise the router's cellular data into a list of active carriers.
// Field names vary between firmware builds, so match keys by pattern.

import { toNumber as num } from '../lib/util.js';
const pick = (obj, ...patterns) => {
  for (const re of patterns) {
    const k = Object.keys(obj).find((key) => re.test(key));
    if (k !== undefined && obj[k] !== '' && obj[k] != null) return obj[k];
  }
  return null;
};
// "20M", "20 MHz", 20 -> 20
const mhz = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const normBand = (b) => {
  if (b == null || b === '') return null;
  const s = String(b).trim();
  if (/^n/i.test(s)) return `n${s.slice(1)}`;
  if (/^b/i.test(s)) return `B${s.slice(1)}`;
  return /^\d+$/.test(s) ? `B${s}` : s;
};
const ratOf = (band) => (band && band.startsWith('n') ? 'NR' : 'LTE');

function fromScc(item) {
  const band = normBand(pick(item, /^Band$/i, /Band$/i));
  return {
    role: /pcc/i.test(item.CC_Type ?? '') ? 'primary' : 'secondary',
    rat: ratOf(band),
    band,
    bandwidth: mhz(pick(item, /^(DL_?)?Bandwidth$/i, /Downlink_?Bandwidth/i, /DL_?BW/i, /Bandwidth/i)),
    pci: num(pick(item, /Ph(y|ysical)Cell_?ID/i, /^PCI$/i)),
    channel: num(pick(item, /RFCN/i, /^EARFCN$/i, /^ARFCN$/i, /Channel/i)),
    rsrp: num(pick(item, /RSRP/i)),
    rsrq: num(pick(item, /RSRQ/i)),
    sinr: num(pick(item, /SINR/i)),
    rssi: num(pick(item, /RSSI/i)),
  };
}

/**
 * cell: CellIntfInfo (from DAL status), nr: CellIntfZyNrNsaInfo, cellwan: DAL cellwan_status Object[0].
 * Returns carriers ordered primary LTE, LTE secondaries, NR (anchor leg first), plus a combination label.
 */
export function summarizeCarriers({ cell, nr, cellwan }) {
  const carriers = [];
  const cw = cellwan ?? {};

  // LTE primary (PCC)
  const pccBand = normBand(pick(cw, /^INTF_Current_Band$/i, /Current_?Band/i) ?? cell?.X_ZYXEL_CurrentBand);
  if (pccBand || cell) {
    carriers.push({
      role: 'primary',
      rat: ratOf(pccBand),
      band: pccBand,
      bandwidth: mhz(pick(cw, /INTF_.*Downlink_?Bandwidth/i) ?? cell?.X_ZYXEL_DownlinkBandwidth),
      pci: num(pick(cw, /^INTF_PhyCell_ID$/i) ?? cell?.X_ZYXEL_PhyCellID),
      channel: num(pick(cw, /^INTF_.*RFCN$/i) ?? cell?.X_ZYXEL_RFCN),
      rsrp: num(cw.INTF_RSRP ?? cell?.X_ZYXEL_RSRP),
      rsrq: num(cw.INTF_RSRQ ?? cell?.X_ZYXEL_RSRQ),
      sinr: num(cw.INTF_SINR ?? cell?.X_ZYXEL_SINR),
      rssi: num(cw.INTF_RSSI ?? cell?.RSSI),
    });
  }

  // Secondary carriers reported by the module (LTE SCCs and NR SCCs)
  for (const item of Array.isArray(cw.SCC_Info) ? cw.SCC_Info : []) {
    // The module pads the list with placeholder rows (Band "", RSRP -140); skip disabled/empty ones.
    if (!item || typeof item !== 'object' || item.Enable === false) continue;
    const c = fromScc(item);
    if (!c.band || (c.pci !== null && c.pci < 0)) continue;
    // The NR leg can appear in SCC_Info as a PCC; it is covered by the NSA block below.
    if (c.rat === 'NR' && c.role === 'primary') continue;
    carriers.push(c);
  }

  // 5G NSA leg (EN-DC)
  const nsaRsrp = num(cw.NSA_RSRP ?? nr?.RSRP);
  const nsaEnabled = (cw.NSA_Enable ?? nr?.Enable) !== false;
  const nsaBand = normBand(cw.NSA_Band ?? nr?.Band);
  if (nsaEnabled && nsaBand && nsaRsrp !== null && nsaRsrp !== 0) {
    carriers.push({
      role: 'nr-anchor',
      rat: 'NR',
      band: nsaBand,
      bandwidth: mhz(cw.NSA_DownlinkBandwidth ?? nr?.DownlinkBandwidth),
      pci: num(cw.NSA_PhyCellID ?? cw.NSA_PCI ?? nr?.PhyCellID),
      channel: num(cw.NSA_RFCN ?? nr?.RFCN),
      rsrp: nsaRsrp,
      rsrq: num(cw.NSA_RSRQ ?? nr?.RSRQ),
      sinr: num(cw.NSA_SINR ?? nr?.SINR),
      rssi: num(cw.NSA_RSSI ?? nr?.RSSI),
    });
  }

  // LTE before NR; within each, the primary/anchor first (stable sort keeps SCC order).
  const rank = (c) => (c.rat === 'LTE' ? 0 : 2) + (c.role === 'secondary' ? 1 : 0);
  carriers.sort((a, b) => rank(a) - rank(b));
  const lte = carriers.filter((c) => c.rat === 'LTE').map((c) => c.band);
  const nrBands = carriers.filter((c) => c.rat === 'NR').map((c) => c.band);
  const combo = [lte.join('+'), nrBands.join('+')].filter(Boolean).join(' + ');
  const totalBw = carriers.reduce((s, c) => s + (c.bandwidth ?? 0), 0) || null;
  return { carriers, combo: combo || null, totalBandwidth: totalBw, aggregated: carriers.length > 1 };
}
