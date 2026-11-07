import { EventEmitter } from 'node:events';
import { RouterError } from '../router/client.js';
import { newLines, parseRouterLine } from '../logs/parse.js';
import { findKey, scalars, toNumber } from '../lib/util.js';
import { interpretRadio } from './radio.js';
import { wanStatus } from './wan.js';
import { performance } from 'node:perf_hooks';
import { SAME_BOOT_MS, detectReboot, rebootMessage, uptimeContinues } from './reboots.js';

// Poll timing uses a monotonic clock, so a wall-clock step back (NTP sync on a Pi
// without an RTC) can't pause polling. Epoch-scaled so 0 still means "long ago".
const clock = () => performance.timeOrigin + performance.now();

const FULL_STATUS_MS = 60_000; // device info + uptime; signal comes from cellwan_status every poll
// A mobile-data drop starts at the last reading that was up, if that's this recent;
// otherwise (first reading after a start or a router outage) at the first one that wasn't.
const WAN_LAST_UP_MS = 120_000;
const wanIdle = (lastUpAt = null) => ({ lastUpAt, downSince: null, downCount: 0, reason: null, confirmed: false });

const WINDOW = 200; // more than GET_LOG's 100 lines, so the overlap is always found
const LOGS = [
  { type: 'system', source: 'router-system' },
  { type: 'security', source: 'router-security' },
];

/**
 * Polls the router's native logs and status. Careful with login: the router
 * locks the account for 5 minutes after 3 bad passwords, so a rejected login
 * halts the collector until someone retries it from the UI.
 */
export class Collector extends EventEmitter {
  constructor({ client, db, pollIntervalSec, statusIntervalSec, log = console }) {
    super();
    this.client = client;
    this.db = db;
    this.pollMs = pollIntervalSec * 1000;
    this.statusMs = statusIntervalSec * 1000;
    this.log = log;
    this.windows = Object.fromEntries(LOGS.map((l) => [l.source, db.lastRaw(l.source, WINDOW)]));
    this.timer = null;
    this.failures = 0;
    this.lastLogPoll = 0;
    this.lastStatusPoll = 0;
    this.inFlight = false;
    this.pollAgain = false;
    this.lastPollNow = 0;
    this.pollNowGen = 0; // bumped by pollNow(), so a request made mid-poll isn't lost
    this.lastUptime = null; // { uptimeSec, mono } from the previous full status, this process
    this.fullStatus = null; // { data, at }
    this.outageStart = null;
    this.wan = wanIdle();
    this.lastCell = null;
    this.cellwanSupported = true;
    this.state = {
      phase: 'starting', // starting | ok | backoff | halted | paused
      lastSuccessAt: null,
      lastLogsAt: null,
      lastStatusAt: null,
      lastError: null,
      nextAttemptAt: null,
      added: { 'router-system': 0, 'router-security': 0 },
      gaps: 0,
      router: null,
    };
  }

  start() {
    this.#schedule(0);
  }

  async stop() {
    clearTimeout(this.timer);
    this.timer = null;
    // An outage still open at shutdown would be forgotten; record what we know.
    if (this.state.phase === 'backoff' && this.outageStart && this.failures >= 2) {
      this.#safely(() =>
        this.db.insertOutage({
          start_ts: this.outageStart,
          end_ts: Date.now(),
          reason: `${this.state.lastError?.kind ?? 'unknown'} (Insight stopped)`,
          kind: 'router',
        }),
      );
    }
    this.#closeWanOutage(Date.now(), 'Insight stopped');
    await this.client.logout().catch(() => {});
  }

  /** Insight just asked the router to restart: the outage that follows is that, not a fault. */
  expectRestart(at = Date.now()) {
    this.restartAt = at;
  }

  /** Hold ordinary polling during maintenance without releasing the router session. */
  async beginMaintenance(reason = 'Router maintenance') {
    if (this.state.phase === 'paused' || this.state.phase === 'halted') {
      throw Object.assign(new Error('Resume the collector before changing router settings'), { status: 409 });
    }
    if (this.state.maintenance) throw Object.assign(new Error('Router maintenance is already running'), { status: 409 });
    this.state.maintenance = { reason, since: Date.now() };
    clearTimeout(this.timer);
    this.state.nextAttemptAt = null;
    this.emit('change');
    // A running poll checks the hold between reads and always emits on completion.
    while (this.inFlight) await new Promise((resolve) => this.once('change', resolve));
    // Drain reads that were queued before the hold; new sampler reads are refused.
    if (this.client.queue) await this.client.queue.run(async () => {});
  }

  endMaintenance() {
    if (!this.state.maintenance) return;
    this.state.maintenance = null;
    this.fullStatus = null;
    this.lastStatusPoll = 0;
    if (this.state.phase !== 'paused' && this.state.phase !== 'halted') this.#schedule(0);
    this.emit('change');
  }

  // Why the router stopped answering: the restart Insight asked for, if the outage began
  // within a few minutes of it, otherwise the kind of error.
  #outageReason() {
    const planned = this.restartAt && this.outageStart >= this.restartAt - 60_000 && this.outageStart <= this.restartAt + 5 * 60_000;
    return planned ? 'restart (requested from Insight)' : (this.state.lastError?.kind ?? null);
  }

  async pause() {
    clearTimeout(this.timer);
    this.state.phase = 'paused';
    this.state.nextAttemptAt = null;
    // Free the session so the router's own web UI can log in. Suspend first, so a
    // poll or sampler request already queued can't log straight back in.
    this.client.suspend();
    // Nothing is watched while paused, so a drop in progress ends here.
    this.#closeWanOutage(Date.now(), 'collector paused');
    await this.client.logout().catch(() => {});
    this.#event('notice', 'Collector paused; router session released');
    this.emit('change');
  }

  resume() {
    if (this.state.phase !== 'paused' && this.state.phase !== 'halted') return;
    // Retry after a certificate change is the user saying "I reset the router, trust it".
    this.client.resume({ trustNewCertificate: this.state.lastError?.kind === 'tls' });
    this.failures = 0;
    this.state.phase = 'starting';
    this.#event('notice', 'Collector resumed');
    // A poll paused mid-request is still unwinding; #tick reschedules itself if so.
    this.#schedule(0);
    this.emit('change');
  }

  /**
   * Poll logs and status right away (e.g. on an SNMP trap) instead of waiting
   * for the next interval. Throttled so a burst of traps causes one poll.
   */
  pollNow() {
    if (this.state.maintenance || this.state.phase !== 'ok' || clock() - this.lastPollNow < 5000) return;
    this.lastPollNow = clock();
    this.pollNowGen++;
    this.lastLogPoll = 0;
    this.lastStatusPoll = 0;
    if (this.inFlight) this.pollAgain = true;
    else this.#schedule(0);
  }

  /** Run one poll cycle now (tests only; normal operation is timer driven). */
  async tickForTest() {
    await this.#tick();
    clearTimeout(this.timer);
  }

  #schedule(ms) {
    clearTimeout(this.timer);
    this.state.nextAttemptAt = Date.now() + ms;
    this.timer = setTimeout(() => this.#tick(), ms);
  }

  async #tick() {
    const stopped = () => this.state.maintenance || this.state.phase === 'paused' || this.state.phase === 'halted';
    if (stopped()) return;
    // Never two polls at once (e.g. resume() while a paused poll is still unwinding).
    if (this.inFlight) {
      this.#schedule(1000);
      return;
    }
    this.inFlight = true;
    const gen = this.pollNowGen;
    // A pollNow() during this poll leaves its 0 in place, so the next tick polls again.
    const t = clock();
    const done = () => (this.pollNowGen === gen ? t : 0);
    try {
      if (t - this.lastLogPoll >= this.pollMs - 1000) {
        for (const l of LOGS) {
          if (stopped()) return;
          await this.#pollLog(l);
        }
        this.lastLogPoll = done();
        this.state.lastLogsAt = Date.now();
      }
      if (stopped()) return;
      if (t - this.lastStatusPoll >= this.statusMs - 1000) {
        await this.#pollStatus();
        this.lastStatusPoll = done();
        this.state.lastStatusAt = Date.now();
      }
      if (stopped()) return; // paused while a request was in flight
      if (this.state.phase === 'backoff' && this.outageStart) {
        const end = Date.now();
        // One failed request that succeeds on the next try is a glitch, not an outage.
        if (this.failures >= 2)
          this.#safely(() =>
            this.db.insertOutage({ start_ts: this.outageStart, end_ts: end, reason: this.#outageReason(), kind: 'router' }),
          );
        this.#event('notice', `Router connection restored after ${Math.round((end - this.outageStart) / 1000)}s`);
      } else if (this.state.phase !== 'ok' && this.state.phase !== 'starting') {
        this.#event('notice', 'Router connection restored');
      }
      this.outageStart = null;
      this.state.phase = 'ok';
      this.state.lastSuccessAt = Date.now();
      this.failures = 0;
      this.#schedule(this.pollAgain ? 1000 : Math.min(this.pollMs, this.statusMs));
    } catch (err) {
      if (!stopped()) this.#handleError(err);
    } finally {
      this.inFlight = false;
      this.pollAgain = false;
      this.emit('change');
    }
  }

  #handleError(err) {
    const kind = err instanceof RouterError ? err.kind : 'internal';
    if (kind === 'paused') return; // a request cut short by Pause, not a router problem
    this.failures++;
    this.state.lastError = { kind, message: err.message, at: Date.now() };
    // Mobile data can't be judged while the router doesn't answer: a drop seen after
    // this must not be backdated to before it.
    this.wan.lastUpAt = null;
    this.log.warn(`[collector] ${kind}: ${err.message}`);

    if (kind === 'auth') {
      this.state.phase = 'halted';
      this.state.nextAttemptAt = null;
      this.#event(
        'err',
        `Login rejected; collector halted to avoid locking the account. Check ROUTER_USER/ROUTER_PASSWORD (a changed password needs an Insight restart), then press Retry. (${err.message})`,
      );
      return;
    }
    if (kind === 'tls') {
      this.state.phase = 'halted';
      this.state.nextAttemptAt = null;
      this.#event('err', `Collector halted before sending the password: ${err.message}`);
      return;
    }
    let delay;
    if (kind === 'duplicate' || kind === 'max-sessions')
      delay = 5 * 60_000; // let the other session finish or time out
    // Network errors are usually a reboot or link loss: keep probing every <=60 s so recovery is seen quickly.
    else if (kind === 'network') delay = Math.min(15_000 * 2 ** (this.failures - 1), 60_000);
    else delay = 60_000;
    if (this.state.phase !== 'backoff') {
      // Start the outage at the last success only if Insight was actually watching
      // until now; after a sleep/suspend the router may have been fine all along.
      const now = Date.now();
      const watching = this.state.lastSuccessAt && now - this.state.lastSuccessAt <= 2 * Math.min(this.pollMs, this.statusMs) + 15_000;
      this.outageStart = watching ? this.state.lastSuccessAt : now;
      if (this.#outageReason()?.startsWith('restart')) this.#event('notice', 'Router restarting; waiting for it to come back');
      else this.#event('warning', `Router unavailable (${kind}): ${err.message}`);
    }
    this.state.phase = 'backoff';
    this.#schedule(delay);
  }

  async #pollLog({ type, source }) {
    const lines = await this.client.getLog(type);
    const prev = this.windows[source];
    const { overlap, added } = newLines(prev, lines);
    if (prev.length && overlap === 0 && added.length) {
      this.state.gaps++;
      this.#event(
        'warning',
        `No overlap with the previous ${type} log poll: lines may have been missed (poll more often or enable remote syslog)`,
      );
    }
    if (added.length) {
      const now = new Date();
      this.db.insertMany(added.map((raw) => ({ ...parseRouterLine(raw, now), source, raw })));
      this.state.added[source] += added.length;
    }
    this.windows[source] = [...prev, ...added].slice(-WINDOW);
  }

  async #pollStatus() {
    const now = Date.now();
    // The big DAL status object (device info, uptime) changes slowly: refresh it once a minute.
    let fresh = false;
    // While mobile data looks down, every poll: the WAN address lives in this object, and
    // recovery should show within seconds, not a minute.
    if (!this.fullStatus || clock() - this.fullStatus.monoAt >= FULL_STATUS_MS || this.lastStatusPoll === 0 || this.wan.downCount) {
      this.fullStatus = { data: await this.client.getStatus(), at: now, monoAt: clock() };
      fresh = true;
    }
    // The small cellular object carries live signal and carrier aggregation.
    let cellwan = null;
    if (this.cellwanSupported) {
      try {
        cellwan = await this.client.getCellwanStatus();
      } catch (e) {
        if (e.kind !== 'http') throw e;
        this.cellwanSupported = false; // older firmware: fall back to the status object
        this.log.warn(`[collector] cellwan_status unavailable, using status only: ${e.message}`);
      }
    }

    const data = this.fullStatus.data;
    const rawUptime = findKey(data, 'UpTime');
    const baseUptime = rawUptime === undefined ? null : Number(rawUptime);
    const uptimeSec = baseUptime == null ? null : baseUptime + Math.floor((now - this.fullStatus.at) / 1000);
    const prev = this.state.router;
    if (fresh && baseUptime != null) {
      // Database trouble below is logged, not treated as the router being unavailable.
      this.#safely(() => this.#checkReboot(this.fullStatus.at - baseUptime * 1000, baseUptime));
      const mem = findKey(data, 'MemoryStatus');
      const cpu = toNumber(findKey(data, 'ProcessStatus')?.CPUUsage);
      this.#safely(() => this.db.insertSystem({ ts: now, cpu, mem_total: mem?.Total ?? null, mem_free: mem?.Free ?? null }));
      this.state.system = { cpu, memTotalKb: mem?.Total ?? null, memFreeKb: mem?.Free ?? null };
    }

    const { cell, nr, signal, carriers: ca, servingCell } = interpretRadio(data, cellwan);
    if (prev?.carriers?.combo && ca.combo && prev.carriers.combo !== ca.combo) {
      this.#event('notice', `Band combination changed: ${prev.carriers.combo} → ${ca.combo}`, 'carriers');
    }
    if (this.lastCell && servingCell && this.lastCell.key !== servingCell.key) {
      this.#event('notice', `Serving cell changed: ${this.lastCell.label} → ${servingCell.label}`, 'cell');
    }
    if (servingCell) this.lastCell = servingCell;
    const wan = wanStatus(data, cellwan);
    this.#trackWan(wan, now);

    this.state.router = {
      fetchedAt: now,
      uptimeSec,
      bootedAt: baseUptime == null ? null : this.fullStatus.at - baseUptime * 1000,
      device: scalars(findKey(data, 'DeviceInfo')),
      signal,
      carriers: ca,
      cell,
      nr,
      wan: { up: wan.up, reason: wan.reason, since: this.wan.confirmed ? this.wan.downSince : null },
      // Raw scalars + SCC list, kept so new firmware fields can be inspected via /api/status.
      cellwan: cellwan ? { ...scalars(cellwan), SCC_Info: cellwan.SCC_Info ?? null } : null,
    };
    // Also with no carriers: a gap in coverage must end the bands' sessions.
    this.#safely(() => this.db.recordCarriers(now, ca.carriers));
    if (signal) {
      const { lte, nr: n } = signal;
      this.#safely(() =>
        this.db.insertMetric({
          ts: now,
          uptime: uptimeSec,
          lte_rsrp: lte.rsrp,
          lte_rsrq: lte.rsrq,
          lte_sinr: lte.sinr,
          lte_rssi: lte.rssi,
          nr_rsrp: n?.rsrp,
          nr_rsrq: n?.rsrq,
          nr_sinr: n?.sinr,
          nr_rssi: n?.rssi,
          combo: ca.combo,
          cell: servingCell?.key ?? null,
        }),
      );
    }
  }

  /**
   * Mobile data drops, debounced like router outages: one reading down is a glitch,
   * two in a row an outage. Logged when confirmed, stored when it ends.
   */
  #trackWan({ up, reason }, now) {
    if (up === null) return; // firmware doesn't say
    const w = this.wan;
    if (up) {
      if (w.confirmed) this.#closeWanOutage(now);
      this.wan = wanIdle(now);
      return;
    }
    if (!w.downCount) w.downSince = w.lastUpAt && now - w.lastUpAt <= WAN_LAST_UP_MS ? w.lastUpAt : now;
    w.downCount++;
    w.reason ??= reason; // the first symptom is the cause; later ones follow from it
    if (!w.confirmed && w.downCount >= 2) {
      w.confirmed = true;
      this.#event('warning', `Mobile data connection lost: ${w.reason}`, 'wan');
    }
  }

  /** Store a confirmed mobile-data outage ending at `end` (`note` says why it ended there). */
  #closeWanOutage(end, note = null) {
    const w = this.wan;
    if (w.confirmed) {
      this.#safely(() =>
        this.db.insertOutage({ start_ts: w.downSince, end_ts: end, reason: note ? `${w.reason} (${note})` : w.reason, kind: 'wan' }),
      );
      if (!note) this.#event('notice', `Mobile data connection restored after ${Math.round((end - w.downSince) / 1000)}s`, 'wan');
    }
    this.wan = wanIdle();
  }

  /** Outages still in progress, which the database only gets once they end. For live views. */
  openOutages(now = Date.now()) {
    const open = [];
    if (this.state.phase === 'backoff' && this.outageStart && this.failures >= 2) {
      open.push({ kind: 'router', start_ts: this.outageStart, end_ts: now, reason: this.state.lastError?.kind ?? null, ongoing: true });
    }
    if (this.wan.confirmed) open.push({ kind: 'wan', start_ts: this.wan.downSince, end_ts: now, reason: this.wan.reason, ongoing: true });
    return open;
  }

  /**
   * Compare the router's boot time with the one stored last time. Persisted, so
   * reboots that happen while Insight is stopped or the Mac sleeps are still
   * recorded, stamped with the real boot time.
   */
  #checkReboot(bootedAt, uptimeSec) {
    const now = Date.now();
    const storedBootedAt = Number(this.db.getMeta('bootedAt')) || null;
    const lastSeen = Number(this.db.getMeta('lastSeenAt')) || null;
    this.db.setMeta('lastSeenAt', now);
    // While this process has a previous reading, uptime itself decides (see
    // uptimeContinues): a wall-clock step moves bootedAt without any reboot.
    const read = { uptimeSec, wall: now, mono: performance.now() };
    const prev = this.lastUptime;
    this.lastUptime = read;
    const continues = prev ? uptimeContinues(prev, read) : null;
    if (continues) {
      if (storedBootedAt && Math.abs(bootedAt - storedBootedAt) > SAME_BOOT_MS) this.db.setMeta('bootedAt', bootedAt);
      return;
    }
    const reboot = detectReboot({
      bootedAt,
      storedBootedAt,
      rebooted: continues === false,
      logs: storedBootedAt || continues === false ? this.db.logsBetween(bootedAt - 15 * 60_000, bootedAt + 5 * 60_000) : [],
    });
    if (reboot) {
      this.db.insertReboot({ ...reboot, detected_at: now, last_seen_before: lastSeen });
      this.db.insertMany([
        {
          ts: bootedAt,
          source: 'insight',
          facility: 'reboot',
          level: reboot.kind === 'unexplained' ? 'warning' : 'notice',
          message: rebootMessage(reboot, lastSeen),
        },
      ]);
    }
    if (!storedBootedAt || Math.abs(bootedAt - storedBootedAt) > SAME_BOOT_MS) this.db.setMeta('bootedAt', bootedAt);
  }

  /** Record Insight's own events in the log stream so gaps and outages are visible in context. */
  #event(level, message, facility = 'collector') {
    this.#safely(() => this.db.insertMany([{ ts: Date.now(), source: 'insight', facility, level, message }]));
  }

  /** A failing DB write (full or dying SD card) is logged, never allowed to stop polling. */
  #safely(fn) {
    try {
      fn();
    } catch (e) {
      this.log.error(`[collector] database write failed: ${e.message}`);
    }
  }
}
