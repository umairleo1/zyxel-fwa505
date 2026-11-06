import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useLive } from '../../app/live.js';
import { Power } from '../../components/ui/Icons.jsx';

// Matches the server's gap between restarts (server/src/router/reboot.js).
const GAP_MS = 5 * 60_000;
// The confirm step disarms itself after this long, so a stray click later can't restart.
const ARM_MS = 6000;

/**
 * Restart the router, as its own Maintenance → Reboot does. Two clicks (no browser dialog):
 * "Restart router", then "Restart now?" within a few seconds. Disabled while the router
 * isn't answering, and for a few minutes after a restart while it comes back.
 */
export default function RestartRouter() {
  const { status, toast } = useLive();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  if (!status?.rebootEnabled) return null;
  const phase = status.collector?.phase;
  const since = status.restartRequestedAt ? Date.now() - status.restartRequestedAt : Infinity;
  const restarting = since < GAP_MS && phase !== 'ok';
  const cooling = since < GAP_MS;
  const unavailable = phase !== 'ok';

  async function restart() {
    setArmed(false);
    setBusy(true);
    try {
      await api.restartRouter();
      toast('Router restarting. It takes about a minute; Insight reconnects by itself.');
    } catch (e) {
      toast(`Restart failed: ${e.message}`, 'critical');
    } finally {
      setBusy(false);
    }
  }

  if (armed) {
    return (
      <button type="button" className="btn btn-danger" onClick={restart} onBlur={() => setArmed(false)} autoFocus>
        <Power />
        <span className="btn-label">Restart now? Internet drops ~1 min</span>
      </button>
    );
  }
  const title = restarting
    ? 'The router is restarting'
    : cooling
      ? 'Restarted a few minutes ago: wait for it to settle before restarting again'
      : unavailable
        ? "The router isn't answering, so it can't be asked to restart"
        : 'Restart the router, as its own Maintenance → Reboot does. Internet and Wi-Fi drop for about a minute.';
  return (
    <button type="button" className="btn" disabled={busy || cooling || unavailable} onClick={() => setArmed(true)} title={title}>
      <Power />
      <span className="btn-label">{busy || restarting ? 'Restarting…' : 'Restart router'}</span>
    </button>
  );
}
