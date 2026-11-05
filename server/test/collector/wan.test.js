import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wanStatus } from '../../src/collector/wan.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../../dev/fixtures/${name}.json`, import.meta.url), 'utf8')).Object;
const status = () => fixture('DAL_oid_status');
const cellwan = () => fixture('DAL_oid_cellwan_status')[0];
const wan = (s) => findWan(s).find((w) => w.X_ZYXEL_DefaultGatewayIface);
const findWan = (s) => s[0].WanLanInfo.filter((w) => w.X_ZYXEL_Type === 'WAN');

test('a real FWA505 status with a WAN address is up', () => {
  assert.deepEqual(wanStatus(status(), cellwan()), { up: true, reason: null });
});

test('WAN down reasons, most fundamental first', () => {
  const s = status();
  wan(s).IPv4Address = [];
  assert.deepEqual(wanStatus(s, cellwan()), { up: false, reason: 'No WAN IP address' });

  const c = { ...cellwan(), INTF_Status: 'Dormant' };
  assert.deepEqual(wanStatus(s, c), { up: false, reason: 'Cellular interface dormant' });

  assert.deepEqual(wanStatus(s, { ...c, USIM_Status: 'DEVST_SIM_NOT_INSERTED' }), {
    up: false,
    reason: 'SIM not ready (DEVST_SIM_NOT_INSERTED)',
  });
});

test('an interface that is Up but only has 0.0.0.0 is down', () => {
  const s = status();
  wan(s).IPv4Address = [{ Enable: true, IPAddress: '0.0.0.0' }];
  assert.equal(wanStatus(s, cellwan()).up, false);
  wan(s).IPv4Address = [];
  wan(s).IPv6Address = [{ Enable: true, IPAddress: '2001:db8::1' }];
  assert.equal(wanStatus(s, cellwan()).up, true, 'IPv6-only is still connected');
});

test('older firmware: falls back to the status object, unknown without either', () => {
  const s = status();
  assert.equal(wanStatus(s, null).up, true);
  s[0].CellIntfInfo = { ...s[0].CellIntfInfo, Status: 'Down' };
  assert.deepEqual(wanStatus(s, null), { up: false, reason: 'Cellular interface down' });
  assert.deepEqual(wanStatus({ Object: [{ DeviceInfo: {} }] }, null), { up: null, reason: null });
});

test('the modem reporting no measurement (-128) is no signal, even with the interface Up', () => {
  const c = { ...cellwan(), INTF_RSRP: -128, INTF_RSRQ: -128, INTF_SINR: -128 };
  assert.deepEqual(wanStatus(status(), c), { up: false, reason: 'No cellular signal' });
});
