import { useState } from 'react';
import { safeStorage } from '../../lib/storage.js';
import { Alert, Info, X } from '../ui/Icons.jsx';
import { When } from '../ui/Time.jsx';
import { Link } from '../../app/route.jsx';

export default function Banners({ status, busy, onAction, route }) {
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

  // Only while the router answers: when it doesn't, the banner above already says so.
  const wan = c.router?.wan;
  if (c.phase === 'ok' && wan?.since) {
    banners.push(
      <div key="wan" className="banner banner-warning" role="status">
        <Alert />
        <div>
          <strong>No mobile data.</strong> The router is up, but its internet connection has been down since <When ts={wan.since} />.
          {wan.reason && <span className="banner-detail">{wan.reason}</span>}
        </div>
      </div>,
    );
  }

  // Only when the router itself looks fine: otherwise one of the banners above explains it.
  const stall = status.internet?.stall;
  if (c.phase === 'ok' && !wan?.since && stall) {
    banners.push(
      <div key="internet" className="banner banner-warning" role="status">
        <Alert />
        <div>
          <strong>Internet stalled.</strong> The router says mobile data is connected, but nothing has got through since{' '}
          <When ts={stall.since} seconds />.{stall.reason && <span className="banner-detail">{stall.reason}</span>}
        </div>
      </div>,
    );
  }

  // A band selection on trial, shown on every page (the Radio page has its own): it reverts by itself unless kept.
  if (status.radioTrial && route !== 'radio') {
    banners.push(
      <div key="radio" className="banner banner-info" role="status">
        <Info />
        <div>
          <strong>Trying new band settings.</strong> They switch back at <When ts={status.radioTrial.until} seconds /> unless you keep them.
        </div>
        <Link to="/radio" className="btn">
          Review
        </Link>
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
