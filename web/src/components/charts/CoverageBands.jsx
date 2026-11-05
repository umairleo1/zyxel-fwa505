import { useId } from 'react';
import { OUTAGE_KINDS, UNMONITORED } from '../../lib/timeline.js';

const LABEL_MIN_PX = 96; // room to name the band inside it; narrower ones say it on hover

/**
 * Why a chart's lines break, drawn behind them (inside an <svg>): hatched where Insight
 * wasn't collecting, tinted where the router didn't answer. Spans are { start, end } in
 * epoch ms (the API's `coverage`); `x` maps time to px, and bands are clipped to
 * [left, right]. `labels` writes the band's name in it when there's room; the chart's
 * own tooltip describes a band on hover (a native <title> would pop up on top of it).
 */
export default function CoverageBands({ unmonitored = [], outages = [], x, left, right, top, height, labels = true }) {
  const hatch = `cov-hatch-${useId().replace(/[^\w-]/g, '')}`; // useId's colons would break url(#…)
  if (!unmonitored.length && !outages.length) return null;

  const band = (s, className, name, fill) => {
    const x0 = Math.max(left, x(s.start));
    const x1 = Math.min(right, x(s.end));
    if (x1 <= x0) return null;
    const w = x1 - x0;
    return (
      <g key={`${className}-${s.start}`}>
        <rect className={className} x={x0} y={top} width={Math.max(1, w)} height={height} fill={fill} />
        {labels && w >= LABEL_MIN_PX && (
          <text x={x0 + w / 2} y={top + 14} textAnchor="middle" className="cov-label">
            {name}
          </text>
        )}
      </g>
    );
  };

  return (
    <g className="cov" aria-hidden="true">
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="cov-hatch" />
        </pattern>
      </defs>
      {outages.map((o) => band(o, 'cov-outage', OUTAGE_KINDS.router.label))}
      {unmonitored.map((g) => band(g, 'cov-gap', UNMONITORED.label, `url(#${hatch})`))}
    </g>
  );
}
