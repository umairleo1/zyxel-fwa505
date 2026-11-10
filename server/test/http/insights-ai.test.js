import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { fakeDeps, serve } from './helpers.js';

async function setup(t, ai) {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-ai-')), 'a.db'));
  const routerData = { raw: async () => ({ data: {} }), has: () => true };
  const s = await serve(fakeDeps({ db, routerData, ai }));
  t.after(async () => {
    await s.close();
    db.close();
  });
  const get = async (q = '') => JSON.parse((await s.request(`/api/insights/ai${q}`)).body);
  // Start a request and hang up on it before the answer.
  get.abandon = (q = '') => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: `/api/insights/ai${q}`, headers: { host: `localhost:${s.port}` } });
    req.on('error', () => {});
    req.end();
    return () => req.destroy();
  };
  return get;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A fake advisor whose runs finish when the test says so. */
function slowAi() {
  const runs = [];
  return {
    runs,
    state: { model: 'qwen3:14b' },
    advise: (_insights, { signal, recheck }) =>
      new Promise((resolve, reject) => {
        const run = {
          signal,
          recheck,
          finish: (summary) => resolve({ summary, recommendations: [], model: 'qwen3:14b', ms: 5, at: Date.now() }),
        };
        runs.push(run);
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  };
}

test('without AI the endpoint returns the rule-based recommendations', async (t) => {
  const get = await setup(t, null);
  const r = await get();
  assert.equal(r.source, 'rules');
  assert.ok(Array.isArray(r.recommendations));
  assert.match(r.reason, /turned off/);
});

test('a failing model falls back to rules with the reason, and is retried next time', async (t) => {
  let n = 0;
  const ai = {
    state: { model: 'qwen3:14b' },
    advise: async () => {
      n++;
      throw new Error('Ollama is not reachable');
    },
  };
  const get = await setup(t, ai);
  const r = await get();
  assert.equal(r.source, 'rules');
  assert.equal(r.reason, 'Ollama is not reachable');
  await get();
  assert.equal(n, 2, 'failures are not cached');
});

test('a model answer is served and reused for the same period', async (t) => {
  let n = 0;
  const ai = {
    state: { model: 'qwen3:14b' },
    advise: async () => (n++, { summary: 'All good', recommendations: [], model: 'qwen3:14b', ms: 5 }),
  };
  const get = await setup(t, ai);
  const r = await get();
  assert.equal(r.source, 'ai');
  assert.equal(r.summary, 'All good');
  await get();
  assert.equal(n, 1);
});

test('fresh=0 (or false) serves the cached answer; fresh=1 regenerates', async (t) => {
  let n = 0;
  const ai = {
    state: { model: 'qwen3:14b' },
    advise: async () => (n++, { summary: `run ${n}`, recommendations: [], model: 'qwen3:14b', ms: 5, at: Date.now() }),
  };
  const get = await setup(t, ai);
  assert.equal((await get()).summary, 'run 1');
  assert.equal((await get('?fresh=0')).summary, 'run 1');
  assert.equal((await get('?fresh=false')).summary, 'run 1');
  assert.equal((await get('?fresh=1')).summary, 'run 2');
  assert.equal((await get('?fresh=1')).summary, 'run 2', 'regenerating is rate-limited per span');
  assert.equal(n, 2);
});

test('asking again while a run is in progress joins it instead of queueing another', async (t) => {
  const ai = slowAi();
  const get = await setup(t, ai);
  const a = get();
  await tick();
  const b = get('?fresh=1');
  await tick();
  assert.equal(ai.runs.length, 1);
  ai.runs[0].finish('shared');
  assert.deepEqual([(await a).summary, (await b).summary], ['shared', 'shared']);
});

test('a run nobody waits for any more is stopped, and the next request starts afresh', async (t) => {
  const ai = slowAi();
  const get = await setup(t, ai);
  const hangUp = get.abandon();
  await tick();
  const kept = get();
  await tick();
  hangUp();
  await tick();
  assert.equal(ai.runs[0].signal.aborted, false, 'still wanted by the second request');
  ai.runs[0].finish('ok');
  assert.equal((await kept).summary, 'ok');

  const hangUp2 = get.abandon('?from=0');
  await tick();
  hangUp2();
  await tick();
  assert.equal(ai.runs[1].signal.aborted, true);
  const again = get('?from=0');
  await tick();
  assert.equal(ai.runs.length, 3, 'the stopped run is not reused');
  ai.runs[2].finish('again');
  assert.equal((await again).summary, 'again');
});
