import { formatFull } from '../../lib/format.js';
import { SOURCE_LABELS, levelGroup } from '../../lib/domain.js';
import { Clock, Copy, Filter } from '../../components/ui/Icons.jsx';
import Drawer from '../../components/ui/Drawer.jsx';

export default function LogDrawer({ row, onClose, setFilters, toast }) {
  if (!row) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.raw);
      toast('Raw line copied');
    } catch {
      toast('Clipboard not available', 'critical');
    }
  };
  const fields = [
    ['Time', formatFull(row.ts)],
    ['Level', row.level ?? '—'],
    ['Source', SOURCE_LABELS[row.source] ?? row.source],
    ['Facility', row.facility ?? '—'],
    ['Category', row.category ?? '—'],
    ['Host', row.host ?? '—'],
    ['ID', row.id],
  ];

  return (
    <Drawer
      title="Log entry"
      label="Log entry details"
      focusKey={row.id}
      onClose={onClose}
      status={<span className={`badge sev-${levelGroup(row.level)}`}>{row.level ?? 'none'}</span>}
    >
      <p className="drawer-message">{row.message}</p>
      <dl className="fields">
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="raw-block">
        <div className="raw-head">
          <span>Raw</span>
          <button className="btn btn-ghost btn-sm" onClick={copy}>
            <Copy size={14} /> Copy
          </button>
        </div>
        <pre>{row.raw}</pre>
      </div>
      <div className="drawer-actions">
        <button
          className="btn"
          onClick={() =>
            setFilters({ range: 'custom', from: row.ts - 5 * 60e3, to: row.ts + 5 * 60e3, q: '', source: [], level: [], facility: [] })
          }
        >
          <Clock size={14} /> Show ±5 min around this
        </button>
        {row.facility && (
          <button className="btn" onClick={() => setFilters({ facility: [row.facility] })}>
            <Filter size={14} /> Only {row.facility}
          </button>
        )}
        <button className="btn" onClick={() => setFilters({ source: [row.source] })}>
          <Filter size={14} /> Only {SOURCE_LABELS[row.source] ?? row.source}
        </button>
      </div>
      <p className="drawer-hint">
        <kbd>j</kbd> <kbd>k</kbd> to move · <kbd>Esc</kbd> to close
      </p>
    </Drawer>
  );
}
