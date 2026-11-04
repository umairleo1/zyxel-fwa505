// Uptime only has 1 s resolution and polls jitter: a smaller jump is the same boot.
export const SAME_BOOT_MS = 120_000;
const REASON = /reboot|restart|upgrad|firmware|fota|factory|reset to default/i;

/**
 * Did the router stay up between two status reads? Each read is
 * { uptimeSec, wall: Date.now(), mono: performance.now() }. Router uptime is
 * compared with two clocks because each fails differently: the wall clock steps
 * (NTP sync on a Pi without an RTC), the monotonic clock stops while the host
 * sleeps. Uptime advancing in step with either one means the same boot. Pure.
 */
export function uptimeContinues(prev, cur, slackMs = SAME_BOOT_MS) {
  const uptimeMs = (cur.uptimeSec - prev.uptimeSec) * 1000;
  const near = (elapsed) => Math.abs(uptimeMs - elapsed) <= slackMs;
  return near(cur.mono - prev.mono) || near(cur.wall - prev.wall);
}

/**
 * Decide whether the router rebooted since we last stored its boot time. Pure.
 * rebooted: already known (uptime didn't continue), so skip the boot-time comparison.
 * logs: router log lines around the new boot, used to explain it.
 * Returns null, or { boot_ts, kind: 'expected' | 'unexplained', reason }.
 */
export function detectReboot({ bootedAt, storedBootedAt, logs = [], rebooted = false }) {
  if (!rebooted && (!storedBootedAt || bootedAt - storedBootedAt <= SAME_BOOT_MS)) return null;
  // Only the router's log can say why; a power cut, crash and a manual reboot
  // without a log line all look the same.
  const hint = logs.find((l) => REASON.test(l.message));
  return { boot_ts: bootedAt, kind: hint ? 'expected' : 'unexplained', reason: hint?.message ?? null };
}

export function rebootMessage({ boot_ts, reason }, lastSeenBefore) {
  const lost = lastSeenBefore && lastSeenBefore < boot_ts ? `; last seen up ${Math.round((boot_ts - lastSeenBefore) / 1000)}s before` : '';
  return `Router rebooted at ${new Date(boot_ts).toLocaleString()}${reason ? ` (${reason})` : ' (no reason in the router log)'}${lost}`;
}
