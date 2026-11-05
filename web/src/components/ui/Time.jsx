import { useNow } from '../../hooks/index.js';
import { formatAgo, formatDuration, formatFull, formatWhen } from '../../lib/format.js';

/**
 * A point in time shown as a stable clock time ("14:32", or "3 Nov 14:32" on other
 * days) with the full date and relative age in the tooltip. Deliberately not a live
 * "3m 12s ago": text that changes width every second reflows tables and toolbars.
 */
export function When({ ts, seconds = false, className = '' }) {
  if (!ts) return <span className={className}>never</span>;
  return (
    <time className={`tabular ${className}`} dateTime={new Date(ts).toISOString()} title={`${formatFull(ts)} · ${formatAgo(ts)}`}>
      {formatWhen(ts, Date.now(), { seconds })}
    </time>
  );
}

/**
 * Router uptime extrapolated from the last status poll. Owns the 1 s clock so only
 * this text re-renders each second, not the page around it.
 */
export function Uptime({ router }) {
  const now = useNow(router?.uptimeSec != null ? 1000 : null);
  if (router?.uptimeSec == null) return formatDuration(null);
  // With seconds: it ticks every second anyway, so the last unit is worth showing.
  return <span className="tabular">{formatDuration(router.uptimeSec + (now - router.fetchedAt) / 1000, { seconds: true })}</span>;
}
