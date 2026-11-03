/**
 * Fan-out of server events to browsers over SSE. Log inserts are batched over a
 * short window so a burst of syslog lines becomes one notification.
 */
export function createEventHub({ logsWindowMs = 250, heartbeatMs = 25_000 } = {}) {
  const clients = new Set();
  const logListeners = [];
  let pending = null;

  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const broadcast = (event, data) => {
    if (!clients.size) return;
    const msg = frame(event, data);
    for (const res of clients) res.write(msg);
  };

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  return {
    broadcast,

    subscribe(req, res, initial = {}) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      for (const [event, data] of Object.entries(initial)) res.write(frame(event, data));
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },

    /** Record inserted log rows; flushed as one `logs` event per window. */
    logs({ count, sources, maxId }) {
      if (!pending) {
        pending = { count: 0, sources: new Set(), maxId: 0 };
        setTimeout(() => {
          const p = pending;
          pending = null;
          const batch = { count: p.count, sources: [...p.sources], maxId: p.maxId };
          broadcast('logs', batch);
          for (const fn of logListeners) fn(batch);
        }, logsWindowMs).unref();
      }
      pending.count += count;
      for (const s of sources) pending.sources.add(s);
      pending.maxId = Math.max(pending.maxId, maxId);
    },
    onLogs: (fn) => logListeners.push(fn),

    /** Returns fn() that broadcasts `event` with getData(), at most once per `ms` (trailing edge). */
    throttled(event, getData, ms) {
      let last = 0;
      let timer = null;
      return () => {
        if (timer) return;
        const wait = Math.max(0, last + ms - Date.now());
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          broadcast(event, getData());
        }, wait);
        timer.unref();
      };
    },

    get size() {
      return clients.size;
    },

    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
