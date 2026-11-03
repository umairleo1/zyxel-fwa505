import { useCallback, useState } from 'react';
import { RANGES } from '../lib/domain.js';

export const DEFAULT_FILTERS = { range: '24h', from: null, to: null, q: '', source: [], level: [], facility: [] };

function parseFilters(search) {
  const p = new URLSearchParams(search);
  const arr = (k) => (p.get(k) ? p.get(k).split(',').filter(Boolean) : []);
  const from = Number(p.get('from')) || null;
  const to = Number(p.get('to')) || null;
  const range = from && to ? 'custom' : RANGES.some((r) => r.key === p.get('range')) ? p.get('range') : DEFAULT_FILTERS.range;
  return {
    range,
    from: range === 'custom' ? from : null,
    to: range === 'custom' ? to : null,
    q: p.get('q') || '',
    source: arr('source'),
    level: arr('level'),
    facility: arr('facility'),
  };
}

function serializeFilters(f) {
  const p = new URLSearchParams();
  if (f.range === 'custom') {
    p.set('from', f.from);
    p.set('to', f.to);
  } else if (f.range !== DEFAULT_FILTERS.range) p.set('range', f.range);
  if (f.q) p.set('q', f.q);
  for (const k of ['source', 'level', 'facility']) if (f[k].length) p.set(k, f[k].join(','));
  const s = p.toString();
  return `${location.pathname}${s ? `?${s}` : ''}`;
}

/** Filter state mirrored into the URL so views can be bookmarked and shared. */
export function useUrlFilters() {
  const [filters, setFiltersState] = useState(() => parseFilters(location.search));
  const setFilters = useCallback((update) => {
    setFiltersState((prev) => {
      const next = typeof update === 'function' ? update(prev) : { ...prev, ...update };
      history.replaceState(null, '', serializeFilters(next));
      return next;
    });
  }, []);
  return [filters, setFilters];
}

/** Concrete { from, to } for a filter state at time `now`. */
export function resolveRange(filters, now) {
  if (filters.range === 'custom') return { from: filters.from, to: filters.to };
  const r = RANGES.find((x) => x.key === filters.range) ?? RANGES[2];
  return { from: now - r.ms, to: now };
}
