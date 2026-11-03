import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import { formatBytes, formatBps, formatDuration, formatFull, formatSigned } from '../lib/format.js';
import { PageHeader, Panel, Stat, ErrorNote } from '../components/ui/index.js';
import Segmented from '../components/ui/Segmented.jsx';
import { StatusIcon } from '../components/ui/Icons.jsx';

const RANGES = [
  { value: 86400e3, label: '24h' },
  { value: 7 * 86400e3, label: '7d' },
  { value: 30 * 86400e3, label: '30d' },
];
const TONE = { fail: 'critical', warn: 'warning', info: 'neutral', pass: 'good' };
const STATUS_LABEL = { fail: 'Risk', warn: 'Review', info: 'Note', pass: 'OK' };

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
  const { ticks } = useLive();
  const [span, setSpan] = useState(7 * 86400e3);
  const [fresh, setFresh] = useState(0);
  const tickKey = Math.floor(ticks.data / 5); // every ~5 pushes is plenty for aggregates
  const r = useAsync(() => api.insights({ from: Date.now() - span, fresh }), [span, tickKey, fresh]);
  const d = r.data;
  const audit = d?.audit;
  const rel = d?.reliability;
  const sig = d?.signal;
  const areas = audit ? [...new Set(audit.checks.map((c) => c.area))] : [];

  return (
    <div className="page">
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
              ? `${audit.counts.fail ?? 0} risks · ${audit.counts.warn ?? 0} to review · ${audit.counts.pass ?? 0} OK`
              : 'Running audit…'
          }
        />
        <Stat
          label="Availability"
          value={rel?.availabilityPct ?? '—'}
          unit="%"
          sub={
            rel
              ? `${rel.outages} outage${rel.outages === 1 ? '' : 's'} · ${formatDuration(rel.downtimeSec)} down · monitored ${rel.coveragePct ?? 0}%`
              : ''
          }
        />
        <Stat label="Reboots" value={rel?.reboots ?? '—'} sub={rel ? `${rel.unexpectedReboots} without a logged reason` : ''} />
        <Stat
          label="Data used"
          value={d?.usage ? formatBytes(d.usage.totals.rx + d.usage.totals.tx) : '—'}
          sub={d?.usage ? `↓ ${formatBytes(d.usage.totals.rx)} · ↑ ${formatBytes(d.usage.totals.tx)}` : ''}
        />
      </div>

      {d?.recommendations?.length > 0 && (
        <Panel title="Recommendations" subtitle="Prioritised from current readings and history">
          <ul className="recs">
            {d.recommendations.map((rec, i) => (
              <li key={i} className={`rec rec-${rec.severity}`}>
                <AuditIcon status={rec.severity} />
                <div>
                  <p className="rec-title">{rec.title}</p>
                  <p className="rec-detail">{rec.detail}</p>
                  {rec.action && <p className="rec-action">→ {rec.action}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
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
              sig ? `${sig.handovers} cell changes · ${sig.comboChanges} combination changes · ${sig.distinctCells} cells seen` : ''
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

          <Panel title="Band combinations" subtitle="Share of time in each carrier set">
            {sig?.combos?.length ? (
              <ul className="dwell">
                {sig.combos.map((c) => (
                  <li key={c.combo}>
                    <span className="dwell-name mono">{c.combo}</span>
                    <span className="dwell-bar">
                      <span style={{ width: `${c.pct}%` }} />
                    </span>
                    <b className="dwell-pct">{c.pct}%</b>
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
                  <li key={`o${o.start_ts}`}>
                    <span className="dot dot-warning" />
                    <b>Unreachable {formatDuration((o.end_ts - o.start_ts) / 1000)}</b>{' '}
                    <span className="muted">{formatFull(o.start_ts)}</span>
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
                <dt>New this period</dt>
                <dd>{d?.devices.newInRange ?? '—'}</dd>
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
