import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { controlRoutes } from '../../src/http/routes/control.js';
import { csrfGuard } from '../../src/http/security.js';

async function serve(control, t) {
  const app = express();
  app.use(csrfGuard);
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', controlRoutes({ control }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/control${path}`, init);
}

test('backup POST preserves bytes and marks its attachment private', async (t) => {
  const bytes = Buffer.from([0, 255, 1, 13, 10]);
  const request = await serve(
    {
      backup: async (kind) => {
        assert.equal(kind, 'configuration');
        return { body: bytes, filename: 'router.rom\r\nX-Injected: yes', contentType: 'application/octet-stream' };
      },
    },
    t,
  );
  const response = await request('/backup/configuration', { method: 'POST', headers: { 'X-Insight-Request': '1' } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-injected'), null);
  assert.equal(response.headers.get('content-disposition').includes('\r'), false);
});

test('restore receives exact binary, decoded filename and explicit confirmation', async (t) => {
  const bytes = Buffer.from([0, 255, 12, 4]);
  let calls = 0;
  const request = await serve(
    {
      restore: async (body, filename, confirm) => {
        calls++;
        assert.deepEqual(body, bytes);
        assert.equal(filename, 'saved configuration.rom');
        assert.equal(confirm, 'RESTORE');
        return { state: 'reconnecting' };
      },
    },
    t,
  );
  const response = await request('/restore', {
    method: 'POST',
    headers: {
      'X-Insight-Request': '1',
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent('saved configuration.rom'),
      'X-Confirm': 'RESTORE',
    },
    body: bytes,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'reconnecting');
  const malformed = await request('/restore', {
    method: 'POST',
    headers: { 'X-Insight-Request': '1', 'Content-Type': 'application/octet-stream', 'X-Filename': '%xx', 'X-Confirm': 'RESTORE' },
    body: bytes,
  });
  assert.equal(malformed.status, 400);
  assert.equal(calls, 1);
});

test('control actions require the existing CSRF header and propagate service denial', async (t) => {
  let calls = 0;
  const request = await serve(
    {
      firmwareInstall: async () => {
        calls++;
        throw Object.assign(new Error('A high account is required.'), { status: 403, kind: 'permission' });
      },
    },
    t,
  );
  const missingHeader = await request('/firmware/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'UPGRADE' }),
  });
  assert.equal(missingHeader.status, 403);
  assert.equal(calls, 0);
  const denied = await request('/firmware/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Insight-Request': '1' },
    body: JSON.stringify({ confirm: 'UPGRADE' }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'A high account is required.', kind: 'permission' });
});

test('partial reset forwards explicit retention selections', async (t) => {
  const request = await serve(
    {
      partialReset: async (confirm, keep) => {
        assert.equal(confirm, 'RESET');
        assert.deepEqual(keep, ['1', '4']);
        return { state: 'reconnecting' };
      },
    },
    t,
  );
  const response = await request('/reset/partial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Insight-Request': '1' },
    body: JSON.stringify({ confirm: 'RESET', keep: ['1', '4'] }),
  });
  assert.equal(response.status, 200);
});
