import { useState } from 'react';
import { humanize, isNoise, isEmpty } from '../../lib/labels.js';
import { Eye, Search } from './Icons.jsx';
import { Value } from './Values.jsx';

/** Auto-columned table for arrays of objects. columns: [{ key, label?, render?, align? }] */
export function DataTable({ rows, columns, empty = 'No entries', search = false, maxAuto = 9, rowKey, onRowClick, selectedKey }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  if (!rows?.length) return <p className="empty-inline">{empty}</p>;
  let cols = columns;
  let hiddenCount = 0;
  if (!cols) {
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))].filter((k) => rows.some((r) => r && typeof r[k] !== 'object'));
    const useful = keys.filter((k) => !isNoise(k) && rows.some((r) => !isEmpty(r?.[k])));
    const picked = all ? keys : useful.slice(0, maxAuto);
    hiddenCount = keys.length - picked.length;
    cols = picked.map((key) => ({ key }));
  }
  const filtered = q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q.toLowerCase())) : rows;
  return (
    <div className="dt">
      {(search || hiddenCount > 0 || (all && !columns)) && (
        <div className="dt-tools">
          {search && (
            <label className="search search-sm">
              <Search size={14} />
              <input type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter rows" />
            </label>
          )}
          {!columns && (hiddenCount > 0 || all) && (
            <button className="btn btn-ghost btn-sm" onClick={() => setAll((a) => !a)}>
              <Eye size={14} /> {all ? 'Fewer columns' : `All columns (+${hiddenCount})`}
            </button>
          )}
        </div>
      )}
      <div className="dt-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'num' : ''} title={c.key}>
                  {c.label ?? humanize(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const key = rowKey ? rowKey(r) : i;
              return (
                <tr
                  key={key}
                  className={`${onRowClick ? 'clickable' : ''} ${selectedKey != null && key === selectedKey ? 'is-selected' : ''}`}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                >
                  {cols.map((c) => (
                    <td key={c.key} className={c.align === 'right' ? 'num' : ''}>
                      {c.render ? c.render(r) : <Value k={c.key} v={r?.[c.key]} />}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {q && filtered.length === 0 && <p className="empty-inline">No rows match “{q}”.</p>}
    </div>
  );
}
