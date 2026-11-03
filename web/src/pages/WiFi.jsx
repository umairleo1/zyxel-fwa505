import { api } from '../api/client.js';
import { useAsync, useRouterData } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import { Bool, DataTable, PageHeader, Panel, SourceNote, Stat } from '../components/ui/index.js';
import SignalBars from '../components/ui/SignalBars.jsx';
import { wifiQuality } from '../lib/domain.js';

const isDfs = (ch) => ch >= 52 && ch <= 144;

export default function WiFi() {
  const { ticks } = useLive();
  const r = useRouterData(['wlan', 'Traffic_Status', 'stations'], [ticks.devices]);
  const devices = useAsync(() => api.devices(), [ticks.devices]);
  const wlan = r.get('wlan') ?? [];
  const radios = r.get('Traffic_Status')?.[0]?.wifiRadio ?? [];
  const stations = r.get('stations') ?? [];
  const nameOf = (mac) => devices.data?.devices.find((d) => d.mac === mac)?.name ?? null;
  const dist = ['Excellent', 'Good', 'Fair', 'Poor'].map((q) => ({ q, n: stations.filter((s) => wifiQuality(s.rssi) === q).length }));

  return (
    <div className="page">
      <PageHeader title="Wi-Fi" subtitle="Radios, networks and connected clients, live.">
        <SourceNote fetchedAt={r.fetchedAt} stale={r.stale} onRefresh={r.reload} loading={r.loading} />
      </PageHeader>
      <div className="tiles">
        {radios.map((rd) => {
          const main = wlan.find((w) => w.band === rd.OperatingFrequencyBand && w.MainSSID);
          const ch = rd.Channel;
          return (
            <Stat
              key={rd.OperatingFrequencyBand}
              label={`${rd.OperatingFrequencyBand} radio`}
              value={`Ch ${ch}`}
              sub={
                <>
                  {rd.OperatingChannelBandwidth} · 802.11{(main?.X_ZYXEL_Wireless_Mode ?? rd.OperatingStandards).replace(/^11/, '')} ·{' '}
                  {rd.AutoChannelEnable ? 'auto channel' : 'fixed'} · {rd.TransmitPower}% power
                  {isDfs(ch) && (
                    <>
                      {' '}
                      ·{' '}
                      <span className="tone-warning" title="DFS: must vacate on radar detection">
                        DFS
                      </span>
                    </>
                  )}
                </>
              }
            >
              <p className="tile-sub">
                {stations.filter((s) => s.band === rd.OperatingFrequencyBand).length} clients · max {rd.MaxBitRate} Mbps
              </p>
            </Stat>
          );
        })}
        <Stat
          label="Client signal"
          value={stations.length}
          unit="clients"
          sub={
            dist
              .filter((d) => d.n)
              .map((d) => `${d.n} ${d.q.toLowerCase()}`)
              .join(' · ') || '—'
          }
        />
      </div>

      <Panel title="Connected Wi-Fi clients" flush>
        <DataTable
          rows={stations}
          rowKey={(s) => s.mac}
          empty="No Wi-Fi clients connected"
          columns={[
            { key: 'name', label: 'Device', render: (s) => <b>{nameOf(s.mac) ?? <span className="mono">{s.mac}</span>}</b> },
            { key: 'band', label: 'Band' },
            { key: 'rssi', label: 'Signal', render: (s) => <SignalBars rssi={s.rssi} /> },
            { key: 'snr', label: 'SNR', align: 'right', render: (s) => `${s.snr} dB` },
            { key: 'rateMbps', label: 'Link rate', align: 'right', render: (s) => `${s.rateMbps} Mbps` },
            { key: 'mac', label: 'MAC', render: (s) => <span className="mono small">{s.mac}</span> },
          ]}
        />
      </Panel>

      <Panel title="Networks" subtitle="Enabled networks first" flush>
        <DataTable
          rows={[...wlan].sort((a, b) => Number(b.wlEnable) - Number(a.wlEnable) || a.Index - b.Index)}
          rowKey={(w) => w.Index}
          columns={[
            {
              key: 'SSID',
              label: 'Name',
              render: (w) => (
                <span className={w.wlEnable ? '' : 'muted'}>
                  <b>{w.SSID}</b>
                  {!w.MainSSID && <span className="tag-soft">guest</span>}
                </span>
              ),
            },
            { key: 'band', label: 'Band' },
            { key: 'wlEnable', label: 'Enabled', render: (w) => <Bool value={w.wlEnable} /> },
            { key: 'SecurityMode', label: 'Security' },
            { key: 'wlHide', label: 'Hidden', render: (w) => (w.wlHide ? 'Yes' : 'No') },
            { key: 'IsolationEnable', label: 'Client isolation', render: (w) => <Bool value={w.IsolationEnable} /> },
            { key: 'MaxAssociatedDevices', label: 'Max clients', align: 'right' },
            { key: 'BSSID', label: 'BSSID', render: (w) => <span className="mono small">{w.BSSID}</span> },
          ]}
        />
      </Panel>
    </div>
  );
}
