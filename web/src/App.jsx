import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api/client.js';
import { useInterval, useNow, useServerEvents, useThrottle, useTheme } from './hooks/index.js';
import { LiveContext } from './app/live.js';
import { href, navigate, useRoute } from './app/route.jsx';
import { NAV_ITEMS } from './app/nav.js';
import Sidebar from './components/shell/Sidebar.jsx';
import TopBar from './components/shell/TopBar.jsx';
import Banners from './components/shell/Banners.jsx';
import { Check, Alert } from './components/ui/Icons.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Insights from './pages/Insights.jsx';
import Cellular from './pages/Cellular.jsx';
import Devices from './pages/Devices.jsx';
import WiFi from './pages/WiFi.jsx';
import Traffic from './pages/Traffic.jsx';
import System from './pages/System.jsx';
import Tables from './pages/Tables.jsx';
import Settings from './pages/settings/Settings.jsx';

// With the event stream connected, data refreshes on push; the slow tick only slides
// preset time windows forward. Without it, fall back to polling.
const PUSH_TICK_MS = 60_000;
const POLL_TICK_MS = 10_000;
// Coalesce bursts of pushes (e.g. a flood of syslog lines) into one refetch per second.
const REFETCH_THROTTLE_MS = 1000;

const PAGES = {
  dashboard: Dashboard,
  insights: Insights,
  cellular: Cellular,
  devices: Devices,
  wifi: WiFi,
  traffic: Traffic,
  system: System,
  tables: Tables,
};

export default function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const [live, setLive] = useState(true);
  const [ticks, setTicks] = useState({ data: 0, metrics: 0, traffic: 0, devices: 0 });
  const [status, setStatus] = useState(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const liveRef = useRef(live);
  liveRef.current = live;
  const now = useNow(1000);

  const toast = useCallback((message, tone = 'good') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  const bump = (k) => setTicks((t) => ({ ...t, [k]: t[k] + 1 }));
  const bumpData = useThrottle(() => bump('data'), REFETCH_THROTTLE_MS);
  const bumpMetrics = useThrottle(() => bump('metrics'), REFETCH_THROTTLE_MS);
  const bumpTraffic = useThrottle(() => bump('traffic'), REFETCH_THROTTLE_MS);
  const bumpDevices = useThrottle(() => bump('devices'), REFETCH_THROTTLE_MS);

  const realtime = useServerEvents({
    open: () => {
      bumpData();
      bumpMetrics();
    },
    status: (s) => {
      setStatus(s);
      setOffline(false);
    },
    logs: () => liveRef.current && bumpData(),
    metrics: () => liveRef.current && bumpMetrics(),
    traffic: () => liveRef.current && bumpTraffic(),
    devices: () => liveRef.current && bumpDevices(),
  });

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  useInterval(
    () => {
      if (document.visibilityState !== 'visible') return; // background tabs stay idle
      if (!realtime) refreshStatus();
      if (live) setTicks((t) => ({ data: t.data + 1, metrics: t.metrics + 1, traffic: t.traffic + 1, devices: t.devices + 1 }));
    },
    realtime ? PUSH_TICK_MS : POLL_TICK_MS,
  );

  async function onAction(action) {
    setBusy(true);
    try {
      await api.collector(action);
      await refreshStatus();
      toast(action === 'pause' ? 'Paused — router session released' : 'Collector resumed');
    } catch (e) {
      toast(`Action failed: ${e.message}`, 'critical');
    } finally {
      setBusy(false);
    }
  }

  const toggleLive = (on) => {
    setLive(on);
    if (on) setTicks((t) => ({ data: t.data + 1, metrics: t.metrics + 1, traffic: t.traffic + 1, devices: t.devices + 1 }));
  };

  const ctx = useMemo(() => ({ status, now, live, realtime, ticks, toast }), [status, now, live, realtime, ticks, toast]);
  const navItem = NAV_ITEMS.find((i) => i.id === route) ?? NAV_ITEMS[0];
  const Page = route.startsWith('settings/') ? Settings : (PAGES[route] ?? Dashboard);

  // Unknown paths fall back to the dashboard with a matching URL.
  useEffect(() => {
    if (navItem.id !== route) navigate(href(navItem.id), { replace: true });
  }, [navItem, route]);

  useEffect(() => {
    document.title = navItem.id === 'dashboard' ? 'Zyxel Insight' : `${navItem.label} · Zyxel Insight`;
    window.scrollTo(0, 0);
  }, [navItem]);

  return (
    <LiveContext.Provider value={ctx}>
      <div className="shell">
        <Sidebar route={navItem.id} open={menuOpen} onClose={() => setMenuOpen(false)} device={status?.collector.router?.device} />
        <div className="shell-main">
          <TopBar
            title={navItem.label}
            section={navItem.group === 'Overview' ? null : navItem.group}
            onMenu={() => setMenuOpen(true)}
            status={status}
            offline={offline}
            realtime={realtime}
            now={now}
            busy={busy}
            onAction={onAction}
            live={live}
            setLive={toggleLive}
            theme={theme}
            setTheme={setTheme}
          />
          <main className="main">
            <Banners status={status} now={now} busy={busy} onAction={onAction} />
            <Page key={route} pageId={route} />
          </main>
        </div>
      </div>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === 'critical' ? <Alert size={15} /> : <Check size={15} />}
            {t.message}
          </div>
        ))}
      </div>
    </LiveContext.Provider>
  );
}
