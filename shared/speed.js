// Speed and placement maths shared by the server (diagnosis, optimiser) and the UI (badges,
// placement score), so the two can never disagree. Pure: no I/O, no state.

/** Middle value; the mean of the middle two for an even count. Null for no numbers. */
export function median(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Spectral efficiency from SINR, as 3GPP TR 36.942 models a real link: Shannon's limit scaled
// by an implementation factor, nothing below the lowest usable SINR, and capped at the best
// modulation (256-QAM at the top code rate, about 7.4 bit/s/Hz per MIMO layer).
const SE_FACTOR = 0.75;
const SE_MAX = 7.4;
const SINR_MIN_DB = -10;

/** Bits per second per hertz one MIMO layer can carry at `sinrDb`. */
export function spectralEfficiency(sinrDb) {
  if (sinrDb == null || !Number.isFinite(sinrDb) || sinrDb < SINR_MIN_DB) return 0;
  return Math.min(SE_MAX, SE_FACTOR * Math.log2(1 + 10 ** (sinrDb / 10)));
}

/** Carriers that measured both bandwidth and SINR: the rest can't be scored. */
const scorable = (carriers) => (carriers ?? []).filter((c) => c?.bandwidth > 0 && c.sinr != null && Number.isFinite(c.sinr));

/**
 * What the carriers in use could carry per MIMO layer, in Mbps: bandwidth × efficiency, summed.
 * An estimate for comparing spots and setups, not a speed you'll see: the network shares the
 * cell with other users, and MIMO layers multiply it.
 */
export function capacityIndex(carriers) {
  const cs = scorable(carriers);
  if (!cs.length) return null;
  return Math.round(cs.reduce((sum, c) => sum + c.bandwidth * spectralEfficiency(c.sinr), 0));
}

/** SINR averaged over the carriers in use, each weighted by its bandwidth (a 40 MHz carrier counts double a 20). */
export function weightedSinr(carriers) {
  const cs = scorable(carriers);
  if (!cs.length) return null;
  const bw = cs.reduce((s, c) => s + c.bandwidth, 0);
  return Math.round((cs.reduce((s, c) => s + c.sinr * c.bandwidth, 0) / bw) * 10) / 10;
}

/**
 * 0–100 placement score from the bandwidth-weighted SINR: −5 dB scores 0, 25 dB scores 100.
 * SINR rather than strength because on a fixed router it's what sets the speed; capacityIndex
 * adds the bandwidth (more carriers) when comparing spots.
 */
export function placementScore(carriers) {
  const sinr = weightedSinr(carriers);
  if (sinr == null) return null;
  return Math.round(Math.min(100, Math.max(0, ((sinr + 5) / 30) * 100)));
}

/**
 * Bufferbloat grade from how much latency rises under load, on the scale common speed tests
 * use (Waveform's): under 5 ms A+, 30 A, 60 B, 200 C, 400 D, above F.
 */
export function bufferbloatGrade(idleMs, loadedMs) {
  if (idleMs == null || loadedMs == null) return null;
  const added = Math.max(0, loadedMs - idleMs);
  if (added < 5) return 'A+';
  if (added < 30) return 'A';
  if (added < 60) return 'B';
  if (added < 200) return 'C';
  if (added < 400) return 'D';
  return 'F';
}

/** Latency added under load: the worse of the download and upload phases. Null if neither was measured. */
export function addedLatency({ idleMs, loadedDownMs, loadedUpMs }) {
  const loaded = [loadedDownMs, loadedUpMs].filter((v) => v != null);
  if (idleMs == null || !loaded.length) return null;
  return Math.max(0, Math.max(...loaded) - idleMs);
}
