// Display formatting. Domain rules (signal scales, severities) live in @zyxel-insight/shared.
const nf = new Intl.NumberFormat();
const cf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const formatNumber = (n) => (n == null ? '—' : nf.format(n));
export const formatCompact = (n) => (n == null ? '—' : n < 10000 ? nf.format(n) : cf.format(n));
// Proper minus sign for negative readings like RSRP.
export const formatSigned = (n) => (n == null ? '—' : String(n).replace('-', '−'));

export function formatDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

export function formatAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return `in ${formatDuration(-s)}`;
  if (s < 5) return 'just now';
  return `${formatDuration(s)} ago`;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export const formatClock = (ts) => clock.format(ts);
export const formatHM = (ts) => hm.format(ts);
export const formatFull = (ts) => (ts ? full.format(ts) : '—');
export const formatDayMonth = (ts) => dayMonth.format(ts);

/** Local midnight at the start of `ts`'s day. Per timestamp, so it is right on both sides of a DST change. */
export const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);

/** Local midnight `n` calendar days after the day of `ts` (a day is 23–25 h around DST changes). */
export function addDays(ts, n) {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export const isSameDay = (a, b) => startOfDay(a) === startOfDay(b);

export function formatDay(ts, now = Date.now()) {
  const d = startOfDay(ts);
  const today = startOfDay(now);
  if (d === today) return `Today · ${weekday.format(ts)}`;
  if (d === addDays(today, -1)) return `Yesterday · ${weekday.format(ts)}`;
  return weekday.format(ts);
}

/**
 * Stable "when" text for live views: clock time today, date + time otherwise. Unlike
 * formatAgo it doesn't change every second, so it never reflows its row; pair it
 * with a formatAgo title for the relative age.
 */
export function formatWhen(ts, now = Date.now(), { seconds = false } = {}) {
  if (!ts) return 'never';
  const time = (seconds ? clock : hm).format(ts);
  return isSameDay(ts, now) ? time : `${dayMonth.format(ts)} ${time}`;
}

export function formatSpan(from, to) {
  return isSameDay(from, to)
    ? `${dayMonth.format(from)} ${hm.format(from)}–${hm.format(to)}`
    : `${dayMonth.format(from)} ${hm.format(from)} – ${dayMonth.format(to)} ${hm.format(to)}`;
}

/** Round tick values for an axis. */
export function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

const TICK_STEPS_MIN = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];

/** Local-time tick candidates in [from, to]: every `stepMin` minutes of each local day, or every `days` midnights. */
function localTicks(from, to, stepMin) {
  const ticks = [];
  if (stepMin >= 1440) {
    // Whole days: local midnights, aligned to a day count so ticks don't hop as the window slides.
    const days = stepMin / 1440;
    for (let t = startOfDay(from); t <= to; t = addDays(t, 1)) {
      const d = new Date(t);
      const dayNo = Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400e3);
      if (t >= from && dayNo % days === 0) ticks.push(t);
    }
    return ticks;
  }
  // Sub-day: wall-clock times within each local day, so 00:00/06:00/... stay on the
  // hour after a DST change. new Date(y, m, d, 0, min) resolves the zone per timestamp.
  for (let day = startOfDay(from); day <= to; day = addDays(day, 1)) {
    const d = new Date(day);
    for (let m = 0; m < 1440; m += stepMin) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m).getTime();
      // A wall time skipped by spring-forward resolves to the next hour: drop the duplicate.
      if (t >= from && t <= to && t > (ticks.at(-1) ?? -Infinity)) ticks.push(t);
    }
  }
  return ticks;
}

/** Time ticks at round local-time intervals for a span. */
export function timeTicks(from, to, maxTicks) {
  const stepMin = TICK_STEPS_MIN.find((m) => (to - from) / (m * 60e3) <= maxTicks) ?? TICK_STEPS_MIN.at(-1);
  const step = stepMin * 60e3;
  const ticks = localTicks(from, to, stepMin);
  return {
    ticks,
    label:
      step >= 86400e3
        ? formatDayMonth
        : (t) => (new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0 ? formatDayMonth(t) : formatHM(t)),
  };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  let i = 0;
  while (Math.abs(n) >= 1000 && i < UNITS.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : digits)} ${UNITS[i]}`;
}
export function formatBps(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const u = ['bps', 'kbps', 'Mbps', 'Gbps'];
  let i = 0;
  while (Math.abs(n) >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
