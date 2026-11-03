import { useState } from 'react';
import { humanize, isNoise, isEmpty, enumLabel, secondsHint } from '../../lib/labels.js';
import { Check, X } from './Icons.jsx';

const MASK = '••••••••';

export function Bool({ value, on = 'On', off = 'Off' }) {
  return (
    <span className={`bool ${value ? 'bool-on' : 'bool-off'}`}>
      {value ? <Check size={12} strokeWidth="3" /> : <X size={12} strokeWidth="3" />} {value ? on : off}
    </span>
  );
}

export function Value({ k, v }) {
  if (v === MASK)
    return (
      <span className="secret" title="Hidden by Insight">
        {MASK} <span className="muted">set</span>
      </span>
    );
  if (typeof v === 'boolean') return <Bool value={v} />;
  if (isEmpty(v)) return <span className="muted">—</span>;
  const en = enumLabel(k, v);
  if (en) return <span title={String(v)}>{en}</span>;
  if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? v.join(', ') : <span className="muted">{v.length} items</span>;
  if (typeof v === 'object') return <span className="muted">{Object.keys(v).length} fields</span>;
  const hint = secondsHint(k, v);
  return (
    <span className={typeof v === 'number' ? 'num-val' : ''}>
      {String(v)}
      {hint && <span className="muted"> ({hint})</span>}
    </span>
  );
}

/** Key/value grid. Hides plumbing and empty fields unless "show all". */
export function KV({ obj, fields, labels = {}, showAll: forceAll }) {
  const [all, setAll] = useState(false);
  if (!obj) return <p className="muted">No data</p>;
  const keys =
    fields ??
    Object.keys(obj).filter(
      (k) => typeof obj[k] !== 'object' || obj[k] === null || (Array.isArray(obj[k]) && obj[k].every((x) => typeof x !== 'object')),
    );
  const shown = forceAll || all ? keys : keys.filter((k) => !isNoise(k) && !isEmpty(obj[k]));
  const hidden = keys.length - shown.length;
  return (
    <>
      <dl className="kv-grid">
        {shown.map((k) => (
          <div key={k} className="kv-row">
            <dt title={k}>{labels[k] ?? humanize(k)}</dt>
            <dd>
              <Value k={k} v={obj[k]} />
            </dd>
          </div>
        ))}
      </dl>
      {hidden > 0 && !forceAll && (
        <button className="btn btn-ghost btn-sm kv-more" onClick={() => setAll(true)}>
          Show {hidden} empty/technical field{hidden === 1 ? '' : 's'}
        </button>
      )}
      {all && !forceAll && (
        <button className="btn btn-ghost btn-sm kv-more" onClick={() => setAll(false)}>
          Hide empty fields
        </button>
      )}
    </>
  );
}
