// Restart the router from Insight, exactly as its own Maintenance → Reboot page does.
// One restart at a time: a second press while it's coming back would only start it over.
import { RouterError } from './client.js';

// The router takes about a minute to come back; leave room for a slow boot and re-registration.
export const MIN_GAP_MS = 5 * 60_000;
// When the last restart was asked for, kept across Insight restarts so they can't bypass the gap.
const LAST_META = 'routerRestartAt';

export function createRebootService({ client, db, collector, enabled, now = Date.now, onChange = () => {} }) {
  let lastAt = 0;
  try {
    lastAt = Number(db.getMeta(LAST_META)) || 0;
  } catch {
    // no record: no gap to enforce
  }

  const audit = (level, message) => {
    try {
      db.insertMany([{ ts: now(), source: 'insight', facility: 'reboot', level, message }]);
    } catch {
      // the log is a record, not a gate
    }
  };
  const remember = (t) => {
    lastAt = t;
    try {
      db.setMeta(LAST_META, t ? String(t) : '');
    } catch {
      // the in-memory gap still holds until Insight restarts
    }
  };

  return {
    enabled,

    /** When the last restart was asked for (ms), or null: for the status payload. */
    get lastAt() {
      return lastAt || null;
    },

    async reboot() {
      if (!enabled) throw Object.assign(new Error('Restart is disabled (REBOOT_ENABLED=false)'), { status: 404 });
      const t = now();
      if (t - lastAt < MIN_GAP_MS) {
        const wait = Math.ceil((MIN_GAP_MS - (t - lastAt)) / 60_000);
        throw Object.assign(new Error(`The router was restarted moments ago. Give it ${wait} min to come back before trying again.`), {
          status: 429,
        });
      }
      // Logged before the request so the reboot it causes is recognised as expected
      // (see detectReboot: it looks for a reason in the log around the new boot).
      audit('notice', 'Router restart requested from Insight');
      remember(t);
      collector?.expectRestart?.(t);
      try {
        await client.reboot();
      } catch (e) {
        // A dropped connection may mean the router is already going down: keep the gap.
        // A clear refusal means nothing happened, so it can be tried again straight away.
        if (!(e instanceof RouterError && e.kind === 'network')) remember(0);
        audit('err', `Router restart failed: ${e.message}`);
        onChange();
        throw e;
      }
      onChange();
      return { requestedAt: t };
    },
  };
}
