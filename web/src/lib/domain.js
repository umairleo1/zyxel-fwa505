// UI vocabulary for the router's data: labels, chart series and time ranges.
// Re-exports the shared domain rules so components import from one place.
export { rsrpBars, rsrpQuality, sinrQuality, wifiQuality, qualityTone } from '@zyxel-insight/shared/quality';
export { LEVELS, levelGroup } from '@zyxel-insight/shared/severity';

export const SOURCE_LABELS = {
  'router-system': 'System',
  'router-security': 'Security',
  syslog: 'Syslog',
  snmp: 'SNMP trap',
  insight: 'Insight',
};

/** Severity groups used by the volume chart and badges, in stack order (bottom first). */
export const SEVERITY_SERIES = [
  { key: 'err', label: 'Errors', color: 'var(--sev-err)' },
  { key: 'warning', label: 'Warnings', color: 'var(--sev-warn)' },
  { key: 'notice', label: 'Notice', color: 'var(--sev-notice)' },
  { key: 'info', label: 'Info', color: 'var(--sev-info)' },
];

/** Chart series with fixed colours, so an entity keeps its colour on every page. */
export const SERIES = {
  lte: { key: 'lte', label: 'LTE', color: 'var(--series-1)' },
  nr: { key: 'nr', label: '5G NR', color: 'var(--series-2)' },
  download: { key: 'rx', label: 'Download', color: 'var(--series-1)' },
  upload: { key: 'tx', label: 'Upload', color: 'var(--series-3)' },
  cpu: { key: 'cpu', label: 'CPU', color: 'var(--series-1)' },
  memory: { key: 'mem', label: 'Memory', color: 'var(--series-3)' },
  rssi: { key: 'rssi', label: 'RSSI', color: 'var(--series-1)' },
  rttAvg: { key: 'rttAvg', label: 'Average', color: 'var(--series-1)' },
  rttMax: { key: 'rttMax', label: 'Peak', color: 'var(--series-2)' },
  failedPct: { key: 'failedPct', label: 'Failed checks', color: 'var(--stall)' },
};

/** Time-range presets. `key` is used in the URL, `ms` by pages with their own picker. */
export const RANGES = [
  { key: '1h', label: '1h', ms: 3600e3 },
  { key: '6h', label: '6h', ms: 6 * 3600e3 },
  { key: '24h', label: '24h', ms: 86400e3 },
  { key: '7d', label: '7d', ms: 7 * 86400e3 },
  { key: '30d', label: '30d', ms: 30 * 86400e3 },
];
/** Segmented-control options for the given preset keys (all by default). */
export const rangeOptions = (keys = RANGES.map((r) => r.key)) =>
  RANGES.filter((r) => keys.includes(r.key)).map((r) => ({ value: r.ms, label: r.label }));

/** Frequency of each band the FWA505 supports, for labels. TDD/SDL marked where it matters. */
export const BAND_FREQ = {
  B1: '2100 MHz',
  B3: '1800 MHz',
  B5: '850 MHz',
  B7: '2600 MHz',
  B8: '900 MHz',
  B20: '800 MHz',
  B28: '700 MHz',
  B32: '1500 MHz SDL',
  B38: '2600 MHz TDD',
  B40: '2300 MHz TDD',
  B41: '2500 MHz TDD',
  B42: '3500 MHz TDD',
  B43: '3700 MHz TDD',
  n1: '2100 MHz',
  n3: '1800 MHz',
  n5: '850 MHz',
  n7: '2600 MHz',
  n8: '900 MHz',
  n20: '800 MHz',
  n28: '700 MHz',
  n38: '2600 MHz TDD',
  n40: '2300 MHz TDD',
  n41: '2500 MHz TDD',
  n77: '3.3–4.2 GHz TDD',
  n78: '3.3–3.8 GHz TDD',
};
