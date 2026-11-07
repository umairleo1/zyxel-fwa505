import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { InternetMonitor, gatewayTarget, parseTargets, signalNote, tcpProbe } from '../../src/collector/internet.js';

const TARGETS = parseTargets(['1.1.1.1:443', '8.8.8.8:443']);
const GATEWAY = { host: '192.168.1.1', port: 443, label: 'router' };

/**
 * A monitor on fake clocks and a scripted network. `net` maps a target label to whether it
 * answers; change it between rounds. `step()` advances both clocks one interval and runs a round.
 */
function harness({ gateway = GATEWAY, context = () => 'LTE -105 dBm, SINR 6 dB' } = {}) {
  let wall = 1_000_000;
  let mono = 5_000;
  const up = { '1.1.1.1': true, '8.8.8.8': true, router: true };
  const probed = [];
  const outages = [];
  const logs = [];
  const minutes = [];
  const rtt = { ms: 40 };
  const db = {
    insertOutage: (o) => outages.push(o),
    insertMany: (rows) => logs.push(...rows),
    insertInternetSample: (m) => minutes.push(m),
  };
  const m = new InternetMonitor({
    db,
    targets: TARGETS,
    gateway,
    intervalMs: 1000,
    timeoutMs: 1500,
    probe: async (t) => {
      probed.push(t.label);
      return { ok: up[t.label], rttMs: up[t.label] ? rtt.ms : null };
    },
    context,
    now: () => wall,
    mono: () => mono,
    log: { error() {} },
  });
  const step = async (ms = 1000) => {
    wall += ms;
    mono += ms;
    await m.round();
  };
  const rounds = async (n, ms) => {
    for (let i = 0; i < n; i++) await step(ms);
  };
  return { m, up, rtt, probed, outages, logs, minutes, step, rounds, wall: () => wall };
}

const offline = (h) => Object.assign(h.up, { '1.1.1.1': false, '8.8.8.8': false });
const online = (h) => Object.assign(h.up, { '1.1.1.1': true, '8.8.8.8': true });

test('healthy rounds probe only the first target', async () => {
  const h = harness();
  await h.rounds(5);
  assert.deepEqual(h.probed, Array(5).fill('1.1.1.1'));
  assert.equal(h.m.state.phase, 'ok');
  assert.equal(h.m.state.rttMs, 40);
  assert.equal(h.m.state.via, '1.1.1.1');
  assert.deepEqual(h.outages, []);
});

test('the first target failing alone is not a stall: the second one answers', async () => {
  const h = harness();
  h.up['1.1.1.1'] = false;
  await h.rounds(10);
  assert.equal(h.m.state.phase, 'ok');
  assert.equal(h.m.state.via, '8.8.8.8');
  assert.deepEqual(h.m.openOutages(), []);
  assert.deepEqual(h.probed.slice(0, 3).sort(), ['1.1.1.1', '8.8.8.8', 'router'], 'fallbacks and router tried together');
});

test('a stall is confirmed after 3 failed rounds, backdated to the last good round', async () => {
  const h = harness();
  await h.step();
  const lastOk = h.wall();
  offline(h);
  await h.rounds(2);
  assert.equal(h.m.state.phase, 'failing');
  assert.deepEqual(h.m.openOutages(), [], 'two rounds could still be a glitch');
  await h.step();
  assert.equal(h.m.state.phase, 'stalled');
  const [open] = h.m.openOutages(h.wall());
  assert.equal(open.kind, 'internet');
  assert.equal(open.start_ts, lastOk);
  assert.equal(open.ongoing, true);
  assert.match(open.reason, /No reply from 1\.1\.1\.1 or 8\.8\.8\.8 \(router reachable\) · LTE -105 dBm, SINR 6 dB/);
  assert.deepEqual(h.m.state.stall, { since: lastOk, reason: open.reason });
  assert.equal(h.logs.at(-1).level, 'warning');
  assert.equal(h.logs.at(-1).facility, 'internet');
});

test('two failed rounds then recovery is a glitch, not stored', async () => {
  const h = harness();
  await h.step();
  offline(h);
  await h.rounds(2);
  online(h);
  await h.rounds(3);
  offline(h);
  await h.rounds(2);
  assert.deepEqual(h.outages, []);
  assert.deepEqual(h.logs, []);
});

test('a stall ends at the first good round once two in a row succeed, and is stored', async () => {
  const h = harness();
  await h.step();
  const start = h.wall();
  offline(h);
  await h.rounds(5);
  online(h);
  await h.step();
  const recoveredAt = h.wall();
  assert.equal(h.outages.length, 0, 'one good round is not recovery yet');
  await h.step();
  assert.equal(h.outages.length, 1);
  assert.deepEqual({ ...h.outages[0], reason: undefined }, { start_ts: start, end_ts: recoveredAt, kind: 'internet', reason: undefined });
  assert.equal(h.m.state.phase, 'ok');
  assert.equal(h.m.state.stall, null);
  assert.equal(h.logs.at(-1).message, 'Internet restored after 6s');
});

test('a flapping link stays one stall', async () => {
  const h = harness();
  await h.step();
  offline(h);
  await h.rounds(3);
  for (let i = 0; i < 3; i++) {
    online(h);
    await h.step();
    offline(h);
    await h.step();
  }
  assert.deepEqual(h.outages, []);
  assert.equal(h.m.openOutages().length, 1);
});

test("when the router doesn't answer either, it's not counted as the internet", async () => {
  const h = harness();
  await h.step();
  offline(h);
  h.up.router = false;
  await h.rounds(10);
  assert.equal(h.m.state.phase, 'local');
  assert.deepEqual(h.m.openOutages(), []);
});

test('losing the router mid-stall keeps the stall open but restarts recovery', async () => {
  const h = harness();
  await h.step();
  offline(h);
  await h.rounds(3);
  online(h);
  await h.step();
  offline(h);
  h.up.router = false;
  await h.step();
  online(h);
  h.up.router = true;
  await h.step();
  assert.deepEqual(h.outages, [], 'recovery needs two good rounds in a row');
  await h.step();
  assert.equal(h.outages.length, 1);
});

test('without a gateway, all targets failing counts as down', async () => {
  const h = harness({ gateway: null });
  await h.step();
  offline(h);
  await h.rounds(3);
  assert.equal(h.m.state.phase, 'stalled');
  assert.doesNotMatch(h.m.openOutages()[0].reason, /router reachable/);
});

test('a sleep gap closes an open stall at the last round and is not backdated across', async () => {
  const h = harness();
  await h.step();
  offline(h);
  await h.rounds(4);
  const lastRound = h.wall();
  await h.step(60_000); // asleep for a minute, still offline on wake
  assert.equal(h.outages.length, 1);
  assert.equal(h.outages[0].end_ts, lastRound);
  assert.match(h.outages[0].reason, /\(Insight paused\)$/);
  await h.rounds(2);
  const [open] = h.m.openOutages();
  assert.equal(open.start_ts, lastRound + 60_000, 'new stall starts after the gap, not before it');
});

test('stop() stores an open stall', async () => {
  const h = harness();
  await h.step();
  offline(h);
  await h.rounds(3);
  h.m.stop();
  assert.equal(h.outages.length, 1);
  assert.match(h.outages[0].reason, /\(Insight stopped\)$/);
});

test('a failing context or database never breaks probing', async () => {
  const h = harness({
    context: () => {
      throw new Error('no router yet');
    },
  });
  h.m.db.insertMany = () => {
    throw new Error('disk full');
  };
  await h.step();
  offline(h);
  await h.rounds(3);
  assert.equal(h.m.state.phase, 'stalled');
  assert.equal(h.m.openOutages()[0].reason, 'No reply from 1.1.1.1 or 8.8.8.8 (router reachable)');
});

test('rounds are summarised per minute: stored when the minute changes, and on stop', async () => {
  const h = harness(); // first round at 1_001_000, in the minute starting 960_000
  await h.rounds(9); // 1_001_000 … 1_009_000
  h.rtt.ms = 100;
  await h.rounds(5); // … 1_014_000
  offline(h);
  await h.rounds(3); // … 1_017_000: failed
  h.up.router = false;
  await h.rounds(2); // … 1_019_000: no verdict
  assert.deepEqual(h.minutes, [], 'nothing written until the minute is over');
  online(h);
  h.up.router = true;
  await h.step(); // 1_020_000: the next minute
  assert.deepEqual(h.minutes, [{ ts: 960_000, rounds: 19, failed: 3, local: 2, rtt_sum: 9 * 40 + 5 * 100, rtt_n: 14, rtt_max: 100 }]);
  h.m.stop();
  assert.deepEqual(h.minutes[1], { ts: 1_020_000, rounds: 1, failed: 0, local: 0, rtt_sum: 100, rtt_n: 1, rtt_max: 100 });
});

test('parseTargets, gatewayTarget and signalNote', () => {
  assert.deepEqual(parseTargets(['1.1.1.1', ' 9.9.9.9:53 ', '[2606:4700::1111]:443']), [
    { host: '1.1.1.1', port: 443, label: '1.1.1.1' },
    { host: '9.9.9.9', port: 53, label: '9.9.9.9:53' },
    { host: '2606:4700::1111', port: 443, label: '2606:4700::1111' },
  ]);
  assert.deepEqual(gatewayTarget('https://192.168.1.1'), { host: '192.168.1.1', port: 443, label: 'router' });
  assert.deepEqual(gatewayTarget('http://127.0.0.1:8081'), { host: '127.0.0.1', port: 8081, label: 'router' });
  assert.equal(signalNote({ lte: { rsrp: -105, sinr: 6 }, nr: { rsrp: -96, sinr: 0 } }), 'LTE -105 dBm, SINR 6 dB · 5G -96 dBm, SINR 0 dB');
  assert.equal(signalNote({ lte: { rsrp: -105, sinr: null }, nr: null }), 'LTE -105 dBm');
  assert.equal(signalNote(null), null);
});

test('tcpProbe: a listening port answers, a closed one does not', async () => {
  const server = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ok = await tcpProbe({ host: '127.0.0.1', port }, 1000);
    assert.equal(ok.ok, true);
    assert.equal(typeof ok.rttMs, 'number');
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(await tcpProbe({ host: '127.0.0.1', port }, 1000), { ok: false, rttMs: null });
});
