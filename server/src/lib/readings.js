// Radio readings as the modem reports them, minus the values that aren't readings.
import { toNumber } from './util.js';

// What a modem can actually report (3GPP TS 36.133 / 38.133 measurement ranges, with margin).
const RANGES = {
  rsrp: [-156, -31],
  rsrq: [-43, 20],
  sinr: [-23, 40],
  rssi: [-125, 0],
};
// The FWA505's Quectel module reports -128 for every metric when it has no measurement
// (seen as RSRP = RSRQ = SINR = -128 together), and -140 / -32768 in padding rows.
const NO_MEASUREMENT = new Set([-128, -140, -32768]);

/** A radio reading ('rsrp' | 'rsrq' | 'sinr' | 'rssi') as a number, or null when it isn't one. */
export function reading(kind, value) {
  const n = toNumber(value);
  if (n == null || NO_MEASUREMENT.has(n)) return null;
  const [lo, hi] = RANGES[kind];
  return n < lo || n > hi ? null : n;
}

export const READING_RANGES = RANGES;
export const NO_MEASUREMENT_VALUES = [...NO_MEASUREMENT];
