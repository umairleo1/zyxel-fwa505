import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useRouterData } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import { formatDuration, formatFull } from '../lib/format.js';
import { OUTAGE_KINDS } from '../lib/timeline.js';
import { DataTable, KV, PageHeader, Panel, Stat, Uptime, PageLoader } from '../components/ui/index.js';
import { SERIES as SERIES_BY_ID, rangeOptions } from '../lib/domain.js';
import Segmented from '../components/ui/Segmented.jsx';
import TimeSeries from '../components/charts/TimeSeries.jsx';
import Legend from '../components/charts/Legend.jsx';

const SERIES = [SERIES_BY_ID.cpu, SERIES_BY_ID.memory];

export default function System() {
  const { status, ticks } = useLive();
  const [span, setSpan] = useState(86400e3);
  const sys = useAsync(() => api.system({ from: Date.now() - span }), [span, Math.floor(ticks.metrics / 12)]);
  const r = useRouterData(['status'], [Math.floor(ticks.metrics / 12)]);
  const st = r.get('status')?.[0];
  const router = status?.collector.router;
  const s = status?.collector.system;
  const memPct = s?.memTotalKb ? Math.round(((s.memTotalKb - s.memFreeKb) / s.memTotalKb) * 100) : null;
  const points = (sys.data?.samples ?? []).map((x) => ({
    t: x.ts,
    cpu: x.cpu,
    mem: x.mem_total ? Math.round(((x.mem_total - x.mem_free) / x.mem_total) * 1000) / 10 : null,
  }));
  // The router reports an instantaneous CPU figure; average the last 15 minutes for the headline.
  const recent = points.filter((p) => p.t >= (sys.data?.to ?? 0) - 15 * 60e3 && p.cpu != null);
  const cpuAvg = recent.length ? Math.round((recent.reduce((a, p) => a + p.cpu, 0) / recent.length) * 10) / 10 : s?.cpu;
  const cpuPeak = recent.length ? Math.max(...recent.map((p) => p.cpu)) : null;
  const dev = st?.DeviceInfo ?? router?.device;

  return (
    <div className="page">
      {!sys.data && sys.loading && <PageLoader />}
      <PageHeader title="System" subtitle="Router health, load, reboots and interfaces.">
        <Segmented options={rangeOptions()} value={span} onChange={setSpan} label="Range" />
      </PageHeader>
      <div className="tiles">
        <Stat label="Uptime" value={<Uptime router={router} />} sub={router?.bootedAt ? `Booted ${formatFull(router.bootedAt)}` : ''} />
        <Stat
          label="CPU · 15 min average"
          value={cpuAvg ?? '—'}
          unit="%"
          sub={`Now ${s?.cpu ?? '—'}% · peak ${cpuPeak ?? '—'}% (router reports instant load)`}
        />
        <Stat
          label="Memory in use"
          value={memPct ?? '—'}
          unit="%"
          sub={
            s?.memTotalKb ? (
              <span title="Total − Free as reported by the router. Linux counts reclaimable cache as used, so real memory pressure is lower than this.">
                {Math.round((s.memTotalKb - s.memFreeKb) / 1024)} of {Math.round(s.memTotalKb / 1024)} MB · includes cache ⓘ
              </span>
            ) : (
              ''
            )
          }
        />
        <Stat label="Firmware" value={dev?.SoftwareVersion ?? '—'} sub={dev ? `${dev.ModelName} · HW ${dev.HardwareVersion}` : ''} />
      </div>

      <Panel title="CPU & memory" subtitle="Sampled once a minute" actions={<Legend series={SERIES} />} flush>
        <TimeSeries
          points={points}
          series={SERIES}
          // The window the data was fetched for, not "now": recomputing it per render
          // slides the lines left between refreshes.
          from={sys.data?.from ?? Date.now() - span}
          to={sys.data?.to ?? Date.now()}
          height={200}
          format={(v) => `${Math.round(v)}%`}
          yMin={0}
          yMax={100}
          gapMs={5 * 60e3}
          empty="Collecting — samples appear once a minute."
          coverage={sys.data?.coverage}
        />
      </Panel>

      <div className="two-col">
        <Panel title="Reboots" subtitle="Detected from uptime; survives Insight restarts" flush>
          <DataTable
            rows={sys.data?.reboots ?? []}
            rowKey={(b) => b.boot_ts}
            empty="No reboots in this range."
            columns={[
              { key: 'boot_ts', label: 'Booted at', render: (b) => formatFull(b.boot_ts) },
              {
                key: 'kind',
                label: 'Cause',
                render: (b) =>
                  b.kind === 'expected' ? (
                    b.reason
                  ) : (
                    <span className="tone-warning">
                      Not logged <span className="muted">— power cut, crash, or a manual reboot</span>
                    </span>
                  ),
              },
              {
                key: 'down',
                label: 'Insight lost contact',
                render: (b) =>
                  b.last_seen_before && b.last_seen_before < b.boot_ts ? (
                    `${formatDuration((b.boot_ts - b.last_seen_before) / 1000)} before boot`
                  ) : (
                    <span className="muted">Not watching at the time</span>
                  ),
              },
            ]}
          />
        </Panel>
        <Panel title="Outages" subtitle="The router didn't answer Insight, or answered without mobile data" flush>
          <DataTable
            rows={sys.data?.outages ?? []}
            rowKey={(o) => `${o.kind}-${o.start_ts}`}
            empty="No outages in this range."
            columns={[
              { key: 'start_ts', label: 'From', render: (o) => formatFull(o.start_ts) },
              {
                key: 'kind',
                label: 'What was down',
                render: (o) => (
                  <span className={o.kind === 'wan' ? 'tone-warning' : 'tone-critical'} title={OUTAGE_KINDS[o.kind]?.detail}>
                    {OUTAGE_KINDS[o.kind]?.label ?? o.kind}
                  </span>
                ),
              },
              {
                key: 'dur',
                label: 'Duration',
                align: 'right',
                render: (o) =>
                  o.ongoing ? `${formatDuration((o.end_ts - o.start_ts) / 1000)} so far` : formatDuration((o.end_ts - o.start_ts) / 1000),
              },
              { key: 'reason', label: 'Cause' },
            ]}
          />
        </Panel>
      </div>

      <div className="two-col">
        <Panel title="Device">
          <KV
            obj={
              dev
                ? {
                    Model: dev.ModelName,
                    Description: dev.Description,
                    'Serial number': dev.SerialNumber,
                    'Hardware version': dev.HardwareVersion,
                    Firmware: dev.SoftwareVersion,
                    'Modem firmware': router?.cell?.X_ZYXEL_ModuleSoftwareVersion,
                    Architecture: dev.X_ZYXEL_SoftwareArchitecture,
                    'Host name': st?.SystemInfo?.HostName,
                    Domain: st?.SystemInfo?.DomainName,
                    Nebula: dev.Connectivity,
                  }
                : null
            }
          />
        </Panel>
        <Panel title="LAN ports" flush>
          <DataTable
            rows={(st?.LanPortInfo ?? []).filter((p) => p.Status !== 'NotPresent')}
            rowKey={(p) => p.Name}
            columns={[
              { key: 'X_ZYXEL_LanPort', label: 'Port' },
              {
                key: 'Status',
                label: 'Link',
                render: (p) => <span className={p.Status === 'Up' ? 'tone-good' : 'muted'}>{p.Status}</span>,
              },
              {
                key: 'MaxBitRate',
                label: 'Speed',
                align: 'right',
                render: (p) => (p.Status === 'Up' && p.MaxBitRate > 0 ? `${p.MaxBitRate} Mbps` : '—'),
              },
              { key: 'DuplexMode', label: 'Duplex' },
              { key: 'MACAddress', label: 'MAC', render: (p) => <span className="mono small">{p.MACAddress}</span> },
            ]}
          />
        </Panel>
      </div>

      <Panel title="IP interfaces" flush>
        <DataTable
          rows={st?.WanLanInfo ?? []}
          rowKey={(w) => w.IpIfacePath}
          columns={[
            {
              key: 'Name',
              label: 'Interface',
              render: (w) => (
                <>
                  <b>{w.Name}</b> <span className="muted mono small">{w.X_ZYXEL_IfName}</span>
                </>
              ),
            },
            { key: 'X_ZYXEL_Type', label: 'Type' },
            {
              key: 'Status',
              label: 'Status',
              render: (w) => <span className={w.Status === 'Up' ? 'tone-good' : 'muted'}>{w.Status ?? 'Inactive'}</span>,
            },
            {
              key: 'ipv4',
              label: 'IPv4',
              render: (w) => (
                <span className="mono">{(w.IPv4Address ?? []).map((a) => `${a.IPAddress}/${a.SubnetMask}`).join(', ') || '—'}</span>
              ),
            },
            {
              key: 'ipv6',
              label: 'IPv6',
              render: (w) => (
                <span className="mono small">
                  {(w.IPv6Address ?? []).map((a) => a.IPAddress).join(', ') || w.X_ZYXEL_IPv6LocalAddress || '—'}
                </span>
              ),
            },
            {
              key: 'dns',
              label: 'DNS',
              render: (w) => (
                <span className="mono small">
                  {[...(w.dnsv4Server ?? []), ...(w.dnsv6Server ?? [])].map((d) => d.DNSServer ?? d).join(', ') || '—'}
                </span>
              ),
            },
            { key: 'gw', label: 'Default gateway', render: (w) => (w.X_ZYXEL_DefaultGatewayIface ? 'Yes' : '') },
          ]}
        />
      </Panel>
    </div>
  );
}
