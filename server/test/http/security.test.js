import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedHostnames, basicPassword, hostnameOf, isLoopback, passwordMatches, CSP } from '../../src/http/security.js';
import { basic, fakeDeps, serve } from './helpers.js';

test('hostnameOf strips ports, brackets and case', () => {
  assert.equal(hostnameOf('LocalHost:4400'), 'localhost');
  assert.equal(hostnameOf('[::1]:4400'), '::1');
  assert.equal(hostnameOf('[fe80::1%en0]'), 'fe80::1');
  assert.equal(hostnameOf('::1'), '::1');
  assert.equal(hostnameOf('mac.local.'), 'mac.local');
  assert.equal(hostnameOf(undefined), '');
});

test('isLoopback', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) assert.ok(isLoopback(h), h);
  for (const h of ['0.0.0.0', '192.168.1.10', '::', 'example.com']) assert.ok(!isLoopback(h), h);
});

test('allowedHostnames: loopback, HOST, interfaces, hostname(.local), extras', () => {
  const set = allowedHostnames({
    httpHost: '192.168.1.50',
    extra: ['Insight.example:443'],
    interfaces: { en0: [{ address: '192.168.1.50' }, { address: 'fe80::1%en0' }] },
    hostname: 'MacBook',
  });
  for (const h of ['localhost', '127.0.0.1', '::1', '192.168.1.50', 'fe80::1', 'macbook', 'macbook.local', 'insight.example']) {
    assert.ok(set.has(h), h);
  }
  assert.ok(!allowedHostnames({ httpHost: '0.0.0.0', interfaces: {}, hostname: '' }).has('0.0.0.0'));
});

test('basic auth parsing and constant-time match', () => {
  assert.equal(basicPassword(basic('insight', 'p:w')), 'p:w');
  assert.equal(basicPassword('Bearer x'), null);
  assert.equal(basicPassword(undefined), null);
  assert.ok(passwordMatches('secret', 'secret'));
  assert.ok(!passwordMatches('secret2', 'secret'));
  assert.ok(!passwordMatches(null, 'secret'));
});

test('rejects unknown Host headers before anything else (DNS rebinding)', async (t) => {
  const s = await serve(fakeDeps());
  t.after(s.close);
  const bad = await s.request('/api/status', { headers: { host: 'evil.example:4400' } });
  assert.equal(bad.status, 421);
  assert.equal(bad.headers['x-content-type-options'], 'nosniff');
  assert.equal((await s.request('/api/status')).status, 200);
});

test('security headers on every response', async (t) => {
  const s = await serve(fakeDeps());
  t.after(s.close);
  const res = await s.request('/api/nope');
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/);
});

test('password protects API and SSE; health is open to loopback only', async (t) => {
  const s = await serve(fakeDeps({ security: { password: 'hunter2', allowedHosts: new Set(['localhost']) } }));
  t.after(s.close);
  const denied = await s.request('/api/status');
  assert.equal(denied.status, 401);
  assert.match(denied.headers['www-authenticate'], /^Basic /);
  assert.equal((await s.request('/api/events')).status, 401);
  assert.equal((await s.request('/api/status', { headers: { authorization: basic('x', 'wrong') } })).status, 401);
  assert.equal((await s.request('/api/status', { headers: { authorization: basic('anyone', 'hunter2') } })).status, 200);
  // Test client connects from 127.0.0.1, so health needs no password.
  assert.equal((await s.request('/api/health')).status, 200);
});

test('CSRF: POST needs X-Insight-Request: 1 and a same-host Origin', async (t) => {
  const s = await serve(fakeDeps());
  t.after(s.close);
  const host = `localhost:${s.port}`;
  assert.equal((await s.request('/api/collector/pause', { method: 'POST' })).status, 403);
  const ok = { 'x-insight-request': '1' };
  assert.equal((await s.request('/api/collector/pause', { method: 'POST', headers: ok })).status, 200);
  const sameOrigin = { ...ok, origin: `http://${host}` };
  assert.equal((await s.request('/api/collector/pause', { method: 'POST', headers: sameOrigin })).status, 200);
  const crossOrigin = { ...ok, origin: 'http://evil.example' };
  assert.equal((await s.request('/api/collector/pause', { method: 'POST', headers: crossOrigin })).status, 403);
  assert.equal((await s.request('/api/collector/pause', { method: 'POST', headers: { ...ok, origin: 'null' } })).status, 403);
});
