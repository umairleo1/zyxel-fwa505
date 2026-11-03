import { useEffect, useState } from 'react';

// Path-based routing on the History API: /devices, /settings/wireless, ...
// "/" is the dashboard. The server serves index.html for every non-/api path.

const NAV_EVENT = 'insight:navigate';

/** Route id for the current URL ("" or "/" -> "dashboard"). */
const currentRoute = () => location.pathname.replace(/^\/+|\/+$/g, '') || 'dashboard';

/** Path for a route id. */
export const href = (id) => (id === 'dashboard' ? '/' : `/${id}`);

/** Client-side navigation without a page load. */
export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

// Old bookmarks used hash routes ("/#/devices"): rewrite them to the real path,
// on load and when such a link is followed from within the app.
function migrateHashRoute() {
  if (!location.hash.startsWith('#/')) return false;
  history.replaceState(null, '', `${href(location.hash.slice(2).split('?')[0] || 'dashboard')}${location.search}`);
  return true;
}
migrateHashRoute();

export function useRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    const onHash = () => migrateHashRoute() && update();
    window.addEventListener('popstate', update); // back/forward
    window.addEventListener(NAV_EVENT, update); // navigate()
    window.addEventListener('hashchange', onHash); // legacy "#/page" links
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAV_EVENT, update);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  return route;
}

/**
 * <a> that navigates client-side. Keeps native behaviour for modified clicks
 * (new tab/window), so links stay real links.
 */
export function Link({ to, onClick, children, ...rest }) {
  const handle = (e) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
