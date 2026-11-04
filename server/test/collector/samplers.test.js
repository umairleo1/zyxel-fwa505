import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTraffic, trafficTotals } from '../../src/collector/samplers.js';

const utcDay = (ts) => Math.floor(ts / 86400e3) * 86400e3;

test('sums WAN and LAN interface counters', () => {
  const t = trafficTotals([
    {
      ipIface: [{ Name: 'LAN' }, { Name: 'WAN' }, { Name: 'WAN' }],
      ipIfaceSt: [
        { BytesSent: 10, BytesReceived: 20 },
        { BytesSent: 100, BytesReceived: 2000 },
        { BytesSent: 0, BytesReceived: 5 },
      ],
    },
  ]);
  assert.deepEqual(t, { wan_rx: 2005, wan_tx: 100, lan_rx: 20, lan_tx: 10 });
});

test('throughput, daily usage, counter reset and gaps', () => {
  const rows = [
    { ts: 0, wan_rx: 0, wan_tx: 0 },
    { ts: 30e3, wan_rx: 3_750_000, wan_tx: 375_000 }, // 1 Mbps down, 0.1 Mbps up
    { ts: 60e3, wan_rx: 7_500_000, wan_tx: 750_000 },
    { ts: 90e3, wan_rx: 1_000, wan_tx: 0 }, // reboot: counters restarted
    { ts: 3600e3, wan_rx: 1_000_001_000, wan_tx: 0 }, // 58-minute gap: counted as usage, not throughput
  ];
  const s = summarizeTraffic(rows, { bucketMs: 60e3, from: 0, to: 3600e3, dayStart: utcDay });
  assert.equal(s.totals.rx, 7_500_000 + 1_000 + 1_000_000_000);
  assert.equal(s.gapBytes, 1_000_000_000);
  assert.equal(s.totals.tx, 750_000);
  assert.equal(Math.round(s.peak.rx), 1_000_000);
  assert.equal(s.days.length, 1);
  assert.equal(s.series.length, 2);
});

test('an impossible counter jump (router swap / reset) is ignored, not counted as traffic', () => {
  const rows = [
    { ts: 0, wan_rx: 1_000, wan_tx: 0 },
    { ts: 30e3, wan_rx: 28_000_000_000, wan_tx: 0 }, // +28 GB in 30 s = 7.5 Gbps: impossible for the modem
    { ts: 60e3, wan_rx: 28_003_750_000, wan_tx: 0 }, // then a normal 1 Mbps
  ];
  const s = summarizeTraffic(rows, { bucketMs: 60e3, from: 0, to: 60e3, dayStart: utcDay });
  assert.equal(s.totals.rx, 3_750_000);
  assert.equal(Math.round(s.peak.rx), 1_000_000);
});

test('daily usage splits at local midnight on both sides of the clock change', async () => {
  // Europe/London left BST on 25 Oct 2026 at 02:00 BST. Run in a child process so TZ applies.
  const { execFileSync } = await import('node:child_process');
  const script = `
    import { summarizeTraffic } from ${JSON.stringify(new URL('../../src/collector/samplers.js', import.meta.url).href)};
    const at = (iso) => Date.parse(iso);
    const row = (ts, rx) => ({ ts, wan_rx: rx, wan_tx: 0 });
    // 22:59 and 23:01 UTC: before the change that's 23:59 / 00:01 BST (two days), after it 22:59 / 23:01 GMT (one day).
    const rows = [
      row(at('2026-10-20T22:59:00Z'), 0), row(at('2026-10-20T23:01:00Z'), 100),
      row(at('2026-10-30T22:59:00Z'), 100), row(at('2026-10-30T23:01:00Z'), 300),
    ];
    const { days } = summarizeTraffic(rows, { bucketMs: 60e3, from: 0, to: Date.now() });
    console.log(JSON.stringify(days.map((d) => [new Date(d.day).toISOString(), d.rx])));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'Europe/London' } });
  assert.deepEqual(JSON.parse(out), [
    ['2026-10-20T23:00:00.000Z', 100], // 21 Oct starts at 00:00 BST
    ['2026-10-30T00:00:00.000Z', 200], // 30 Oct starts at 00:00 GMT; the long gap is credited here
  ]);
});

test('cached (stale) router data is never recorded as a new sample', async () => {
  const { startSamplers } = await import('../../src/collector/samplers.js');
  const writes = [];
  const db = {
    insertTraffic: (t) => writes.push(['traffic', t]),
    batch: (fn) => fn(),
    getMeta: () => '1',
    setMeta() {},
    device: () => null,
    devices: () => [],
    upsertDevice: (d) => writes.push(['device', d]),
    insertStations() {},
    insertMany() {},
  };
  // Router unavailable: router/data serves the last cached values marked stale.
  const routerData = { raw: async () => ({ stale: true, data: [] }) };
  const s = startSamplers({ routerData, db, trafficMs: 10, devicesMs: 10, log: { warn() {}, error() {} } });
  await new Promise((r) => setTimeout(r, 6_200)); // first runs are staggered by 4 s and 6 s
  s.stop();
  assert.deepEqual(writes, []);
});
