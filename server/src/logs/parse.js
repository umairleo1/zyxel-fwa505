const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const FACILITIES = [
  'kern',
  'user',
  'mail',
  'daemon',
  'auth',
  'syslog',
  'lpr',
  'news',
  'uucp',
  'cron',
  'authpriv',
  'ftp',
  'ntp',
  'audit',
  'alert',
  'clock',
  'local0',
  'local1',
  'local2',
  'local3',
  'local4',
  'local5',
  'local6',
  'local7',
];
const LEVEL_ALIASES = { warn: 'warning', error: 'err', panic: 'emerg', critical: 'crit', emergency: 'emerg' };

export const LEVELS = SEVERITIES;

export function normalizeLevel(level) {
  if (!level) return null;
  const l = level.toLowerCase();
  return LEVEL_ALIASES[l] ?? (SEVERITIES.includes(l) ? l : l);
}

/**
 * Syslog timestamps have no year. Use the current year unless that would put
 * the entry more than a day in the future (i.e. it's from last December).
 */
export function resolveTimestamp(mon, day, hh, mm, ss, now = new Date()) {
  const month = MONTHS[mon];
  if (month === undefined) return null;
  let d = new Date(now.getFullYear(), month, Number(day), Number(hh), Number(mm), Number(ss));
  if (d.getTime() - now.getTime() > 86_400_000) {
    d = new Date(now.getFullYear() - 1, month, Number(day), Number(hh), Number(mm), Number(ss));
  }
  return d.getTime();
}

const ROUTER_LINE = /^\s*(?:\[([^\]]*)\]\s*)?([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(?:(\S+?)\.([a-z]+)\s+)?(.*)$/s;

/** Parse a native GET_LOG line: "[category] Mon DD HH:MM:SS facility.level msg". */
export function parseRouterLine(raw, now = new Date()) {
  const m = ROUTER_LINE.exec(raw);
  if (!m) return { ts: now.getTime(), category: null, facility: null, level: null, message: raw.trim() };
  const [, category, mon, day, hh, mi, ss, facility, level, message] = m;
  return {
    ts: resolveTimestamp(mon, day, hh, mi, ss, now) ?? now.getTime(),
    category: category?.trim() || null,
    facility: facility || null,
    level: normalizeLevel(level),
    message: message.trim(),
  };
}

const RFC3164 = /^<(\d{1,3})>([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(.*)$/s;
const RFC5424 = /^<(\d{1,3})>1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:-|(?:\[.*?\])+)\s?(.*)$/s;

/** Parse a remote syslog datagram (RFC 3164 or 5424). */
export function parseSyslog(raw, remoteAddress, now = new Date()) {
  const text = raw.replace(/\0+$/, '').trimEnd();
  let pri = null;
  let ts = now.getTime();
  let host = remoteAddress;
  let tag = null;
  let message = text;

  let m;
  if ((m = RFC5424.exec(text))) {
    pri = Number(m[1]);
    const parsed = Date.parse(m[2]);
    if (!Number.isNaN(parsed)) ts = parsed;
    if (m[3] !== '-') host = m[3];
    if (m[4] !== '-') tag = m[4];
    message = m[7];
  } else if ((m = RFC3164.exec(text))) {
    pri = Number(m[1]);
    ts = resolveTimestamp(m[2], m[3], m[4], m[5], m[6], now) ?? ts;
    let rest = m[7];
    // Optional hostname, then "tag[pid]: message".
    const hostTag = /^(\S+)\s+([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/s.exec(rest);
    const tagOnly = /^([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/s.exec(rest);
    if (tagOnly) {
      [, tag, rest] = tagOnly;
    } else if (hostTag) {
      [, host, tag, rest] = hostTag;
    }
    message = rest;
  } else if ((m = /^<(\d{1,3})>(.*)$/s.exec(text))) {
    pri = Number(m[1]);
    message = m[2];
  }

  // The router may also prefix its own "[category]" inside the message.
  let category = null;
  const cat = /^\[([^\]]*)\]\s*(.*)$/s.exec(message);
  if (cat) [, category, message] = cat;

  return {
    ts,
    host,
    category: category?.trim() || null,
    facility: tag || (pri !== null ? (FACILITIES[pri >> 3] ?? null) : null),
    level: pri !== null ? SEVERITIES[pri & 7] : null,
    message: message.trim(),
  };
}

/**
 * GET_LOG returns a sliding window (last ~100 lines, oldest first). Return the
 * lines in `next` that weren't in `prev`, by finding the longest suffix of
 * `prev` that is a prefix of `next`. `overlap === 0` with a non-empty `prev`
 * means we either missed lines (polled too slowly) or the log was cleared.
 */
export function newLines(prev, next) {
  const max = Math.min(prev.length, next.length);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== next[i]) {
        match = false;
        break;
      }
    }
    if (match) return { overlap: k, added: next.slice(k) };
  }
  return { overlap: 0, added: next.slice() };
}
