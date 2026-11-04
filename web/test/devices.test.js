import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceEvents, isDeviceEvent } from '../src/lib/devices.js';

const mac = { mac: 'aa:bb:cc:dd:ee:ff', name: 'Mac' };

test('new events match on the MAC, whatever the name says', () => {
  assert.ok(isDeviceEvent('Device connected: Renamed (aa:bb:cc:dd:ee:ff)', mac));
  assert.ok(isDeviceEvent('Device disconnected: Mac (AA:BB:CC:DD:EE:FF)', mac));
  assert.ok(!isDeviceEvent('Device connected: Mac (11:22:33:44:55:66)', mac)); // another "Mac"
});

test('old name-only events match the name as a whole word', () => {
  assert.ok(isDeviceEvent('Device connected: Mac', mac));
  assert.ok(isDeviceEvent('New device: mac on Wi-Fi 5GHz', mac));
  assert.ok(!isDeviceEvent('Device connected: MacBook', mac));
  assert.ok(!isDeviceEvent('Device connected: Mac', { mac: mac.mac, name: null }));
  assert.ok(isDeviceEvent('Device connected: Pixel (7a)', { mac: mac.mac, name: 'Pixel (7a)' }));
});

test('deviceEvents merges both searches, filters, dedupes and sorts newest first', () => {
  const byMac = { items: [{ id: 5, ts: 50, message: 'Device connected: Mac (aa:bb:cc:dd:ee:ff)' }] };
  const byName = {
    items: [
      { id: 5, ts: 50, message: 'Device connected: Mac (aa:bb:cc:dd:ee:ff)' },
      { id: 4, ts: 40, message: 'Device connected: MacBook (11:22:33:44:55:66)' },
      { id: 2, ts: 20, message: 'Device disconnected: Mac' },
      { id: 3, ts: 30, message: 'Device connected: MacBook' },
    ],
  };
  assert.deepEqual(
    deviceEvents([byMac, byName], mac).map((e) => e.id),
    [5, 2],
  );
  assert.deepEqual(deviceEvents([byMac, null], mac, 1).length, 1);
});
