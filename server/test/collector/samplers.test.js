import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTraffic, trafficTotals } from '../../src/collector/samplers.js';

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
  const s = summarizeTraffic(rows, { bucketMs: 60e3, from: 0, to: 3600e3, tzOffsetMin: 0 });
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
  const s = summarizeTraffic(rows, { bucketMs: 60e3, from: 0, to: 60e3, tzOffsetMin: 0 });
  assert.equal(s.totals.rx, 3_750_000);
  assert.equal(Math.round(s.peak.rx), 1_000_000);
});
