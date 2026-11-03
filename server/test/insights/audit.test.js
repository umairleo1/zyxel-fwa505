import test from 'node:test';
import assert from 'node:assert/strict';
import { runAudit } from '../../src/insights/audit.js';

// Shapes as returned by an FWA505 (V1.71), trimmed.
const fixtures = {
  mgmt_srv: [
    { Name: 'HTTP', Port: 80, Mode: '' },
    { Name: 'HTTPS', Port: 443, Mode: 'LAN_ONLY' },
    { Name: 'TELNET', Port: 23, Mode: '' },
    { Name: 'SSH', Port: 22, Mode: 'LAN_ONLY' },
  ],
  wlan: [
    {
      SSID: 'Zyxel_0000',
      band: '2.4GHz',
      wlEnable: true,
      MainSSID: true,
      SecurityMode: 'WPA2-Personal',
      channel: 11,
      ModesSupported: 'None,WPA2-Personal,WPA3-Personal',
    },
    { SSID: 'Zyxel_0000', band: '5GHz', wlEnable: true, MainSSID: true, SecurityMode: 'WPA2-Personal', channel: 52 },
    { SSID: 'guest', band: '2.4GHz', wlEnable: false, MainSSID: false, SecurityMode: 'WPA2-Personal' },
  ],
  wps: [{ Band: '2.4GHz', Enable: true, X_ZYXEL_WPS_EnablePBC: true, X_ZYXEL_WPS_EnableAPPin: false, X_ZYXEL_WPS_EnableStaPin: false }],
  snmp: [{ Enable: false, GetCommunity: 'public', SetCommunity: 'private' }],
  firewall: [{ IPv4_Enable: true, IPv6_Enable: true, enableDos: true, Level_GUI: 'Low' }],
  lanadv: [{ UPnPEnable: false }],
  nat_conf: [{ DMZHost: '0.0.0.0' }],
  nat: [],
  logset: [{ LogMode: 'Local', LogServer: '0.0.0.0', UDPPort: 514 }],
};

test('audit flags the real-world findings', async () => {
  const a = await runAudit(async (id) => {
    if (!(id in fixtures)) throw new Error('n/a');
    return fixtures[id];
  });
  const byId = Object.fromEntries(a.checks.map((c) => [c.id, c]));
  assert.equal(byId['remote-mgmt'].status, 'pass');
  assert.equal(byId.wps.status, 'warn');
  assert.equal(byId.dfs.status, 'info');
  assert.equal(byId['wifi-sec'].status, 'info'); // WPA3 supported but unused
  assert.equal(byId.snmp.status, 'info'); // disabled, but default communities
  assert.equal(byId.syslog.status, 'warn');
  assert.equal(byId.dmz.status, 'pass');
  assert.ok(!byId.telnet);
  assert.ok(a.score > 0 && a.score <= 100);
  assert.equal(a.checks[0].status === 'fail' || a.checks[0].status === 'warn', true); // worst first
});

test('audit runs on every captured fixture without throwing', async () => {
  const fs = await import('node:fs');
  const get = async (id) => {
    const f = new URL(`../../dev/fixtures/${id === 'snmp' ? 'System_oid_snmp' : `DAL_oid_${id}`}.json`, import.meta.url);
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(d) ? d : d.Object;
  };
  const a = await runAudit(get);
  assert.ok(a.checks.length >= 15, `only ${a.checks.length} checks`);
  assert.ok(a.score > 40);
});
