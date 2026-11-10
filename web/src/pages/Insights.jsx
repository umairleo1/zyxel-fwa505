import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/index.js';
import { useLive, useToast } from '../app/live.js';
import { navigate } from '../app/route.jsx';
import { isNr } from '@zyxel-insight/shared/radio';
import { formatBytes, formatBps, formatDayMonth, formatDuration, formatFull, formatSigned } from '../lib/format.js';
import { OUTAGE_KINDS, outageTone } from '../lib/timeline.js';
import { PageHeader, Panel, Stat, ErrorNote, PageLoader } from '../components/ui/index.js';
import Segmented from '../components/ui/Segmented.jsx';
import { StatusIcon } from '../components/ui/Icons.jsx';
import HourProfile from '../features/insights/HourProfile.jsx';
import Recommendations from '../features/insights/Recommendations.jsx';

const RANGES = [
  { value: 86400e3, label: '24h' },
  { value: 7 * 86400e3, label: '7d' },
  { value: 30 * 86400e3, label: '30d' },
];
const TONE = { fail: 'critical', warn: 'warning', info: 'neutral', pass: 'good' };
const STATUS_LABEL = { fail: 'Risk', warn: 'Review', info: 'Note', pass: 'OK' };
/** " (2 mobile data, 3 stalls)": the outages that weren't the router itself. */
const outageBreakdown = (rel) => {
  const parts = [
    rel.wanOutages && `${rel.wanOutages} mobile data`,
    rel.internetStalls && `${rel.internetStalls} stall${rel.internetStalls === 1 ? '' : 's'}`,
  ];
  const shown = parts.filter(Boolean);
  return shown.length ? ` (${shown.join(', ')})` : '';
};

/** Audit/recommendation status -> shared status icon. */
const AuditIcon = ({ status }) => <StatusIcon tone={TONE[status]} size={15} />;

/** 100% bar: share of samples in Good / Fair / Poor. */
function QualityBar({ dist, label }) {
  if (!dist) return null;
  const parts = [
    { key: 'good', label: 'Good', v: (dist.excellent ?? 0) + (dist.good ?? 0), color: 'var(--good)' },
    { key: 'fair', label: 'Fair', v: dist.fair ?? 0, color: 'var(--warning)' },
    { key: 'poor', label: 'Poor', v: dist.poor ?? 0, color: 'var(--critical)' },
  ];
  const total = parts.reduce((a, p) => a + p.v, 0);
  return (
    <div className="qbar">
      <div className="qbar-label">{label}</div>
      {total ? (
        <div className="qbar-track" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${Math.round(p.v)}%`).join(', ')}`}>
          {parts
            .filter((p) => p.v > 0)
            .map((p) => (
              <span key={p.key} className="qbar-seg" style={{ flexGrow: p.v, background: p.color }} title={`${p.label} ${p.v}%`} />
            ))}
        </div>
      ) : (
        <div className="qbar-track empty" />
      )}
      <div className="qbar-legend">
        {parts.map((p) => (
          <span key={p.key}>
            <i style={{ background: p.color }} />
            {p.label} <b>{Math.round(p.v)}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function StatsRow({ name, s, unit }) {
  if (!s)
    return (
      <tr>
        <td>{name}</td>
        <td colSpan={4} className="muted">
          No samples
        </td>
      </tr>
    );
  return (
    <tr>
      <td>{name}</td>
      <td className="num">
        <b>{formatSigned(s.avg)}</b> <span className="muted">{unit}</span>
      </td>
      <td className="num">{formatSigned(s.p10)}</td>
      <td className="num">{formatSigned(s.min)}</td>
      <td className="num">{formatSigned(s.max)}</td>
    </tr>
  );
}

export default function Insights() {
  const { status, ticks } = useLive();
  const [span, setSpan] = useState(7 * 86400e3);
  const [fresh, setFresh] = useState(0);
  const tickKey = Math.floor(ticks.data / 5); // every ~5 pushes is plenty for aggregates
  const r = useAsync(() => api.insights({ from: Date.now() - span, fresh }), [span, tickKey, fresh]);
  const d = r.data;
  const audit = d?.audit;
  const rel = d?.reliability;
  const sig = d?.signal;
  // "Internet" first: whether the router is reachable at all frames every exposure check.
  const areas = audit ? [...new Set(audit.checks.map((c) => c.area))].sort((a, b) => (b === 'Internet') - (a === 'Internet')) : [];
  const month = d?.usage?.month;

  return (
    <div className="page">
      {!r.data && r.loading && <PageLoader />}
      <PageHeader
        title="Insights"
        subtitle="What the router doesn't tell you: configuration risks, reliability, signal quality and usage — derived from everything Insight has collected."
      >
        <Segmented options={RANGES} value={span} onChange={setSpan} label="Period" />
        <button className="btn btn-sm" onClick={() => setFresh(Date.now())} disabled={r.loading}>
          Re-run audit
        </button>
      </PageHeader>
      <ErrorNote error={r.error} />

      <div className="tiles">
        <Stat
          label="Security score"
          value={audit?.score ?? '—'}
          unit="/100"
          sub={
            audit
              ? `${audit.counts.fail ?? 0} risks · ${audit.counts.warn ?? 0} to review · ${audit.counts.pass ?? 0} OK · notes don't count`
              : 'Running audit…'
          }
        />
        <Stat
          label="Availability"
          value={rel?.availabilityPct ?? '—'}
          unit="%"
          sub={
            rel
              ? `${rel.outages} outage${rel.outages === 1 ? '' : 's'}${outageBreakdown(rel)} · ${formatDuration(rel.downtimeSec)} down · watched ${rel.coveragePct ?? 0}%${rel.startedInPeriod ? ` since ${formatDayMonth(rel.monitoredSince)}` : ''}`
              : ''
          }
        />
        <Stat label="Reboots" value={rel?.reboots ?? '—'} sub={rel ? `${rel.unexpectedReboots} without a logged reason` : ''} />
        <Stat
          label="Data used"
          value={d?.usage ? formatBytes(d.usage.totals.rx + d.usage.totals.tx) : '—'}
          sub={d?.usage ? `↓ ${formatBytes(d.usage.totals.rx)} · ↑ ${formatBytes(d.usage.totals.tx)}` : ''}
        >
          {month && (
            <p className="tile-sub">
              This month <b>{formatBytes(month.used)}</b> · {monthSub(month)}
            </p>
          )}
        </Stat>
      </div>

      {d && (
        <Recommendations
          rules={d.recommendations}
          span={span}
          ai={status?.ai}
          extra={(rec) => rec.tryBand && <TryBand band={rec.tryBand} enabled={!!status?.radioEnabled} />}
        />
      )}

      <div className="two-col">
        <Panel title="Configuration audit" subtitle={audit ? `${audit.checks.length} checks · ${formatFull(audit.at)}` : ''} flush>
          {areas.map((area) => (
            <div key={area} className="audit-group">
              <div className="audit-area">{area}</div>
              {audit.checks
                .filter((c) => c.area === area)
                .map((c) => (
                  <div key={c.id} className={`audit-row audit-${c.status}`}>
                    <AuditIcon status={c.status} />
                    <div className="audit-text">
                      <p className="audit-title">
                        {c.title} <span className={`audit-tag tag-${c.status}`}>{STATUS_LABEL[c.status]}</span>
                      </p>
                      <p className="audit-detail">{c.detail}</p>
                      {c.fix && <p className="audit-fix">{c.fix}</p>}
                    </div>
                  </div>
                ))}
            </div>
          ))}
          {audit?.error && <p className="error-text panel-body">{audit.error}</p>}
        </Panel>

        <div className="stack">
          <Panel
            title="Signal health"
            subtitle={
              sig
                ? `${sig.handovers} cell change${sig.handovers === 1 ? '' : 's'} · ${sig.comboChanges} combination change${sig.comboChanges === 1 ? '' : 's'} · ${sig.distinctCells} cell${sig.distinctCells === 1 ? '' : 's'} seen`
                : ''
            }
          >
            <QualityBar label="LTE strength (RSRP · router bar scale: Good = 4–5 bars, Fair = 3, Poor = 0–2)" dist={sig?.lte.rsrpDist} />
            <QualityBar label="LTE quality (SINR)" dist={sig?.lte.sinrDist} />
            <QualityBar label="5G strength (RSRP)" dist={sig?.nr.rsrpDist} />
            <QualityBar label="5G quality (SINR)" dist={sig?.nr.sinrDist} />
            <table className="mini-stats">
              <thead>
                <tr>
                  <th />
                  <th className="num">Average</th>
                  <th className="num">Worst 10%</th>
                  <th className="num">Min</th>
                  <th className="num">Max</th>
                </tr>
              </thead>
              <tbody>
                <StatsRow name="LTE RSRP" s={sig?.lte.rsrp} unit="dBm" />
                <StatsRow name="LTE SINR" s={sig?.lte.sinr} unit="dB" />
                <StatsRow name="5G RSRP" s={sig?.nr.rsrp} unit="dBm" />
                <StatsRow name="5G SINR" s={sig?.nr.sinr} unit="dB" />
              </tbody>
            </table>
            {sig?.nr.availabilityPct != null && (
              <p className="tile-sub">
                5G leg active in <b>{sig.nr.availabilityPct}%</b> of samples.
              </p>
            )}
          </Panel>

          <Panel title="By hour of day" subtitle="The period folded onto one day: when quality dips and when you use the connection">
            <HourProfile hourly={d?.hourly} />
          </Panel>

          <Panel title="Band combinations" subtitle="Share of time in each carrier set">
            {sig?.combos?.length ? (
              <ul className="dwell">
                {sig.combos.map((c) => (
                  <li key={c.combo}>
                    <span className="dwell-name mono">{c.combo}</span>
                    <span className="dwell-bar">
                      <span style={{ width: `${c.pct}%` }} />
                    </span>
                    <b className="dwell-pct">{c.pct >= 0.1 ? `${c.pct}%` : '<0.1%'}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-inline">No samples yet</p>
            )}
          </Panel>

          <Panel title="Reliability">
            {rel?.recentReboots?.length || rel?.recentOutages?.length ? (
              <ul className="timeline">
                {rel.recentReboots.map((b) => (
                  <li key={`r${b.boot_ts}`}>
                    <span className={`dot ${b.kind === 'expected' ? 'dot-neutral' : 'dot-warning'}`} />
                    <b>{b.kind === 'expected' ? 'Reboot' : 'Reboot (no logged reason)'}</b>{' '}
                    <span className="muted">{formatFull(b.boot_ts)}</span>
                    {b.reason && <div className="muted small">{b.reason}</div>}
                  </li>
                ))}
                {rel.recentOutages.map((o) => (
                  <li key={`o${o.kind}${o.start_ts}`}>
                    <span className={`dot dot-${outageTone(o.kind)}`} />
                    <b>
                      {OUTAGE_KINDS[o.kind]?.label ?? 'Outage'} {formatDuration((o.end_ts - o.start_ts) / 1000)}
                      {o.ongoing && ' so far'}
                    </b>{' '}
                    <span className="muted">{formatFull(o.start_ts)}</span>
                    {o.reason && <div className="muted small">{o.reason}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-inline">No reboots or outages in this period.</p>
            )}
          </Panel>

          <Panel title="Devices & usage">
            <dl className="kv-grid">
              <div className="kv-row">
                <dt>Known devices</dt>
                <dd>
                  {d?.devices.known ?? '—'} <span className="muted">({d?.devices.online ?? 0} online)</span>
                </dd>
              </div>
              <div className="kv-row">
                <dt>Joined this period</dt>
                <dd>
                  {d?.devices.newInRange ?? '—'}
                  {d?.devices.firstSeenAt > d?.from && (
                    <span className="muted"> (not counting those already there on {formatDayMonth(d.devices.firstSeenAt)})</span>
                  )}
                </dd>
              </div>
              <div className="kv-row">
                <dt>Peak download</dt>
                <dd>
                  {formatBps(d?.usage?.peak.rx)}
                  {d?.usage?.peak.rxAt && <span className="muted"> · {formatFull(d.usage.peak.rxAt)}</span>}
                </dd>
              </div>
              <div className="kv-row">
                <dt>Peak upload</dt>
                <dd>{formatBps(d?.usage?.peak.tx)}</dd>
              </div>
              <div className="kv-row">
                <dt>CPU (avg / max)</dt>
                <dd>{d?.system.cpu ? `${d.system.cpu.avg}% / ${d.system.cpu.max}%` : '—'}</dd>
              </div>
              <div className="kv-row">
                <dt>Memory (avg / max)</dt>
                <dd>{d?.system.mem ? `${d.system.mem.avg}% / ${d.system.mem.max}%` : '—'}</dd>
              </div>
            </dl>
            {d?.devices.dhcpChatter?.length > 0 && (
              <>
                <h3 className="sub-h">Most DHCP requests (from router log)</h3>
                <ul className="dwell">
                  {d.devices.dhcpChatter.slice(0, 5).map((c) => (
                    <li key={c.mac}>
                      <span className="dwell-name">{c.name ?? <span className="mono">{c.mac}</span>}</span>
                      <span className="dwell-bar">
                        <span style={{ width: `${(c.n / d.devices.dhcpChatter[0].n) * 100}%` }} />
                      </span>
                      <b className="dwell-pct">{c.n}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** "on track for ~32 GB by 1 Dec", or why there's no projection yet. */
function monthSub(m) {
  if (m.projected == null) return 'projection after 2 days of data';
  return `on track for ~${formatBytes(m.projected, 0)} by ${formatDayMonth(m.monthEnd - 1)}`;
}

/** Start "only this 4G band, every 5G band" as a 5-minute Radio control trial, then show it there. */
function TryBand({ band, enabled }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!enabled) return <p className="rec-detail">In the router’s admin page: Network Setting → Broadband → Band.</p>;
  async function start() {
    setBusy(true);
    try {
      const radio = await api.radio();
      // 4G only or 5G SA can’t combine a 4G band with 5G ones; NSA keeps the 5G leg.
      const technology = ['Auto', 'NR5G-NSA'].includes(radio.technology.preferred) ? radio.technology.preferred : 'NR5G-NSA';
      await api.radioApply({ technology, bands: [band, ...radio.bands.supported.filter(isNr)] });
      toast(`Trying ${band}: switches back in 5 minutes unless you keep it`);
      navigate('/radio');
    } catch (e) {
      toast(`Couldn’t start the trial: ${e.message}`, 'critical');
      setBusy(false);
    }
  }
  return (
    <div className="rec-buttons">
      <button className="btn btn-sm btn-primary" disabled={busy} onClick={start}>
        {busy ? 'Applying…' : `Try ${band} for 5 minutes`}
      </button>
      <button className="btn btn-sm btn-ghost" onClick={() => navigate('/radio')}>
        Open Radio control
      </button>
    </div>
  );
}
