// Geometry helpers shared by the SVG charts.

/** Bar path with rounded top corners (radius r) and a square base. */
export function topRounded(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Gap between stacked segments, in px. */
export const SEGMENT_GAP = 2;

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
