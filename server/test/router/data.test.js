import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets, MASK } from '../../src/router/secrets.js';
import { parseWlanTable } from '../../src/router/catalog.js';
import { createRouterData } from '../../src/router/data.js';

test('masks credentials but keeps look-alike flags', () => {
  const out = maskSecrets([
    {
      wifiPassword: 'hunter2',
      PskDisplay: 'abc',
      GetCommunity: 'public',
      Passthru_Enable: false,
      USIM_PIN_RemainingAttempts: 3,
      Password: '',
      nested: { RadiusSecret: 'x', SSID: 'Home' },
    },
  ]);
  assert.deepEqual(out, [
    {
      wifiPassword: MASK,
      PskDisplay: MASK,
      GetCommunity: MASK,
      Passthru_Enable: false,
      USIM_PIN_RemainingAttempts: 3,
      Password: '',
      nested: { RadiusSecret: MASK, SSID: 'Home' },
    },
  ]);
});

test('parses the WLAN station text table', () => {
  const rows = parseWlanTable([
    {
      result: 'Address            Rate(Mbps)  RSSI   SNR  Level 02:00:00:00:00:03         144   -62    28      4 ',
      result5:
        'Address            Rate(Mbps)  RSSI   SNR  Level 02:00:00:00:00:01        1080   -39    51      5 02:00:00:00:00:02         288   -74    16      3 ',
    },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.mac, r.band, r.rateMbps, r.rssi]),
    [
      ['02:00:00:00:00:03', '2.4GHz', 144, -62],
      ['02:00:00:00:00:01', '5GHz', 1080, -39],
      ['02:00:00:00:00:02', '5GHz', 288, -74],
    ],
  );
});

test('caches, de-duplicates concurrent reads, and refuses to log in while paused', async () => {
  let calls = 0;
  const client = {
    async getJson(path) {
      calls++;
      const data = { result: 'ZCFG_SUCCESS', Object: [{ wifiPassword: 'x', SSID: 'a' }] };
      this.onResponse?.(path, data);
      return data;
    },
  };
  const collector = { state: { phase: 'ok' } };
  const rd = createRouterData({ client, collector, liveTtlMs: 1000 });
  const [a] = await Promise.all([rd.public('status'), rd.public('status')]);
  assert.equal(calls, 1);
  assert.equal(a.data[0].wifiPassword, MASK);
  assert.equal((await rd.raw('status')).data[0].wifiPassword, 'x');
  collector.state.phase = 'paused';
  assert.equal((await rd.public('status', 0)).stale, true); // serves cache, no request
  assert.equal(calls, 1);
  await assert.rejects(rd.public('wlan'), (e) => e.status === 409);
  await assert.rejects(rd.public('not_allowed'), (e) => e.status === 404);
});

test('reads made elsewhere (e.g. by the collector) are served from the shared cache', async () => {
  let calls = 0;
  const client = {
    async getJson(path) {
      calls++;
      const d = { Object: [{ n: calls }] };
      this.onResponse?.(path, d);
      return d;
    },
  };
  const rd = createRouterData({ client, collector: { state: { phase: 'ok' } } });
  await client.getJson('/cgi-bin/DAL?oid=status'); // collector's own poll
  const r = await rd.public('status');
  assert.equal(calls, 1);
  assert.equal(r.data[0].n, 1);
  await rd.public('wlan'); // config: fetched once, then cached for minutes
  await rd.public('wlan');
  assert.equal(calls, 2);
});
