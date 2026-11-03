import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useRouterData } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import { Bool, DataTable, PageHeader, Panel, SourceNote } from '../components/ui/index.js';
import Segmented from '../components/ui/Segmented.jsx';

const TABS = [
  { value: 'routes', label: 'Routing' },
  { value: 'arp', label: 'ARP / neighbours' },
  { value: 'interfaces', label: 'Interfaces' },
  { value: 'ports', label: 'Bridge ports' },
];

export default function Tables() {
  const { ticks } = useLive();
  const [tab, setTab] = useState('routes');
  const r = useRouterData(['routes', 'routes6', 'arp', 'arp6', 'interfaces', 'lan_ports'], [Math.floor(ticks.devices / 2)]);
  const devices = useAsync(() => api.devices(), [ticks.devices]);
  const nameOf = (mac) => devices.data?.devices.find((d) => d.mac === String(mac).toLowerCase())?.name;

  return (
    <div className="page">
      <PageHeader title="Network tables" subtitle="The router's live routing, neighbour and interface tables.">
        <SourceNote fetchedAt={r.fetchedAt} stale={r.stale} onRefresh={r.reload} loading={r.loading} />
      </PageHeader>
      <Segmented options={TABS} value={tab} onChange={setTab} label="Table" />

      {tab === 'routes' && (
        <>
          <Panel title="IPv4 routes" flush>
            <DataTable
              rows={r.get('routes') ?? []}
              columns={[
                {
                  key: 'network',
                  label: 'Destination',
                  render: (x) => <span className="mono">{x.network === '0.0.0.0' ? 'default' : `${x.network}/${x.mask}`}</span>,
                },
                {
                  key: 'gateway',
                  label: 'Gateway',
                  render: (x) => <span className="mono">{x.gateway === '0.0.0.0' ? 'on-link' : x.gateway}</span>,
                },
                { key: 'intf', label: 'Interface', render: (x) => <span className="mono">{x.intf}</span> },
                { key: 'flags', label: 'Flags' },
                { key: 'metric', label: 'Metric', align: 'right' },
              ]}
            />
          </Panel>
          <Panel title="IPv6 routes" flush>
            <DataTable rows={r.get('routes6') ?? []} empty="No IPv6 routes" />
          </Panel>
        </>
      )}
      {tab === 'arp' && (
        <>
          <Panel title="IPv4 neighbours (ARP)" flush>
            <DataTable
              rows={r.get('arp') ?? []}
              search
              columns={[
                { key: 'host', label: 'Device', render: (x) => <b>{nameOf(x.mac) ?? x.host ?? '—'}</b> },
                { key: 'ip', label: 'IP', render: (x) => <span className="mono">{x.ip}</span> },
                { key: 'mac', label: 'MAC', render: (x) => <span className="mono">{x.mac}</span> },
                { key: 'intf', label: 'Interface', render: (x) => <span className="mono">{x.intf}</span> },
              ]}
            />
          </Panel>
          <Panel title="IPv6 neighbours" flush>
            <DataTable rows={r.get('arp6') ?? []} empty="No IPv6 neighbours" />
          </Panel>
        </>
      )}
      {tab === 'interfaces' && (
        <Panel title="WAN & LAN interfaces" flush>
          <DataTable
            rows={r.get('interfaces') ?? []}
            columns={[
              { key: 'Name', label: 'Name', render: (x) => <b>{x.Name}</b> },
              { key: 'Type', label: 'Type' },
              { key: 'Enable', label: 'Enabled', render: (x) => <Bool value={x.Enable} /> },
              { key: 'ConnectionType', label: 'Mode' },
              { key: 'Encapsulation', label: 'Encapsulation' },
              { key: 'IPv4Enable', label: 'IPv4', render: (x) => <Bool value={x.IPv4Enable} /> },
              { key: 'IPv6Enable', label: 'IPv6', render: (x) => <Bool value={x.IPv6Enable} /> },
              { key: 'NatEnable', label: 'NAT', render: (x) => <Bool value={x.NatEnable} /> },
              { key: 'DefaultGateway', label: 'Default GW', render: (x) => <Bool value={x.DefaultGateway} on="Yes" off="No" /> },
              { key: 'IpIfacePath', label: 'Path', render: (x) => <span className="mono small muted">{x.IpIfacePath}</span> },
            ]}
          />
        </Panel>
      )}
      {tab === 'ports' && (
        <Panel title="Bridge ports" flush>
          <DataTable
            rows={r.get('lan_ports') ?? []}
            columns={[
              { key: 'Name', label: 'Port', render: (x) => <b>{x.Name}</b> },
              { key: 'Type', label: 'Type' },
              { key: 'IntfPath', label: 'Interface', render: (x) => <span className="mono small">{x.IntfPath}</span> },
              { key: 'BrPortPath', label: 'Bridge port', render: (x) => <span className="mono small muted">{x.BrPortPath}</span> },
            ]}
          />
        </Panel>
      )}
    </div>
  );
}
