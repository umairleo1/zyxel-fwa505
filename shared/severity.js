// Syslog severities and how Insight groups them for charts and filters.
export const LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

export const ERROR_LEVELS = ['emerg', 'alert', 'crit', 'err'];

/** err | warning | notice | info (debug and unknown count as info). */
export function levelGroup(level) {
  if (ERROR_LEVELS.includes(level)) return 'err';
  if (level === 'warning' || level === 'notice') return level;
  return 'info';
}
