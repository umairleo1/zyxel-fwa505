// Liveness for systemd/monitoring: is the collector still reading the router?

/**
 * { code, body } for GET /api/health. 503 when login is halted, or when the last
 * successful router read (or start-up, if none yet) is older than
 * 3 × max(statusIntervalSec, 60 s) while not paused.
 */
export function healthOf(state, { statusIntervalSec, startedAt, now = Date.now() }) {
  const { phase, lastSuccessAt = null } = state;
  const staleAfterMs = 3 * Math.max(statusIntervalSec, 60) * 1000;
  const ageMs = now - (lastSuccessAt ?? startedAt);
  const body = { status: phase, phase, lastSuccessAt, ageSec: Math.round(ageMs / 1000) };
  if (phase === 'halted') return { code: 503, body };
  if (state.maintenance) return { code: 200, body: { ...body, status: 'maintenance', maintenance: state.maintenance } };
  if (phase === 'paused') return { code: 200, body };
  if (ageMs > staleAfterMs) return { code: 503, body: { ...body, status: 'stale' } };
  return { code: 200, body: { ...body, status: phase === 'ok' ? 'ok' : phase } };
}
