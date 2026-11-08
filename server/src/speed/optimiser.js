// The optimiser: tries a few band and network-mode setups as radio trials, speed-tests each one
// next to the current setting, and reports whether any of them is consistently faster.
//
// Radio conditions are noisy and change through the day, so a single test proves little. Each
// round tests the current setting (the baseline) and every candidate back to back, and a
// candidate is only compared with the baseline from its own round. The baseline moves between
// first and last place each round to cancel out drift. A candidate wins only if it beats the
// baseline by a clear margin in most rounds without hurting upload or latency. Whatever
// happens (a finish, a cancel, an error), the router ends on the setting it started with.
// Applying a winner is left to the person, as an ordinary Radio control trial.
import { AUTO, TECHNOLOGIES, describeBands, isLte, isNr, selectionError, serialiseBands } from '@zyxel-insight/shared/radio';
import { addedLatency, median } from '@zyxel-insight/shared/speed';
import { MIN_GAP_MS } from '../radio/service.js';

const MIN_HISTORY_SEC = 600; // a band counts as "known here" once it has served this long
const STRONG_WITHIN_DB = 6;
export const DEFAULT_ROUNDS = 2;
export const MAX_ROUNDS = 5;
export const MAX_ARMS = 5;
export const MIN_GAIN = 0.1; // a winner must be at least this much faster than the baseline
const UPLOAD_FLOOR = 0.8; // ...without losing more than 20 % of the upload
const LATENCY_SLACK_MS = 100; // ...or adding this much more latency under load

// Settling after a switch: the modem re-registers in ~12 s; then wait for the connection and its
// band combination to hold still before measuring.
export const SETTLE = { minMs: 20_000, stableMs: 10_000, maxMs: 90_000, pollMs: 2_000 };

const keyOf = (s) => `${s.technology}|${serialiseBands(s.bands)}`;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** "B3 + all 5G, 5G with 4G anchor (NSA)". */
export const selectionLabel = (s, supportedBands) =>
  `${describeBands(s.bands, supportedBands)}, ${TECHNOLOGIES[s.technology] ?? s.technology}`;

/**
 * Pure: the setups worth trying from here, most promising first.
 * supported: { technologies, bands }; current: { technology, bands }; history: rows from
 * db.bandsSeen() for the network in use; inUse: bands serving right now (used when there's
 * no history yet).
 * Returns { baseline, arms: [{ key, label, why, selection }] }.
 */
export function planCandidates({ supported, current, history = [], inUse = [], maxArms = MAX_ARMS }) {
  const nsa = supported.technologies.includes('NR5G-NSA') ? 'NR5G-NSA' : 'Auto';
  const allNr = supported.bands.filter(isNr);
  const allLte = supported.bands.filter(isLte);
  const known = (b) => history.find((h) => h.band.toUpperCase() === b.toUpperCase());
  const seen = (b) => {
    const h = known(b);
    return h && h.seconds >= MIN_HISTORY_SEC ? h : null;
  };
  // LTE bands by measured strength; with no history, the ones serving now.
  let lteRanked = allLte.filter((b) => seen(b)?.avgRsrp != null).sort((a, b) => seen(b).avgRsrp - seen(a).avgRsrp);
  if (!lteRanked.length) lteRanked = allLte.filter((b) => inUse.some((u) => u.toUpperCase() === b.toUpperCase()));

  const out = [];
  const add = (selection, label, why) => out.push({ selection, label, why });
  // A custom band list is compared with letting the network choose from every band.
  if (current.bands !== AUTO) {
    add({ technology: 'Auto', bands: AUTO }, 'Automatic', 'The router and network choose freely from every band and mode.');
  }
  for (const band of lteRanked.slice(0, 2)) {
    const h = seen(band);
    add(
      { technology: nsa, bands: [band, ...allNr] },
      `Only ${band} as the 4G anchor`,
      h
        ? `${band} averages ${h.avgRsrp} dBm here. In 5G NSA the 4G anchor carries control traffic and often the upload, so a strong one can help even when 5G looks the same.`
        : `${band} is serving you now. A fixed anchor stops the modem drifting to weaker 4G bands.`,
    );
  }
  if (lteRanked.length >= 3) {
    const best = seen(lteRanked[0])?.avgRsrp;
    const strong = best == null ? [] : lteRanked.filter((b) => seen(b).avgRsrp >= best - STRONG_WITHIN_DB);
    if (strong.length >= 2 && strong.length < lteRanked.length) {
      add(
        { technology: nsa, bands: [...strong, ...allNr] },
        `Strong 4G only (${strong.join('+')})`,
        `Every 4G band within ${STRONG_WITHIN_DB} dB of the strongest stays available for aggregation; weaker ones are left out.`,
      );
    }
  }
  const nrSeen = allNr.filter((b) => seen(b)?.avgSinr != null).sort((a, b) => seen(b).avgSinr - seen(a).avgSinr);
  if (nrSeen.length >= 2) {
    const [best, ...rest] = nrSeen;
    const weak = rest.filter((b) => seen(best).avgSinr - seen(b).avgSinr >= 3);
    if (weak.length) {
      add(
        { technology: nsa, bands: [...allLte, ...allNr.filter((b) => !weak.includes(b))] },
        `Without weaker 5G (${weak.join('+')})`,
        `${weak.join(', ')} averaged at least 3 dB worse SINR than ${best}. A weak 5G carrier can take the place of a better one.`,
      );
    }
  }
  if (supported.technologies.includes('NR5G-SA') && allNr.length) {
    add(
      { technology: 'NR5G-SA', bands: AUTO },
      '5G standalone (SA)',
      'No 4G anchor at all: fewer handovers and lower latency where the network offers SA. Without SA coverage there is no connection during this trial; it switches back by itself.',
    );
  }

  const baselineKey = keyOf(current);
  const unique = new Map();
  for (const c of out) {
    const key = keyOf(c.selection);
    if (key === baselineKey || unique.has(key)) continue;
    if (selectionError(c.selection, supported)) continue;
    unique.set(key, { key, ...c });
  }
  return {
    baseline: { key: baselineKey, label: 'Current setting', why: selectionLabel(current, supported.bands), selection: current },
    arms: [...unique.values()].slice(0, maxArms),
  };
}

/**
 * Pure: summarise an experiment's tests per arm and pick a winner, or none.
 * tests: rows with { arm, round, state, downMbps, upMbps, idleMs, loadedDownMs, loadedUpMs }.
 */
export function verdict({ baselineKey, armKeys, tests, minGain = MIN_GAIN }) {
  const byRound = new Map();
  for (const t of tests) {
    if (!byRound.has(t.round)) byRound.set(t.round, new Map());
    byRound.get(t.round).set(t.arm, t);
  }
  const ok = (t) => t?.state === 'ok' && t.downMbps != null;
  const summary = (key) => {
    const mine = tests.filter((t) => t.arm === key);
    const good = mine.filter(ok);
    const ratios = { down: [], up: [], latency: [] };
    let wins = 0;
    let paired = 0;
    for (const round of byRound.values()) {
      const base = round.get(baselineKey);
      const t = round.get(key);
      if (key === baselineKey || !ok(base) || !ok(t)) continue;
      paired++;
      const down = t.downMbps / Math.max(base.downMbps, 0.1);
      ratios.down.push(down);
      if (t.upMbps != null && base.upMbps != null) ratios.up.push(t.upMbps / Math.max(base.upMbps, 0.1));
      const la = addedLatency(t);
      const lb = addedLatency(base);
      if (la != null && lb != null) ratios.latency.push(la - lb);
      if (down > 1) wins++;
    }
    return {
      key,
      tests: mine.length,
      failed: mine.length - good.length,
      downMbps: median(good.map((t) => t.downMbps)),
      upMbps: median(good.map((t) => t.upMbps)),
      idleMs: median(good.map((t) => t.idleMs)),
      addedMs: median(good.map(addedLatency)),
      gain: ratios.down.length ? Math.round((median(ratios.down) - 1) * 1000) / 1000 : null,
      upRatio: median(ratios.up),
      addedVsBaselineMs: median(ratios.latency),
      wins,
      paired,
    };
  };
  const baseline = summary(baselineKey);
  const arms = armKeys.map(summary);
  // A majority of the paired rounds, and every round it was tested in when there are only two.
  const needWins = (n) => (n <= 2 ? n : Math.ceil((n * 2) / 3));
  const eligible = arms.filter(
    (a) =>
      a.failed === 0 &&
      a.paired > 0 &&
      a.gain >= minGain &&
      a.wins >= needWins(a.paired) &&
      (a.upRatio == null || a.upRatio >= UPLOAD_FLOOR) &&
      (a.addedVsBaselineMs == null || a.addedVsBaselineMs <= LATENCY_SLACK_MS),
  );
  const winner = eligible.sort((a, b) => b.gain - a.gain)[0] ?? null;
  return {
    baseline,
    arms,
    winner: winner?.key ?? null,
    reason: winner
      ? `${Math.round(winner.gain * 100)}% faster download than the current setting, ahead in ${winner.wins} of ${winner.paired} round${winner.paired === 1 ? '' : 's'}.${winner.paired < 2 ? ' One round is a single comparison: run two or more to confirm before relying on it.' : ''}`
      : baseline.failed === baseline.tests && baseline.tests > 0
        ? 'The current setting could not be measured, so nothing could be compared. Check the internet connection and try again.'
        : `No setup beat the current setting by ${Math.round(minGain * 100)}% or more in most rounds without hurting upload or latency. Keep what you have.`,
  };
}

/**
 * Runs experiments. Needs the radio service (trials), the speed service (tests) and the
 * collector (to know when the connection has settled after a switch).
 */
export function createOptimiser({
  radio,
  speed,
  collector,
  db,
  now = Date.now,
  sleep = realSleep,
  settle = SETTLE,
  onChange = () => {},
  log = console,
}) {
  let run = null; // { id, plan, rounds, startedAt, step, done, total, controller }
  let last = null; // the most recent finished experiment

  try {
    // An experiment can't continue across a restart; the radio trial it left reverts by itself.
    for (const e of db.experiments(5)) {
      if (e.state === 'running') db.updateExperiment(e.id, { finishedAt: now(), state: 'interrupted', result: e.result });
    }
    last = db.experiments(1)[0] ?? null;
  } catch {
    // no history yet
  }

  const event = (level, message) => {
    try {
      db.insertMany([{ ts: now(), source: 'insight', facility: 'optimiser', level, message }]);
    } catch {
      // the log is a record, not a gate
    }
  };
  const step = (patch) => {
    run.step = { ...run.step, ...patch };
    onChange();
  };
  const cancelled = () => run.controller.signal.aborted;

  /** Switch to `selection`, waiting out the modem's minimum gap between changes if needed. */
  async function apply(selection) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await radio.apply(selection);
      } catch (e) {
        if (e.status !== 429 || cancelled()) throw e;
        await sleep(MIN_GAP_MS / 3, run.controller.signal);
      }
    }
    throw fail('The modem kept refusing the change.', 502);
  }

  /** Wait until mobile data is up and the band combination has held still. Resolves true, or false on timeout. */
  async function settled() {
    collector.boost?.(settle.maxMs + 30_000);
    const start = now();
    await sleep(settle.minMs, run.controller.signal);
    let combo = null;
    let since = now();
    while (!cancelled() && now() - start < settle.maxMs) {
      const r = collector.state.router;
      const up = collector.state.phase === 'ok' && r?.wan?.up !== false && !!r?.carriers?.combo;
      if (!up) {
        combo = null;
        since = now();
      } else if (r.carriers.combo !== combo) {
        combo = r.carriers.combo;
        since = now();
      } else if (now() - since >= settle.stableMs) {
        return true;
      }
      await sleep(settle.pollMs, run.controller.signal);
    }
    return false;
  }

  async function execute() {
    const { plan, rounds, id } = run;
    const supported = plan.supportedBands;
    const tests = [];
    let error = null;
    try {
      for (let round = 0; round < rounds && !cancelled(); round++) {
        // Baseline first in even rounds, last in odd ones; candidates rotate.
        const shift = round % Math.max(1, plan.arms.length);
        const arms = [...plan.arms.slice(shift), ...plan.arms.slice(0, shift)];
        const order = round % 2 ? [...arms, plan.baseline] : [plan.baseline, ...arms];
        for (const arm of order) {
          if (cancelled()) break;
          if (collector.state.maintenance || ['paused', 'halted'].includes(collector.state.phase))
            throw fail('Router collection stopped or maintenance started.', 409);
          step({ round: round + 1, arm: arm.key, label: arm.label, phase: 'switching' });
          await apply(arm.selection);
          step({ phase: 'settling' });
          const ready = await settled();
          if (cancelled()) break;
          const tag = { round, arm: arm.key };
          if (!ready) {
            const row = {
              ts: now(),
              trigger: 'optimiser',
              experimentId: id,
              arm: arm.key,
              state: 'failed',
              error: 'No stable connection with this setting',
            };
            row.id = db.insertSpeedTest(row);
            tests.push({ ...row, ...tag });
            event('warning', `Optimiser: no stable connection with ${arm.label}`);
          } else {
            step({ phase: 'testing' });
            try {
              const row = await speed.run({
                trigger: 'optimiser',
                experimentId: id,
                arm: arm.key,
                bandsPref: selectionLabel(arm.selection, supported),
                signal: run.controller.signal,
              });
              tests.push({ ...row, ...tag });
            } catch (e) {
              if (cancelled()) break;
              tests.push({ state: 'failed', error: e.message, ...tag });
            }
          }
          run.done++;
          onChange();
        }
      }
    } catch (e) {
      error = e;
      log.warn(`[optimiser] stopped: ${e.message}`);
    } finally {
      // Back to where it started, whatever happened. A trial in place means we moved away.
      step({ phase: 'restoring', arm: plan.baseline.key, label: plan.baseline.label });
      try {
        if (radio.trial) await radio.revert();
      } catch (e) {
        // The trial's own timer reverts it within minutes; say so rather than hide it.
        log.warn(`[optimiser] restoring the starting setting failed; the trial will revert by itself: ${e.message}`);
        error ??= e;
      }
    }
    const state = error ? 'failed' : cancelled() ? 'cancelled' : 'complete';
    const result = {
      ...verdict({ baselineKey: plan.baseline.key, armKeys: plan.arms.map((a) => a.key), tests }),
      error: error?.message ?? null,
    };
    if (state !== 'complete') result.winner = null; // partial data isn't a verdict
    db.updateExperiment(id, { finishedAt: now(), state, result });
    const winner = plan.arms.find((a) => a.key === result.winner);
    event(
      state === 'failed' ? 'warning' : 'notice',
      state === 'complete'
        ? winner
          ? `Optimiser finished: ${winner.label} was ${Math.round(result.arms.find((a) => a.key === winner.key).gain * 100)}% faster than the current setting`
          : 'Optimiser finished: nothing beat the current setting'
        : `Optimiser ${state}${error ? `: ${error.message}` : ''}`,
    );
    last = db.experiment(id);
    run = null;
    onChange();
  }

  const optimiser = {
    get running() {
      return !!run;
    },

    /** For the status payload and the page. */
    get state() {
      return {
        running: run && { id: run.id, startedAt: run.startedAt, rounds: run.rounds, step: run.step, done: run.done, total: run.total },
        last: last && { id: last.id, state: last.state, finishedAt: last.finishedAt },
      };
    },

    /** The plan a run would follow now, without starting it. */
    async plan() {
      if (!radio?.enabled) throw fail('Radio control is disabled (RADIO_CONTROL_ENABLED=false).', 404);
      const r = await radio.get();
      // Only this network's history ranks the bands: after a SIM swap, the old network's
      // strong bands mean nothing, and with no history yet the bands serving now are used.
      const network = db.bandNetwork(collector.state.router?.signal?.plmn ?? undefined);
      const history = db.bandsSeen({ plmn: network.plmn });
      const plan = planCandidates({
        supported: { technologies: r.technology.supported, bands: r.bands.supported },
        current: { technology: r.technology.preferred, bands: r.bands.preferred },
        history,
        inUse: (collector.state.router?.carriers?.carriers ?? []).map((c) => c.band).filter(Boolean),
      });
      return { ...plan, network: { ...network, historyBands: history.length }, supportedBands: r.bands.supported, trial: r.trial };
    },

    /** Start an experiment: { rounds, arms?: [keys] } (default every planned arm). Resolves at once. */
    async start({ rounds = DEFAULT_ROUNDS, arms } = {}) {
      if (run) throw fail('The optimiser is already running.', 409);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw fail(`Rounds must be 1 to ${MAX_ROUNDS}.`);
      if (speed.running) throw fail('A speed test is running; wait for it to finish.', 409);
      if (collector.state.phase !== 'ok' || collector.state.maintenance) throw fail('Resume router collection first.', 409);
      const plan = await optimiser.plan();
      if (plan.trial) throw fail('Keep or revert the band trial on Radio control first.', 409);
      if (arms !== undefined) {
        if (!Array.isArray(arms) || arms.some((k) => typeof k !== 'string')) throw fail('arms must be a list of plan keys.');
        const unknown = arms.filter((k) => !plan.arms.some((a) => a.key === k));
        if (unknown.length) throw fail('The plan changed; reload it and choose again.', 409);
        plan.arms = plan.arms.filter((a) => arms.includes(a.key));
      }
      if (!plan.arms.length) throw fail('Choose at least one setup to try.');
      delete plan.trial;
      const startedAt = now();
      const id = db.insertExperiment({ startedAt, state: 'running', plan: { ...plan, rounds } });
      run = { id, plan, rounds, startedAt, step: null, done: 0, total: rounds * (plan.arms.length + 1), controller: new AbortController() };
      event(
        'notice',
        `Optimiser started: ${plan.arms.length} setup${plan.arms.length === 1 ? '' : 's'} × ${rounds} round${rounds === 1 ? '' : 's'}`,
      );
      onChange();
      void execute();
      return optimiser.state;
    },

    /** Stop after restoring the starting setting. */
    cancel() {
      run?.controller.abort();
      return optimiser.state;
    },

    stop() {
      run?.controller.abort();
    },

    /** Recent experiments with their tests. */
    history(limit = 5) {
      return db.experiments(limit).map((e) => ({ ...e, tests: db.speedTestsForExperiment(e.id) }));
    },
  };
  return optimiser;
}
