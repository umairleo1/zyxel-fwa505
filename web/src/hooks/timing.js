import { useCallback, useEffect, useRef, useState } from 'react';

/** setInterval that always calls the latest fn; `ms == null` pauses it. */
export function useInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return undefined;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Current time, re-rendering every `ms`. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

/** Leading + trailing throttle: fn runs at most once per `ms`. */
export function useThrottle(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  const state = useRef({ last: 0, timer: null });
  useEffect(() => () => clearTimeout(state.current.timer), []);
  return useCallback(() => {
    const s = state.current;
    if (s.timer) return;
    s.timer = setTimeout(
      () => {
        s.timer = null;
        s.last = Date.now();
        ref.current();
      },
      Math.max(0, s.last + ms - Date.now()),
    );
  }, [ms]);
}
