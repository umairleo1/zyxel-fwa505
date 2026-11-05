// Geometry helpers shared by the SVG charts.

/** Bar path with rounded top corners (radius r) and a square base. */
export function topRounded(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Gap between stacked segments, in px. */
export const SEGMENT_GAP = 2;

/**
 * Path for one series of `points` ({ t, [key]: number | null }), broken across gaps
 * longer than `gapMs` instead of interpolating. With `baseY`, each run is closed down
 * to that y as an area. x and y map time and value to pixels.
 */
export function linePath(points, key, { x, y, gapMs, baseY = null }) {
  let d = '';
  let prevT = null;
  let segStartX = null;
  const close = () => (baseY != null && prevT != null ? `L${x(prevT)},${baseY}L${segStartX},${baseY}Z` : '');
  for (const p of points) {
    const v = p[key];
    if (v == null || !Number.isFinite(v)) continue;
    const brk = prevT == null || p.t - prevT > gapMs;
    if (brk) {
      d += close();
      segStartX = x(p.t);
    }
    d += `${brk ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
    prevT = p.t;
  }
  return d + close();
}

/** Keep a centred tooltip of ~180px inside the chart width. */
export const clampTooltip = (x, width, half = 90) => Math.min(Math.max(x, half), width - half);

/**
 * Screen-reader summary of a time series chart: per series its latest, min and max,
 * e.g. "Download: latest 4 Mbps, min 0 bps, max 9 Mbps". Series without data say so.
 */
export function seriesSummary(points, series, format = String) {
  return series
    .map((s) => {
      let latest = null;
      let min = Infinity;
      let max = -Infinity;
      for (const p of points) {
        const v = p[s.key];
        if (v == null || !Number.isFinite(v)) continue;
        latest = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return latest == null ? `${s.label}: no data` : `${s.label}: latest ${format(latest)}, min ${format(min)}, max ${format(max)}`;
    })
    .join('; ');
}
