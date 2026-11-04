import test from 'node:test';
import assert from 'node:assert/strict';
import { detectReboot, uptimeContinues } from '../../src/collector/reboots.js';

const read = (uptimeSec, wall, mono) => ({ uptimeSec, wall, mono });

test('uptime advancing with both clocks: same boot', () => {
  assert.equal(uptimeContinues(read(1000, 0, 0), read(1060, 60e3, 60e3)), true);
});

test('wall clock steps (NTP on a Pi without RTC): uptime still matches the monotonic clock', () => {
  assert.equal(uptimeContinues(read(1000, 0, 0), read(1060, 3600e3 + 60e3, 60e3)), true);
});

test('host slept (monotonic clock paused): uptime matches the wall clock', () => {
  assert.equal(uptimeContinues(read(1000, 0, 0), read(1000 + 8 * 3600, 8 * 3600e3, 1e3)), true);
});

test('router rebooted: uptime matches neither clock', () => {
  assert.equal(uptimeContinues(read(86400, 0, 0), read(90, 300e3, 300e3)), false);
  // Rebooted during an 8 h sleep and has been up 7 h since: still neither.
  assert.equal(uptimeContinues(read(3600, 0, 0), read(7 * 3600, 8 * 3600e3, 1e3)), false);
});

test('a known reboot is reported even when boot times look the same', () => {
  const r = detectReboot({ bootedAt: 1000, storedBootedAt: 1000, rebooted: true });
  assert.equal(r.kind, 'unexplained');
});
