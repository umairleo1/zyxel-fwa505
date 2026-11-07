import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../../src/collector/collector.js';
import { createRouterData } from '../../src/router/data.js';
import { healthOf } from '../../src/http/health.js';

test('maintenance drains the active poll without logout and resumes collection afterwards', async () => {
  let finishRead;
  let reads = 0;
  let logouts = 0;
  const client = {
    getLog: async () => {
      reads++;
      if (reads === 1) await new Promise((resolve) => (finishRead = resolve));
      return [];
    },
    getStatus: async () => ({ Object: [{ DeviceInfo: { UpTime: 10 } }] }),
    getCellwanStatus: async () => ({}),
    logout: async () => logouts++,
  };
  const db = {
    lastRaw: () => [],
    insertMany() {},
    getMeta: () => null,
    setMeta() {},
    insertSystem() {},
    insertMetric() {},
    recordCarriers() {},
    logsBetween: () => [],
  };
  const collector = new Collector({ client, db, pollIntervalSec: 120, statusIntervalSec: 5, log: { warn() {} } });
  const poll = collector.tickForTest();
  assert.equal(reads, 1);
  const hold = collector.beginMaintenance('Restore configuration');
  assert.ok(collector.state.maintenance);
  finishRead();
  await Promise.all([poll, hold]);
  assert.equal(reads, 1, 'the remaining log read was stopped at the maintenance boundary');
  assert.equal(logouts, 0, 'the maintenance operation keeps the existing session');
  await collector.tickForTest();
  assert.equal(reads, 1);
  collector.endMaintenance();
  await collector.tickForTest();
  assert.equal(reads, 3);
  await collector.stop();
});

test('maintenance blocks uncached sampler reads and marks cached values stale', async () => {
  let hits = 0;
  const collector = { state: { phase: 'ok', maintenance: null } };
  const client = {
    async getJson(path) {
      hits++;
      client.onResponse(path, { Object: [{ Name: 'WAN' }] });
    },
  };
  const data = createRouterData({ client, collector });
  await data.raw('wan', 0);
  collector.state.maintenance = { reason: 'Firmware upgrade', since: Date.now() };
  assert.equal((await data.raw('wan', 0)).stale, true);
  await assert.rejects(data.raw('user_account', 0), (e) => e.status === 409);
  assert.equal(hits, 1);
  data.invalidate();
  await assert.rejects(data.raw('wan', 0), (e) => e.status === 409);
});

test('an intentional maintenance hold does not report stale collector health', () => {
  const state = { phase: 'ok', lastSuccessAt: 1, maintenance: { reason: 'Upgrade', since: 1 } };
  assert.equal(healthOf(state, { statusIntervalSec: 5, startedAt: 1, now: 900_000 }).code, 200);
});
