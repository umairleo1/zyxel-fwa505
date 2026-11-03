import { useEffect, useRef } from 'react';
import { X } from './Icons.jsx';

/** Side panel with a header (status slot, title, close) used for details views. */
export default function Drawer({ title, status, onClose, label, className = 'drawer', focusKey, children }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [focusKey]);
  return (
    <aside className={className} aria-label={label ?? title}>
      <header className="drawer-head">
        {status}
        <h2>{title}</h2>
        <button ref={closeRef} className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close (Esc)">
          <X />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}
