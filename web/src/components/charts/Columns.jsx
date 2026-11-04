import { useState } from 'react';
import { useElementWidth } from '../../hooks/index.js';
import { niceTicks } from '../../lib/format.js';
import Tooltip from './Tooltip.jsx';
import { SEGMENT_GAP, clampTooltip, topRounded } from './svg.js';

const M = { t: 10, r: 8, b: 24, l: 52 };
/** Stacked columns. items: [{ key, label, values: { [seriesKey]: number } }] */
export default function Columns({ items, series, height = 200, format = String }) {
  const [ref, width] = useElementWidth();
  const [hover, setHover] = useState(null);
  const totals = items.map((it) => series.reduce((a, s) => a + (it.values[s.key] ?? 0), 0));
  const ticks = niceTicks(0, Math.max(1, ...totals), 3);
  const top = ticks.at(-1);
  const iw = Math.max(0, width - M.l - M.r);
  const ih = height - M.t - M.b;
  const slot = items.length ? iw / items.length : 0;
  const bw = Math.max(2, Math.min(28, slot - 6));
  const y = (v) => M.t + ih - (v / top) * ih;
  const every = Math.ceil(items.length / Math.max(1, Math.floor(iw / 56)));
  const peak = totals.length ? totals.indexOf(Math.max(...totals)) : -1;
  const summary = peak < 0 ? 'Column chart, no data' : `${items.length} columns; highest ${format(totals[peak])} (${items[peak].label})`;
  const h = hover != null ? items[hover] : null;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} className="chart-svg" onPointerLeave={() => setHover(null)} role="img" aria-label={summary}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-base' : 'grid'} />
              <text x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                {format(t)}
              </text>
            </g>
          ))}
          {items.map((it, i) => {
            const x = M.l + i * slot + (slot - bw) / 2;
            let acc = 0;
            const segs = series.filter((s) => (it.values[s.key] ?? 0) > 0);
            return (
              <g key={it.key} opacity={hover != null && hover !== i ? 0.55 : 1} onPointerEnter={() => setHover(i)}>
                <rect x={M.l + i * slot} y={M.t} width={slot} height={ih} fill="transparent" />
                {segs.map((s, k) => {
                  const y0 = y(acc);
                  acc += it.values[s.key];
                  const y1 = y(acc);
                  const last = k === segs.length - 1;
                  return last ? (
                    <path key={s.key} d={topRounded(x, y1, bw, y0 - y1, 4)} fill={s.color} />
                  ) : (
                    <rect key={s.key} x={x} y={y1 + SEGMENT_GAP} width={bw} height={Math.max(1, y0 - y1 - SEGMENT_GAP)} fill={s.color} />
                  );
                })}
                {i % every === 0 && (
                  <text x={M.l + i * slot + slot / 2} y={height - 6} textAnchor="middle" className="tick">
                    {it.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {h && (
        <Tooltip
          mark="rect"
          left={clampTooltip(M.l + hover * slot + slot / 2, width, 80)}
          title={h.title ?? h.label}
          rows={[...series].reverse().map((s) => ({ key: s.key, color: s.color, value: format(h.values[s.key] ?? 0), label: s.label }))}
        />
      )}
    </div>
  );
}
