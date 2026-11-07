import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startZconsole } from '../../src/ingest/zconsole.js';

const quiet = { info() {}, warn() {}, error() {} };

async function receiver(t, options = {}) {
  const rows = [];
  const listener = startZconsole({
    host: '127.0.0.1',
    port: 0,
    db: { insertMany: (batch) => rows.push(...batch) },
    allows: () => true,
    log: quiet,
    ...options,
  });
  await once(listener.server, 'listening');
  t.after(() => listener.close());
  const send = async (parts) => {
    const socket = net.connect(listener.state.port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    const closed = new Promise((resolve) => socket.once('close', resolve));
    for (const part of parts) socket.write(part);
    socket.end();
    await closed;
  };
  return { listener, rows, send };
}

test('console TCP frames split lines and UTF-8 without losing the final line', async (t) => {
  const { send, rows, listener } = await receiver(t);
  const utf8 = Buffer.from('Kernel ready ✓');
  await send(['[System] Nov 06 09:00:00 kern.info Boot', ' complete\r\n', utf8.subarray(0, utf8.length - 1), utf8.subarray(-1)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message, 'Boot complete');
  assert.equal(rows[1].message, 'Kernel ready ✓');
  assert.equal(rows[0].source, 'router-console');
  assert.equal(listener.state.received, 2);
});

test('console rejects disallowed sources before recording data', async (t) => {
  const { send, rows, listener } = await receiver(t, { allows: () => false });
  await send(['not accepted\n']);
  assert.equal(rows.length, 0);
  assert.equal(listener.state.denied, 1);
});

test('console discards oversized lines and caps rows while preserving framing', async (t) => {
  const { send, rows, listener } = await receiver(t, { ratePerMin: 2 });
  await send(['x'.repeat(5000), 'tail\nfirst\nsecond\nthird\n']);
  assert.deepEqual(
    rows.map((r) => r.message),
    ['first', 'second'],
  );
  assert.equal(listener.state.dropped, 2);
});

test('a new router connection replaces the oldest when the receiver is full', async (t) => {
  const { listener } = await receiver(t);
  const open = [];
  for (let k = 0; k < 5; k++) {
    const socket = net.connect(listener.state.port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    open.push(socket);
  }
  t.after(() => open.forEach((s) => s.destroy()));
  await once(open[0], 'close');
  assert.equal(listener.state.denied, 0);
  assert.equal(listener.state.connections, 4);
});
