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
