import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RouterClient } from '../../src/router/client.js';

test('retries a GET once when the router drops the connection', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/cgi-bin/DAL') && hits++ === 0) return req.socket.destroy(); // -> "socket hang up"
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'ZCFG_SUCCESS', Object: [{ DeviceInfo: { UpTime: 5 } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new RouterClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, username: 'a', password: 'b' });
  client.sessionKey = 'k'; // skip login
  const data = await client.getStatus();
  assert.equal(data.Object[0].DeviceInfo.UpTime, 5);
  assert.equal(hits, 2);
  server.close();
});

test('refuses destructive calls', async () => {
  const client = new RouterClient({ baseUrl: 'http://127.0.0.1:1', username: 'a', password: 'b' });
  client.sessionKey = 'k';
  await assert.rejects(client.getJson('/cgi-bin/Log?action=DEL_LOG'), /read-only/);
});
