import { useCallback, useRef, useState } from 'react';

/** Width of an element via ResizeObserver. Returns a callback ref, so remounts re-attach. */
export function useElementWidth() {
  const [width, setWidth] = useState(0);
  const observer = useRef(null);
  const ref = useCallback((el) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, width];
}
