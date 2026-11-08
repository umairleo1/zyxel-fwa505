import http from 'node:http';
import { createApp } from '../../src/http/app.js';

/** Fakes for everything createApp needs; override per test. */
export function fakeDeps(over = {}) {
  return {
    db: { query: () => [], stats: () => ({ count: 0 }) },
    hub: { size: 0, subscribe: (_req, res) => res.end('sse') },
    collector: { state: { phase: 'ok', lastSuccessAt: Date.now() }, pause: async () => {}, resume() {} },
    routerData: { has: () => true, public: async (id) => ({ id, data: {} }) },
    statusPayload: () => ({}),
    security: { allowedHosts: new Set(['localhost', '127.0.0.1']) },
    ...over,
  };
}

/** Start the app on an ephemeral loopback port; returns { request, close }. */
export async function serve(deps) {
  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  // body: sent as JSON (with the content type) when given.
  const request = (path, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      if (payload) headers = { 'content-type': 'application/json', ...headers };
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(payload ?? undefined);
    });
  return { port, request, close: () => new Promise((r) => server.close(r)) };
}

export const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
