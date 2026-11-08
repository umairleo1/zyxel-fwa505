// One speed test, run from this machine through the router: idle latency, then download and
// upload over parallel HTTP streams with latency probed during each, which is what shows
// bufferbloat. It measures the whole path, so this machine's own link counts too: run Insight
// wired to the router (or close to it) for numbers that are about the mobile connection.
import { performance } from 'node:perf_hooks';
import { tcpProbe } from '../collector/internet.js';

const clock = () => performance.now();
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const DOWN_CHUNK = 25_000_000; // bytes asked for per download request; streams loop until time is up
const UP_CHUNK = 8_000_000; // bytes per upload request
const UP_PIECE = new Uint8Array(64 * 1024); // the upload body, fed in pieces so progress is counted as it's sent
const SAMPLE_MS = 200; // throughput sampling
const LOADED_PROBE_MS = 300; // latency probes during a transfer
const IDLE_PROBES = 8;
// The first part of a transfer is TCP ramping up (and the OS filling its send buffer on
// upload): speed is taken from what follows, as other speed tests do.
const WARMUP_SHARE = 0.3;

export const DEFAULTS = {
  downMs: 8000,
  upMs: 6000,
  streams: 4,
  maxBytes: 300e6, // per test, download and upload together: a ceiling on data used
  probeTimeoutMs: 2000,
};

const isAbort = (e) => e?.name === 'AbortError';
const abortError = () => Object.assign(new Error('Speed test cancelled'), { name: 'AbortError' });

/**
 * Bytes over time → Mbps over the steady part (after warm-up). Pure; exported for tests.
 * samples: [{ t (ms), bytes (cumulative) }] in time order.
 */
export function steadyMbps(samples, warmupShare = WARMUP_SHARE) {
  if (samples.length < 2) return null;
  const t0 = samples[0].t;
  const span = samples.at(-1).t - t0;
  const from = samples.find((s) => s.t - t0 >= span * warmupShare) ?? samples[0];
  const to = samples.at(-1);
  const ms = to.t - from.t;
  if (ms <= 0) return span > 0 ? ((to.bytes - samples[0].bytes) * 8) / span / 1000 : null;
  return Math.round((((to.bytes - from.bytes) * 8) / ms / 1000) * 10) / 10;
}

/** Mean absolute difference between consecutive round trips. Pure. */
export function jitter(rtts) {
  if (rtts.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < rtts.length; i++) sum += Math.abs(rtts[i] - rtts[i - 1]);
  return Math.round(sum / (rtts.length - 1));
}

const mid = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * Run one test. Resolves { downMbps, upMbps, idleMs, jitterMs, loadedDownMs, loadedUpMs,
 * bytesDown, bytesUp, durationMs }; rejects with an AbortError if `signal` aborts, or an
 * Error when a direction moved no data at all.
 *
 * downUrl: a URL with `{bytes}` where the size goes (Cloudflare's speed endpoint by default);
 * upUrl: accepts POSTed bytes; latencyTarget: { host, port } for TCP handshake timing.
 */
export async function runSpeedTest({
  downUrl,
  upUrl,
  latencyTarget,
  downMs = DEFAULTS.downMs,
  upMs = DEFAULTS.upMs,
  streams = DEFAULTS.streams,
  maxBytes = DEFAULTS.maxBytes,
  probeTimeoutMs = DEFAULTS.probeTimeoutMs,
  signal,
  onProgress = () => {},
  probe = tcpProbe,
  fetchImpl = fetch,
  now = clock,
}) {
  const started = now();
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  check();

  // Idle latency, before anything loads the line.
  onProgress({ phase: 'latency' });
  const idle = [];
  for (let i = 0; i < IDLE_PROBES; i++) {
    check();
    const r = await probe(latencyTarget, probeTimeoutMs);
    if (r.ok) idle.push(r.rttMs);
    await sleep(100, signal);
  }
  check();
  const idleMs = mid(idle);

  // Download gets most of the data budget: it's the faster direction on mobile.
  const down = await transfer({ direction: 'download', ms: downMs, budget: maxBytes * 0.75 });
  const up = await transfer({ direction: 'upload', ms: upMs, budget: maxBytes * 0.25 });

  return {
    downMbps: down.mbps,
    upMbps: up.mbps,
    idleMs,
    jitterMs: jitter(idle),
    loadedDownMs: down.loadedMs,
    loadedUpMs: up.loadedMs,
    bytesDown: down.bytes,
    bytesUp: up.bytes,
    durationMs: Math.round(now() - started),
  };

  /** Run `streams` parallel requests for `ms` (or until `budget` bytes), probing latency meanwhile. */
  async function transfer({ direction, ms, budget }) {
    onProgress({ phase: direction, mbps: null, latencyMs: null });
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const t0 = now();
    const deadline = t0 + ms;
    let bytes = 0;
    let lastError = null;
    const samples = [{ t: t0, bytes: 0 }];
    const loaded = [];
    const done = () => ctrl.signal.aborted || now() >= deadline || bytes >= budget;
    const count = (n) => {
      bytes += n;
      if (bytes >= budget) stop();
    };

    const sampler = setInterval(() => {
      samples.push({ t: now(), bytes });
      onProgress({ phase: direction, mbps: steadyMbps(samples), latencyMs: loaded.at(-1) ?? null });
      if (now() >= deadline) stop();
    }, SAMPLE_MS);

    const prober = (async () => {
      await sleep(LOADED_PROBE_MS, ctrl.signal); // let the transfer start before judging it
      while (!done()) {
        const r = await probe(latencyTarget, probeTimeoutMs);
        if (done()) break;
        // A probe lost under load is bufferbloat at its worst: count it as the timeout.
        loaded.push(r.ok ? r.rttMs : probeTimeoutMs);
        await sleep(LOADED_PROBE_MS, ctrl.signal);
      }
    })();

    const worker = async () => {
      while (!done()) {
        try {
          if (direction === 'download') await downloadOnce(ctrl.signal, count);
          else await uploadOnce(ctrl.signal, count, () => done());
        } catch (e) {
          if (ctrl.signal.aborted) break;
          lastError = e;
          await sleep(250, ctrl.signal); // a refused request shouldn't spin
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: streams }, worker));
    } finally {
      clearInterval(sampler);
      stop();
      signal?.removeEventListener('abort', stop);
      await prober;
    }
    check();
    samples.push({ t: now(), bytes });
    if (!bytes) throw new Error(`${direction === 'download' ? 'Download' : 'Upload'} failed: ${lastError?.message ?? 'no data moved'}`);
    return { mbps: steadyMbps(samples), loadedMs: mid(loaded), bytes };
  }

  async function downloadOnce(abort, count) {
    const res = await fetchImpl(downUrl.replace('{bytes}', String(DOWN_CHUNK)), {
      signal: abort,
      cache: 'no-store',
      headers: { 'accept-encoding': 'identity' }, // count bytes on the wire, not decompressed ones
    });
    if (!res.ok || !res.body) throw new Error(`download server answered ${res.status}`);
    try {
      for await (const chunk of res.body) count(chunk.byteLength);
    } catch (e) {
      if (!isAbort(e) && !abort.aborted) throw e;
    }
  }

  async function uploadOnce(abort, count, done) {
    let sent = 0;
    const body = new ReadableStream({
      pull(c) {
        if (sent >= UP_CHUNK || done()) return c.close();
        sent += UP_PIECE.byteLength;
        count(UP_PIECE.byteLength);
        c.enqueue(UP_PIECE);
      },
    });
    try {
      const res = await fetchImpl(upUrl, {
        method: 'POST',
        body,
        duplex: 'half',
        signal: abort,
        headers: { 'content-type': 'application/octet-stream' },
      });
      await res.arrayBuffer().catch(() => {});
      if (!res.ok) throw Object.assign(new Error(`upload server answered ${res.status}`), { refused: true });
    } catch (e) {
      if (isAbort(e) || abort.aborted) return; // cut off at the deadline: what went out still counts
      // Refused or failed: those bytes didn't make it, so they're no throughput.
      count(-sent);
      throw e;
    }
  }
}
