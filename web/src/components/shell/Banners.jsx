import { useState } from 'react';
import { safeStorage } from '../../lib/storage.js';
import { Alert, Info, X } from '../ui/Icons.jsx';
import { When } from '../ui/Time.jsx';

export default function Banners({ status, busy, onAction }) {
  const [hintHidden, setHidden] = useState(() => safeStorage.get('insight.hideSetupHint') === '1');
  if (!status) return null;
  const { collector: c, syslog: s } = status;
  const banners = [];

  if (c.phase === 'halted') {
    banners.push(
      <div key="halted" className="banner banner-critical" role="alert">
        <Alert />
        <div>
          <strong>Collection halted.</strong> The router rejected the login, so Insight stopped to avoid locking the account (3 failed
          attempts = 5 min lockout).
          <span className="banner-detail">{c.lastError?.message}</span>
        </div>
        <button className="btn" disabled={busy} onClick={() => onAction('retry')}>
          Retry login
        </button>
      </div>,
    );
  } else if (c.phase === 'backoff') {
    banners.push(
      <div key="backoff" className="banner banner-warning" role="status">
        <Alert />
        <div>
          <strong>Router unreachable.</strong> {c.lastError?.message}
          {/* A clock time rather than a per-second countdown, so the banner doesn't reflow. */}
          {c.nextAttemptAt && (
            <span className="banner-detail">
              Next attempt at <When ts={c.nextAttemptAt} seconds />.
            </span>
          )}
        </div>
      </div>,
    );
  }

  for (const [key, svc, name] of [
    ['syslog-err', s, 'Syslog listener'],
    ['snmp-err', status.snmp, 'SNMP trap listener'],
  ]) {
    if (svc?.error) {
      banners.push(
        <div key={key} className="banner banner-warning" role="status">
          <Alert />
          <div>
            <strong>{name} failed.</strong> {svc.error}
          </div>
        </div>,
      );
    }
  }

  // Setup checklist for the two push channels, until each has delivered something.
  const ip = status.lanIp ?? 'this computer';
  const steps = [];
  if (!s.error && !s.received) {
    steps.push(
      <li key="syslog">
        <b>Remote syslog</b> (Maintenance → Log setting): server <code>{ip}</code>, UDP port <code>{s.port}</code>. Keeps full history; the
        router itself only holds 100 lines.
      </li>,
    );
  }
  if (status.snmp && !status.snmp.error && !status.snmp.received) {
    steps.push(
      <li key="snmp">
        <b>SNMP traps</b> (Maintenance → SNMP): enable SNMP, trap destination{' '}
        <code>
          {ip}:{status.snmp.port}
        </code>
        . Instant reboot and link up/down events.
      </li>,
    );
  }
  if (steps.length && !hintHidden) {
    banners.push(
      <div key="setup" className="banner banner-info">
        <Info />
        <div>
          <strong>Get events the moment they happen.</strong> In the router’s admin page, set:
          <ul className="banner-steps">{steps}</ul>
        </div>
        <button
          className="btn btn-ghost btn-icon"
          aria-label="Dismiss"
          onClick={() => {
            safeStorage.set('insight.hideSetupHint', '1');
            setHidden(true);
          }}
        >
          <X />
        </button>
      </div>,
    );
  }
  return banners.length ? <div className="banners">{banners}</div> : null;
}
