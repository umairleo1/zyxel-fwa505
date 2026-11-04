import { useEffect, useRef } from 'react';
import { NAV } from '../../app/nav.js';
import { Link, href } from '../../app/route.jsx';
import { useMediaQuery } from '../../hooks/index.js';
import { Router, X } from '../ui/Icons.jsx';

// Matches the breakpoint in shell.css where the sidebar becomes off-canvas.
const OFF_CANVAS = '(max-width: 960px)';

export default function Sidebar({ route, open, onClose, device }) {
  const offCanvas = useMediaQuery(OFF_CANVAS);
  const closeRef = useRef(null);
  const navRef = useRef(null);
  const scrimRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Off-canvas and open behaves like a modal dialog: the page behind goes inert, focus
  // moves in, Escape closes, and focus returns to whatever opened it (the menu button).
  useEffect(() => {
    if (!open) return undefined;
    if (!offCanvas) {
      onCloseRef.current(); // widened past the breakpoint: nothing left to close
      return undefined;
    }
    // Read before anything goes inert: inert blurs the focused element.
    const opener = document.activeElement;
    const nav = navRef.current;
    const behind = [...nav.parentElement.children].filter((el) => el !== nav && el !== scrimRef.current && !el.inert);
    for (const el of behind) el.inert = true;
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onCloseRef.current();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      for (const el of behind) el.inert = false;
      if (opener?.isConnected) opener.focus();
    };
  }, [open, offCanvas]);

  return (
    <>
      <div ref={scrimRef} className={`scrim ${open ? 'is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      {/* Closed off-canvas, it's only translated out of view: inert keeps it out of the tab order. */}
      <nav ref={navRef} className={`sidebar ${open ? 'is-open' : ''}`} aria-label="Main" inert={offCanvas && !open}>
        <div className="sidebar-brand">
          <span className="brand-mark">
            <Router size={18} />
          </span>
          <div className="brand-text">
            <span className="brand-name">Zyxel Insight</span>
            <span className="brand-sub">{device ? `${device.ModelName} · ${device.SoftwareVersion}` : 'Router monitor'}</span>
          </div>
          <button ref={closeRef} className="btn btn-ghost btn-icon sidebar-close" onClick={onClose} aria-label="Close menu">
            <X />
          </button>
        </div>
        <div className="sidebar-scroll">
          {NAV.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-group-label">
                {g.group}
                {g.note && <span className="nav-note">{g.note}</span>}
              </div>
              {g.items.map((it) => {
                const Icon = it.icon;
                const active = route === it.id;
                return (
                  <Link
                    key={it.id}
                    to={href(it.id)}
                    className={`nav-item ${active ? 'is-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={onClose}
                  >
                    <Icon size={16} />
                    <span>{it.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
