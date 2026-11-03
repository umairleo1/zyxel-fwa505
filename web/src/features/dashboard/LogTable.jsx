import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { formatClock, formatDay, formatFull, formatNumber } from '../../lib/format.js';
import { SOURCE_LABELS, levelGroup } from '../../lib/domain.js';
import LogDrawer from './LogDrawer.jsx';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function Highlight({ text, q }) {
  if (!q) return text;
  return text.split(new RegExp(`(${escapeRe(q)})`, 'ig')).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
const inField = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

export default function LogTable({ query, filterKey, refreshKey, live, setFilters, toast, searchRef }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fresh, setFresh] = useState(() => new Set());
  const queryRef = useRef(query);
  queryRef.current = query;
  const reqId = useRef(0);
  const maxId = useRef(0);
  const paged = useRef(false);
  const rowRefs = useRef(new Map());
  const sentinel = useRef(null);

  const loadFirst = useCallback(async (isRefresh) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const page = await api.logs(queryRef.current);
      if (id !== reqId.current) return;
      const prevMax = maxId.current;
      setFresh(isRefresh && prevMax ? new Set(page.items.filter((r) => r.id > prevMax).map((r) => r.id)) : new Set());
      for (const r of page.items) if (r.id > maxId.current) maxId.current = r.id;
      setItems(page.items);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setError(null);
      paged.current = false;
    } catch (e) {
      if (id === reqId.current) setError(e.message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  // New filters: start over.
  useEffect(() => {
    loadFirst(false);
  }, [filterKey, loadFirst]);

  // Live tick: refresh the first page unless the user has scrolled into older pages.
  useEffect(() => {
    if (refreshKey && live && !paged.current) loadFirst(true);
  }, [refreshKey, live, loadFirst]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.logs(queryRef.current, cursor);
      paged.current = true;
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      toast(`Couldn't load older entries: ${e.message}`, 'critical');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, toast]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && loadMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  // Keyboard: / search · j/k move · Enter open · Esc close.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' && !inField()) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (inField()) document.activeElement.blur();
        else if (drawerOpen) setDrawerOpen(false);
        return;
      }
      if (inField() || !items.length) return;
      const idx = items.findIndex((r) => r.id === selectedId);
      let next = null;
      if (e.key === 'j' || e.key === 'ArrowDown') next = Math.min(items.length - 1, idx + 1);
      else if (e.key === 'k' || e.key === 'ArrowUp') next = Math.max(0, idx === -1 ? 0 : idx - 1);
      else if (e.key === 'Enter' && idx !== -1) {
        setDrawerOpen((o) => !o);
        return;
      } else return;
      e.preventDefault();
      const id = items[next].id;
      setSelectedId(id);
      rowRefs.current.get(id)?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selectedId, drawerOpen, searchRef]);

  const selectedRow = drawerOpen ? items.find((r) => r.id === selectedId) : null;
  let lastDay = null;

  return (
    <section className={`panel logs-panel ${selectedRow ? 'with-drawer' : ''}`} aria-label="Log entries">
      <header className="panel-head">
        <div>
          <h2>Events</h2>
          <p className="panel-sub">
            {total != null ? `${formatNumber(items.length)} of ${formatNumber(total)} shown` : ' '}
            {loading && <span className="spinner" aria-label="Loading" />}
          </p>
        </div>
        <p className="kbd-hint">
          <kbd>/</kbd> search <kbd>j</kbd>
          <kbd>k</kbd> navigate <kbd>↵</kbd> details
        </p>
      </header>

      {error && <div className="banner banner-critical inline">Couldn’t load events: {error}</div>}

      <div className="logs-layout">
        <div className="table-wrap" style={{ opacity: loading && items.length ? 0.6 : 1 }}>
          <table className="log-table">
            <thead>
              <tr>
                <th className="c-time">Time</th>
                <th className="c-level">Level</th>
                <th className="c-src">Source</th>
                <th className="c-fac">Facility</th>
                <th className="c-msg">Message</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const day = new Date(r.ts).toDateString();
                const divider = day !== lastDay;
                lastDay = day;
                const g = levelGroup(r.level);
                return (
                  <Fragment key={r.id}>
                    {divider && (
                      <tr className="day-row">
                        <td colSpan={5}>{formatDay(r.ts)}</td>
                      </tr>
                    )}
                    <tr
                      ref={(el) => (el ? rowRefs.current.set(r.id, el) : rowRefs.current.delete(r.id))}
                      className={`log-row sev-row-${g} ${r.id === selectedId ? 'is-selected' : ''} ${fresh.has(r.id) ? 'is-fresh' : ''}`}
                      onClick={() => {
                        setSelectedId(r.id);
                        setDrawerOpen(true);
                      }}
                      aria-selected={r.id === selectedId}
                    >
                      <td className="c-time mono" title={formatFull(r.ts)}>
                        {formatClock(r.ts)}
                      </td>
                      <td className="c-level">
                        <span className={`badge sev-${g}`}>{r.level ?? '—'}</span>
                      </td>
                      <td className="c-src">
                        <span className={`src src-${r.source}`}>{SOURCE_LABELS[r.source] ?? r.source}</span>
                      </td>
                      <td className="c-fac mono">{r.facility ?? ''}</td>
                      <td className="c-msg">
                        {r.category && <span className="cat">{r.category}</span>}
                        <Highlight text={r.message} q={query.q} />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!items.length && !loading && !error && (
            <div className="empty-state">
              <p>
                <b>No events match.</b>
              </p>
              <p className="muted">Try a wider time range or clear some filters.</p>
            </div>
          )}
          <div ref={sentinel} className="sentinel">
            {loadingMore ? 'Loading older entries…' : cursor ? '' : items.length ? 'End of results' : ''}
          </div>
        </div>
        {selectedRow && <LogDrawer row={selectedRow} onClose={() => setDrawerOpen(false)} setFilters={setFilters} toast={toast} />}
      </div>
    </section>
  );
}
