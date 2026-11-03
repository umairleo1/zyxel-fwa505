import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync } from './useAsync.js';

/** Several allowlisted router endpoints in one request. `reload()` bypasses the server cache. */
export function useRouterData(ids, deps = []) {
  const [fresh, setFresh] = useState(0);
  const r = useAsync(() => api.router(ids, { fresh }), [ids.join(','), fresh, ...deps]);
  const raw = r.data ?? {};
  const fetchedAt = Math.min(...ids.map((id) => raw[id]?.fetchedAt ?? Infinity));
  const errors = ids.map((id) => raw[id]?.error).filter(Boolean);
  return {
    ...r,
    raw,
    get: (id) => raw[id]?.data ?? null,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    stale: ids.some((id) => raw[id]?.stale),
    error: r.error ?? (errors.length && errors.length === ids.length ? new Error(errors[0]) : null),
    reload: () => setFresh(Date.now()),
  };
}
