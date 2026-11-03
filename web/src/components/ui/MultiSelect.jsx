import { useCallback, useRef, useState } from 'react';
import { useDismiss } from '../../hooks/index.js';
import { Check, ChevronDown } from './Icons.jsx';

/** Dropdown with checkboxes. options: [{ value, label?, count?, swatch? }] */
export default function MultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(ref, open, close);

  const toggle = (v) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const summary =
    selected.length === 0
      ? 'All'
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className="ms" ref={ref}>
      <button
        className={`btn ms-trigger ${selected.length ? 'is-active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ms-label">{label}</span>
        <span className="ms-value">{summary}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="popover ms-menu" role="listbox" aria-multiselectable="true" aria-label={label}>
          {options.length === 0 && <div className="ms-empty">No values in this range</div>}
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                role="option"
                aria-selected={on}
                className={`ms-option ${on ? 'on' : ''}`}
                onClick={() => toggle(o.value)}
              >
                <span className="ms-check">{on && <Check size={14} strokeWidth="3" />}</span>
                {o.swatch && <span className="swatch" style={{ background: o.swatch }} aria-hidden="true" />}
                <span className="ms-option-label">{o.label ?? o.value}</span>
                {o.count != null && <span className="ms-count">{o.count.toLocaleString()}</span>}
              </button>
            );
          })}
          {selected.length > 0 && (
            <div className="ms-footer">
              <button className="btn btn-ghost btn-sm" onClick={() => onChange([])}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
