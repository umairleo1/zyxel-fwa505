import test from 'node:test';
import assert from 'node:assert/strict';
import { createRebootService, MIN_GAP_MS } from '../../src/router/reboot.js';
import { RouterError } from '../../src/router/client.js';

function harness({ enabled = true, meta = {}, fail = null } = {}) {
  let t = 1_000_000;
  const calls = [];
  const log = [];
  const expected = [];
  const client = {
    reboot: async () => {
      calls.push(t);
      if (fail) throw fail;
      return { result: 'ZCFG_SUCCESS' };
    },
  };
  const db = {
    insertMany: (rows) => log.push(...rows.map((r) => `${r.level}: ${r.message}`)),
    getMeta: (k) => meta[k] ?? null,
    setMeta: (k, v) => (meta[k] = v),
  };
  const collector = { expectRestart: (at) => expected.push(at) };
  const reboot = createRebootService({ client, db, collector, enabled, now: () => t });
  return { reboot, calls, log, expected, meta, advance: (ms) => (t += ms) };
}

test('restarts the router, logs it first and tells the collector to expect it', async () => {
  const h = harness();
  await h.reboot.reboot();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.log, ['notice: Router restart requested from Insight']);
  assert.deepEqual(h.expected, [1_000_000]);
  assert.equal(h.reboot.lastAt, 1_000_000);
});

test('a second restart within the gap is refused, even after Insight restarts', async () => {
  const h = harness();
  await h.reboot.reboot();
  h.advance(60_000);
  await assert.rejects(h.reboot.reboot(), (e) => e.status === 429);
  // A new service reading the same meta (Insight restarted) still enforces the gap.
  const again = createRebootService({
    client: { reboot: async () => assert.fail('must not restart') },
    db: { insertMany: () => {}, getMeta: (k) => h.meta[k], setMeta: () => {} },
    enabled: true,
    now: () => 1_000_000 + 120_000,
  });
  await assert.rejects(again.reboot(), (e) => e.status === 429);
  h.advance(MIN_GAP_MS);
  await h.reboot.reboot();
  assert.equal(h.calls.length, 2);
});

test('a refused restart can be tried again at once; a dropped connection keeps the gap', async () => {
  const refused = harness({ fail: new RouterError('http', 'Restart refused by the router: busy') });
  await assert.rejects(refused.reboot.reboot(), /refused/);
  assert.equal(refused.reboot.lastAt, null);
  assert.match(refused.log.at(-1), /^err: Router restart failed/);

  const dropped = harness({ fail: new RouterError('network', 'socket hang up') });
  await assert.rejects(dropped.reboot.reboot(), /hang up/);
  assert.equal(dropped.reboot.lastAt, 1_000_000);
});

test('disabled: refuses without touching the router', async () => {
  const h = harness({ enabled: false });
  await assert.rejects(h.reboot.reboot(), (e) => e.status === 404);
  assert.equal(h.calls.length, 0);
});
