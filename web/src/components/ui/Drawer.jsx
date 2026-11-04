import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../../hooks/index.js';
import { X } from './Icons.jsx';

// Matches responsive.css/pages.css: below this the drawer is a bottom sheet over the page.
const SHEET = '(max-width: 1100px)';
const inField = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

/**
 * Side panel with a header (status slot, title, close) used for details views.
 * Beside the content it is a plain region; as a bottom sheet it covers the page, so
 * it becomes a modal dialog: portalled to <body> with a scrim, and the rest of the
 * page made inert so focus can't wander behind it.
 */
export default function Drawer({ title, status, onClose, label, className = 'drawer', focusKey, children }) {
  const sheet = useMediaQuery(SHEET);
  const closeRef = useRef(null);
  const rootRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Whatever had focus when the drawer opened (e.g. the table row), read before the
  // first commit can move it.
  const [opener] = useState(() => document.activeElement);

  // Modal sheet: everything else on <body> goes inert while it's open.
  // Declared before the focus-restoring effect so its cleanup runs first: an inert
  // element can't take focus.
  useEffect(() => {
    if (!sheet) return undefined;
    const own = rootRef.current;
    const made = [...document.body.children].filter((el) => el !== own && !el.inert);
    for (const el of made) el.inert = true;
    return () => {
      for (const el of made) el.inert = false;
    };
  }, [sheet]);

  useEffect(
    () => () => {
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    },
    [opener],
  );

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [focusKey, sheet]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !inField() && onCloseRef.current();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const panel = (
    <aside className={className} aria-label={label ?? title} role={sheet ? 'dialog' : undefined} aria-modal={sheet ? 'true' : undefined}>
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
  if (!sheet) return panel;
  return createPortal(
    <div ref={rootRef} className="drawer-modal">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      {panel}
    </div>,
    document.body,
  );
}
