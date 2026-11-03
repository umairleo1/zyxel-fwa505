import { useCallback, useRef, useState } from 'react';
import { useDismiss } from '../../hooks/index.js';
import { formatClock, formatDuration } from '../../lib/format.js';
import { ChevronDown } from '../ui/Icons.jsx';

/** One overall state for the pill: the worst thing the user would care about. */
function overall({ status, offline, realtime }) {
  const c = status?.collector;
  if (offline) return { tone: 'critical', label: 'Offline', hint: 'The Insight server is not responding' };
  if (!c || c.phase === 'starting') return { tone: 'neutral', label: 'Connecting' };
  if (c.phase === 'halted') return { tone: 'critical', label: 'Halted', hint: 'Router login rejected' };
  if (c.phase === 'paused') return { tone: 'neutral', label: 'Paused', hint: 'Router session released' };
  if (c.phase === 'backoff') return { tone: 'warning', label: 'Reconnecting', hint: c.lastError?.message };
  if (!realtime) return { tone: 'warning', label: 'Delayed', hint: 'Live updates disconnected; refreshing every 10 s' };
  return { tone: 'good', label: 'Live' };
}

// Exact clock time plus a ticking age, e.g. "18:20:49 · 3s ago", so frequent reads visibly update.
const lastAt = (ts, now) => (ts ? `${formatClock(ts)} · ${formatDuration(Math.max(0, (now - ts) / 1000))} ago` : 'never');

const every = (sec) => (!Number.isFinite(sec) ? '—' : sec >= 60 ? `every ${sec / 60} min` : `every ${sec} s`);

function Row({ tone, name, state, detail }) {
  return (
    <li className="health-row">
      <span className={`health-dot dot-${tone}`} aria-hidden="true" />
      <span className="health-name">{name}</span>
      <span className="health-state">{state}</span>
      {detail && <span className="health-detail">{detail}</span>}
    </li>
  );
}

export default function HealthMenu({ status, offline, realtime, now }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const o = overall({ status, offline, realtime });
  const c = status?.collector;
  const routerOk = c?.phase === 'ok';
  const push = (svc, what) =>
    !svc
      ? null
      : svc.error
        ? { tone: 'critical', state: 'Error', detail: svc.error }
        : svc.received
          ? {
              tone: 'good',
              state: 'Receiving',
              detail: `${svc.received.toLocaleString()} ${svc.received === 1 ? what : `${what}s`} · last ${lastAt(svc.lastAt, now)}`,
            }
          : { tone: 'neutral', state: 'Not set up', detail: `Waiting on UDP ${svc.port}` };
  const syslog = push(status?.syslog, 'line');
  const snmp = push(status?.snmp, 'trap');

  return (
    <div className="health" ref={ref}>
      <button
        className={`conn conn-${o.tone}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={o.hint}
      >
        <span className="conn-dot" aria-hidden="true" />
        <span className="conn-label">{o.label}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="popover health-pop" role="dialog" aria-label="System health">
          <div className="health-head">System health</div>
          <ul className="health-list">
            <Row
              tone={
                offline
                  ? 'critical'
                  : routerOk
                    ? 'good'
                    : c?.phase === 'backoff'
                      ? 'warning'
                      : c?.phase === 'halted'
                        ? 'critical'
                        : 'neutral'
              }
              name="Router"
              state={offline ? 'Unknown' : routerOk ? 'Connected' : o.label}
              detail={c?.lastError && !routerOk ? c.lastError.message : status?.routerUrl}
            />
            <Row
              tone={c?.lastStatusAt ? 'good' : 'neutral'}
              name="Signal & uptime"
              state={every(status?.statusIntervalSec)}
              detail={`Last read ${lastAt(c?.lastStatusAt, now)}`}
            />
            <Row
              tone={c?.lastLogsAt ? 'good' : 'neutral'}
              name="Router logs"
              state={every(status?.pollIntervalSec)}
              detail={`Last sync ${lastAt(c?.lastLogsAt, now)}${c?.gaps ? ` · ${c.gaps} gap${c.gaps > 1 ? 's' : ''}` : ''}`}
            />
            {status?.routerLoad && (
              <Row
                tone={status.routerLoad.perMinute <= 30 ? 'good' : 'warning'}
                name="Load on router"
                state={`${status.routerLoad.perMinute} req/min`}
                detail={`${status.routerLoad.avgMs ?? '—'} ms avg response · ${status.routerLoad.logins} login${status.routerLoad.logins === 1 ? '' : 's'} · ${status.routerLoad.errors} errors since start`}
              />
            )}
            <Row
              tone={realtime ? 'good' : 'warning'}
              name="Live updates"
              state={realtime ? 'Connected' : 'Polling'}
              detail={realtime ? 'Changes appear as they happen' : 'Reconnecting; refreshing every 10 s'}
            />
            {syslog && <Row name="Remote syslog" {...syslog} />}
            {snmp && <Row name="SNMP traps" {...snmp} />}
          </ul>
        </div>
      )}
    </div>
  );
}
