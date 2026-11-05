import { useRef, useState } from 'react';
import { useElementWidth } from '../../hooks/index.js';
import { formatDuration, formatFull, formatSpan, niceTicks, timeTicks } from '../../lib/format.js';
import Tooltip from './Tooltip.jsx';
import CoverageBands from './CoverageBands.jsx';
import { OUTAGE_KINDS, UNMONITORED, spanAt } from '../../lib/timeline.js';
import { clampTooltip, linePath, seriesSummary } from './svg.js';

const M = { t: 10, r: 56, b: 22, l: 52 };
const LABEL_MIN_GAP = 12; // px between end labels before one is dropped

/**
 * Multi-series line chart over time with a crosshair tooltip.
 * - series: [{ key, label, color }]; points: [{ t, [key]: number | null }]
 * - Lines break across gaps longer than `gapMs` instead of interpolating.
 * - Hover can be controlled (`hoverT` + `onHoverT`) to sync several charts. It's the
 *   pointer's time; each chart snaps to its own nearest point, never across a gap.
 * - `coverage` ({ unmonitored, outages } from the API) shades why lines break;
 *   `coverageLabels` names the bands inside them (off for all but one small multiple).
 */
export default function TimeSeries({
  points,
  series,
  from,
  to,
  height = 200,
  format = String,
  yMin,
  yMax,
  gapMs = 5 * 60e3,
  area = false,
  empty = 'No data in this range yet',
  hoverT: controlledT,
  onHoverT,
  ariaLabel,
  coverage,
  coverageLabels = true,
}) {
  const [ref, width] = useElementWidth();
  const [localT, setLocalT] = useState(null);
  const hoverT = onHoverT ? controlledT : localT;
  const setHoverT = onHoverT ?? setLocalT;
  const svgRef = useRef(null);

  const iw = Math.max(0, width - M.l - M.r);
  const ih = height - M.t - M.b;
  const values = points.flatMap((p) => series.map((s) => p[s.key])).filter((v) => v != null && Number.isFinite(v));
  const lo = yMin ?? (values.length ? Math.min(...values) : 0);
  const hi = yMax ?? (values.length ? Math.max(...values) : 1);
  const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi, 4);
  const [y0, y1] = [yMin ?? ticks[0], yMax ?? ticks.at(-1)];
  const x = (t) => M.l + ((t - from) / (to - from || 1)) * iw;
  const y = (v) => M.t + (1 - (v - y0) / (y1 - y0 || 1)) * ih;
  const { ticks: xTicks, label: xLabel } = timeTicks(from, to, Math.max(2, Math.floor(iw / 90)));

  /** Line path (or closed area) for one series, broken at gaps. */
  const path = (key, closed) => linePath(points, key, { x, y, gapMs, baseY: closed ? y(y0) : null });

  // Nearest point, but only within the line-break distance: across a gap it would show
  // readings from far away as if they were where the pointer is.
  const nearest = (t) => {
    let best = null;
    for (const p of points) if (best == null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best && Math.abs(best.t - t) <= gapMs ? best : null;
  };
  const onMove = (e) => {
    if (!points.length || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    setHoverT(Math.max(from, Math.min(to, from + ((e.clientX - r.left - M.l) / iw) * (to - from))));
  };
  // Inside a band, the band is the answer; elsewhere, the readings nearest the pointer.
  const band =
    hoverT == null
      ? null
      : (() => {
          const out = spanAt(coverage?.outages ?? [], hoverT);
          if (out) return { ...out, color: 'var(--critical)', label: OUTAGE_KINDS.router.label, note: out.reason };
          const gap = spanAt(coverage?.unmonitored ?? [], hoverT);
          return gap && { ...gap, color: 'var(--muted)', label: UNMONITORED.label, note: "Insight wasn't collecting" };
        })();
  const hp = hoverT != null && !band ? nearest(hoverT) : null;

  // Latest value per series, labelled at the line end; drop labels that would overlap.
  const ends = [];
  for (const s of series) {
    const p = [...points].reverse().find((q) => q[s.key] != null);
    if (!p) continue;
    const ly = y(p[s.key]);
    ends.push({ s, p, ly, label: !ends.some((e) => e.label && Math.abs(e.ly - ly) < LABEL_MIN_GAP) });
  }

  if (!values.length) {
    return (
      <div className="chart" ref={ref}>
        <div className="chart-empty static" style={{ minHeight: height }}>
          {/* "Collecting…" would be wrong when the range simply wasn't watched. */}
          {coverage?.unmonitored?.length ? `${UNMONITORED.label} in this range. ${UNMONITORED.detail}.` : empty}
        </div>
      </div>
    );
  }

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className="chart-svg"
          onPointerMove={onMove}
          onPointerLeave={() => setHoverT(null)}
          role="img"
          aria-label={`${ariaLabel ?? series.map((s) => s.label).join(', ')} — ${seriesSummary(points, series, format)}${coverageSummary(coverage)}`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + iw} y1={y(t)} y2={y(t)} className={t === ticks[0] ? 'axis-base' : 'grid'} />
              <text x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                {format(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={height - 6} textAnchor="middle" className="tick">
              {xLabel(t)}
            </text>
          ))}
          <CoverageBands
            unmonitored={coverage?.unmonitored}
            outages={coverage?.outages}
            x={x}
            left={M.l}
            right={M.l + iw}
            top={M.t}
            height={ih}
            labels={coverageLabels}
          />
          {area && series.map((s) => <path key={`a-${s.key}`} d={path(s.key, true)} fill={s.color} opacity="0.1" />)}
          {series.map((s) => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {ends.map(({ s, p, ly, label }) => (
            <g key={`e-${s.key}`}>
              <circle cx={x(p.t)} cy={ly} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
              {label && (
                <text x={x(p.t) + 8} y={ly} dy="0.32em" className="end-label">
                  {format(p[s.key])}
                </text>
              )}
            </g>
          ))}
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={M.t} y2={M.t + ih} className="crosshair" />
              {series.map((s) =>
                hp[s.key] == null ? null : (
                  <circle key={s.key} cx={x(hp.t)} cy={y(hp[s.key])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
                ),
              )}
            </g>
          )}
        </svg>
      )}
      {hp && (
        <Tooltip
          left={clampTooltip(x(hp.t), width)}
          title={formatFull(hp.t)}
          rows={series.map((s) => ({ key: s.key, color: s.color, value: hp[s.key] == null ? '—' : format(hp[s.key]), label: s.label }))}
        />
      )}
      {band && (
        <Tooltip
          left={clampTooltip(x(hoverT), width)}
          title={formatSpan(band.start, band.end)}
          rows={[{ key: 'band', color: band.color, value: formatDuration((band.end - band.start) / 1000), label: band.label }]}
          note={band.note}
        />
      )}
    </div>
  );
}

/** "; not monitored for 7h 10m, router unreachable for 3m" for screen readers, or nothing. */
function coverageSummary(coverage) {
  const total = (spans = []) => spans.reduce((a, s) => a + s.end - s.start, 0) / 1000;
  const parts = [];
  if (coverage?.unmonitored?.length) parts.push(`not monitored for ${formatDuration(total(coverage.unmonitored))}`);
  if (coverage?.outages?.length) parts.push(`router unreachable for ${formatDuration(total(coverage.outages))}`);
  return parts.length ? `; ${parts.join(', ')}` : '';
}
