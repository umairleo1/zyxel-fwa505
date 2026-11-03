import { useCallback, useEffect, useState } from 'react';

/**
 * Run an async function when deps change and track its result. Keeps the previous
 * data while refetching, so charts hold their frame instead of flashing empty.
 */
export function useAsync(fn, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve()
      .then(fn)
      .then(
        (data) => !cancelled && setState({ data, loading: false, error: null }),
        (error) => !cancelled && setState((s) => ({ ...s, loading: false, error })),
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass explicit deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
