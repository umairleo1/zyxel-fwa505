// Uptime only has 1 s resolution and polls jitter: a smaller jump is the same boot.
export const SAME_BOOT_MS = 120_000;
const REASON = /reboot|restart|upgrad|firmware|fota|factory|reset to default/i;

/**
 * Decide whether the router rebooted since we last stored its boot time. Pure.
 * logs: router log lines around the new boot, used to explain it.
 * Returns null, or { boot_ts, kind: 'expected' | 'unexplained', reason }.
 */
export function detectReboot({ bootedAt, storedBootedAt, logs = [] }) {
  if (!storedBootedAt || bootedAt - storedBootedAt <= SAME_BOOT_MS) return null;
  // Only the router's log can say why; a power cut, crash and a manual reboot
  // without a log line all look the same.
  const hint = logs.find((l) => REASON.test(l.message));
  return { boot_ts: bootedAt, kind: hint ? 'expected' : 'unexplained', reason: hint?.message ?? null };
}

export function rebootMessage({ boot_ts, reason }, lastSeenBefore) {
  const lost = lastSeenBefore && lastSeenBefore < boot_ts ? `; last seen up ${Math.round((boot_ts - lastSeenBefore) / 1000)}s before` : '';
  return `Router rebooted at ${new Date(boot_ts).toLocaleString()}${reason ? ` (${reason})` : ' (no reason in the router log)'}${lost}`;
}
