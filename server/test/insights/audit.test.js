import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIpv4, runAudit } from '../../src/insights/audit.js';

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

test('firmware audit distinguishes scheduled checks from automatic installation', async () => {
  for (const force of [false, true]) {
    const a = await runAudit(async (id) => (id === 'periodic_FOTA_config' ? [{ PeriodicCheckEnable: true, ForceUpgrade: force }] : []));
    const fota = a.checks.find((c) => c.id === 'fota');
    assert.equal(fota.status, force ? 'pass' : 'warn');
    assert.equal(fota.title, force ? 'Automatic firmware updates are on' : 'Scheduled firmware checks are on');
  }
});

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

const wanWith = (ip) => [
  {
    WanLanInfo: [{ X_ZYXEL_Type: 'WAN', Status: 'Up', X_ZYXEL_DefaultGatewayIface: true, IPv4Address: [{ IPAddress: ip }] }],
    FirewallInfo: { X_ZYXEL_DenyPing: false },
  },
];

test('carrier-grade NAT is detected and reframes the exposure checks', async () => {
  const a = await runAudit(async (id) => {
    if (id === 'status') return wanWith('10.0.0.13');
    if (id === 'nat') return [{ Description: 'game', InternalClient: '192.168.1.20' }];
    if (!(id in fixtures)) throw new Error('n/a');
    return fixtures[id];
  });
  const byId = Object.fromEntries(a.checks.map((c) => [c.id, c]));
  assert.match(byId.cgnat.title, /^Behind carrier-grade NAT \(WAN address 10\.0\.0\.13\)$/);
  assert.equal(byId.ping.status, 'pass', "pings can't arrive at all");
  assert.equal(byId.portfwd.status, 'warn', "a port forward behind CGNAT can't work");
  assert.match(byId['remote-mgmt'].detail, /unreachable from the Internet anyway/);
});

test('a public WAN address keeps the exposure checks as they are', async () => {
  const a = await runAudit(async (id) => {
    if (id === 'status') return wanWith('81.2.69.160');
    if (!(id in fixtures)) throw new Error('n/a');
    return fixtures[id];
  });
  const byId = Object.fromEntries(a.checks.map((c) => [c.id, c]));
  assert.match(byId.cgnat.title, /^Public IPv4 address/);
  assert.equal(byId.ping.status, 'info', 'answers pings, and is reachable');
});

test('notes never move the security score', async () => {
  const withNotes = await runAudit(async (id) => {
    if (!(id in fixtures)) throw new Error('n/a');
    return fixtures[id];
  });
  const counts = withNotes.counts;
  assert.equal(withNotes.scored, counts.pass + counts.warn + counts.fail);
  assert.equal(withNotes.score, Math.round(((counts.pass + counts.warn * 0.25) / withNotes.scored) * 100));
});

test('isPublicIpv4 knows private and carrier-grade NAT ranges', () => {
  for (const ip of ['10.0.0.13', '100.64.1.1', '100.127.255.254', '172.16.0.1', '172.31.9.9', '192.168.1.1', '0.0.0.0', 'nonsense']) {
    assert.equal(isPublicIpv4(ip), false, ip);
  }
  for (const ip of ['81.2.69.160', '100.63.255.255', '100.128.0.1', '172.32.0.1', '8.8.8.8']) assert.equal(isPublicIpv4(ip), true, ip);
});
