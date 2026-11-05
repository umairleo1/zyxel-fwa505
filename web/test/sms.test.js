import test from 'node:test';
import assert from 'node:assert/strict';
import { groupThreads, threadKey } from '../src/lib/sms.js';

const m = (id, number, at, extra = {}) => ({ id, number, at, direction: 'in', unread: false, text: `m${id}`, ...extra });

test('received +44 and sent digits-only numbers are one conversation', () => {
  const threads = groupThreads([
    m(1, '+447700900123', 100),
    m(2, '447700900123', 200, { direction: 'out' }),
    m(3, 'EE', 300, { unread: true }),
    m(4, '+447700900456', 50, { unread: true }),
  ]);
  assert.deepEqual(
    threads.map((t) => [t.title, t.messages.map((x) => x.id), t.unread, t.named]),
    [
      ['EE', [3], 1, true],
      ['+447700900123', [1, 2], 0, false],
      ['+447700900456', [4], 1, false],
    ],
  );
  assert.equal(threads[1].replyTo, '+447700900123');
});

test('threadKey lines up national and international forms', () => {
  assert.equal(threadKey('+44 7700 900123'), threadKey('07700900123'));
  assert.equal(threadKey('447700900123'), threadKey('07700 900123'));
  assert.notEqual(threadKey('+447700900123'), threadKey('+447700900456'));
  assert.equal(threadKey('150'), '150', 'short codes as they are');
  assert.equal(threadKey('Vodafone'), 'name:vodafone');
  assert.deepEqual(groupThreads(), []);
});

test('listTime and dayLabel read like a phone', async () => {
  const { listTime, dayLabel } = await import('../src/lib/sms.js');
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  assert.match(listTime(new Date(2026, 10, 4, 14, 59).getTime(), now), /^14:59$/);
  assert.equal(listTime(new Date(2026, 10, 3, 9, 0).getTime(), now), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 10, 4, 1, 0).getTime(), now), 'Today');
  assert.match(dayLabel(new Date(2026, 9, 20).getTime(), now), /2026/);
});

test('byDay and filterThreads', async () => {
  const { byDay, filterThreads } = await import('../src/lib/sms.js');
  const d = (day, h) => new Date(2026, 10, day, h).getTime();
  const days = byDay([m(1, 'a', d(3, 9)), m(2, 'a', d(3, 22)), m(3, 'a', d(4, 8))]);
  assert.deepEqual(
    days.map((x) => x.messages.map((y) => y.id)),
    [[1, 2], [3]],
  );
  const threads = groupThreads([m(1, '+447700900123', 1, { text: 'Parcel at 6' }), m(2, 'EE', 2, { text: 'Allowance' })]);
  assert.deepEqual(
    filterThreads(threads, 'parcel').map((t) => t.title),
    ['+447700900123'],
  );
  assert.deepEqual(
    filterThreads(threads, '07700 900123').map((t) => t.title),
    ['+447700900123'],
  );
  assert.deepEqual(
    filterThreads(threads, 'ee').map((t) => t.title),
    ['EE'],
  );
  assert.equal(filterThreads(threads, '  ').length, 2);
});
