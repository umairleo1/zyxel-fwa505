// Is data actually getting through? The router can report mobile data as up (SIM ready,
// interface up, an address) while nothing flows, e.g. a stall on a weak cell. This probes
// the internet directly from this machine and records stalls as outages of kind 'internet'.
import net from 'node:net';
import { performance } from 'node:perf_hooks';

// Monotonic, epoch-scaled: a wall-clock step (NTP) must not look like a sleep.
const clock = () => performance.timeOrigin + performance.now();

const CONFIRM_ROUNDS = 3; // failed rounds in a row before it's a stall: one lost probe is noise
const RECOVER_ROUNDS = 2; // good rounds in a row before it's over, so a flapping link is one stall
// Rounds further apart than this mean Insight wasn't running (computer asleep): nothing is
// known about the time between, so a stall isn't backdated or stretched across it.
const SLEEP_GAP_MS = 15_000;
const MINUTE = 60_000; // rounds are summarised per minute for the System page chart

/**
 * One TCP handshake to `host:port`, abandoned with a reset as soon as it completes (no data,
 * no TLS: about 250 bytes on the wire). Resolves { ok, rttMs }; never rejects.
 */
export function tcpProbe({ host, port }, timeoutMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) socket.resetAndDestroy();
      else socket.destroy();
      resolve({ ok, rttMs: ok ? Math.round(performance.now() - start) : null });
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** "1.1.1.1:443, 8.8.8.8" → [{ host, port, label }]. Port defaults to 443. */
export function parseTargets(list) {
  return list.map((t) => {
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(t.trim());
    const host = m?.[1] ?? t.trim();
    const port = Number(m?.[2] ?? 443);
    return { host, port, label: port === 443 ? host : `${host}:${port}` };
  });
}

/** The router's own address and port from ROUTER_URL: reaching it rules out this machine's link. */
export function gatewayTarget(routerUrl) {
  const u = new URL(routerUrl);
  const port = Number(u.port || (u.protocol === 'http:' ? 80 : 443));
  return { host: u.hostname, port, label: 'router' };
}

/** Signal at the moment a stall is confirmed, for its reason: "LTE -105 dBm, SINR 6 dB · 5G -96 dBm, SINR 0 dB". Pure. */
export function signalNote(signal) {
  const leg = (name, s) => {
    if (!s || (s.rsrp == null && s.sinr == null)) return null;
    const parts = [s.rsrp != null && `${s.rsrp} dBm`, s.sinr != null && `SINR ${s.sinr} dB`].filter(Boolean);
    return `${name} ${parts.join(', ')}`;
  };
  return [leg('LTE', signal?.lte), leg('5G', signal?.nr)].filter(Boolean).join(' · ') || null;
}

const idle = () => ({ fails: 0, oks: 0, since: null, recoverAt: null, reason: null, confirmed: false });
const emptyMinute = (ts) => ({ ts, rounds: 0, failed: 0, local: 0, rtt_sum: 0, rtt_n: 0, rtt_max: null });

/**
 * Probes the first target every `intervalMs`. Only when it fails are the other targets and
 * the router tried (together), so the usual cost is one handshake per round:
 * - another target answers → the internet is fine, the first one had a bad moment;
 * - none answer but the router does → a failed round (data isn't getting through);
 * - the router doesn't answer either → no verdict: this machine's own link, or the router
 *   itself, which the collector records as "router unreachable".
 * Debounced like the other outages, logged when confirmed, stored when it ends.
 */
export class InternetMonitor {
  constructor({
    db,
    targets,
    gateway = null,
    intervalMs = 1000,
    timeoutMs = 1500,
    probe = tcpProbe,
    context = () => null,
    onChange = () => {},
    now = Date.now,
    mono = clock,
    log = console,
  }) {
    if (!targets?.length) throw new Error('InternetMonitor needs at least one target');
    Object.assign(this, { db, targets, gateway, intervalMs, timeoutMs, probe, context, onChange, now, mono, log });
    this.stall = idle();
    this.lastOkAt = null;
    this.lastRound = null; // { at, mono }
    this.minute = null; // this minute's tally, stored when the minute changes
    this.timer = null;
    this.running = false;
    this.state = {
      enabled: true,
      phase: 'starting', // starting | ok | failing | stalled | local
      intervalMs,
      targets: targets.map((t) => t.label),
      lastOkAt: null,
      rttMs: null,
      via: null,
      stall: null, // { since, reason } while a confirmed stall is open
    };
  }

  start() {
    this.running = true;
    const loop = async () => {
      const began = this.mono();
      try {
        await this.round();
      } catch (e) {
        this.log.error(`[internet] probe round failed: ${e.message}`);
      }
      if (this.running) this.timer = setTimeout(loop, Math.max(0, this.intervalMs - (this.mono() - began)));
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.#flushMinute();
    this.#close(this.now(), 'Insight stopped');
  }

  /** One probe round. Public for tests; normally driven by start(). */
  async round() {
    const at = this.now();
    const mono = this.mono();
    if (this.lastRound && mono - this.lastRound.mono > SLEEP_GAP_MS) {
      // Asleep or stalled process: end what we knew at the last round, start fresh.
      this.#close(this.lastRound.at, 'Insight paused');
      this.lastOkAt = null;
    }
    this.lastRound = { at, mono };

    const [first, ...rest] = this.targets;
    let res = await this.probe(first, this.timeoutMs);
    let via = first;
    if (!res.ok) {
      const [gw, ...others] = await Promise.all([
        this.gateway ? this.probe(this.gateway, this.timeoutMs) : { ok: true },
        ...rest.map((t) => this.probe(t, this.timeoutMs)),
      ]);
      const i = others.findIndex((o) => o.ok);
      if (i >= 0) {
        res = others[i];
        via = rest[i];
      } else if (!gw.ok) {
        this.#tally(at, { local: true });
        this.#local();
        return;
      }
    }
    this.#tally(at, res);
    if (res.ok) this.#up(at, res.rttMs, via);
    else this.#down(at);
  }

  /** Add one round to its minute; a new minute stores the previous one (a minute's write, not a second's). */
  #tally(at, { ok = false, rttMs = null, local = false }) {
    const ts = Math.floor(at / MINUTE) * MINUTE;
    if (this.minute?.ts !== ts) {
      this.#flushMinute();
      this.minute = emptyMinute(ts);
    }
    const m = this.minute;
    m.rounds++;
    if (local) m.local++;
    else if (!ok) m.failed++;
    else if (rttMs != null) {
      m.rtt_sum += rttMs;
      m.rtt_n++;
      m.rtt_max = Math.max(m.rtt_max ?? 0, rttMs);
    }
  }

  #flushMinute() {
    const m = this.minute;
    this.minute = null;
    if (m?.rounds) this.#safely(() => this.db.insertInternetSample(m));
  }

  #up(at, rttMs, via) {
    const s = this.stall;
    this.lastOkAt = at;
    Object.assign(this.state, { lastOkAt: at, rttMs, via: via.label });
    if (s.confirmed) {
      s.recoverAt ??= at;
      s.oks++;
      if (s.oks >= RECOVER_ROUNDS) this.#close(s.recoverAt);
    } else {
      this.stall = idle();
    }
    this.#phase(this.stall.confirmed ? 'stalled' : 'ok');
  }

  #down(at) {
    const s = this.stall;
    // Starts at the last good round if that was just before; after a gap, at this one.
    if (!s.fails) s.since = this.lastOkAt && at - this.lastOkAt <= SLEEP_GAP_MS ? this.lastOkAt : at;
    s.fails++;
    s.oks = 0;
    s.recoverAt = null;
    this.state.rttMs = null;
    if (!s.confirmed && s.fails >= CONFIRM_ROUNDS) {
      s.confirmed = true;
      const signal = this.#safeContext();
      s.reason = `No reply from ${this.targets.map((t) => t.label).join(' or ')}${this.gateway ? ' (router reachable)' : ''}${signal ? ` · ${signal}` : ''}`;
      this.state.stall = { since: s.since, reason: s.reason };
      this.#event('warning', `Internet stalled: ${s.reason}`);
    }
    this.#phase(s.confirmed ? 'stalled' : 'failing');
  }

  /** Can't reach the router either: no verdict on the internet, and recovery has to start over. */
  #local() {
    this.stall.oks = 0;
    this.stall.recoverAt = null;
    this.state.rttMs = null;
    this.#phase(this.stall.confirmed ? 'stalled' : 'local');
  }

  /** Store a confirmed stall ending at `end` (`note` says why it ended there, if not recovery). */
  #close(end, note = null) {
    const s = this.stall;
    if (s.confirmed) {
      this.#safely(() =>
        this.db.insertOutage({
          start_ts: s.since,
          end_ts: Math.max(end, s.since),
          reason: note ? `${s.reason} (${note})` : s.reason,
          kind: 'internet',
        }),
      );
      if (!note) this.#event('notice', `Internet restored after ${Math.round((end - s.since) / 1000)}s`);
    }
    this.stall = idle();
    if (this.state.stall) {
      this.state.stall = null;
      this.onChange();
    }
  }

  #phase(phase) {
    const changed = this.state.phase !== phase;
    this.state.phase = phase;
    if (changed) this.onChange();
  }

  /** The stall in progress, which the database only gets once it ends. For live views. */
  openOutages(now = this.now()) {
    const s = this.stall;
    return s.confirmed ? [{ kind: 'internet', start_ts: s.since, end_ts: now, reason: s.reason, ongoing: true }] : [];
  }

  #safeContext() {
    try {
      return this.context();
    } catch {
      return null;
    }
  }

  #event(level, message) {
    this.#safely(() => this.db.insertMany([{ ts: this.now(), source: 'insight', facility: 'internet', level, message }]));
  }

  /** A failing DB write is logged, never allowed to stop probing. */
  #safely(fn) {
    try {
      fn();
    } catch (e) {
      this.log.error(`[internet] database write failed: ${e.message}`);
    }
  }
}
