import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { jitter, runSpeedTest, steadyMbps } from '../../src/speed/measure.js';

/** A local speed server: /__down?bytes=N streams zeros, /__up swallows a POST (or refuses it). */
async function speedServer({ refuseUpload = false } = {}) {
  const piece = Buffer.alloc(64 * 1024);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__down') {
      let left = Number(url.searchParams.get('bytes'));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const pump = () => {
        while (left > 0) {
          const n = Math.min(piece.length, left);
          left -= n;
          if (!res.write(piece.subarray(0, n))) return res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', () => (left = 0));
      return pump();
    }
    if (url.pathname === '/__up') {
      req.resume();
      return req.on('end', () => {
        res.writeHead(refuseUpload ? 403 : 200);
        res.end();
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    options: {
      downUrl: `${base}/__down?bytes={bytes}`,
      upUrl: `${base}/__up`,
      latencyTarget: { host: '127.0.0.1', port: server.address().port },
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

test('steady speed skips the warm-up and is in Mbps', () => {
  // 0–1 s: slow start (1 MB); 1–3 s: 10 MB/s steady.
  const samples = [
    { t: 0, bytes: 0 },
    { t: 1000, bytes: 1e6 },
    { t: 2000, bytes: 11e6 },
    { t: 3000, bytes: 21e6 },
  ];
  assert.equal(steadyMbps(samples), 80);
  assert.equal(steadyMbps([{ t: 0, bytes: 0 }]), null);
});

test('jitter is the mean change between consecutive round trips', () => {
  assert.equal(jitter([20, 30, 25, 25]), 5);
  assert.equal(jitter([20]), null);
});

test('a test measures both directions and idle and loaded latency', async () => {
  const s = await speedServer();
  const phases = new Set();
  try {
    const r = await runSpeedTest({ ...s.options, downMs: 600, upMs: 600, streams: 2, onProgress: (p) => phases.add(p.phase) });
    assert.ok(r.downMbps > 0, 'download measured');
    assert.ok(r.upMbps > 0, 'upload measured');
    assert.ok(r.idleMs >= 0);
    assert.ok(r.loadedDownMs >= 0);
    assert.ok(r.bytesDown > 0 && r.bytesUp > 0);
    assert.deepEqual([...phases], ['latency', 'download', 'upload']);
  } finally {
    await s.close();
  }
});

test('the data cap ends a transfer early', async () => {
  const s = await speedServer();
  try {
    const r = await runSpeedTest({ ...s.options, downMs: 10_000, upMs: 10_000, maxBytes: 4e6, streams: 1 });
    // 75 % of the cap for download; one in-flight piece per stream may overshoot.
    assert.ok(r.bytesDown <= 3e6 + 256 * 1024, `download stopped near its share (${r.bytesDown})`);
    assert.ok(r.durationMs < 9000, 'did not run the full duration');
  } finally {
    await s.close();
  }
});

test('an upload the server refuses fails the test instead of counting', async () => {
  const s = await speedServer({ refuseUpload: true });
  try {
    await assert.rejects(runSpeedTest({ ...s.options, downMs: 300, upMs: 500, streams: 1 }), /Upload failed/);
  } finally {
    await s.close();
  }
});

test('an unreachable server fails, and aborting cancels', async () => {
  await assert.rejects(
    runSpeedTest({
      downUrl: 'http://127.0.0.1:9/__down?bytes={bytes}',
      upUrl: 'http://127.0.0.1:9/__up',
      latencyTarget: { host: '127.0.0.1', port: 9 },
      downMs: 300,
      upMs: 300,
      probeTimeoutMs: 50,
      streams: 1,
    }),
    /Download failed/,
  );
  const s = await speedServer();
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    await assert.rejects(runSpeedTest({ ...s.options, downMs: 5000, upMs: 5000, signal: ctrl.signal }), (e) => e.name === 'AbortError');
  } finally {
    await s.close();
  }
});
