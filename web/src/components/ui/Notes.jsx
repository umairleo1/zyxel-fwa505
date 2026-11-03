import { formatAgo } from '../../lib/format.js';
import { Refresh } from './Icons.jsx';

export function SourceNote({ ids, fetchedAt, stale, onRefresh, loading }) {
  return (
    <div className="source-note">
      {ids && <span className="mono">{[].concat(ids).join(' · ')}</span>}
      {fetchedAt && (
        <span>
          · read {formatAgo(fetchedAt)}
          {stale ? ' (cached, collector paused)' : ''}
        </span>
      )}
      {onRefresh && (
        <button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading} aria-label="Refresh">
          <Refresh size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      )}
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="banner banner-warning inline-banner" role="status">
      {String(error.message ?? error)}
    </div>
  );
}
