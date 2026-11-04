import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue } from '../../src/router/queue.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs jobs one at a time, in order', async () => {
  const q = new RequestQueue();
  const log = [];
  let running = 0;
  const job = (name) => async () => {
    running++;
    assert.equal(running, 1, 'jobs overlapped');
    log.push(name);
    await delay(5);
    running--;
    return name;
  };
  const results = await Promise.all([q.run(job('a')), q.run(job('b')), q.run(job('c'))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, ['a', 'b', 'c']);
});

test('high priority jumps ahead of queued normal jobs, not the running one', async () => {
  const q = new RequestQueue();
  const log = [];
  const job = (name) => async () => {
    log.push(name);
    await delay(5);
  };
  const all = [q.run(job('slow')), q.run(job('n1')), q.run(job('n2'))];
  all.push(q.run(job('signal'), { priority: 'high' }));
  await Promise.all(all);
  assert.deepEqual(log, ['slow', 'signal', 'n1', 'n2']);
});

test('a failing job rejects its caller without blocking the queue', async () => {
  const q = new RequestQueue();
  const failed = q.run(async () => {
    throw new Error('boom');
  });
  const ok = q.run(async () => 'next');
  await assert.rejects(failed, /boom/);
  assert.equal(await ok, 'next');
});

test('leaves a gap between back-to-back jobs and reports queue wait', async () => {
  const waits = [];
  const q = new RequestQueue({ gapMs: 40, onRun: (r) => waits.push(r) });
  const starts = [];
  const job = async () => starts.push(Date.now());
  await Promise.all([q.run(job), q.run(job)]);
  assert.ok(starts[1] - starts[0] >= 35, `gap was ${starts[1] - starts[0]} ms`);
  assert.equal(waits.length, 2);
  assert.ok(waits[1].waitMs >= 35);

  // After the queue has been idle for longer than the gap, a new job starts at once.
  await delay(50);
  const t = Date.now();
  await q.run(job);
  assert.ok(starts[2] - t < 20);
});

test('rejects an unknown priority', async () => {
  await assert.rejects(
    new RequestQueue().run(async () => {}, { priority: 'urgent' }),
    /Unknown priority/,
  );
});
