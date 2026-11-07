import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createControlService } from '../../src/control/service.js';

function harness({
  level = 'medium',
  flags = {},
  readback = true,
  persisted = null,
  writeError,
  diagnosticState = 'Complete',
  pollMs = 5,
} = {}) {
  const seen = [];
  const store = new Map(persisted ? [['routerControlOperation', JSON.stringify(persisted)]] : []);
  const data = {
    periodic_FOTA_config: [
      { PeriodicCheckEnable: false, PeriodicMode: 0, PeriodicStartDay: 0, StartTime: 1, ShiftTimeRange: 14400, ForceUpgrade: false },
    ],
    online_fw_info: [{ FWVersion: 'V2', FWReleaseDate: '2026-11-01', FWSize: 1000 }],
    wan: [
      {
        index: 1,
        Name: 'ETHWAN',
        Type: 'ETH',
        Enable: true,
        Mode: 'IP_Routed',
        Encapsulation: 'IPoE',
        ipMode: 'DualStack',
        MaxMTUSize: 1500,
        NatEnable: true,
        pppPassword: 'original-wan-secret',
      },
    ],
    user_account: [
      { Index: 1, Username: 'admin', Enabled: true, group: 'Administrator', Password: 'original-admin-secret' },
      { Index: 2, Username: 'guest', Enabled: true, group: 'User' },
    ],
    login_privilege: [
      { Index0: 2, Index1: 0, Page: 'Broadband,Wireless' },
      { Index0: 2, Index1: 1, Username: 'admin', EnableQuickStart: true },
    ],
    zconsole: [
      {
        zconsole_log: { Enable: false, LogServerIP: '192.168.1.2', LogServerPort: 5515, BufferSize: 100, PreRunCommand: 'private-command' },
      },
    ],
    backupRestore_config: [{ SupportedFactoryResetUnpurgedList: '1,2,4', FactoryResetUnpurgedList: '1,2' }],
    PINGTEST: [{ DiagnosticsState: diagnosticState }],
    IPERFTEST: [{ DiagnosticsState: diagnosticState }],
  };
  const client = {
    username: 'admin',
    controlInfo: async () => {
      seen.push(['info']);
      return {
        level,
        flags: { supportSpeedTest: true, showOnline_FirmwareUpgrade: true, showPartialReset: true, ...flags },
        device: { ModelName: 'FWA505', SoftwareVersion: 'V1' },
      };
    },
    controlRead: async (oid) => {
      seen.push(['read', oid]);
      return { result: 'ZCFG_SUCCESS', Object: structuredClone(data[oid] ?? []) };
    },
    controlWrite: async (oid, method, body) => {
      seen.push(['write', oid, method, structuredClone(body)]);
      if (writeError) throw writeError;
      if (!readback || ['PINGTEST', 'IPERFTEST'].includes(oid)) return;
      if (oid === 'login_privilege') {
        const [index, patch] = body;
        const group = data[oid].find((r) => r.Index0 === index.Index0 && r.Index1 === 0);
        const account = data[oid].find((r) => r.Index0 === index.Index0 && r.Index1 === index.Index0 - 1);
        group.Page = patch.Page;
        account.EnableQuickStart = patch.EnableQuickStart;
      } else if (method === 'DELETE') data[oid] = data[oid].filter((r) => r.Username !== body.Username);
      else if (method === 'POST') data[oid].push({ Index: 3, index: 3, ...structuredClone(body) });
      else if (Array.isArray(body)) data[oid] = structuredClone(body);
      else data[oid][0] = { ...data[oid][0], ...structuredClone(body) };
    },
    controlAction: async (name) => {
      seen.push(['action', name]);
    },
    diagnosticResult: async () => [{ result: 'iperf3 -c private-host\npassword=hidden\nDownload: 80 Mbps' }],
    controlDownload: async () => ({ body: Buffer.from([0, 255, 1]), filename: 'backup.rom', contentType: 'application/octet-stream' }),
    controlRestore: async () => {
      seen.push(['restore']);
    },
  };
  const collector = {
    state: { phase: 'ok' },
    beginMaintenance: async () => seen.push(['hold']),
    endMaintenance: async () => seen.push(['release']),
    expectRestart: () => seen.push(['restart']),
  };
  const db = { getMeta: (key) => store.get(key), setMeta: (key, value) => store.set(key, value), insertMany: () => {} };
  const service = createControlService({ client, db, collector, enabled: true, pollMs });
  return { service, client, data, seen, store, collector };
}

test('capabilities use server level and firmware flags, without exposing secrets or commands', async () => {
  const h = harness();
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.level, 'medium');
  assert.equal(snapshot.capabilities.speedtest.available, true);
  assert.equal(snapshot.capabilities.romd.available, false);
  assert.equal(snapshot.capabilities.privileges.available, false);
  assert.equal(snapshot.capabilities.zconsole.available, false);
  assert.equal(JSON.stringify(snapshot).includes('original-'), false);
  await assert.rejects(h.service.romd('save', 'SAVE ROMD'), (e) => e.status === 403);
  assert.equal(
    h.seen.some(([type]) => type === 'action'),
    false,
  );
  const high = harness({ level: 'high', flags: { show_zconsole_log: true } });
  const result = await high.service.snapshot();
  assert.equal(result.capabilities.zconsole.available, true);
  assert.equal(Object.hasOwn(result.zconsole.zconsole_log, 'PreRunCommand'), false);
});

test('WAN patches preserve raw secrets and verify the settings the router kept', async () => {
  const h = harness();
  await h.service.wan('1', { MaxMTUSize: 1400 }, 'SAVE WAN');
  const write = h.seen.find(([type]) => type === 'write');
  assert.equal(write[3].pppPassword, 'original-wan-secret');
  assert.equal(write[3].MaxMTUSize, 1400);
  assert.equal(h.service.operation.state, 'complete');
  assert.deepEqual(
    h.seen.filter(([type]) => ['hold', 'release'].includes(type)),
    [['hold'], ['release']],
  );
  await assert.rejects(h.service.wan('1', { pppPassword: '••••••••' }, 'SAVE WAN'), /invalid value/);
  const refused = harness({ readback: false });
  await assert.rejects(refused.service.wan('1', { MaxMTUSize: 1400 }, 'SAVE WAN'), /did not keep/);
  assert.equal(refused.service.operation.state, 'failed');
});

test('WAN restrictions depend on actual customization and interface type', async () => {
  const h = harness({ flags: { ABOG_GUI_Customization: true } });
  await assert.rejects(h.service.wan('1', { VLANEnable: true, VLANID: 10, VLANPriority: 0 }, 'SAVE WAN'), (e) => e.status === 403);
  const cellular = harness();
  cellular.data.wan[0].Type = 'CELL';
  await assert.rejects(cellular.service.wan('1', { pppUsername: 'new' }, 'SAVE WAN'), /do not apply/);
  assert.equal(
    cellular.seen.some(([type]) => type === 'write'),
    false,
  );
});

test('a medium account cannot manage router accounts: it may only edit its own, which is protected', async () => {
  const h = harness();
  await assert.rejects(h.service.createAccount({ Username: 'new', Password: 'a-password' }), (e) => e.status === 403);
});

test('the active credentials and last enabled administrator are protected', async () => {
  const h = harness({ level: 'high' });
  await assert.rejects(h.service.account('1', { Password: 'new-password' }), /active credentials/);
  await assert.rejects(h.service.deleteAccount('1', 'DELETE ACCOUNT'), /account it is using/);
  h.client.username = 'observer';
  await assert.rejects(h.service.deleteAccount('1', 'DELETE ACCOUNT'), /one enabled administrator/);
  await assert.rejects(h.service.createAccount({ Username: 'supervisor', Password: 'a-password', group: 'high' }), /Administrator or User/);
  assert.equal(
    h.seen.some(([type]) => type === 'write'),
    false,
  );
});

test('native login privilege PUT uses account index while readback uses group row', async () => {
  const h = harness({ level: 'high' });
  await h.service.privileges('2', { Page: 'Broadband', EnableQuickStart: false });
  const write = h.seen.find(([type]) => type === 'write');
  assert.deepEqual(write.slice(1), [
    'login_privilege',
    'PUT',
    [
      { Index0: 2, Index1: 1 },
      { Page: 'Broadband', EnableQuickStart: false },
    ],
  ]);
  assert.equal(h.service.operation.state, 'complete');
  await assert.rejects(h.service.privileges('1', { Page: 'Broadband' }), /Only administrator and user/);
});

test('diagnostics reject shell syntax, serialize operations, and publish scrubbed results', async (t) => {
  const h = harness({ level: 'high', pollMs: 5 });
  t.after(() => h.service.stop());
  await assert.rejects(h.service.diagnostics({ kind: 'iperf', host: 'example.test;reboot' }), /IPv4 address or hostname/);
  const started = await h.service.diagnostics({ kind: 'iperf', host: 'example.test', duration: 5, reverse: true });
  assert.equal(started.state, 'reconnecting');
  assert.equal(h.service.busy, true);
  const count = h.seen.length;
  await h.service.snapshot();
  await assert.rejects(h.service.refresh(), (e) => e.kind === 'busy');
  await assert.rejects(h.service.firmwareCheck(), (e) => e.kind === 'busy');
  assert.equal(h.seen.length, count, 'snapshot and concurrent actions must not add router traffic');
  const command = h.seen.find(([type]) => type === 'write')[3].iperf_Req;
  assert.equal(command, 'iperf3 -c example.test -p 5201 -t 5 -R');
  for (let i = 0; i < 30 && h.service.busy; i++) await delay(5);
  assert.equal(h.service.operation.state, 'complete');
  assert.equal(h.service.operation.result.text, 'Download: 80 Mbps');
  assert.equal(h.seen.filter(([type]) => type === 'write').length, 1);
});

test('a dropped mutation is unknown and never automatically resent', async () => {
  const h = harness({ writeError: Object.assign(new Error('socket hang up'), { kind: 'network' }) });
  await assert.rejects(h.service.firmwareSettings({ ForceUpgrade: true }), (e) => e.kind === 'unknown');
  assert.equal(h.service.operation.state, 'unknown');
  await assert.rejects(h.service.firmwareSettings({ ForceUpgrade: true }), (e) => e.kind === 'unknown');
  assert.equal(h.seen.filter(([type]) => type === 'write').length, 1);
});

test('an interrupted durable operation becomes unknown without replay', async () => {
  const h = harness({
    persisted: { id: 'old', kind: 'firmwareInstall', state: 'running', startedAt: Date.now(), deadline: Date.now() + 60000 },
  });
  assert.equal(h.service.operation.state, 'unknown');
  await h.service.snapshot();
  assert.equal(
    h.seen.some(([type]) => ['write', 'action', 'restore'].includes(type)),
    false,
  );
  assert.equal(JSON.parse(h.store.get('routerControlOperation')).state, 'unknown');
});

test('partial reset validates and writes retention choices before reset', async (t) => {
  const h = harness();
  t.after(() => h.service.stop());
  await assert.rejects(h.service.partialReset('RESET', ['999']), /supports retaining/);
  await h.service.partialReset('RESET', ['4', '1']);
  const write = h.seen.find(([type]) => type === 'write');
  assert.equal(write[1], 'backupRestore_config');
  assert.equal(write[3].FactoryResetUnpurgedList, '1,4');
  assert.equal(h.seen.findIndex(([type, name]) => type === 'action' && name === 'partialReset') > h.seen.indexOf(write), true);
});

test('failed maintenance preparation releases a partial hold and sends no action', async () => {
  const h = harness();
  h.collector.beginMaintenance = async () => {
    throw new Error('hold failed');
  };
  await assert.rejects(h.service.firmwareInstall('UPGRADE'), /hold failed/);
  assert.equal(
    h.seen.some(([type]) => type === 'release'),
    true,
  );
  assert.equal(
    h.seen.some(([type]) => type === 'action'),
    false,
  );
});

test('a username must stay unique, or the router could update the other account', async () => {
  const h = harness({ level: 'high' });
  await assert.rejects(h.service.account('2', { Username: 'ADMIN' }), (e) => e.status === 409 && /already uses/.test(e.message));
  await assert.rejects(h.service.createAccount({ Username: 'guest', Password: 'a-password' }), (e) => e.status === 409);
  assert.equal(
    h.seen.some(([type]) => type === 'write'),
    false,
  );
});

test('a WAN name must be unique, and creation verifies the new row', async () => {
  const h = harness();
  await assert.rejects(h.service.createWan({ Name: 'ethwan', Type: 'ETH' }, 'SAVE WAN'), (e) => e.status === 409);
  assert.equal(
    h.seen.some(([type]) => type === 'write'),
    false,
  );
});

test('quick start is refused for a group without accounts instead of failing after the write', async () => {
  const h = harness({ level: 'high' });
  h.data.login_privilege = [{ Index0: 3, Index1: 0, Page: 'Broadband' }];
  await assert.rejects(h.service.privileges('3', { EnableQuickStart: false }), (e) => e.status === 409 && /no accounts/.test(e.message));
  assert.equal(
    h.seen.some(([type]) => type === 'write'),
    false,
  );
});

test('firmware schedule numbers must be integers, not empty or numeric strings', async () => {
  const h = harness();
  await assert.rejects(h.service.firmwareSettings({ StartTime: '' }), /whole number/);
  await assert.rejects(h.service.firmwareSettings({ ShiftTimeRange: '3600' }), /whole number/);
});

test('iperf hosts are checked label by label', async () => {
  const h = harness({ level: 'high' });
  for (const host of ['a-.b', '-a.b', 'a..b', 'a b', 'a;b'])
    await assert.rejects(h.service.diagnostics({ kind: 'iperf', host }), /iperf server/, host);
});

test('a partial reset never sends settings the router no longer supports', async () => {
  const h = harness();
  h.data.backupRestore_config = [{ SupportedFactoryResetUnpurgedList: '1,2', FactoryResetUnpurgedList: '1,9' }];
  await h.service.partialReset('RESET').catch(() => {});
  const write = h.seen.find(([type, oid]) => type === 'write' && oid === 'backupRestore_config');
  assert.equal(write[3].FactoryResetUnpurgedList, '1');
});
