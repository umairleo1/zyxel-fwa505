import { formatCompact, formatDuration, formatFull, formatSigned } from '../../lib/format.js';
import { qualityTone, rsrpBars, rsrpQuality, sinrQuality, SEVERITY_SERIES } from '../../lib/domain.js';
import { Bars, QualityBadge } from '../../components/ui/Quality.jsx';

function Sparkline({ values, width = 112, height = 30 }) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const vs = pts.map(([, v]) => v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const x = (i) => 2 + (i / (values.length - 1)) * (width - 8);
  const y = (v) => (max === min ? height / 2 : 3 + (1 - (v - min) / (max - min)) * (height - 6));
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const [li, lv] = pts.at(-1);
  return (
    <svg className="sparkline" width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--spark)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(li)} cy={y(lv)} r="3" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}

function SignalTile({ title, leg, series, empty }) {
  if (!leg) {
    return (
      <section className="tile">
        <h3 className="tile-label">{title}</h3>
        <p className="tile-value muted-value">—</p>
        <p className="tile-sub">{empty}</p>
      </section>
    );
  }
  // Headline = signal strength on the router's own bar scale, so it matches the admin page.
  const overall = rsrpQuality(leg.rsrp);
  const sq = sinrQuality(leg.sinr);
  return (
    <section className="tile">
      <div className="tile-head">
        <h3 className="tile-label">
          {title}
          {leg.band && <span className="tile-tag">{leg.band}</span>}
        </h3>
        <QualityBadge label={overall} />
      </div>
      <div className="tile-bars" title="Same 5-bar scale as the router's admin page (RSRP)">
        <Bars n={rsrpBars(leg.rsrp)} /> <span>{rsrpBars(leg.rsrp)}/5 bars</span>
      </div>
      <div className="tile-row">
        <p className="tile-value">
          {formatSigned(leg.rsrp)}
          <span className="unit">dBm</span>
        </p>
        <Sparkline values={series} />
      </div>
      <p className="tile-sub">
        RSRP · SINR <b>{formatSigned(leg.sinr)} dB</b>
        {sq && <span className={`tone-${qualityTone(sq)}`}> ({sq.toLowerCase()})</span>} · RSRQ <b>{formatSigned(leg.rsrq)} dB</b>
        {leg.bandwidth && <> · {leg.bandwidth}</>}
      </p>
    </section>
  );
}

export default function Kpis({ router, now, metrics, histogram }) {
  const signal = router?.signal;
  const pts = metrics?.points ?? [];
  const tail = (k) => pts.slice(-24).map((p) => p[k]);
  const liveUptime = router?.uptimeSec != null ? router.uptimeSec + (now - router.fetchedAt) / 1000 : null;
  const totals = Object.fromEntries(SEVERITY_SERIES.map((s) => [s.key, 0]));
  for (const b of histogram?.buckets ?? []) for (const s of SEVERITY_SERIES) totals[s.key] += b[s.key];
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  return (
    <div className="tiles">
      <section className="tile">
        <h3 className="tile-label">Router uptime</h3>
        <p className="tile-value">{formatDuration(liveUptime)}</p>
        <p className="tile-sub">{router?.bootedAt ? <>Booted {formatFull(router.bootedAt)}</> : 'Waiting for first status poll'}</p>
        {signal && (
          <p className="tile-sub">
            {[signal.operator, signal.tech].filter(Boolean).join(' · ')}
            {signal.lte?.cellId != null && <> · Cell {signal.lte.cellId}</>}
          </p>
        )}
        {router?.carriers?.combo && (
          <p className="tile-sub">
            Bands <b>{router.carriers.combo}</b>
            {router.carriers.totalBandwidth ? <> · {router.carriers.totalBandwidth} MHz</> : null}
          </p>
        )}
      </section>

      <SignalTile title="LTE anchor" leg={signal?.lte} series={tail('lte_rsrp')} empty="No cellular data yet" />
      <SignalTile title="5G NSA" leg={signal?.nr} series={tail('nr_rsrp')} empty={signal ? '5G leg not active' : 'No cellular data yet'} />

      <section className="tile">
        <h3 className="tile-label">Log events in range</h3>
        <p className="tile-value">{formatCompact(total)}</p>
        <ul className="sev-totals">
          {SEVERITY_SERIES.map((s) => (
            <li key={s.key}>
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              {s.label} <b>{formatCompact(totals[s.key])}</b>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
