// AI insights from a local model served by Ollama (https://ollama.com). The model reads the
// same aggregates the Insights page shows and writes a plain-language summary with prioritised
// advice. It never sees raw logs, MAC addresses or device names, and nothing leaves this machine
// unless OLLAMA_URL points elsewhere. Any failure (Ollama not running, model not pulled, timeout,
// malformed answer) falls back to the rule-based recommendations, which are always computed.

const CHECK_TTL_MS = 60e3; // how long "the model is there / isn't" is trusted
const SEVERITIES = ['fail', 'warn', 'info'];
const MAX_RECS = 8;

// Ollama's structured output: the answer must match this schema.
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          title: { type: 'string' },
          detail: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['severity', 'title', 'detail', 'action'],
      },
    },
  },
  required: ['summary', 'recommendations'],
};

const SYSTEM_PROMPT = `You are a network engineer reviewing a home 4G/5G fixed wireless router (Zyxel FWA505) for its owner.
You get JSON aggregates collected over a period: reliability, signal (RSRP in dBm, SINR in dB), band history, router load, Wi-Fi clients, data usage, a configuration audit, and rule-based findings already computed from the same data.
Write for a non-expert:
- "summary": 2-4 sentences on how the connection has been and the single most important thing to do.
- "recommendations": at most ${MAX_RECS}, most important first. Each has severity (fail = act now, warn = worth fixing, info = optional), a short title with the key number, a detail explaining why using the numbers given, and one concrete action.
Rules: use only numbers present in the data, never invent readings, bands or events. Keep the rule-based findings' facts but you may merge, reword or reprioritise them. Judge a home connection strictly: availability below 99.9% is worth mentioning and below 99% is unreliable; SINR below 10 dB limits speed and below 3 dB is poor; RSRP below -105 dBm is weak. Only include something the owner can act on: leave out anything that is fine, and never write an item whose action is "no action needed" or "keep monitoring". If the data is thin (little coverage, few samples) say so instead of guessing.
The owner's dashboard has a Radio control page (lock bands as a trial), a Speed page (run speed tests and see what limits speed) and a Placement page (compare router positions): suggest these where they fit, and nothing else of the dashboard.
Wi-Fi devices are named "Wi-Fi device 1", "Wi-Fi device 2" and so on: refer to them by exactly those names.
Plain English, no markdown, no numbering in titles.`;

const MAC_RE = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;

/**
 * Pure: stand-in names for the devices the insights mention, so the model never sees a device's
 * name or MAC address. [{ label: 'Wi-Fi device 1', ids: [name, mac], shown: name ?? mac }]
 */
export function devicePseudonyms(insights) {
  return (insights.devices?.weakWifi ?? []).map((w, i) => ({
    label: `Wi-Fi device ${i + 1}`,
    ids: [w.name, w.mac].filter(Boolean),
    shown: w.name || w.mac,
  }));
}

/** Pure: `text` with every device name and MAC replaced by its stand-in (any other MAC masked). */
function pseudonymise(text, pseudonyms) {
  let out = String(text ?? '');
  for (const p of pseudonyms) for (const id of p.ids) out = out.split(id).join(p.label);
  return out.replace(MAC_RE, 'a device');
}

/** Pure: the model's answer with the stand-ins turned back into the names the owner knows. */
export function restoreNames(answer, pseudonyms) {
  // Longest label first, so "Wi-Fi device 1" doesn't eat the start of "Wi-Fi device 12".
  const byLength = [...pseudonyms].sort((a, b) => b.label.length - a.label.length);
  // Models like to quote a name ("check 'Wi-Fi device 1'"): the real name needs no quotes.
  const quoted = (label) => new RegExp([`'${label}'`, `"${label}"`, `‘${label}’`, `“${label}”`, label].join('|'), 'g');
  const restore = (text) => byLength.reduce((t, p) => t.replace(quoted(p.label), () => p.shown), text);
  return {
    ...answer,
    summary: restore(answer.summary),
    recommendations: answer.recommendations.map((r) => ({
      ...r,
      title: restore(r.title),
      detail: restore(r.detail),
      action: restore(r.action),
    })),
  };
}

/**
 * Pure: the facts the model gets, from computeInsights() output plus the audit. Devices appear
 * only under stand-in names (see devicePseudonyms), and lists the model doesn't need (raw event
 * rows) are left out.
 */
export function aiDigest(insights, pseudonyms = devicePseudonyms(insights)) {
  const anon = (text) => pseudonymise(text, pseudonyms);
  const { reliability: rel, signal, system, hourly, devices, usage, recommendations, audit } = insights;
  const stat = (s) => (s ? { avg: s.avg, p10: s.p10, min: s.min, max: s.max, samples: s.n } : null);
  return {
    periodDays: Math.round(((insights.to - insights.from) / 86400e3) * 10) / 10,
    reliability: rel && {
      monitoredPct: rel.coveragePct,
      availabilityPct: rel.availabilityPct,
      downtimeSec: rel.downtimeSec,
      longestOutageSec: rel.longestOutageSec,
      routerUnreachable: rel.routerOutages,
      mobileDataDrops: rel.wanOutages,
      mobileDataDownSec: rel.wanDownSec,
      dropReasons: rel.wanReasons?.map((r) => ({ ...r, reason: anon(r.reason) })),
      internetStalls: rel.internetStalls,
      internetStallSec: rel.internetStallSec,
      reboots: rel.reboots,
      unexplainedReboots: rel.unexpectedReboots,
    },
    signal: signal && {
      lte: { rsrp: stat(signal.lte.rsrp), sinr: stat(signal.lte.sinr), rsrpQualityPct: signal.lte.rsrpDist },
      nr5g: {
        rsrp: stat(signal.nr.rsrp),
        sinr: stat(signal.nr.sinr),
        rsrpQualityPct: signal.nr.rsrpDist,
        availablePct: signal.nr.availabilityPct,
      },
      handovers: signal.handovers,
      carrierComboChanges: signal.comboChanges,
      distinctCells: signal.distinctCells,
      combos: signal.combos?.slice(0, 5),
    },
    routerLoad: system,
    // Only hours seen on enough days to compare.
    hourOfDay: (hourly ?? [])
      .filter((h) => h.reliable)
      .map((h) => ({ hour: h.hour, lteSinr: h.lteSinr, nrSinr: h.nrSinr, avgDownMbps: mbps(h.avgDownBps) })),
    wifi: devices && {
      knownDevices: devices.known,
      online: devices.online,
      newInPeriod: devices.newInRange,
      weakClients: devices.weakWifi.map((w, i) => ({ device: pseudonyms[i]?.label, band: w.band, rssi: w.rssi })),
    },
    usage: usage && {
      downloadGB: gb(usage.totals?.rx),
      uploadGB: gb(usage.totals?.tx),
      monthUsedGB: gb(usage.month?.used),
      monthProjectedGB: gb(usage.month?.projected),
    },
    audit: audit?.checks
      ? {
          score: audit.score,
          issues: audit.checks
            .filter((c) => c.status === 'fail' || c.status === 'warn')
            .map((c) => ({ status: c.status, title: anon(c.title) })),
        }
      : null,
    ruleFindings: (recommendations ?? []).map((r) => ({ severity: r.severity, title: anon(r.title), detail: anon(r.detail) })),
  };
}

const mbps = (bps) => (bps == null ? null : Math.round(bps / 1e5) / 10);
const gb = (bytes) => (bytes == null ? null : Math.round(bytes / 1e7) / 100);

/** Pure: the model's answer, checked and trimmed; throws if it isn't usable. */
export function parseAnswer(text) {
  // Reasoning models may still wrap the JSON in a <think> block.
  const json = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('the model did not answer in JSON');
  }
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const summary = str(raw?.summary);
  const recommendations = (Array.isArray(raw?.recommendations) ? raw.recommendations : [])
    .map((r) => ({
      severity: SEVERITIES.includes(r?.severity) ? r.severity : 'info',
      title: str(r?.title).replace(/^\s*(#?\d+[.:)]|[-*•])\s*/, ''), // "1: Fix drops" -> "Fix drops"
      detail: str(r?.detail),
      action: str(r?.action),
    }))
    // An item that asks for nothing isn't a recommendation, whatever the model was told.
    .filter((r) => r.title && !/^(no (action|change)s? (is )?(needed|required)|none\b)/i.test(r.action))
    .slice(0, MAX_RECS);
  if (!summary && !recommendations.length) throw new Error('the model returned an empty answer');
  const rank = { fail: 0, warn: 1, info: 2 };
  return { summary, recommendations: recommendations.sort((a, b) => rank[a.severity] - rank[b.severity]) };
}

/**
 * Ollama client. url: e.g. http://127.0.0.1:11434; model: e.g. qwen3:14b.
 * advise(insights, { signal, recheck }) resolves to { summary, recommendations, model, ms, at } or
 * rejects with a reason. Aborting `signal` drops a queued run or stops a running one.
 */
export function createAiAdvisor({ url, model, timeoutMs = 120e3, fetch = globalThis.fetch, now = () => Date.now() }) {
  const base = url.replace(/\/+$/, '');
  let check = null; // { at, ok, reason }
  let thinks = null; // the model supports thinking (null: unknown)
  let tail = Promise.resolve(); // one generation at a time: a 14B model saturates the machine
  // reachable: Ollama answers at all (false hides the AI view); available: and has the model.
  const state = {
    model,
    url: base,
    reachable: null,
    available: null,
    reason: null,
    lastRunAt: null,
    lastMs: null,
    running: false,
    queued: 0,
  };
  const unreachable = `Ollama is not reachable at ${base}`;

  function setCheck(ok, reachable, reason) {
    check = { at: now(), ok, reason };
    Object.assign(state, { reachable, available: ok, reason });
    return check;
  }

  async function call(path, opts, ms, signal) {
    const timeout = AbortSignal.timeout(ms);
    let res;
    try {
      res = await fetch(`${base}${path}`, { ...opts, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      setCheck(false, false, unreachable); // Ollama went away: say so without waiting for the next check
      throw new Error(unreachable);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Ollama answered ${res.status}`);
    }
    return res.json();
  }

  /**
   * Does the model support thinking? Ollama rejects `think` for one that doesn't (often a GGUF
   * pulled from Hugging Face). null = unknown (older Ollama, no capabilities): send it, as before.
   */
  async function canThink() {
    try {
      const { capabilities } = await call('/api/show', { method: 'POST', body: JSON.stringify({ model }) }, 3000);
      return Array.isArray(capabilities) ? capabilities.includes('thinking') : null;
    } catch {
      return null;
    }
  }

  /** Is Ollama up with the model pulled? Cached for CHECK_TTL_MS unless `force`. */
  async function available({ force = false } = {}) {
    if (!force && check && now() - check.at < CHECK_TTL_MS) return check;
    try {
      const { models = [] } = await call('/api/tags', {}, 3000);
      const want = model.includes(':') ? model : `${model}:latest`;
      const ok = models.some((m) => m.name === want || m.model === want);
      if (ok) thinks = await canThink();
      return setCheck(ok, true, ok ? null : `model ${model} is not pulled (run: ollama pull ${model})`);
    } catch (e) {
      return setCheck(false, false, e.name === 'TimeoutError' ? 'Ollama did not answer' : unreachable);
    }
  }

  async function generate(insights, signal) {
    const started = now();
    const pseudonyms = devicePseudonyms(insights);
    const body = {
      model,
      stream: false,
      // Thinking models (qwen3) think by default: slower, and the reasoning isn't shown.
      ...(thinks === false ? {} : { think: false }),
      format: ANSWER_SCHEMA,
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(aiDigest(insights, pseudonyms)) },
      ],
    };
    const out = await call(
      '/api/chat',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      timeoutMs,
      signal,
    ).catch((e) => {
      throw e.name === 'TimeoutError' ? new Error(`the model took longer than ${Math.round(timeoutMs / 1000)} s`) : e;
    });
    const answer = restoreNames(parseAnswer(out?.message?.content), pseudonyms);
    state.lastRunAt = now();
    state.lastMs = state.lastRunAt - started;
    return { ...answer, model, ms: state.lastMs, at: state.lastRunAt };
  }

  /**
   * Run `task` after the ones already queued. A task still waiting after timeoutMs, or whose
   * signal aborts while it waits, is dropped without running.
   */
  function enqueue(task, signal) {
    return new Promise((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        state.queued--;
        clearTimeout(wait);
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const drop = (e) => leave() && reject(e);
      const onAbort = () => drop(signal.reason);
      const wait = setTimeout(() => drop(new Error('the model is busy with another analysis: try again in a minute')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      state.queued++;
      tail = tail.then(async () => {
        if (!leave()) return; // dropped while waiting
        state.running = true;
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        } finally {
          state.running = false;
        }
      });
    });
  }

  return {
    state,
    available,
    async advise(insights, { signal, recheck = false } = {}) {
      signal?.throwIfAborted();
      const c = await available({ force: recheck });
      if (!c.ok) throw new Error(c.reason);
      return enqueue(() => (signal?.throwIfAborted(), generate(insights, signal)), signal);
    },
  };
}
