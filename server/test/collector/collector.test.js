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
    recordCarriers() {},
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
    suspend() {},
    resume() {},
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
    recordCarriers() {},
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
    suspend() {},
    resume() {},
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

/** Client whose getLog blocks until release(); counts calls and concurrency. */
function blockingHarness() {
  const calls = { log: 0, status: 0, maxConcurrent: 0, suspended: 0, resumed: [] };
  let active = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const enter = async (fn) => {
    active++;
    calls.maxConcurrent = Math.max(calls.maxConcurrent, active);
    try {
      return await fn();
    } finally {
      active--;
    }
  };
  const client = {
    getLog: () =>
      enter(async () => {
        calls.log++;
        await gate;
        return [];
      }),
    getStatus: () => enter(async () => (calls.status++, { Object: [{ DeviceInfo: { UpTime: 100 } }] })),
    getCellwanStatus: async () => ({}),
    logout: async () => {},
    suspend: () => calls.suspended++,
    resume: (o) => calls.resumed.push(o),
  };
  const db = {
    lastRaw: () => [],
    insertMany() {},
    insertOutage() {},
    insertMetric() {},
    recordCarriers() {},
    insertSystem() {},
    getMeta: () => null,
    setMeta() {},
    logsBetween: () => [],
  };
  const c = new Collector({ client, db, pollIntervalSec: 120, statusIntervalSec: 5, log: { warn() {}, info() {}, error() {} } });
  return { c, calls, release };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('pause during a poll stops it before the next router request', async () => {
  const { c, calls, release } = blockingHarness();
  const tick = c.tickForTest();
  await settle();
  await c.pause();
  release();
  await tick;
  assert.equal(calls.suspended, 1, 'client suspended before logout');
  assert.equal(calls.log, 1, 'the second log was not requested');
  assert.equal(calls.status, 0, 'status was not requested');
  assert.equal(c.state.phase, 'paused');
  await c.stop();
});

test('resume while a paused poll is still unwinding never runs two polls at once', async () => {
  const { c, calls, release } = blockingHarness();
  const tick = c.tickForTest();
  await settle();
  await c.pause();
  c.resume(); // schedules a tick at once, while the first is still waiting on the router
  await settle();
  release();
  await tick;
  await settle();
  assert.equal(calls.maxConcurrent, 1);
  await c.stop();
});

test('pollNow during a poll is not lost', async () => {
  const { c, release } = blockingHarness();
  c.state.phase = 'ok';
  const tick = c.tickForTest();
  await settle();
  c.pollNow(); // e.g. an SNMP trap arrives mid-poll
  release();
  await tick;
  assert.equal(c.lastLogPoll, 0, 'logs are due again on the next tick');
  await c.stop();
});

test('a changed router certificate halts the collector, and Retry trusts the new one', async () => {
  const { RouterError } = await import('../../src/router/client.js');
  const { c, calls } = blockingHarness();
  c.client.getLog = async () => {
    throw new RouterError('tls', "The router's TLS certificate changed");
  };
  await c.tickForTest();
  assert.equal(c.state.phase, 'halted');
  c.resume();
  assert.deepEqual(calls.resumed, [{ trustNewCertificate: true }]);
  await c.stop();
});

test('a wall-clock step between reads is not a reboot', async (t) => {
  const meta = new Map();
  const h = rebootHarness(meta, 86400);
  await h.c.tickForTest();
  // NTP sync on a Pi without an RTC: the clock jumps an hour while ~1 s of uptime passes.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3600e3 });
  h.c.client.getStatus = async () => ({ Object: [{ DeviceInfo: { UpTime: 86401 } }] });
  h.c.lastStatusPoll = 0;
  h.c.fullStatus = null;
  await h.c.tickForTest();
  t.mock.timers.reset();
  assert.equal(h.reboots.length, 0);
  await h.c.stop();
});
