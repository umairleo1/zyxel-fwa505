import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RouterClient } from '../../src/router/client.js';
import { createControlMock } from '../../dev/control-mock.js';

async function harness(t, options = {}, username = 'supervisor') {
  const mock = createControlMock({ delayMs: 0, rebootMs: 25, zconsoleEnabled: true, ...options });
  const server = http.createServer(mock.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new RouterClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    username,
    password: 'mock',
    allowControl: true,
    requestGapMs: 0,
  });
  t.after(() => {
    client.agent.destroy();
    server.closeAllConnections();
    server.close();
  });
  return { client, mock, server };
}

async function native(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new RouterClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    username: 'supervisor',
    password: 'mock',
    allowControl: true,
    requestGapMs: 0,
  });
  client.sessionKey = 'native-key';
  t.after(() => {
    client.agent.destroy();
    server.closeAllConnections();
    server.close();
  });
  return client;
}

test('controls are disabled by default and unsupported paths and prototype names never reach the router', async (t) => {
  const { client, mock } = await harness(t);
  client.allowControl = false;
  await assert.rejects(client.controlInfo(), (e) => e.status === 403);
  assert.equal(mock.state.logins, 0);
  client.allowControl = true;
  await assert.rejects(client.controlRead('status'), (e) => e.status === 400);
  await assert.rejects(client.controlWrite('__proto__', 'PUT', {}), (e) => e.status === 400);
  await assert.rejects(client.controlAction('constructor'), (e) => e.status === 400);
  await assert.rejects(client.controlWrite('wan', 'DELETE', {}), (e) => e.status === 400);
  await assert.rejects(client.getJson('/cgi-bin/Online_Firmware_Upgrade?action=online'), /read-only/);
  assert.deepEqual(mock.state.actions, []);
});

test('public capability flags are merged and the authenticated account level is preserved', async (t) => {
  const { client } = await harness(t, { flags: { supportSpeedTest: false } }, 'admin');
  const info = await client.controlInfo();
  assert.equal(info.level, 'medium');
  assert.equal(client.loginLevel, 'medium');
  assert.equal(info.flags.supportSpeedTest, false);
  assert.equal(info.flags.ACCOUNT_MGT, true);
  assert.equal(info.device.SoftwareVersion, 'V1.71(ACKO.0)C0');
  assert.deepEqual(Object.keys(info.device), ['ModelName', 'SoftwareVersion']);
});

test('a permission denial is returned as 403 without a second login or action attempt', async (t) => {
  const { client, mock } = await harness(t, {}, 'admin');
  await client.controlInfo();
  await assert.rejects(client.controlAction('romdSave'), (e) => e.status === 403 && e.kind === 'permission');
  await assert.rejects(client.controlWrite('IPERFTEST', 'PUT', { DiagnosticsState: 'Requested' }), (e) => e.status === 403);
  assert.equal(mock.state.logins, 1);
  assert.deepEqual(mock.state.actions, []);
});

test('an action GET with an ambiguous connection failure is never retried', async (t) => {
  let requests = 0;
  const client = await native(t, (req) => {
    requests++;
    req.socket.destroy();
  });
  await assert.rejects(client.controlAction('firmwareInstall'), (e) => e.kind === 'network');
  assert.equal(requests, 1);
});

test('a mutation requires native success and a DAL read requires a valid envelope', async (t) => {
  const client = await native(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await assert.rejects(client.controlWrite('periodic_FOTA_config', 'PUT', {}), (e) => e.status === 502);
  await assert.rejects(client.controlRead('wan'), (e) => e.status === 502);
});

test('firmware, partial-reset and native Z-console objects persist and read back', async (t) => {
  const { client } = await harness(t);
  const settings = (await client.controlRead('periodic_FOTA_config')).Object[0];
  settings.PeriodicCheckEnable = false;
  await client.controlWrite('periodic_FOTA_config', 'PUT', settings);
  assert.equal((await client.controlRead('periodic_FOTA_config')).Object[0].PeriodicCheckEnable, false);
  const reset = (await client.controlRead('backupRestore_config')).Object[0];
  await client.controlWrite('backupRestore_config', 'PUT', { ...reset, FactoryResetUnpurgedList: 'ResetKeep_2,ResetKeep_5' });
  assert.equal((await client.controlRead('backupRestore_config')).Object[0].FactoryResetUnpurgedList, 'ResetKeep_2,ResetKeep_5');
  const zconsole = (await client.controlRead('zconsole')).Object;
  zconsole[0].zconsole_log.LogServerIP = '192.168.1.9';
  await client.controlWrite('zconsole', 'PUT', zconsole);
  assert.equal((await client.controlRead('zconsole')).Object[0].zconsole_log.LogServerIP, '192.168.1.9');
});

test('ROM-D export selection and download are atomic and preserve arbitrary file bytes', async (t) => {
  const order = [];
  const expected = Buffer.from([0, 255, 128, 13, 10, 65]);
  let extra;
  const client = await native(t, (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/tagRomdBackupFlag') {
      order.push('tag');
      extra = client.getStatus();
      res.end('{"Recv_tagRomdBackupFlag":1}');
    } else if (url.pathname === '/cgi-bin/Backup_Restore') {
      order.push('backup');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="../../native.rom"' });
      res.end(expected);
    } else {
      order.push('status');
      res.end('{"result":"ZCFG_SUCCESS","Object":[{}]}');
    }
  });
  const file = await client.controlDownload('romd');
  await extra;
  assert.deepEqual(file.body, expected);
  assert.equal(file.filename, 'native.rom');
  assert.deepEqual(order, ['tag', 'backup', 'status']);
});

test('native exports restore through the exact multipart field and end the old session', async (t) => {
  const { client, mock } = await harness(t);
  const file = await client.controlDownload('configuration');
  const before = mock.state.fota.PeriodicCheckEnable;
  await client.controlWrite('periodic_FOTA_config', 'PUT', { ...mock.state.fota, PeriodicCheckEnable: !before });
  await client.controlRestore(file.body, 'configuration.rom');
  assert.deepEqual(mock.state.restored, file.body);
  assert.equal(mock.state.fota.PeriodicCheckEnable, before);
  assert.equal(client.hasSession, false);
});

test('downloads reject login HTML and JSON status envelopes', async (t) => {
  let status = false;
  const client = await native(t, (_req, res) => res.end(status ? '{"result":"ZCFG_SUCCESS"}' : '<html>Login</html>'));
  await assert.rejects(client.controlDownload('configuration'), (e) => e.status === 502);
  status = true;
  await assert.rejects(client.controlDownload('configuration'), (e) => e.status === 502);
});

test('accounts use native CRUD and delete usernames as query parameters', async (t) => {
  const { client, mock } = await harness(t);
  await client.controlWrite('user_account', 'POST', { Username: 'guest', Password: 'SomePassword123', Enabled: true, group: 'User' });
  const account = (await client.controlRead('user_account')).Object.find((a) => a.Username === 'guest');
  assert.ok(account.Index > 0);
  assert.equal(account.Password, undefined);
  await client.controlWrite('user_account', 'PUT', { ...account, AccountIdleTime: 600 });
  assert.equal(mock.state.accounts.find((a) => a.Username === 'guest').AccountIdleTime, 600);
  await client.controlWrite('user_account', 'DELETE', { Username: 'guest' });
  assert.equal(
    (await client.controlRead('user_account')).Object.some((a) => a.Username === 'guest'),
    false,
  );
});

test('privilege writes enforce native group-minus-one indexes and update separate group/account rows', async (t) => {
  const { client } = await harness(t);
  await assert.rejects(
    client.controlWrite('login_privilege', 'PUT', [
      { Index0: 2, Index1: 0 },
      { Page: 'Broadband', EnableQuickStart: false },
    ]),
    (e) => e.status === 502,
  );
  await client.controlWrite('login_privilege', 'PUT', [
    { Index0: 2, Index1: 1 },
    { Page: 'Broadband', EnableQuickStart: false },
  ]);
  const rows = (await client.controlRead('login_privilege')).Object;
  assert.equal(rows.find((r) => r.Index0 === 2 && r.Index1 === 0).Page, 'Broadband');
  assert.equal(rows.find((r) => r.Username === 'admin').EnableQuickStart, false);
});

test('mock medium accounts can run advertised speed tests, with iperf restricted to high', async (t) => {
  const { client, mock } = await harness(t, {}, 'admin');
  await client.controlWrite('PINGTEST', 'PUT', { type: 8, DiagnosticsState: 'Requested' });
  mock.state.diagnostics.PINGTEST.completeAt = 0;
  assert.equal((await client.controlRead('PINGTEST')).Object[0].DiagnosticsState, 'Complete');
  assert.match((await client.diagnosticResult())[0].result, /Download: 312/);
  await assert.rejects(client.controlWrite('IPERFTEST', 'PUT', { DiagnosticsState: 'Requested' }), (e) => e.status === 403);
});

test('mock validates account identities at login and advertises configurable support flags', async (t) => {
  const { client } = await harness(t, { speedTestEnabled: false, zconsoleEnabled: false }, 'unknown');
  await assert.rejects(client.controlInfo(), (e) => e.kind === 'auth');
});

test('a control read that meets an expired session (403) logs in again once instead of reporting a denial', async (t) => {
  let reads = 0;
  const client = await native(t, (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/getRSAPublickKey') return json(200, {});
    if (req.url === '/UserLogin') return json(200, { sessionkey: 'fresh', loginLevel: 'high' });
    if (req.url.startsWith('/cgi-bin/DAL?oid=wan'))
      return reads++ === 0 ? json(403, {}) : json(200, { result: 'ZCFG_SUCCESS', Object: [{}] });
    json(404, {});
  });
  const reply = await client.controlRead('wan');
  assert.equal(reply.result, 'ZCFG_SUCCESS');
  assert.equal(client.sessionKey, 'fresh');
});

test('probe reports whether the web server answers, without logging in', async (t) => {
  let logins = 0;
  const client = await native(t, (req, res) => {
    if (req.url === '/UserLogin') logins++;
    res.writeHead(req.url === '/getRSAPublickKey' ? 200 : 404);
    res.end('{}');
  });
  assert.equal(await client.probe(), true);
  client.base = new URL('http://127.0.0.1:1');
  assert.equal(await client.probe(), false);
  assert.equal(logins, 0);
});
