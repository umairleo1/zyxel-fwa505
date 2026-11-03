import { useRef, useState } from 'react';
import { useElementWidth } from '../../hooks/index.js';
import { formatCompact, formatSpan, niceTicks, timeTicks } from '../../lib/format.js';
import { SEVERITY_SERIES } from '../../lib/domain.js';
import Tooltip from '../../components/charts/Tooltip.jsx';
import { SEGMENT_GAP, clampTooltip, topRounded } from '../../components/charts/svg.js';

const M = { t: 10, r: 8, b: 24, l: 40 };
export default function VolumeChart({ data, loading, onBrush }) {
  const [ref, width] = useElementWidth();
  const [hover, setHover] = useState(null);
  const [brush, setBrush] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const svgRef = useRef(null);

  const H = width && width < 560 ? 200 : 330;
  const buckets = data?.buckets ?? [];
  const totals = buckets.map((b) => SEVERITY_SERIES.reduce((a, s) => a + b[s.key], 0));
  const max = Math.max(1, ...totals);
  const yTicks = niceTicks(0, max, 3);
  const yMax = yTicks.at(-1);
  const iw = Math.max(0, width - M.l - M.r);
  const ih = H - M.t - M.b;
  const slot = buckets.length ? iw / buckets.length : 0;
  const barW = Math.max(1, Math.min(24, slot - SEGMENT_GAP));
  const y = (v) => M.t + ih - (v / yMax) * ih;
  const xAt = (i) => M.l + i * slot + (slot - barW) / 2;
  const from = data?.from;
  const to = data?.to;
  const tx = (t) => M.l + ((t - from) / (to - from)) * iw;
  const { ticks: xTicks, label: xLabel } = from ? timeTicks(from, to, Math.max(2, Math.floor(iw / 90))) : { ticks: [], label: () => '' };

  const idxAt = (clientX) => {
    const rect = svgRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(buckets.length - 1, Math.floor((clientX - rect.left - M.l) / slot)));
  };
  const onPointerDown = (e) => {
    if (!buckets.length || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = idxAt(e.clientX);
    setBrush({ a: i, b: i });
  };
  const onPointerMove = (e) => {
    if (!buckets.length) return;
    const i = idxAt(e.clientX);
    setHover(i);
    if (brush) setBrush((b) => ({ ...b, b: i }));
  };
  const onPointerUp = () => {
    if (brush && brush.a !== brush.b) {
      const lo = Math.min(brush.a, brush.b);
      const hi = Math.max(brush.a, brush.b);
      onBrush(buckets[lo].t, Math.min(to, buckets[hi].t + data.bucketMs));
    }
    setBrush(null);
  };

  const hb = hover != null ? buckets[hover] : null;

  return (
    <section className="panel chart-panel" aria-label="Log volume by severity">
      <header className="panel-head">
        <div>
          <h2>Log volume</h2>
          <p className="panel-sub">{data ? `Per ${formatBucket(data.bucketMs)} · drag to zoom` : ' '}</p>
        </div>
        <div className="panel-tools">
          <ul className="legend">
            {SEVERITY_SERIES.map((s) => (
              <li key={s.key}>
                <span className="swatch" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost btn-sm" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            {asTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </header>

      {asTable ? (
        <div className="mini-table-wrap">
          <table className="mini-table">
            <thead>
              <tr>
                <th>Bucket</th>
                {SEVERITY_SERIES.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets
                .filter((_, i) => totals[i])
                .reverse()
                .map((b) => (
                  <tr key={b.t}>
                    <td>{formatSpan(b.t, b.t + data.bucketMs)}</td>
                    {SEVERITY_SERIES.map((s) => (
                      <td key={s.key} className="num">
                        {b[s.key]}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart" ref={ref} style={{ opacity: loading && data ? 0.6 : 1 }}>
          {width > 0 && (
            <svg
              ref={svgRef}
              width={width}
              height={H}
              className="chart-svg brushable"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => !brush && setHover(null)}
              role="img"
              aria-label={`Log volume, ${totals.reduce((a, b) => a + b, 0)} events`}
            >
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-base' : 'grid'} />
                  <text x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                    {formatCompact(t)}
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <text key={t} x={tx(t)} y={H - 6} textAnchor="middle" className="tick">
                  {xLabel(t)}
                </text>
              ))}

              {buckets.map((b, i) => {
                let acc = 0;
                const segs = SEVERITY_SERIES.filter((s) => b[s.key] > 0);
                const dim = hover != null && hover !== i && !brush;
                return (
                  <g key={b.t} opacity={dim ? 0.55 : 1}>
                    {segs.map((s, k) => {
                      const y0 = y(acc);
                      acc += b[s.key];
                      const y1 = y(acc);
                      // 2px surface gap between stacked segments (taken from the top of the lower one).
                      const h = Math.max(1, y0 - y1 - (k < segs.length - 1 ? SEGMENT_GAP : 0));
                      const top = k < segs.length - 1 ? y1 + SEGMENT_GAP : y1;
                      return k === segs.length - 1 ? (
                        <path key={s.key} d={topRounded(xAt(i), y1, barW, y0 - y1, 4)} fill={s.color} />
                      ) : (
                        <rect key={s.key} x={xAt(i)} y={top} width={barW} height={h} fill={s.color} />
                      );
                    })}
                  </g>
                );
              })}

              {brush && (
                <rect
                  className="brush"
                  x={M.l + Math.min(brush.a, brush.b) * slot}
                  y={M.t}
                  width={(Math.abs(brush.b - brush.a) + 1) * slot}
                  height={ih}
                />
              )}
            </svg>
          )}
          {hb && !brush && (
            <Tooltip
              mark="rect"
              left={clampTooltip(xAt(hover) + barW / 2, width)}
              top={4}
              title={formatSpan(hb.t, hb.t + data.bucketMs)}
              rows={[...SEVERITY_SERIES]
                .reverse()
                .map((s) => ({ key: s.key, color: s.color, value: hb[s.key].toLocaleString(), label: s.label }))}
            />
          )}
          {data && !totals.some(Boolean) && <div className="chart-empty">No events in this range</div>}
        </div>
      )}
    </section>
  );
}

function formatBucket(ms) {
  const m = ms / 60e3;
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${m / 60} h`;
  return `${m / 1440} d`;
}
