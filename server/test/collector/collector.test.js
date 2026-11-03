import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../../src/collector/collector.js';
import { RouterError } from '../../src/router/client.js';

function harness(script) {
  const outages = [];
  const db = {
    lastRaw: () => [],
    insertMany() {},
    insertOutage: (o) => outages.push(o),
    insertMetric() {},
    insertSystem() {},
    getMeta: () => null,
    setMeta() {},
    logsBetween: () => [],
  };
  let i = 0;
  const client = {
    async getLog() {
      const step = script[i++] ?? 'ok';
      if (step === 'fail') throw new RouterError('network', 'socket hang up');
      return [];
    },
    async getStatus() {
      return { Object: [{ DeviceInfo: { UpTime: 100 } }] };
    },
    async getCellwanStatus() {
      return {};
    },
    async logout() {},
  };
  const c = new Collector({ client, db, pollIntervalSec: 120, statusIntervalSec: 5, log: { warn() {}, info() {} } });
  return { c, outages };
}

test('a single failed request is a glitch, not an outage', async () => {
  const { c, outages } = harness(['ok', 'fail', 'ok']);
  for (let k = 0; k < 3; k++) {
    c.lastLogPoll = 0;
    await c.tickForTest();
  }
  assert.equal(outages.length, 0);
  await c.stop();
});

test('after a long sleep, an outage starts at the first failure, not the last success before sleep', async () => {
  const { c, outages } = harness(['ok', 'fail', 'fail', 'ok']);
  c.lastLogPoll = 0;
  await c.tickForTest();
  c.state.lastSuccessAt = Date.now() - 8 * 3600e3; // Mac slept for 8 h
  const wake = Date.now();
  for (let k = 0; k < 3; k++) {
    c.lastLogPoll = 0;
    await c.tickForTest();
  }
  assert.equal(outages.length, 1);
  assert.ok(outages[0].start_ts >= wake, 'outage must not include the sleep');
  assert.ok(outages[0].end_ts - outages[0].start_ts < 60_000);
  await c.stop();
});

function rebootHarness(meta, uptimeSec, logs = []) {
  const reboots = [];
  const events = [];
  const db = {
    lastRaw: () => [],
    insertMany: (rows) => events.push(...rows),
    insertOutage() {},
    insertMetric() {},
    insertSystem() {},
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => meta.set(k, String(v)),
    logsBetween: () => logs,
    insertReboot: (r) => reboots.push(r),
  };
  const client = {
    async getLog() {
      return [];
    },
    async getStatus() {
      return { Object: [{ DeviceInfo: { UpTime: uptimeSec } }] };
    },
    async getCellwanStatus() {
      return {};
    },
    async logout() {},
  };
  const c = new Collector({ client, db, pollIntervalSec: 120, statusIntervalSec: 5, log: { warn() {}, info() {} } });
  return { c, reboots, events };
}

test('a reboot that happened while Insight was not running is detected with the real boot time', async () => {
  const meta = new Map(); // persisted in SQLite in real use
  const first = rebootHarness(meta, 3 * 86400); // router up 3 days
  await first.c.tickForTest();
  await first.c.stop();
  assert.equal(first.reboots.length, 0);

  // Insight restarts later; meanwhile the router power-cycled and has been up 90 s.
  const second = rebootHarness(meta, 90);
  await second.c.tickForTest();
  await second.c.stop();
  assert.equal(second.reboots.length, 1);
  assert.equal(second.reboots[0].kind, 'unexplained');
  assert.ok(Math.abs(second.reboots[0].boot_ts - (Date.now() - 90_000)) < 2000, 'boot time from uptime');
  assert.match(second.events.at(-1).message, /no reason in the router log/);
});

test('a reboot is marked expected when the router log explains it', async () => {
  const meta = new Map([['bootedAt', String(Date.now() - 5 * 86400e3)]]);
  const h = rebootHarness(meta, 60, [{ ts: Date.now() - 120_000, message: 'System reboot by FOTA firmware upgrade' }]);
  await h.c.tickForTest();
  await h.c.stop();
  assert.equal(h.reboots[0].kind, 'expected');
  assert.match(h.reboots[0].reason, /FOTA/);
});

test('uptime jitter is not mistaken for a reboot', async () => {
  const meta = new Map([['bootedAt', String(Date.now() - 86400e3 - 1500)]]);
  const h = rebootHarness(meta, 86400);
  await h.c.tickForTest();
  await h.c.stop();
  assert.equal(h.reboots.length, 0);
});
