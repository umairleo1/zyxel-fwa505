import { useState } from 'react';
import { formatSigned } from '../../lib/format.js';
import { SERIES } from '../../lib/domain.js';
import Legend from '../../components/charts/Legend.jsx';
import TimeSeries from '../../components/charts/TimeSeries.jsx';

const PANELS = [
  { metric: 'rsrp', title: 'RSRP', unit: 'dBm', hint: 'Signal strength' },
  { metric: 'sinr', title: 'SINR', unit: 'dB', hint: 'Signal quality' },
];
const LEGS = [SERIES.lte, SERIES.nr];

/** LTE and 5G RSRP/SINR as two small multiples sharing one crosshair. */
export default function SignalChart({ metrics, range, signal, loading }) {
  const [hoverT, setHoverT] = useState(null);
  const points = metrics?.points ?? [];
  const gapMs = Math.max(3 * (metrics?.bucketMs ?? 60e3), 5 * 60e3);
  const format = (v) => formatSigned(Math.round(v));

  return (
    <section className="panel chart-panel" aria-label="Cellular signal history">
      <header className="panel-head">
        <div>
          <h2>Signal</h2>
          <p className="panel-sub">Averaged per sample bucket · higher is better</p>
        </div>
        <Legend series={LEGS.map((s) => ({ ...s, note: signal?.[s.key]?.band }))} />
      </header>
      <div style={{ opacity: loading && metrics ? 0.6 : 1 }}>
        {points.length < 2 ? (
          <div className="chart-empty static">Signal history builds up as Insight reads the router.</div>
        ) : (
          PANELS.map((p) => (
            <div key={p.metric} className="signal-panel">
              <div className="signal-title">
                <b>{p.title}</b>{' '}
                <span className="muted">
                  {p.unit} · {p.hint}
                </span>
              </div>
              <TimeSeries
                points={points}
                series={LEGS.map((s) => ({ key: `${s.key}_${p.metric}`, label: s.label, color: s.color }))}
                from={range.from}
                to={range.to}
                height={150}
                format={format}
                gapMs={gapMs}
                hoverT={hoverT}
                onHoverT={setHoverT}
                ariaLabel={`${p.title} over time`}
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
