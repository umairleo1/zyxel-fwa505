// Signal-quality scales used by both the server (statistics, advice) and the UI
// (badges, bars), so the two can never disagree.

/**
 * LTE/NR RSRP on the router's own 5-bar scale, taken from its web UI
 * (`cellwanRefSignal()`): > -95, > -100, > -106, > -112, > -126 dBm.
 */
export function rsrpBars(dbm) {
  if (dbm == null || dbm > -20) return 0;
  if (dbm > -95) return 5;
  if (dbm > -100) return 4;
  if (dbm > -106) return 3;
  if (dbm > -112) return 2;
  if (dbm > -126) return 1;
  return 0;
}

const BAR_LABELS = ['No signal', 'Very poor', 'Poor', 'Fair', 'Good', 'Excellent'];
export const rsrpQuality = (dbm) => (dbm == null ? null : BAR_LABELS[rsrpBars(dbm)]);

/** SINR: the router has no rating, so use standard LTE/NR guidance. */
export function sinrQuality(db) {
  if (db == null) return null;
  if (db >= 20) return 'Excellent';
  if (db >= 13) return 'Good';
  if (db >= 0) return 'Fair';
  return 'Poor';
}

/** Wi-Fi client RSSI. */
export function wifiQuality(dbm) {
  if (dbm == null) return null;
  if (dbm >= -55) return 'Excellent';
  if (dbm >= -65) return 'Good';
  if (dbm >= -72) return 'Fair';
  return 'Poor';
}

/** Map any quality word to a status tone. */
export function qualityTone(label) {
  if (label === 'Excellent' || label === 'Good') return 'good';
  if (label === 'Fair') return 'warning';
  if (label == null) return 'neutral';
  return 'critical';
}

/**
 * Lower bounds (inclusive, integer dB) of excellent / good / fair, for SQL
 * bucketing. Derived from the functions above so there is one source of truth.
 */
export const RSRP_CUTS = [-94, -99, -105];
export const SINR_CUTS = [20, 13, 0];
