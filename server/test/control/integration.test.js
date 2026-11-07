import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createControlMock } from '../../dev/control-mock.js';
import { RouterClient } from '../../src/router/client.js';
import { createControlService } from '../../src/control/service.js';
import { createApp } from '../../src/http/app.js';
import { fakeDeps } from '../http/helpers.js';

async function setup(t, { level = 'high', ...options } = {}) {
  const mock = createControlMock({
    level,
    zconsoleEnabled: true,
    delayMs: 5,
    rebootMs: 150,
    lingerMs: 30,
    flags: { hideDSL: true },
    ...options,
  });
  const native = http.createServer(mock.handler).listen(0, '127.0.0.1');
  await once(native, 'listening');
  const client = new RouterClient({
    baseUrl: `http://127.0.0.1:${native.address().port}`,
    username: level === 'high' ? 'supervisor' : 'admin',
    password: 'mock',
    allowControl: true,
    requestGapMs: 0,
  });
  const meta = new Map();
  const audit = [];
  const db = { getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value), insertMany: (rows) => audit.push(...rows) };
  const collector = {
    state: { phase: 'ok', lastSuccessAt: Date.now() },
    beginMaintenance(reason) {
      this.state.maintenance = { reason, since: Date.now() };
    },
    endMaintenance() {
      this.state.maintenance = null;
    },
    expectRestart() {},
  };
  const radio = { trial: null };
  const control = createControlService({ client, db, collector, radio, enabled: true, pollMs: 10, reconnectMs: 10 });
  const server = createApp(fakeDeps({ control, collector, db })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = '', { method = 'GET', body, headers = {} } = {}) {
    return fetch(`${base}/api/control${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'X-Insight-Request': '1' }),
        ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
  }
  async function json(path, options) {
    const res = await request(path, options);
    const value = await res.json();
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(value)}`);
    return value;
  }
  async function settled() {
    const deadline = Date.now() + 3000;
    while (control.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(control.busy, false, 'mock operation must finish within its test deadline');
    return control.operation;
  }
  t.after(async () => {
    await control.stop();
    server.closeAllConnections();
    native.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => native.close(resolve))]);
  });
  return { mock, client, control, collector, radio, request, json, settled, meta, audit, base };
}

test('medium sessions expose ordinary speed testing but cannot execute high-only controls', async (t) => {
  const h = await setup(t, { level: 'medium' });
  const view = await h.json('');
  assert.equal(view.level, 'medium');
  assert.equal(view.capabilities.speedtest.available, true);
  assert.equal(view.capabilities.romd.available, false);
  assert.equal(view.capabilities.iperf.available, false);
  for (const [path, body] of [
    ['/romd/save', { confirm: 'SAVE ROMD' }],
    ['/diagnostics', { kind: 'iperf', host: '192.0.2.1' }],
  ]) {
    assert.equal((await h.request(path, { method: 'POST', body })).status, 403);
  }
  assert.deepEqual(h.mock.state.actions, []);
  await h.json('/diagnostics', { method: 'POST', body: { kind: 'speedtest' } });
  assert.equal((await h.settled()).state, 'complete');
  assert.match(h.control.operation.result.text, /Download:/);
});

test('high session saves native settings, exports binary backups, and manages WAN/accounts/privileges', async (t) => {
  const h = await setup(t);
  await h.json('/firmware/settings', { method: 'PUT', body: { patch: { PeriodicCheckEnable: true, ForceUpgrade: false, StartTime: 3 } } });
  assert.equal(h.mock.state.fota.StartTime, 3);
  assert.equal(h.mock.state.fota.ForceUpgrade, false);
  await h.json('/firmware/check', { method: 'POST' });
  assert.equal((await h.json('')).firmware.available.FWVersion, h.mock.state.firmware.FWVersion);
  const exported = await h.request('/backup/configuration', { method: 'POST' });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const original = Buffer.from(await exported.arrayBuffer());
  assert.equal(JSON.parse(original).format, 'FWA505-MOCK-CONFIG-1');
  await h.json('/romd/save', { method: 'POST', body: { confirm: 'SAVE ROMD' } });
  const defaults = await h.request('/backup/romd', { method: 'POST' });
  assert.equal(defaults.status, 200);
  assert.deepEqual(Buffer.from(await defaults.arrayBuffer()), h.mock.state.romd);
  await h.json('/romd/clear', { method: 'POST', body: { confirm: 'CLEAR ROMD' } });
  assert.equal(h.mock.state.romd, null);
  await h.json('/zconsole', {
    method: 'PUT',
    body: { patch: { Enable: true, LogServerIP: '192.0.2.5', LogServerPort: 5515, UseCommonServer: true } },
  });
  assert.equal(h.mock.state.zconsole.zconsole_log.LogServerPort, 5515);
  const wan = h.mock.state.wan.find((w) => w.Type === 'ETH');
  wan.pppPassword = 'keep-this-private';
  await h.json(`/wan/${wan.index}`, {
    method: 'PUT',
    body: { patch: { VLANEnable: true, VLANID: 100, VLANPriority: 0 }, confirm: 'SAVE WAN' },
  });
  assert.equal(wan.VLANID, 100);
  assert.equal(wan.pppPassword, 'keep-this-private');
  assert.doesNotMatch(JSON.stringify(await h.json('')), /keep-this-private/);
  await h.json('/accounts', { method: 'POST', body: { account: { Username: 'viewer', Password: 'ExamplePass123!', group: 'User' } } });
  const user = h.mock.state.accounts.find((a) => a.Username === 'viewer');
  assert.ok(user);
  await h.json(`/accounts/${user.Index}`, { method: 'PUT', body: { patch: { AccountIdleTime: 600 } } });
  assert.equal(user.AccountIdleTime, 600);
  await h.json('/privileges/2', { method: 'PUT', body: { patch: { Page: 'Broadband,Wireless', EnableQuickStart: false } } });
  assert.equal(h.mock.state.privileges.find((p) => p.Index0 === 2 && p.Index1 === 0).Page, 'Broadband,Wireless');
  await h.json(`/accounts/${user.Index}`, { method: 'DELETE', body: { confirm: 'DELETE ACCOUNT' } });
  assert.equal(
    h.mock.state.accounts.some((a) => a.Username === 'viewer'),
    false,
  );
  assert.equal((await h.request('/accounts/1', { method: 'DELETE', body: { confirm: 'DELETE ACCOUNT' } })).status, 409);
  assert.doesNotMatch(JSON.stringify(h.audit), /ExamplePass123|keep-this-private/);
});

test('firmware installation verifies the new version after the mock reconnects', async (t) => {
  const h = await setup(t);
  await h.json('/firmware/check', { method: 'POST' });
  const started = await h.json('/firmware/install', { method: 'POST', body: { confirm: 'UPGRADE' } });
  assert.equal(started.state, 'reconnecting');
  assert.ok(h.collector.state.maintenance);
  assert.equal((await h.settled()).state, 'complete');
  assert.equal(h.control.operation.result.firmwareVersion, h.mock.state.firmware.FWVersion);
  assert.equal(h.mock.state.actions.filter((a) => a === 'firmware:install').length, 1);
  assert.equal(h.collector.state.maintenance, null);
});

test('configuration restore preserves exact bytes, reconnects and reports its verification limit', async (t) => {
  const h = await setup(t);
  const exported = await h.request('/backup/configuration', { method: 'POST' });
  const bytes = Buffer.from(await exported.arrayBuffer());
  await h.json('/firmware/settings', { method: 'PUT', body: { patch: { StartTime: 12 } } });
  await h.json('/restore', {
    method: 'POST',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'configuration.rom', 'X-Confirm': 'RESTORE' },
  });
  const result = await h.settled();
  assert.deepEqual(h.mock.state.restored, bytes);
  assert.equal(h.mock.state.fota.StartTime, JSON.parse(bytes).fota.StartTime);
  assert.equal(result.state, 'unknown', 'reachability alone must not claim exact configuration verification');
  assert.equal(result.result.configurationReadable, true);
  assert.equal(h.collector.state.maintenance, null);
  const acknowledged = await h.json('/operation/acknowledge', { method: 'POST', body: { id: result.id, confirm: 'ACKNOWLEDGE' } });
  assert.equal(acknowledged.operation.state, 'acknowledged');
  assert.equal(h.mock.state.actions.filter((a) => a === 'configuration:restore').length, 1);
});

test('partial reset validates and saves retention categories before resetting', async (t) => {
  const h = await setup(t);
  const invalid = await h.request('/reset/partial', { method: 'POST', body: { confirm: 'RESET', keep: ['not-supported'] } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(h.mock.state.actions, []);
  await h.json('/reset/partial', { method: 'POST', body: { confirm: 'RESET', keep: ['ResetKeep_1', 'ResetKeep_3'] } });
  assert.equal(h.mock.state.reset.FactoryResetUnpurgedList, 'ResetKeep_1,ResetKeep_3');
  assert.equal((await h.settled()).state, 'unknown');
  assert.equal(h.mock.state.actions.at(-1), 'configuration:partialReset');
});

test('feature flags, validation, confirmation and CSRF prevent native changes', async (t) => {
  const h = await setup(t, { zconsoleEnabled: false, speedTestEnabled: false });
  assert.equal((await h.request('/zconsole', { method: 'PUT', body: { patch: { Enable: true } } })).status, 403);
  assert.equal((await h.request('/firmware/install', { method: 'POST', body: { confirm: 'wrong' } })).status, 400);
  assert.equal((await h.request('/diagnostics', { method: 'POST', body: { kind: 'speedtest' } })).status, 403);
  assert.equal((await h.request('/diagnostics', { method: 'POST', body: { kind: 'iperf', host: 'example.com;reboot' } })).status, 400);
  assert.equal(
    (
      await h.request('/accounts', {
        method: 'POST',
        body: { account: { Username: 'fake', Password: 'ExamplePass123!', group: 'Supervisor' } },
      })
    ).status,
    400,
  );
  const csrf = await fetch(`${h.base}/api/control/romd/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'SAVE ROMD' }),
  });
  assert.equal(csrf.status, 403);
  assert.deepEqual(h.mock.state.actions, []);
});

test('an active operation locks native actions and conflicting radio controls', async (t) => {
  const h = await setup(t, { delayMs: 200 });
  await h.json('/diagnostics', { method: 'POST', body: { kind: 'iperf', host: '192.0.2.20', port: 5201, duration: 2, reverse: true } });
  assert.equal((await h.request('/romd/save', { method: 'POST', body: { confirm: 'SAVE ROMD' } })).status, 409);
  const radio = await fetch(`${h.base}/api/radio/keep`, { method: 'POST', headers: { 'X-Insight-Request': '1' } });
  assert.equal(radio.status, 409);
  assert.equal((await h.settled()).state, 'complete');
  assert.equal(h.mock.state.actions.filter((a) => a === 'PUT:IPERFTEST').length, 1);
});

test('a restore is not settled while the router still answers before it reboots', async (t) => {
  const h = await setup(t, { lingerMs: 300 });
  const exported = await h.request('/backup/configuration', { method: 'POST' });
  const bytes = Buffer.from(await exported.arrayBuffer());
  await h.json('/restore', {
    method: 'POST',
    body: bytes,
    // A browser's name for a second download: sanitised, not refused.
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('backup (1) é.rom'), 'X-Confirm': 'RESTORE' },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  // The old configuration is still being served: nothing may be released or claimed yet.
  assert.equal(h.control.operation.state, 'reconnecting');
  assert.ok(h.collector.state.maintenance);
  const result = await h.settled();
  assert.equal(result.state, 'unknown');
  assert.equal(result.result.configurationReadable, true);
});

test('renaming an account to an existing username is refused before anything is sent', async (t) => {
  const h = await setup(t);
  await h.json('/accounts', { method: 'POST', body: { account: { Username: 'bob', Password: 'ExamplePass123!', group: 'User' } } });
  const bob = h.mock.state.accounts.find((a) => a.Username === 'bob');
  const before = structuredClone(h.mock.state.accounts);
  const res = await h.request(`/accounts/${bob.Index}`, { method: 'PUT', body: { patch: { Username: 'admin' } } });
  assert.equal(res.status, 409);
  assert.deepEqual(h.mock.state.accounts, before);
  assert.equal((await h.request('/accounts', { method: 'POST', body: { account: { Username: 'bob', Password: 'x' } } })).status, 409);
});
