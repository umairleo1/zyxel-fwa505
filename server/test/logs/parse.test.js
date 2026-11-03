import test from 'node:test';
import assert from 'node:assert/strict';
import { newLines, parseRouterLine, parseSyslog, resolveTimestamp } from '../../src/logs/parse.js';

const now = new Date(2026, 10, 3, 17, 0, 0); // 3 Nov 2026

test('parses a native GET_LOG line with a space-padded day', () => {
  const r = parseRouterLine('[DHCP Server] Nov  3 08:12:01 dhcpd.info DHCPACK on 192.168.1.20 to aa:bb via br0', now);
  assert.equal(r.category, 'DHCP Server');
  assert.equal(r.facility, 'dhcpd');
  assert.equal(r.level, 'info');
  assert.equal(r.message, 'DHCPACK on 192.168.1.20 to aa:bb via br0');
  assert.equal(r.ts, new Date(2026, 10, 3, 8, 12, 1).getTime());
});

test('normalises level aliases and keeps unparseable lines', () => {
  assert.equal(parseRouterLine('[System] Nov  3 08:00:00 httpd.warn x', now).level, 'warning');
  const r = parseRouterLine('garbage line', now);
  assert.equal(r.message, 'garbage line');
  assert.equal(r.level, null);
});

test('December lines read in January belong to last year', () => {
  const jan = new Date(2027, 0, 1, 0, 5);
  assert.equal(new Date(resolveTimestamp('Dec', '31', '23', '59', '00', jan)).getFullYear(), 2026);
  assert.equal(new Date(resolveTimestamp('Jan', '1', '00', '01', '00', jan)).getFullYear(), 2027);
});

test('parses RFC 3164 syslog with host, tag and router category', () => {
  const r = parseSyslog('<30>Nov  3 16:59:58 FWA505 dhcpd[812]: [DHCP Server] DHCPACK on 192.168.1.5', '192.168.1.1', now);
  assert.equal(r.host, 'FWA505');
  assert.equal(r.facility, 'dhcpd');
  assert.equal(r.level, 'info'); // 30 & 7 = 6
  assert.equal(r.category, 'DHCP Server');
  assert.equal(r.message, 'DHCPACK on 192.168.1.5');
});

test('parses RFC 3164 without hostname, and RFC 5424', () => {
  const a = parseSyslog('<27>Nov  3 16:00:00 cellwan: link down', '192.168.1.1', now);
  assert.equal(a.facility, 'cellwan');
  assert.equal(a.level, 'err');
  assert.equal(a.host, '192.168.1.1');
  const b = parseSyslog('<165>1 2026-11-03T16:00:00Z router app 99 ID47 - hello', '10.0.0.1', now);
  assert.equal(b.host, 'router');
  assert.equal(b.facility, 'app');
  assert.equal(b.level, 'notice');
  assert.equal(b.message, 'hello');
  assert.equal(b.ts, Date.parse('2026-11-03T16:00:00Z'));
});

test('newLines finds the sliding-window overlap', () => {
  assert.deepEqual(newLines([], ['a', 'b']), { overlap: 0, added: ['a', 'b'] });
  assert.deepEqual(newLines(['a', 'b', 'c'], ['b', 'c', 'd', 'e']), { overlap: 2, added: ['d', 'e'] });
  assert.deepEqual(newLines(['a', 'b', 'c'], ['a', 'b', 'c']), { overlap: 3, added: [] });
  // Identical repeated lines: prefer the longest overlap so nothing is duplicated.
  assert.deepEqual(newLines(['x', 'x', 'x'], ['x', 'x', 'x', 'y']), { overlap: 3, added: ['y'] });
  // No overlap: a gap (or cleared log), keep everything.
  assert.deepEqual(newLines(['a'], ['q', 'r']), { overlap: 0, added: ['q', 'r'] });
});
