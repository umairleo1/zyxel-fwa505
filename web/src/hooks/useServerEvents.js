import { useEffect, useRef, useState } from 'react';

export const SERVER_EVENTS = ['status', 'logs', 'metrics', 'traffic', 'devices'];

/**
 * Subscribe to the server's SSE stream. handlers: { open, status, logs, metrics, traffic, devices }.
 *
 * Browsers allow only ~6 HTTP/1.1 connections per server, and each open stream holds one.
 * So the stream is only kept while this tab is visible: background tabs and pages parked in
 * the back/forward cache close it (otherwise a few tabs or navigations exhaust the pool and
 * every request stalls). `open` fires on every (re)connect so callers can resync.
 */
export function useServerEvents(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    let es = null;

    const connect = () => {
      if (es || document.visibilityState !== 'visible') return;
      es = new EventSource('/api/events');
      es.onopen = () => {
        setConnected(true);
        ref.current.open?.();
      };
      es.onerror = () => setConnected(false); // EventSource retries by itself
      for (const name of SERVER_EVENTS) {
        es.addEventListener(name, (e) => {
          try {
            ref.current[name]?.(JSON.parse(e.data));
          } catch {
            // ignore malformed frames
          }
        });
      }
    };
    const disconnect = () => {
      es?.close();
      es = null;
      setConnected(false);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? connect() : disconnect());

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', disconnect); // entering the back/forward cache
    window.addEventListener('pageshow', connect); // restored from it
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', disconnect);
      window.removeEventListener('pageshow', connect);
      disconnect();
    };
  }, []);

  return connected;
}
