// Speed tests: one at a time, each stored with the radio state it ran under (band combination,
// cell, signal), so results can be compared later by setup, signal and hour. Optionally on a
// schedule, which skips moments that would give a misleading number: the line busy with other
// traffic, the router not being read, the internet stalled, or a band trial in progress.
import { capacityIndex } from '@zyxel-insight/shared/speed';
import { runSpeedTest } from './measure.js';

const CHECK_MS = 60_000; // how often the schedule looks whether a test is due
const BUSY_RETRY_MS = 10 * 60_000; // a skipped scheduled test is tried again this much later
const FIRST_DELAY_MS = 5 * 60_000; // after Insight starts, before an overdue scheduled test
const JITTER = 0.1; // ±10 % on the interval, so tests drift across the hours of the day

const conflict = (message) => Object.assign(new Error(message), { status: 409, kind: 'busy' });

/** Radio state at the start of a test, from the collector's latest read. Pure. */
export function radioContext(router) {
  const s = router?.signal;
  const cw = router?.cellwan;
  const carriers = router?.carriers?.carriers ?? [];
  return {
    tech: s?.tech ?? null,
    combo: router?.carriers?.combo ?? null,
    cell: cw?.INTF_Cell_ID != null ? `${cw.INTF_Cell_ID}/${cw.INTF_PhyCell_ID ?? '?'}` : null,
    lteRsrp: s?.lte?.rsrp ?? null,
    lteSinr: s?.lte?.sinr ?? null,
    nrRsrp: s?.nr?.rsrp ?? null,
    nrSinr: s?.nr?.sinr ?? null,
    capacity: capacityIndex(carriers),
    plmn: s?.plmn ?? null, // results are compared within one network, like band history
  };
}

/**
 * Throughput on the WAN over the last couple of traffic samples, in Mbps (the busier
 * direction), or null when there aren't two recent samples. Pure over the rows.
 */
export function recentWanMbps(rows) {
  if (rows.length < 2) return null;
  const [a, b] = rows.slice(-2);
  const sec = (b.ts - a.ts) / 1000;
  if (sec <= 0) return null;
  const rx = Math.max(0, b.wan_rx - a.wan_rx);
  const tx = Math.max(0, b.wan_tx - a.wan_tx);
  return Math.round(((Math.max(rx, tx) * 8) / sec / 1e6) * 10) / 10;
}

export function createSpeedService({
  db,
  collector,
  internet = null,
  radio = null,
  options,
  measure = runSpeedTest,
  isBlocked = () => null, // returns a reason while something (the optimiser) owns the radio
  now = Date.now,
  random = Math.random,
  onChange = () => {},
  log = console,
}) {
  const { everyHours = 0, busyMbps = 5, ...testOptions } = options;
  let running = null; // { trigger, startedAt, phase, mbps, latencyMs, controller }
  let nextAt = null;
  let lastSkip = null; // { at, reason }
  let timer = null;

  const intervalMs = () => everyHours * 3600e3 * (1 + (random() * 2 - 1) * JITTER);
  const event = (level, message) => {
    try {
      db.insertMany([{ ts: now(), source: 'insight', facility: 'speed', level, message }]);
    } catch {
      // the log is a record, not a gate
    }
  };

  /** Why a scheduled test shouldn't run now, or null. */
  function skipReason() {
    const c = collector.state;
    if (c.maintenance) return 'a High control operation is running';
    if (c.phase !== 'ok') return "the router isn't being read";
    if (c.router?.wan && !c.router.wan.up) return 'mobile data is down';
    if (internet && ['stalled', 'failing'].includes(internet.state.phase)) return 'the internet check is failing';
    if (radio?.trial) return 'a band trial is in progress';
    const blocked = isBlocked();
    if (blocked) return blocked;
    let busy = null;
    try {
      busy = recentWanMbps(db.traffic(now() - 150_000, now()));
    } catch {
      // no traffic history: nothing to judge by
    }
    if (busy != null && busy > busyMbps) return `the line is busy (${busy} Mbps of other traffic)`;
    return null;
  }

  async function tick() {
    if (!nextAt || now() < nextAt || running) return;
    const reason = skipReason();
    if (reason) {
      lastSkip = { at: now(), reason };
      nextAt = now() + BUSY_RETRY_MS;
      onChange();
      return;
    }
    lastSkip = null;
    nextAt = now() + intervalMs();
    try {
      await service.run({ trigger: 'schedule' });
    } catch (e) {
      if (e.status !== 409) log.warn(`[speed] scheduled test failed: ${e.message}`);
    }
  }

  const service = {
    get state() {
      return {
        running: running && {
          trigger: running.trigger,
          startedAt: running.startedAt,
          phase: running.phase,
          mbps: running.mbps,
          latencyMs: running.latencyMs,
        },
        schedule: { everyHours, nextAt: everyHours > 0 ? nextAt : null, lastSkip },
        maxBytes: testOptions.maxBytes ?? null,
      };
    },

    get running() {
      return !!running;
    },

    start() {
      if (!(everyHours > 0)) return;
      let last = null;
      try {
        last = db.lastSpeedTest('schedule')?.ts ?? null;
      } catch {
        // first run, or no table yet: schedule from now
      }
      nextAt = Math.max(now() + FIRST_DELAY_MS, last ? last + everyHours * 3600e3 : 0);
      timer = setInterval(() => void tick(), CHECK_MS);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      timer = null;
      running?.controller.abort();
    },

    /**
     * Run one test now. trigger: manual | schedule | optimiser. `experimentId`/`arm`/`bandsPref`
     * tag optimiser runs; `signal` cancels it from outside. Resolves the stored row; rejects
     * (status 409) if a test is already running, or with the measurement's error.
     */
    async run({ trigger = 'manual', experimentId = null, arm = null, bandsPref = null, signal = null } = {}) {
      if (running) throw conflict('A speed test is already running.');
      if (trigger === 'manual') {
        const blocked = isBlocked();
        if (blocked) throw conflict(`Wait until ${blocked.replace(/ is running$/, '')} finishes.`);
      }
      const controller = new AbortController();
      running = { trigger, startedAt: now(), phase: 'latency', mbps: null, latencyMs: null, controller };
      onChange();
      const context = radioContext(collector.state.router);
      const base = { ts: now(), trigger, experimentId, arm, bandsPref, ...context };
      try {
        const r = await measure({
          ...testOptions,
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          onProgress: ({ phase, mbps = null, latencyMs = null }) => {
            Object.assign(running, { phase, mbps, latencyMs });
            onChange();
          },
        });
        const row = { ...base, state: 'ok', ...r };
        row.id = db.insertSpeedTest(row);
        event('info', `Speed test (${trigger}): ${r.downMbps ?? '—'} Mbps down, ${r.upMbps ?? '—'} Mbps up, ${r.idleMs ?? '—'} ms idle`);
        return row;
      } catch (e) {
        if (e.name === 'AbortError') throw Object.assign(new Error('Speed test cancelled.'), { status: 409, kind: 'cancelled' });
        const row = { ...base, state: 'failed', error: e.message };
        try {
          row.id = db.insertSpeedTest(row);
        } catch {
          // the failure is still reported to the caller
        }
        event('warning', `Speed test (${trigger}) failed: ${e.message}`);
        throw Object.assign(new Error(e.message), { status: 502, kind: 'speedtest' });
      } finally {
        running = null;
        onChange();
      }
    },

    /** Stop the running test, if any. */
    cancel() {
      running?.controller.abort();
      return service.state;
    },

    /** Public for tests: run the schedule check now. */
    tickForTest: tick,
  };
  return service;
}
