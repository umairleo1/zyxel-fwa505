import HealthMenu from './HealthMenu.jsx';
import { Menu, Monitor, Moon, Pause, Play, Refresh, Sun } from '../ui/Icons.jsx';

const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

export default function TopBar({ title, section, onMenu, status, offline, realtime, busy, onAction, live, setLive, theme, setTheme }) {
  const c = status?.collector;
  const ThemeIcon = THEME_ICON[theme];

  return (
    <header className="topbar">
      <div className="topbar-title">
        <button className="btn btn-ghost btn-icon menu-btn" onClick={onMenu} aria-label="Open menu">
          <Menu />
        </button>
        <nav aria-label="Breadcrumb">
          <p className="crumbs">
            {section && (
              <>
                <span className="crumb">{section}</span>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
              </>
            )}
            <span className="topbar-h1" aria-current="page">
              {title}
            </span>
          </p>
        </nav>
      </div>

      <div className="topbar-actions">
        <HealthMenu status={status} offline={offline} realtime={realtime} />
        <span className="topbar-divider" aria-hidden="true" />

        {c?.phase === 'paused' || c?.phase === 'halted' ? (
          <button
            className="btn"
            disabled={busy || offline}
            onClick={() => onAction(c.phase === 'halted' ? 'retry' : 'resume')}
            aria-label={c.phase === 'halted' ? 'Retry login' : 'Resume collection'}
          >
            {c.phase === 'halted' ? <Refresh /> : <Play />}
            <span className="btn-label">{c.phase === 'halted' ? 'Retry login' : 'Resume'}</span>
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy || offline || !c}
            onClick={() => onAction('pause')}
            title="Log out of the router so you can use its admin page"
            aria-label="Pause collection"
          >
            <Pause />
            <span className="btn-label">Pause</span>
          </button>
        )}

        <label className="switch" title="Update charts and logs as new data arrives">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} aria-label="Auto-update" />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span className="switch-text">Auto-update</span>
        </label>
        <span className="topbar-divider" aria-hidden="true" />

        <button
          className="btn btn-icon"
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme}`}
          onClick={() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])}
        >
          <ThemeIcon />
        </button>
      </div>
    </header>
  );
}
