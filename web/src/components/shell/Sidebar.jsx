import { NAV } from '../../app/nav.js';
import { Link, href } from '../../app/route.jsx';
import { Router, X } from '../ui/Icons.jsx';

export default function Sidebar({ route, open, onClose, device }) {
  return (
    <>
      <div className={`scrim ${open ? 'is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <nav className={`sidebar ${open ? 'is-open' : ''}`} aria-label="Main">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <Router size={18} />
          </span>
          <div className="brand-text">
            <span className="brand-name">Zyxel Insight</span>
            <span className="brand-sub">{device ? `${device.ModelName} · ${device.SoftwareVersion}` : 'Router monitor'}</span>
          </div>
          <button className="btn btn-ghost btn-icon sidebar-close" onClick={onClose} aria-label="Close menu">
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
