import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTrap, trapToRow } from '../../src/ingest/snmpTrap.js';

// Tiny BER encoder for building fixtures.
const len = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const tlv = (tag, bytes) => [tag, ...len(bytes.length), ...bytes];
const seq = (...items) => tlv(0x30, items.flat());
const int = (n) => {
  const b = [];
  do {
    b.unshift(n & 255);
    n >>= 8;
  } while (n > 0 && n !== -1);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(0x02, b);
};
const str = (s) => tlv(0x04, [...Buffer.from(s)]);
const oid = (s) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [a * 40 + b];
  for (let n of rest) {
    const enc = [n & 0x7f];
    while ((n >>= 7)) enc.unshift((n & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlv(0x06, out);
};
const ticks = (n) => tlv(0x43, int(n).slice(2));
const vb = (o, v) => seq(oid(o), v);

const v2trap = (pduTag, trapOid, extra = []) =>
  Buffer.from(
    seq(
      int(1),
      str('public'),
      tlv(pduTag, [
        ...int(42),
        ...int(0),
        ...int(0),
        ...seq(vb('1.3.6.1.2.1.1.3.0', ticks(123456)), vb('1.3.6.1.6.3.1.1.4.1.0', oid(trapOid)), ...extra),
      ]),
    ),
  );

test('decodes a v2c linkDown trap with interface varbinds', () => {
  const buf = v2trap(0xa7, '1.3.6.1.6.3.1.1.5.3', [
    vb('1.3.6.1.2.1.2.2.1.1.7', int(7)),
    vb('1.3.6.1.2.1.2.2.1.2.7', str('wwan0')),
    vb('1.3.6.1.2.1.2.2.1.8.7', int(2)),
  ]);
  const t = decodeTrap(buf);
  assert.equal(t.version, 'v2c');
  assert.equal(t.community, 'public');
  assert.equal(t.name, 'linkDown');
  assert.equal(t.uptimeTicks, 123456);
  assert.equal(t.varbinds.length, 3);
  const row = trapToRow(t, '192.168.1.1', 0);
  assert.equal(row.level, 'warning');
  assert.equal(row.source, 'snmp');
  assert.equal(row.message, 'Interface went down: wwan0 (ifIndex=7, ifDescr=wwan0, ifOperStatus=down)');
});

test('decodes a v1 coldStart trap', () => {
  const buf = Buffer.from(
    seq(
      int(0),
      str('public'),
      tlv(0xa4, [...oid('1.3.6.1.4.1.890'), ...tlv(0x40, [192, 168, 1, 1]), ...int(0), ...int(0), ...ticks(500), ...seq()]),
    ),
  );
  const t = decodeTrap(buf);
  assert.equal(t.version, 'v1');
  assert.equal(t.name, 'coldStart');
  assert.equal(t.agent, '192.168.1.1');
  assert.equal(trapToRow(t, 'x', 0).message, 'Router restarted (cold start)');
});

test('recognises informs and keeps vendor trap OIDs', () => {
  const t = decodeTrap(v2trap(0xa6, '1.3.6.1.4.1.890.1.15.0.9'));
  assert.equal(t.type, 'inform');
  assert.equal(t.name, '1.3.6.1.4.1.890.1.15.0.9');
  assert.equal(Buffer.from(v2trap(0xa6, '1.3.6.1.4.1.890'))[t.pduOffset], 0xa6);
});

test('rejects garbage without throwing past the decoder', () => {
  assert.throws(() => decodeTrap(Buffer.from([0x01, 0x02, 0x03])));
  assert.throws(() => decodeTrap(Buffer.from([0x30, 0x10, 0x02])));
});
