// Placement: score router positions from live signal. Capturing a spot takes the collector's
// readings over a short window (signal fluctuates second to second) and stores their medians,
// so spots are compared on settled numbers rather than a lucky moment.
import { capacityIndex, median, placementScore, weightedSinr } from '@zyxel-insight/shared/speed';

export const CAPTURE = { defaultSec: 20, minSec: 10, maxSec: 60, pollMs: 1000, boostMarginMs: 15_000 };
const MIN_READINGS = 3;
const NAME_MAX = 60;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** The spot's numbers from several router reads (collector.state.router snapshots). Pure. */
export function summariseReadings(readings) {
  const carriers = readings.map((r) => r?.carriers?.carriers ?? []);
  const combos = new Map();
  for (const r of readings) {
    const c = r?.carriers?.combo;
    if (c) combos.set(c, (combos.get(c) ?? 0) + 1);
  }
  return {
    samples: readings.length,
    score: round1(median(carriers.map(placementScore))),
    capacity: round1(median(carriers.map(capacityIndex))),
    sinr: round1(median(carriers.map(weightedSinr))),
    lteRsrp: round1(median(readings.map((r) => r?.signal?.lte?.rsrp))),
    nrRsrp: round1(median(readings.map((r) => r?.signal?.nr?.rsrp))),
    // The combination seen most during the capture.
    combo: [...combos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    // The network at the end: a spot is only comparable with spots on the same one.
    plmn: readings.at(-1)?.signal?.plmn ?? null,
  };
}

export function createPlacement({ db, collector, now = Date.now, sleep = realSleep, capture = CAPTURE }) {
  let capturing = null; // { name, until }

  return {
    get state() {
      return { capturing };
    },

    /** Faster signal reads while the Placement page is open; the page renews this. */
    boost(seconds) {
      const s = Number(seconds);
      if (!Number.isFinite(s) || s <= 0 || s > 300) throw fail('seconds must be 1 to 300.');
      if (typeof collector.boost !== 'function') throw fail('Live boost is not available.', 404);
      return { remainingMs: collector.boost(s * 1000) };
    },

    /** Measure the router where it is now for `seconds` and save it as `name`. Resolves the stored spot. */
    async capture({ name, seconds = capture.defaultSec } = {}) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX)
        throw fail(`Name the spot (1 to ${NAME_MAX} characters).`);
      if (!Number.isInteger(seconds) || seconds < capture.minSec || seconds > capture.maxSec)
        throw fail(`Capture for ${capture.minSec} to ${capture.maxSec} seconds.`);
      if (capturing) throw fail('Another spot is being captured.', 409);
      if (collector.state.phase !== 'ok') throw fail("The router isn't being read right now.", 409);
      capturing = { name: name.trim(), until: now() + seconds * 1000 };
      try {
        collector.boost?.(seconds * 1000 + capture.boostMarginMs);
        // One reading per router read: a repeated snapshot would weigh that moment twice.
        const readings = [];
        let lastAt = null;
        const end = now() + seconds * 1000;
        while (now() < end) {
          const r = collector.state.router;
          if (r?.fetchedAt != null && r.fetchedAt !== lastAt) {
            lastAt = r.fetchedAt;
            readings.push(r);
          }
          await sleep(capture.pollMs);
        }
        if (readings.length < MIN_READINGS) throw fail('Too few signal readings arrived; check the router connection and try again.', 409);
        const spot = { ts: now(), name: capturing.name, ...summariseReadings(readings) };
        spot.id = db.insertSpot(spot);
        return spot;
      } finally {
        capturing = null;
      }
    },

    /** Saved spots on `plmn` (and any saved before spots recorded their network), plus how many are on others. */
    spots(plmn = null) {
      const all = db.spots();
      const mine = plmn ? all.filter((s) => !s.plmn || s.plmn === plmn) : all;
      return { spots: mine, otherNetworks: all.length - mine.length };
    },

    remove(id) {
      if (!Number.isInteger(id) || id < 1) throw fail('Invalid spot.');
      if (!db.deleteSpot(id)) throw fail('Spot not found.', 404);
      return { deleted: id };
    },
  };
}
