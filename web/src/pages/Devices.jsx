import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useRouterData } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import { formatFull, formatDuration, formatWhen } from '../lib/format.js';
import { deviceEvents } from '../lib/devices.js';
import { DataTable, KV, PageHeader, Panel, Stat, When } from '../components/ui/index.js';
import Segmented from '../components/ui/Segmented.jsx';
import { SERIES } from '../lib/domain.js';
import SignalBars from '../components/ui/SignalBars.jsx';
import TimeSeries from '../components/charts/TimeSeries.jsx';
import Legend from '../components/charts/Legend.jsx';
import Drawer from '../components/ui/Drawer.jsx';

const DAY = 86400e3;
const EVENT_LIMIT = 20;
const deviceLogs = (q) => api.logs({ source: 'insight', facility: 'devices', q }, undefined, EVENT_LIMIT);

function DeviceDrawer({ device, host, onClose }) {
  // Keep the window the history was fetched for, so the chart doesn't slide between refreshes.
  const detail = useAsync(async () => {
    const to = Date.now();
    const from = to - DAY;
    return { ...(await api.device(device.mac, { from })), from, to };
  }, [device.mac, device.last_seen]);
  // Search by MAC (new events) and by name (events stored before they carried the MAC),
  // then keep only this device's; see lib/devices.js.
  const events = useAsync(
    async () =>
      deviceEvents(await Promise.all([deviceLogs(device.mac), device.name ? deviceLogs(device.name) : null]), device, EVENT_LIMIT),
    [device.mac, device.name, device.last_seen],
  );
  const hist = detail.data?.history ?? [];
  const points = hist.map((h) => ({ t: h.ts, rssi: h.rssi, snr: h.snr }));
  return (
    <Drawer
      className="side-drawer"
      title={device.name ?? device.mac}
      label={`${device.name ?? device.mac} details`}
      focusKey={device.mac}
      onClose={onClose}
      status={<span className={`dot ${device.online ? 'dot-good' : 'dot-neutral'}`} />}
    >
      <KV
        showAll
        obj={{
          Status: device.online ? 'Online' : `Offline · last seen ${formatWhen(device.last_seen)}`,
          'IP address': device.ip,
          'MAC address': device.mac,
          Connection: device.conn,
          'Wi-Fi signal': device.wifi ? `${device.wifi.rssi} dBm · SNR ${device.wifi.snr} dB` : null,
          'Link rate': device.wifi ? `${device.wifi.rate} Mbps` : null,
          'First seen': formatFull(device.first_seen),
          'Last seen': formatFull(device.last_seen),
          'DHCP lease left': host?.LeaseTimeRemaining ? formatDuration(host.LeaseTimeRemaining) : null,
          'Address source': host?.AddressSource,
          'IPv6 address': host?.IPAddress6 || null,
          'Vendor class': host?.VendorClassID && host.VendorClassID !== '*' ? host.VendorClassID : null,
        }}
      />
      {points.length > 1 && (
        <div>
          <div className="drawer-sub">
            <b>Wi-Fi signal, last 24 h</b>
            <Legend series={[{ ...SERIES.rssi, label: 'RSSI (dBm)' }]} />
          </div>
          <TimeSeries
            points={points}
            series={[SERIES.rssi]}
            from={detail.data.from}
            to={detail.data.to}
            height={150}
            format={(v) => String(Math.round(v)).replace('-', '−')}
          />
        </div>
      )}
      <div>
        <div className="drawer-sub">
          <b>Activity</b>
        </div>
        {events.data?.length ? (
          <ul className="timeline">
            {events.data.map((e) => (
              <li key={e.id}>
                <span className="dot dot-neutral" />
                <span className="muted small mono">{formatFull(e.ts)}</span> {e.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-inline">No connect/disconnect events yet.</p>
        )}
      </div>
    </Drawer>
  );
}

export default function Devices() {
  const { ticks } = useLive();
  const [filter, setFilter] = useState('online');
  const [selected, setSelected] = useState(null);
  const list = useAsync(() => api.devices(), [ticks.devices]);
  const hosts = useRouterData(['lanhosts'], [ticks.devices]);
  // A handful of hosts: no need to memoise.
  const hostByMac = new Map((hosts.get('lanhosts')?.[0]?.lanhosts ?? []).map((h) => [String(h.PhysAddress).toLowerCase(), h]));
  const devices = list.data?.devices ?? [];
  const rows = filter === 'online' ? devices.filter((d) => d.online) : devices;
  const online = devices.filter((d) => d.online);
  const byConn = (re) => online.filter((d) => re.test(d.conn ?? '')).length;
  const sel = selected ? devices.find((d) => d.mac === selected) : null;

  return (
    <div className="page">
      <PageHeader
        title="Devices"
        subtitle="Everything that has joined your network, with live Wi-Fi signal and connect/disconnect history."
      />
      <div className="tiles">
        <Stat label="Online now" value={online.length} sub={`${devices.length} known in total`} />
        <Stat label="Wi-Fi 5 GHz" value={byConn(/5GHz/)} sub="Faster, shorter range" />
        <Stat label="Wi-Fi 2.4 GHz" value={byConn(/2\.4GHz/)} sub="Longer range, slower" />
        <Stat label="New in 24 h" value={devices.filter((d) => d.first_seen > Date.now() - DAY).length} sub="First time on this network" />
      </div>
      <div className={`with-drawer-layout ${sel ? 'has-drawer' : ''}`}>
        <Panel
          title="All devices"
          actions={
            <Segmented
              options={[
                { value: 'online', label: `Online (${online.length})` },
                { value: 'all', label: `All (${devices.length})` },
              ]}
              value={filter}
              onChange={setFilter}
              label="Filter"
            />
          }
          flush
        >
          <DataTable
            rows={rows}
            rowKey={(d) => d.mac}
            selectedKey={selected}
            onRowClick={(d) => setSelected(d.mac === selected ? null : d.mac)}
            search
            empty={list.loading ? 'Loading…' : 'No devices yet — the first scan runs a few seconds after start.'}
            columns={[
              {
                key: 'name',
                label: 'Device',
                render: (d) => (
                  <span className="dev-name">
                    <span className={`dot ${d.online ? 'dot-good' : 'dot-neutral'}`} />
                    <b>{d.name ?? 'Unknown device'}</b>
                    {d.first_seen > Date.now() - DAY && <span className="tag-new">New</span>}
                  </span>
                ),
              },
              { key: 'ip', label: 'IP address', render: (d) => <span className="mono">{d.ip ?? '—'}</span> },
              { key: 'conn', label: 'Connection' },
              {
                key: 'rssi',
                label: 'Signal',
                render: (d) => (d.wifi ? <SignalBars rssi={d.wifi.rssi} /> : <span className="muted">—</span>),
              },
              { key: 'rate', label: 'Link rate', align: 'right', render: (d) => (d.wifi ? `${d.wifi.rate} Mbps` : '—') },
              { key: 'mac', label: 'MAC', render: (d) => <span className="mono small">{d.mac}</span> },
              {
                key: 'first_seen',
                label: 'First seen',
                render: (d) => <When ts={d.first_seen} />,
              },
              {
                key: 'last_seen',
                label: 'Last seen',
                render: (d) => (d.online ? <span className="tone-good">Now</span> : <When ts={d.last_seen} />),
              },
            ]}
          />
        </Panel>
        {sel && <DeviceDrawer device={sel} host={hostByMac.get(sel.mac)} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
