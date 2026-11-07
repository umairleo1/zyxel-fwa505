import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controlIndex,
  controlPatch,
  controlSummary,
  operationAcknowledgeable,
  operationActive,
  operationBlocks,
  pageLabel,
  privilegePages,
} from '../src/lib/control.js';

test('editing WAN settings preserves hidden passwords and omits unchanged fields', () => {
  const original = { Name: 'ETHWAN', NatEnable: true, pppPassword: '••••••••' };
  assert.deepEqual(controlPatch(original, { ...original, NatEnable: false, pppPassword: '' }, Object.keys(original), ['pppPassword']), {
    NatEnable: false,
  });
  assert.deepEqual(controlPatch(original, original, Object.keys(original), ['pppPassword']), {});
  assert.deepEqual(controlPatch(original, { ...original, pppPassword: 'new secret' }, Object.keys(original), ['pppPassword']), {
    pppPassword: 'new secret',
  });
});

test('confirmation summaries never contain entered passwords', () => {
  const summary = controlSummary({
    Username: 'new-user',
    Password: 'private password',
    pppPassword: 'provider secret',
    oldPw: 'old secret',
  });
  assert.match(summary[0], /new-user/);
  for (const secret of ['private password', 'provider secret', 'old secret']) assert.ok(!summary.join('\n').includes(secret));
});

test('unknown router outcomes block resubmission without pretending the operation is still running', () => {
  assert.equal(operationActive({ state: 'unknown' }), false);
  assert.equal(operationBlocks({ state: 'unknown' }), true);
  assert.equal(operationBlocks({ state: 'reconnecting' }), true);
  assert.equal(operationBlocks({ state: 'complete' }), false);
});

test('native privilege page identifiers survive parsing without duplicates', () => {
  assert.deepEqual(privilegePages('System, Custom_Page, ,System'), ['System', 'Custom_Page']);
  assert.deepEqual(privilegePages(['System', 'Custom_Page']), ['System', 'Custom_Page']);
  assert.deepEqual(privilegePages(null), []);
});

test('an unknown outcome blocks until its deadline, and can be acknowledged early once the router is readable', () => {
  const now = 1_000;
  assert.equal(operationBlocks({ state: 'unknown', deadline: now + 1 }, now), true);
  assert.equal(operationBlocks({ state: 'unknown', deadline: now }, now), false);
  assert.equal(operationAcknowledgeable({ state: 'unknown', deadline: now + 1 }, now), false);
  assert.equal(operationAcknowledgeable({ state: 'unknown', deadline: now + 1, result: { configurationReadable: true } }, now), true);
  assert.equal(operationAcknowledgeable({ state: 'complete', deadline: 0 }, now), false);
});

test('rows are addressed by their own index, never by list position', () => {
  assert.equal(controlIndex({ Index: 4 }), 4);
  assert.equal(controlIndex({ index: 2 }), 2);
  assert.equal(controlIndex({ Iid: 7 }), 7);
  assert.equal(controlIndex({ Username: 'bob' }), null);
});

test('reviews and page names read as words, not router identifiers', () => {
  assert.deepEqual(controlSummary({ VLANEnable: false, StartTime: 3, ShiftTimeRange: 7200, AccountIdleTime: 600 }), [
    'VLAN: off',
    'Start hour: 03:00',
    'Update window: 2 h',
    'Idle timeout: 10 min',
  ]);
  assert.equal(pageLabel('McastSt'), 'Multicast status');
  assert.equal(pageLabel('Home_Networking'), 'Home Networking');
});
