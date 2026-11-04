import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useRouterData } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import { formatDuration, formatFull, formatSigned } from '../lib/format.js';
import { rsrpQuality, rangeOptions } from '../lib/domain.js';
import { KV, PageHeader, Panel, SourceNote, Stat } from '../components/ui/index.js';
import Segmented from '../components/ui/Segmented.jsx';
import Carriers from '../features/cellular/Carriers.jsx';
import SignalChart from '../features/cellular/SignalChart.jsx';
import BandsSeen from '../features/cellular/BandsSeen.jsx';
import { QualityBadge } from '../components/ui/Quality.jsx';

const SIM = { DEVST_SIM_RDY: 'Ready', DEVST_SIM_NOT_INSERTED: 'Not inserted', DEVST_SIM_PIN: 'PIN required' };

export default function Cellular() {
  const { status, ticks } = useLive();
  const [span, setSpan] = useState(86400e3);
  const router = status?.collector.router;
  const ca = router?.carriers;
  const sig = router?.signal;
  const range = useMemo(() => ({ from: Date.now() - span, to: Date.now() }), [span, ticks.metrics]); // eslint-disable-line react-hooks/exhaustive-deps
  const metrics = useAsync(() => api.metrics(range), [range]);
  const r = useRouterData(['cellwan_status', 'cellwan_sim', 'cellwan_band'], [Math.floor(ticks.metrics / 12)]);
  const seen = useAsync(() => api.bands(), [Math.floor(ticks.metrics / 12)]);
  const events = useAsync(() => api.logs({ source: 'insight', facility: ['cell', 'carriers'] }, undefined, 15), [ticks.data]);
  const cw = r.get('cellwan_status')?.[0];
  const sim = r.get('cellwan_sim')?.[0];
  const band = r.get('cellwan_band')?.[0];
  const active = new Set((ca?.carriers ?? []).map((c) => c.band?.toUpperCase()));
  const supported = (band?.INTF_Supported_Bands ?? '').split(',').filter(Boolean);
  const seenBands = new Set((seen.data?.bands ?? []).map((b) => b.band.toUpperCase()));
  const pcc = ca?.carriers.find((c) => c.role === 'primary');

  return (
    <div className="page">
      <PageHeader
        title="Cellular"
        subtitle={
          sig
            ? `${sig.operator ?? ''} · ${sig.tech ?? ''}${router?.cell?.X_ZYXEL_ModuleSoftwareVersion ? ` · modem ${router.cell.X_ZYXEL_ModuleSoftwareVersion}` : ''}`
            : 'Waiting for the first status read'
        }
      >
        <SourceNote fetchedAt={r.fetchedAt} stale={r.stale} onRefresh={r.reload} loading={r.loading} />
      </PageHeader>

      <div className="tiles">
        <Stat
          label="Network"
          value={sig?.operator ?? '—'}
          sub={`${sig?.tech ?? '—'}${cw ? ` · MCC/MNC ${cw.NSA_MCC ?? ''}${cw.NSA_MNC ? `/${cw.NSA_MNC}` : ''}` : ''}`}
        />
        <Stat
          label={`LTE primary ${pcc?.band ?? ''}`}
          value={formatSigned(pcc?.rsrp)}
          unit="dBm"
          sub={
            <>
              SINR {formatSigned(pcc?.sinr)} dB · RSRQ {formatSigned(pcc?.rsrq)} dB <QualityBadge label={rsrpQuality(pcc?.rsrp)} />
            </>
          }
        />
        <Stat
          label={`5G NSA ${sig?.nr?.band ?? ''}`}
          value={formatSigned(sig?.nr?.rsrp)}
          unit="dBm"
          sub={
            sig?.nr ? (
              <>
                SINR {formatSigned(sig.nr.sinr)} dB <QualityBadge label={rsrpQuality(sig.nr.rsrp)} />
              </>
            ) : (
              '5G leg not active'
            )
          }
        />
        <Stat label="Aggregated bandwidth" value={ca?.totalBandwidth ?? '—'} unit="MHz" sub={ca?.combo ?? '—'} />
      </div>

      <Carriers ca={ca} />

      <div className="toolbar-row">
        <span className="muted">Signal history</span>
        <Segmented options={rangeOptions()} value={span} onChange={setSpan} label="Range" />
      </div>
      <SignalChart metrics={metrics.data} range={range} signal={sig} loading={metrics.loading} />

      <div className="two-col">
        <Panel title="Serving cell">
          {cw ? (
            <KV
              obj={{
                'Cell ID': cw.INTF_Cell_ID,
                PCI: cw.INTF_PhyCell_ID,
                TAC: cw.INTF_TAC,
                'EARFCN (LTE)': cw.INTF_RFCN,
                'Band (LTE)': cw.INTF_Current_Band,
                'Bandwidth UL / DL': `${cw.INTF_Uplink_Bandwidth || '—'} / ${cw.INTF_Downlink_Bandwidth || '—'}`,
                RSSI: `${cw.INTF_RSSI} dBm`,
                '5G PCI': cw.NSA_PhyCellID,
                'NR-ARFCN': cw.NSA_RFCN,
                '5G bandwidth UL / DL': `${cw.NSA_UplinkBandwidth || '—'} / ${cw.NSA_DownlinkBandwidth || '—'}`,
                Roaming: cw.CELL_Roaming_Enable ? cw.CELL_Roaming_Status || 'Allowed' : 'Disabled',
                Antenna: cw.Antenna_Status === '1' ? 'Internal' : cw.Antenna_Status === '0' ? 'External' : cw.Antenna_Status,
                'Connection uptime': router?.uptimeSec != null ? formatDuration(router.uptimeSec) : '—',
              }}
              showAll
            />
          ) : (
            <p className="muted">Loading…</p>
          )}
        </Panel>
        <div className="stack">
          <Panel title="SIM">
            {sim ? (
              <KV
                obj={{
                  Status: SIM[sim.USIM_Status] ?? sim.USIM_Status,
                  IMSI: sim.USIM_IMSI,
                  ICCID: sim.USIM_ICCID,
                  'IMEI (modem)': cw?.INTF_IMEI,
                  'PIN protection': sim.USIM_PIN_Protection,
                  'PIN attempts left': sim.USIM_PIN_RemainingAttempts,
                  'PUK attempts left': sim.USIM_PUK_RemainingAttempts,
                }}
                showAll
              />
            ) : (
              <p className="muted">Loading…</p>
            )}
          </Panel>
          <Panel
            title="Bands"
            subtitle={band ? `Preferred: ${band.INTF_Preferred_Bands} · access ${band.INTF_Preferred_Access_Technology}` : ''}
          >
            <div className="band-cloud">
              {supported.map((b) => (
                <span
                  key={b}
                  className={`band-chip ${active.has(b.toUpperCase()) ? 'is-active' : seenBands.has(b.toUpperCase()) ? 'is-seen' : ''}`}
                  title={active.has(b.toUpperCase()) ? 'In use now' : seenBands.has(b.toUpperCase()) ? 'Used here before' : 'Supported'}
                >
                  {b}
                </span>
              ))}
            </div>
            <p className="tile-sub">Filled: in use now. Outlined: used here before. Plain: supported, not seen yet.</p>
          </Panel>
        </div>
      </div>

      <BandsSeen bands={seen.data?.bands} active={active} loading={seen.loading} />

      <Panel title="Cell & carrier changes" subtitle="Handovers and band-combination changes detected by Insight">
        {events.data?.items?.length ? (
          <ul className="timeline">
            {events.data.items.map((e) => (
              <li key={e.id}>
                <span className="dot dot-neutral" />
                <span className="muted mono small">{formatFull(e.ts)}</span> {e.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-inline">No changes recorded yet.</p>
        )}
      </Panel>
    </div>
  );
}
