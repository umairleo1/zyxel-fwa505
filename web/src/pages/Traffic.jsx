import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useRouterData } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import { formatBps, formatBytes, formatFull, formatDayMonth } from '../lib/format.js';
import { usageToday } from '../lib/traffic.js';
import { DataTable, PageHeader, Panel, Stat } from '../components/ui/index.js';
import { SERIES as SERIES_BY_ID, rangeOptions } from '../lib/domain.js';
import Segmented from '../components/ui/Segmented.jsx';
import TimeSeries from '../components/charts/TimeSeries.jsx';
import Legend from '../components/charts/Legend.jsx';
import Columns from '../components/charts/Columns.jsx';

const SERIES = [
  { ...SERIES_BY_ID.download, key: 'rxBps' },
  { ...SERIES_BY_ID.upload, key: 'txBps' },
];
const DAY_SERIES = [SERIES_BY_ID.download, SERIES_BY_ID.upload];

export default function Traffic() {
  const { ticks } = useLive();
  const [span, setSpan] = useState(86400e3);
  const t = useAsync(() => api.traffic({ from: Date.now() - span }), [span, ticks.traffic]);
  const week = useAsync(() => api.traffic({ from: Date.now() - 14 * 86400e3 }), [Math.floor(ticks.traffic / 10)]);
  const r = useRouterData(['Traffic_Status'], [ticks.traffic]);
  const d = t.data;
  const today = usageToday(week.data?.days);
  const ts = r.get('Traffic_Status')?.[0];
  const ifaces = (ts?.ipIface ?? []).map((i, k) => ({ ...i, st: ts.ipIfaceSt?.[k] ?? {} }));
  const ports = (ts?.ethIface ?? []).map((i, k) => ({ ...i, st: ts.ethIfaceSt?.[k] ?? {} })).filter((p) => p.Status !== 'NotPresent');
  const latest = d?.series?.at(-1);

  return (
    <div className="page">
      <PageHeader title="Traffic" subtitle="Throughput and data usage computed from the router's interface counters (sampled every 30 s).">
        <Segmented options={rangeOptions()} value={span} onChange={setSpan} label="Range" />
      </PageHeader>
      <div className="tiles">
        <Stat label="Right now" value={formatBps(latest?.rxBps)} sub={`↑ ${formatBps(latest?.txBps)}`} />
        <Stat
          label="Used today"
          value={formatBytes(today ? today.rx + today.tx : null)}
          sub={today ? `↓ ${formatBytes(today.rx)} · ↑ ${formatBytes(today.tx)}` : 'Collecting…'}
        />
        <Stat
          label="Used in range"
          value={formatBytes(d ? d.totals.rx + d.totals.tx : null)}
          sub={d ? `↓ ${formatBytes(d.totals.rx)} · ↑ ${formatBytes(d.totals.tx)}` : ''}
        />
        <Stat
          label="Peak download"
          value={formatBps(d?.peak.rx)}
          sub={d?.peak.rxAt ? `${formatFull(d.peak.rxAt)} · peak up ${formatBps(d.peak.tx)}` : ''}
        />
      </div>

      <Panel
        title="Throughput (WAN)"
        subtitle={d ? `Average per ${Math.round(d.bucketMs / 60e3)} min` : ''}
        actions={<Legend series={SERIES} />}
        flush
      >
        <TimeSeries
          points={d?.series ?? []}
          series={SERIES}
          // The fetched window, so lines don't slide left between refreshes.
          from={d?.from ?? Date.now() - span}
          to={d?.to ?? Date.now()}
          height={240}
          format={formatBps}
          yMin={0}
          area
          gapMs={Math.max(3 * (d?.bucketMs ?? 60e3), 5 * 60e3)}
          empty="Collecting — throughput appears after the first two samples (≈1 min)."
        />
      </Panel>

      <Panel title="Daily usage" subtitle="Last 14 days (local time)" actions={<Legend series={DAY_SERIES} kind="rect" />} flush>
        {week.data?.days?.length ? (
          <Columns
            items={week.data.days.map((x) => ({
              key: x.day,
              label: formatDayMonth(x.day),
              title: new Date(x.day).toDateString(),
              values: { rx: x.rx, tx: x.tx },
            }))}
            series={DAY_SERIES}
            format={(v) => formatBytes(v, 0)}
            height={200}
          />
        ) : (
          <p className="empty-inline panel-body">No usage recorded yet.</p>
        )}
      </Panel>

      <Panel title="Interfaces" subtitle="Lifetime counters since the router booted" flush>
        <DataTable
          rows={[...ifaces.map((i) => ({ ...i, kind: 'IP' })), ...ports.map((i) => ({ ...i, kind: 'Ethernet' }))]}
          rowKey={(i) => `${i.kind}-${i.Name}-${i.X_ZYXEL_IfName ?? i.X_ZYXEL_LanPort ?? ''}`}
          columns={[
            {
              key: 'Name',
              label: 'Interface',
              render: (i) => (
                <>
                  <b>{i.kind === 'Ethernet' ? (i.X_ZYXEL_LanPort ?? i.Name) : i.Name}</b>{' '}
                  <span className="muted mono small">{i.X_ZYXEL_IfName ?? i.Name}</span>
                </>
              ),
            },
            {
              key: 'Status',
              label: 'Status',
              render: (i) => <span className={i.Status === 'Up' ? 'tone-good' : 'muted'}>{i.Status}</span>,
            },
            { key: 'rx', label: 'Received', align: 'right', render: (i) => formatBytes(i.st.BytesReceived) },
            { key: 'tx', label: 'Sent', align: 'right', render: (i) => formatBytes(i.st.BytesSent) },
            {
              key: 'pkts',
              label: 'Packets in / out',
              align: 'right',
              render: (i) => `${(i.st.PacketsReceived ?? 0).toLocaleString()} / ${(i.st.PacketsSent ?? 0).toLocaleString()}`,
            },
            {
              key: 'err',
              label: 'Errors',
              align: 'right',
              render: (i) => {
                const e = (i.st.ErrorsReceived ?? 0) + (i.st.ErrorsSent ?? 0);
                return <span className={e ? 'tone-warning' : ''}>{e}</span>;
              },
            },
            {
              key: 'drop',
              label: 'Dropped',
              align: 'right',
              render: (i) => (i.st.DiscardPacketsReceived ?? 0) + (i.st.DiscardPacketsSent ?? 0),
            },
          ]}
        />
      </Panel>
    </div>
  );
}
