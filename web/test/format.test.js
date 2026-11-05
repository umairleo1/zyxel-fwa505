// Time helpers across the UK clock change (BST → GMT at 02:00 BST on 25 Oct 2026).
// TZ must be set before anything formats a date, hence the dynamic import.
process.env.TZ = 'Europe/London';
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { addDays, formatDay, formatWhen, startOfDay, timeTicks } = await import('../src/lib/format.js');

const H = 3600e3;
const BEFORE = Date.UTC(2026, 9, 24, 12); // Sat 24 Oct, 13:00 BST
const AFTER = Date.UTC(2026, 9, 27, 12); // Tue 27 Oct, 12:00 GMT
const local = (t) => {
  const d = new Date(t);
  return [d.getDate(), d.getHours(), d.getMinutes()];
};

test('startOfDay is local midnight on both sides of the change', () => {
  assert.equal(startOfDay(BEFORE), Date.UTC(2026, 9, 23, 23)); // 00:00 BST
  assert.equal(startOfDay(AFTER), Date.UTC(2026, 9, 27, 0)); // 00:00 GMT
});

test('addDays steps calendar days, including the 25-hour day', () => {
  const sat = startOfDay(BEFORE);
  const sun = addDays(sat, 1);
  const mon = addDays(sat, 2);
  assert.equal(sun - sat, 24 * H);
  assert.equal(mon - sun, 25 * H);
  assert.deepEqual(local(mon), [26, 0, 0]);
  assert.equal(addDays(mon, -2), sat);
});

test('formatDay recognises yesterday across the change', () => {
  const now = Date.UTC(2026, 9, 26, 9); // Mon 09:00 GMT
  assert.match(formatDay(Date.UTC(2026, 9, 25, 0, 30), now), /^Yesterday/); // Sun 01:30 BST
  assert.match(formatDay(Date.UTC(2026, 9, 26, 0, 5), now), /^Today/);
  assert.doesNotMatch(formatDay(Date.UTC(2026, 9, 24, 22, 30), now), /^(Today|Yesterday)/); // Sat 23:30 BST
});

test('day ticks over 7d/30d stay on local midnight after the change', () => {
  for (const days of [7, 30]) {
    const to = AFTER;
    const { ticks } = timeTicks(to - days * 24 * H, to, days); // one tick per day
    assert.ok(ticks.length >= days - 1);
    for (const t of ticks) assert.deepEqual(local(t).slice(1), [0, 0], new Date(t).toString());
    assert.ok(ticks.includes(Date.UTC(2026, 9, 24, 23))); // Sun 25 Oct 00:00 BST
    assert.ok(ticks.includes(Date.UTC(2026, 9, 26, 0))); // Mon 26 Oct 00:00 GMT
  }
});

test('multi-day ticks are stable as the window slides', () => {
  const a = timeTicks(AFTER - 30 * 24 * H, AFTER, 8).ticks;
  const b = timeTicks(AFTER - 30 * 24 * H + 5 * 60e3, AFTER + 5 * 60e3, 8).ticks;
  assert.deepEqual(a, b);
});

test('hourly ticks stay on round local hours through the change', () => {
  const from = Date.UTC(2026, 9, 24, 12);
  const to = Date.UTC(2026, 9, 25, 12);
  const { ticks } = timeTicks(from, to, 4); // 6 h steps
  assert.deepEqual(
    ticks.map((t) => local(t)),
    [
      [24, 18, 0],
      [25, 0, 0],
      [25, 6, 0],
      [25, 12, 0],
    ],
  );
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1]);
});

test('sub-hour ticks have no duplicates through the repeated hour', () => {
  const from = Date.UTC(2026, 9, 24, 23, 30); // 00:30 BST
  const to = Date.UTC(2026, 9, 25, 3); // 03:00 GMT
  const { ticks } = timeTicks(from, to, 20); // 15 min steps
  assert.equal(new Set(ticks).size, ticks.length);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1]);
  for (const t of ticks) assert.equal(new Date(t).getMinutes() % 15, 0);
});

test('spring-forward: no duplicate tick for the skipped hour', () => {
  const from = Date.UTC(2026, 2, 28, 22); // Sat 28 Mar 22:00 GMT
  const to = Date.UTC(2026, 2, 29, 4); // Sun 05:00 BST
  const { ticks } = timeTicks(from, to, 7); // 1 h steps
  assert.equal(new Set(ticks).size, ticks.length);
  assert.ok(!ticks.some((t) => new Date(t).getHours() === 1)); // 01:xx doesn't exist
});

test('formatWhen is a stable clock time, with the date on other days', () => {
  const now = Date.UTC(2026, 9, 26, 15);
  const t = Date.UTC(2026, 9, 26, 9, 5, 7);
  assert.equal(formatWhen(t, now), formatWhen(t, now + 59e3)); // doesn't tick
  assert.match(formatWhen(t, now), /^09:05$/);
  assert.match(formatWhen(t, now, { seconds: true }), /^09:05:07$/);
  assert.match(formatWhen(Date.UTC(2026, 9, 24, 9), now), /24.*10:00/); // 10:00 BST
  assert.equal(formatWhen(null, now), 'never');
});

test('formatDuration keeps minutes past a day', async () => {
  const { formatDuration } = await import('../src/lib/format.js');
  assert.equal(formatDuration(173_979), '2d 0h 19m');
  assert.equal(formatDuration(3 * 86400), '3d 0h 0m');
  assert.equal(formatDuration(5400), '1h 30m');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(9), '9s');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(173_979, { seconds: true }), '2d 0h 19m 39s');
  assert.equal(formatDuration(5405, { seconds: true }), '1h 30m 5s');
  assert.equal(formatDuration(125, { seconds: true }), '2m 5s');
});
