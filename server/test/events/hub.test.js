import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEventHub } from '../../src/events/hub.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeClient() {
  const req = new EventEmitter();
  const res = {
    chunks: [],
    writeHead() {},
    write(c) {
      this.chunks.push(c);
    },
    end() {},
  };
  return {
    req,
    res,
    events: () =>
      res.chunks
        .join('')
        .split('\n\n')
        .filter((f) => f.startsWith('event:')),
  };
}

test('sends initial snapshot and batches log bursts into one event', async () => {
  const hub = createEventHub({ logsWindowMs: 30 });
  const c = fakeClient();
  hub.subscribe(c.req, c.res, { status: { ok: true } });
  assert.match(c.events()[0], /^event: status\ndata: \{"ok":true\}/);
  for (let i = 1; i <= 50; i++) hub.logs({ count: 1, sources: [i % 2 ? 'syslog' : 'snmp'], maxId: i });
  await sleep(60);
  const logs = c.events().filter((e) => e.startsWith('event: logs'));
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0].split('data: ')[1]), { count: 50, sources: ['syslog', 'snmp'], maxId: 50 });
  c.req.emit('close');
  assert.equal(hub.size, 0);
  hub.close();
});

test('throttled broadcast coalesces calls', async () => {
  const hub = createEventHub();
  const c = fakeClient();
  hub.subscribe(c.req, c.res);
  let n = 0;
  const push = hub.throttled('status', () => ({ n: ++n }), 40);
  for (let i = 0; i < 20; i++) push();
  await sleep(20);
  for (let i = 0; i < 20; i++) push();
  await sleep(80);
  assert.equal(c.events().length, 2);
  hub.close();
});
