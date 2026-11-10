import test from 'node:test';
import assert from 'node:assert/strict';
import { aiDigest, createAiAdvisor, devicePseudonyms, parseAnswer, restoreNames } from '../../src/insights/ai.js';

const insights = {
  from: 0,
  to: 7 * 86400e3,
  reliability: { coveragePct: 99, availabilityPct: 99.5, wanReasons: [], recentOutages: [{ start_ts: 1 }] },
  signal: { lte: { rsrp: { avg: -100, n: 1000 } }, nr: { availabilityPct: 80 }, combos: [] },
  system: { cpu: { avg: 20 } },
  hourly: [
    { hour: 1, reliable: true, lteSinr: 9, avgDownBps: 25e6 },
    { hour: 2, reliable: false },
  ],
  devices: { known: 3, online: 2, newInRange: 0, weakWifi: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'Laptop', band: '5GHz', rssi: -80 }] },
  usage: null,
  recommendations: [
    { severity: 'warn', title: 'Weak LTE', detail: 'd', action: 'a', tryBand: 'B3' },
    { severity: 'warn', title: 'Laptop has poor Wi-Fi (-80 dBm on 5GHz)', detail: 'seen as 11:22:33:44:55:66 too', action: 'a' },
  ],
  audit: {
    score: 80,
    checks: [
      { status: 'fail', title: 'Default password' },
      { status: 'pass', title: 'Fine' },
    ],
  },
};

test('the digest keeps the numbers and drops what identifies devices', () => {
  const d = aiDigest(insights);
  const text = JSON.stringify(d);
  assert.equal(d.periodDays, 7);
  assert.deepEqual(d.hourOfDay, [{ hour: 1, lteSinr: 9, nrSinr: undefined, avgDownMbps: 25 }]);
  assert.deepEqual(d.wifi.weakClients, [{ device: 'Wi-Fi device 1', band: '5GHz', rssi: -80 }]);
  assert.equal(d.ruleFindings[1].title, 'Wi-Fi device 1 has poor Wi-Fi (-80 dBm on 5GHz)');
  assert.equal(d.ruleFindings[1].detail, 'seen as a device too', 'any other MAC is masked');
  assert.deepEqual(d.audit.issues, [{ status: 'fail', title: 'Default password' }]);
  assert.ok(!/aa:bb|11:22|Laptop|recentOutages/.test(text));
});

test("the model's stand-in names are turned back into the owner's device names", () => {
  const p = devicePseudonyms({
    devices: { weakWifi: [{ name: 'Phone', mac: 'aa' }, ...Array(11).fill({ mac: 'm' }), { name: 'TV', mac: 'bb' }] },
  });
  const a = restoreNames(
    {
      summary: "'Wi-Fi device 1' and Wi-Fi device 13 are weak.",
      recommendations: [{ title: 'Wi-Fi device 1', detail: '', action: 'Move “Wi-Fi device 13” and Wi-Fi device 1’s charger' }],
    },
    p,
  );
  assert.equal(a.summary, 'Phone and TV are weak.', 'quotes around a stand-in go');
  assert.equal(a.recommendations[0].action, 'Move TV and Phone’s charger', 'a possessive stays');
  assert.equal(a.recommendations[0].title, 'Phone');
});

test('answers are checked, trimmed and sorted by severity', () => {
  const a = parseAnswer(
    '<think>hmm</think>{"summary":" Fine. ","recommendations":[{"severity":"info","title":"2: B","detail":"","action":""},{"severity":"bogus","title":"","detail":""},{"severity":"fail","title":"A","detail":"x","action":"y"}]}',
  );
  assert.equal(a.summary, 'Fine.');
  assert.deepEqual(
    a.recommendations.map((r) => [r.severity, r.title]),
    [
      ['fail', 'A'],
      ['info', 'B'],
    ],
  );
  const idle = parseAnswer(
    '{"summary":"s","recommendations":[{"severity":"info","title":"Stable","detail":"","action":"No action needed."}]}',
  );
  assert.deepEqual(idle.recommendations, [], 'items that ask for nothing are dropped');
  assert.throws(() => parseAnswer('not json'), /JSON/);
  assert.throws(() => parseAnswer('{"summary":"","recommendations":[]}'), /empty/);
});

// chat: optional (signal) => Promise<content>, to hold or fail a generation.
function fakeOllama({ models = ['qwen3:14b'], answer, fail, chat, capabilities } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push([url, opts?.body ? JSON.parse(opts.body) : null]);
    if (fail) throw new TypeError('fetch failed');
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: models.map((name) => ({ name, model: name })) }) };
    if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ capabilities }) };
    const content = chat ? await chat(opts.signal) : JSON.stringify(answer);
    return { ok: true, json: async () => ({ message: { content } }) };
  };
  return { calls, fetch, chats: () => calls.filter(([u]) => u.endsWith('/api/chat')).length };
}

/** A chat that answers when released, or rejects when its signal aborts (like fetch). */
function heldChat() {
  const held = [];
  const chat = (signal) =>
    new Promise((resolve, reject) => {
      held.push((summary) => resolve(JSON.stringify({ summary, recommendations: [] })));
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  return { held, chat };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('advise asks the model with structured output and thinking off', async () => {
  const o = fakeOllama({ answer: { summary: 'Good', recommendations: [] } });
  const ai = createAiAdvisor({ url: 'http://x:11434/', model: 'qwen3:14b', fetch: o.fetch });
  const r = await ai.advise(insights);
  assert.equal(r.summary, 'Good');
  assert.equal(r.model, 'qwen3:14b');
  const [url, body] = o.calls.at(-1);
  assert.equal(url, 'http://x:11434/api/chat');
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(body.format.type, 'object');
  assert.equal(ai.state.available, true);
  assert.equal(ai.state.reachable, true);
  assert.equal(typeof r.at, 'number');
});

test('advise rejects with a reason when Ollama is down or the model is missing', async () => {
  const down = createAiAdvisor({ url: 'http://x:11434', model: 'qwen3:14b', fetch: fakeOllama({ fail: true }).fetch });
  await assert.rejects(down.advise(insights), /not reachable/);
  assert.equal(down.state.available, false);
  assert.equal(down.state.reachable, false);
  const missing = createAiAdvisor({ url: 'http://x:11434', model: 'qwen3:14b', fetch: fakeOllama({ models: ['llama3:8b'] }).fetch });
  await assert.rejects(missing.advise(insights), /ollama pull qwen3:14b/);
});

test('a model named without a tag matches :latest', async () => {
  const ai = createAiAdvisor({ url: 'http://x', model: 'qwen3', fetch: fakeOllama({ models: ['qwen3:latest'] }).fetch });
  assert.equal((await ai.available()).ok, true);
});

test('runs go one at a time, and a queued run whose caller leaves never reaches the model', async () => {
  const h = heldChat();
  const o = fakeOllama({ chat: h.chat });
  const ai = createAiAdvisor({ url: 'http://x', model: 'qwen3:14b', fetch: o.fetch });
  const first = ai.advise(insights);
  const gone = new AbortController();
  const second = ai.advise(insights, { signal: gone.signal });
  const third = ai.advise(insights);
  await tick();
  assert.equal(o.chats(), 1);
  assert.equal(ai.state.queued, 2);
  gone.abort(new Error('left'));
  await assert.rejects(second, /left/);
  h.held[0]('one');
  assert.equal((await first).summary, 'one');
  await tick();
  h.held[1]('three');
  assert.equal((await third).summary, 'three');
  assert.equal(o.chats(), 2, 'the abandoned run was skipped');
  assert.equal(ai.state.queued, 0);
  assert.equal(ai.state.running, false);
});

test('aborting a running generation stops the request to Ollama', async () => {
  const h = heldChat();
  const ai = createAiAdvisor({ url: 'http://x', model: 'qwen3:14b', fetch: fakeOllama({ chat: h.chat }).fetch });
  const c = new AbortController();
  const run = ai.advise(insights, { signal: c.signal });
  await tick();
  c.abort(new Error('nobody is waiting'));
  await assert.rejects(run, /nobody is waiting/);
  assert.equal(ai.state.running, false);
  assert.equal(ai.state.reachable, true, 'a cancel is not an outage');
});

test('a run that waits longer than the timeout in the queue gives up with a reason', async () => {
  // A generation stuck ahead of it (one that doesn't honour its timeout).
  let release;
  const chat = () => new Promise((resolve) => (release = () => resolve('{"summary":"done","recommendations":[]}')));
  const ai = createAiAdvisor({ url: 'http://x', model: 'qwen3:14b', timeoutMs: 300, fetch: fakeOllama({ chat }).fetch });
  const first = ai.advise(insights);
  await tick();
  await assert.rejects(ai.advise(insights), /busy with another analysis/);
  assert.equal(ai.state.queued, 0);
  release();
  assert.equal((await first).summary, 'done');
});

test('Ollama going away mid-run is reported as unreachable, not as a raw fetch error', async () => {
  let up = true;
  const fetch = async (url) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen3:14b' }] }) };
    up = false;
    throw new TypeError('fetch failed');
  };
  const ai = createAiAdvisor({ url: 'http://x:11434', model: 'qwen3:14b', fetch });
  await assert.rejects(ai.advise(insights), /Ollama is not reachable at http:\/\/x:11434/);
  assert.equal(up, false);
  assert.equal(ai.state.reachable, false);
});

test('recheck skips the cached availability, so a just-pulled model is seen', async () => {
  let models = [];
  const fetch = async (url) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models }) };
    return { ok: true, json: async () => ({ message: { content: '{"summary":"hi","recommendations":[]}' } }) };
  };
  const ai = createAiAdvisor({ url: 'http://x', model: 'qwen3:14b', fetch });
  await assert.rejects(ai.advise(insights), /not pulled/);
  models = [{ name: 'qwen3:14b' }];
  await assert.rejects(ai.advise(insights), /not pulled/, 'cached');
  assert.equal((await ai.advise(insights, { recheck: true })).summary, 'hi');
});

test('think is sent only to models that can think', async () => {
  const lastChat = (o) => o.calls.filter(([u]) => u.endsWith('/api/chat')).at(-1)[1];
  const answer = { summary: 'ok', recommendations: [] };
  const run = async (capabilities) => {
    const o = fakeOllama({ answer, capabilities, models: ['hf.co/unsloth/Qwen3.5-27B-GGUF:Q4_K_M'] });
    await createAiAdvisor({ url: 'http://x', model: 'hf.co/unsloth/Qwen3.5-27B-GGUF:Q4_K_M', fetch: o.fetch }).advise(insights);
    return lastChat(o);
  };
  assert.equal((await run(['completion', 'thinking'])).think, false);
  assert.ok(!('think' in (await run(['completion']))), 'a GGUF without thinking support gets no think');
  assert.equal((await run(undefined)).think, false, 'an older Ollama without capabilities: as before');
});
