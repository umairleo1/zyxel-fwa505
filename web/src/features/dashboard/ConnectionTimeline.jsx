import { useRef, useState } from 'react';
import { useElementWidth } from '../../hooks/index.js';
import { formatBps, formatBucket, formatDuration, formatFull, formatSpan, niceTicks, timeTicks } from '../../lib/format.js';
import { SERIES as SERIES_BY_ID } from '../../lib/domain.js';
import { MARKER_KINDS, OUTAGE_KINDS, UNMONITORED, clusterMarkers, focusWindow, spanAt, timelineSummary } from '../../lib/timeline.js';
import Tooltip from '../../components/charts/Tooltip.jsx';
import CoverageBands from '../../components/charts/CoverageBands.jsx';
import { clampTooltip, linePath, seriesSummary } from '../../components/charts/svg.js';

const SERIES = [
  { ...SERIES_BY_ID.download, key: 'rxBps' },
  { ...SERIES_BY_ID.upload, key: 'txBps' },
];
const M = { t: 10, r: 12, b: 24, l: 56 };
const LANE = 26; // marker row between the plot and the time axis
const BRUSH_MIN_PX = 6; // a shorter drag is a click, not a zoom
const MARKER_GAP_PX = 14;
const TIP_ITEMS = 4;
const OUTAGE_COLOR = { router: 'var(--critical)', wan: 'var(--warning)' };

/**
 * WAN throughput with outages shaded (router unreachable, or mobile data down) and
 * reboots / cell / band changes marked underneath, so a slowdown lines up with its
 * cause. Stretches Insight wasn't watching are hatched, so they don't read as calm.
 * Drag to zoom; a marker zooms to its moment (and with it the log table below).
 */
export default function ConnectionTimeline({ data, loading, onRange }) {
  const [ref, width] = useElementWidth();
  const [hoverT, setHoverT] = useState(null);
  const [active, setActive] = useState(null); // marker cluster key under the pointer or keyboard focus
  const [brush, setBrush] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const svgRef = useRef(null);

  const H = width && width < 560 ? 230 : 330;
  const from = data?.from;
  const to = data?.to;
  const points = data?.series ?? [];
  const outages = data?.outages ?? [];
  const markers = data?.markers ?? [];
  const unmonitored = data?.unmonitored ?? [];
  const summary = timelineSummary(data ?? undefined);
  const gapMs = Math.max(3 * (data?.bucketMs ?? 60e3), 5 * 60e3);

  const iw = Math.max(0, width - M.l - M.r);
  const ih = H - M.t - M.b - LANE;
  const laneY = M.t + ih + LANE / 2 + 2;
  const max = Math.max(0, ...points.flatMap((p) => SERIES.map((s) => p[s.key] ?? 0)));
  const yTicks = niceTicks(0, max || 1e6, 3);
  const yMax = yTicks.at(-1);
  const x = (t) => M.l + ((t - from) / (to - from || 1)) * iw;
  const y = (v) => M.t + ih - (v / yMax) * ih;
  const { ticks: xTicks, label: xLabel } = data ? timeTicks(from, to, Math.max(2, Math.floor(iw / 90))) : { ticks: [], label: () => '' };
  const clusters = data && iw ? clusterMarkers(markers, x, MARKER_GAP_PX) : [];
  const hasData = points.length > 0 || outages.length > 0 || markers.length > 0 || unmonitored.length > 0;

  const zoomTo = (a, b) => onRange(focusWindow(a, b, { from, to }));

  // Pointer → time, clamped to the plot.
  const tAt = (clientX) => {
    const r = svgRef.current.getBoundingClientRect();
    return Math.max(from, Math.min(to, from + ((clientX - r.left - M.l) / (iw || 1)) * (to - from)));
  };
  const nearest = (t) => {
    let best = null;
    for (const p of points) if (best == null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best && Math.abs(best.t - t) <= gapMs ? best.t : null;
  };
  const onPointerDown = (e) => {
    if (!data || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = tAt(e.clientX);
    setBrush({ a: t, b: t });
  };
  const onPointerMove = (e) => {
    if (!data) return;
    const t = tAt(e.clientX);
    setHoverT(t);
    if (brush) setBrush((b) => ({ ...b, b: t }));
  };
  const onPointerUp = () => {
    if (brush && Math.abs(x(brush.b) - x(brush.a)) >= BRUSH_MIN_PX)
      onRange({ from: Math.min(brush.a, brush.b), to: Math.max(brush.a, brush.b) });
    setBrush(null);
  };

  const hovering = hoverT != null && !brush && !active;
  const hoverOutage = hovering ? spanAt(outages, hoverT) : null;
  const hoverGap = hovering && !hoverOutage ? spanAt(unmonitored, hoverT) : null;
  // Not inside a not-monitored band: the nearest reading there is from outside it. (In an
  // outage it stays: the bucket at its edge is what the drop did to throughput.)
  const pointT = hovering && !hoverGap ? nearest(hoverT) : null;
  const hp = pointT != null ? points.find((p) => p.t === pointT) : null;
  const activeCluster = clusters.find((c) => c.key === active) ?? null;

  return (
    <section className="panel chart-panel" aria-label="Connection timeline">
      <header className="panel-head">
        <div>
          <h2>Connection</h2>
          <p className="panel-sub">{data ? `WAN throughput per ${formatBucket(data.bucketMs)} · drag to zoom` : ' '}</p>
        </div>
        <div className="panel-tools">
          <ul className="legend">
            {SERIES.map((s) => (
              <li key={s.key}>
                <span className="key-line" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost btn-sm" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            {asTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </header>

      {data && <Summary summary={summary} truncated={data.truncated} />}

      {asTable ? (
        <EventTable outages={outages} unmonitored={unmonitored} markers={markers} onShow={zoomTo} />
      ) : (
        <div className="chart" ref={ref} style={{ opacity: loading && data ? 0.6 : 1 }}>
          {width > 0 && data && (
            <svg
              ref={svgRef}
              width={width}
              height={H}
              className="chart-svg brushable"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => !brush && setHoverT(null)}
              role="group"
              aria-label={`Connection timeline. ${seriesSummary(points, SERIES, formatBps)}. ${describe(summary)}.`}
            >
              <CoverageBands unmonitored={unmonitored} x={x} left={M.l} right={M.l + iw} top={M.t} height={ih} />
              {outages.map((o) => (
                <g key={`${o.kind}-${o.start}`} className={`tl-outage-group is-${o.kind}${o.ongoing ? ' is-ongoing' : ''}`}>
                  <rect className="tl-outage" x={x(o.start)} y={M.t} width={Math.max(2, x(o.end) - x(o.start))} height={ih + LANE} />
                  {/* Solid edge so a short outage still reads on a long range. */}
                  <rect className="tl-outage-edge" x={x(o.start)} y={M.t} width={Math.max(3, x(o.end) - x(o.start))} height={3} rx="1" />
                </g>
              ))}
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={M.l} x2={M.l + iw} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-base' : 'grid'} />
                  <text x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                    {formatBps(t)}
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="tick">
                  {xLabel(t)}
                </text>
              ))}

              {SERIES.map((s) => (
                <path key={`a-${s.key}`} d={linePath(points, s.key, { x, y, gapMs, baseY: y(0) })} fill={s.color} opacity="0.1" />
              ))}
              {SERIES.map((s) => (
                <path
                  key={s.key}
                  d={linePath(points, s.key, { x, y, gapMs })}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}

              {/* Reboots always get a guide through the plot; other markers only while active. */}
              {clusters
                .filter((c) => c.kind === 'reboot' || c.key === active)
                .map((c) => (
                  <line
                    key={`g-${c.key}`}
                    x1={c.x}
                    x2={c.x}
                    y1={M.t}
                    y2={laneY - 7}
                    className={`tl-guide ${c.key === active ? 'is-active' : ''}`}
                  />
                ))}

              {hp && (
                <g>
                  <line x1={x(hp.t)} x2={x(hp.t)} y1={M.t} y2={M.t + ih} className="crosshair" />
                  {SERIES.map((s) =>
                    hp[s.key] == null ? null : (
                      <circle key={s.key} cx={x(hp.t)} cy={y(hp[s.key])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
                    ),
                  )}
                </g>
              )}

              {clusters.map((c) => (
                <g
                  key={c.key}
                  className={`tl-marker ${c.key === active ? 'is-active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${markerLabel(c)}. Zoom to this moment.`}
                  // Markers are click targets, not the start of a drag-to-zoom.
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerEnter={() => setActive(c.key)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(c.key)}
                  onBlur={() => setActive(null)}
                  onClick={() => zoomTo(c.from, c.to)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      zoomTo(c.from, c.to);
                    }
                  }}
                >
                  <rect x={c.x - 9} y={laneY - 10} width={18} height={20} className="tl-hit" />
                  <Glyph kind={c.kind} cx={c.x} cy={laneY} alert={c.alert} big />
                  {c.items.length > 1 && (
                    <text x={c.x + 7} y={laneY - 4} className="tl-count">
                      {c.items.length}
                    </text>
                  )}
                </g>
              ))}

              {brush && (
                <rect
                  className="brush"
                  x={Math.min(x(brush.a), x(brush.b))}
                  y={M.t}
                  width={Math.abs(x(brush.b) - x(brush.a))}
                  height={ih}
                />
              )}
            </svg>
          )}

          {activeCluster && <MarkerTip cluster={activeCluster} left={clampTooltip(activeCluster.x, width, 140)} top={laneY - 14} />}
          {!activeCluster && (hp || hoverOutage || hoverGap) && (
            <Tooltip
              left={clampTooltip(hp ? x(hp.t) : x(hoverT), width)}
              top={4}
              title={hp ? formatSpan(hp.t, hp.t + data.bucketMs) : formatFull(hoverT)}
              rows={[
                ...(hp ? SERIES.map((s) => ({ key: s.key, color: s.color, value: formatBps(hp[s.key]), label: s.label })) : []),
                ...(hoverOutage ? [{ key: 'outage', color: OUTAGE_COLOR[hoverOutage.kind], ...spanRow(hoverOutage) }] : []),
                ...(hoverGap
                  ? [
                      {
                        key: 'gap',
                        color: 'var(--muted)',
                        value: formatDuration((hoverGap.end - hoverGap.start) / 1000),
                        label: UNMONITORED.label,
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {(!data || !hasData) && (
            <div className={data ? 'chart-empty' : 'chart-empty static'} style={data ? { bottom: M.b + LANE } : { minHeight: H }}>
              {data
                ? 'No throughput samples in this range yet — they start about a minute after Insight starts.'
                : loading
                  ? 'Loading…'
                  : ' '}
            </div>
          )}
        </div>
      )}
      {!asTable && data && hasData && (
        <ul className="legend tl-key" aria-label="Key">
          {Object.entries(OUTAGE_KINDS).map(([kind, k]) => (
            <li key={kind} title={k.detail}>
              <span className={`swatch tl-swatch-outage is-${kind}`} />
              {k.label}
            </li>
          ))}
          <li title={UNMONITORED.detail}>
            <span className="swatch cov-swatch" />
            {UNMONITORED.label}
          </li>
          {Object.entries(MARKER_KINDS).map(([kind, k]) => (
            <li key={kind}>
              <svg width="10" height="10" aria-hidden="true">
                <Glyph kind={kind} cx={5} cy={5} />
              </svg>
              {k.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Marker glyph: diamond for reboots, circle for cell changes, square for band changes. */
function Glyph({ kind, cx, cy, alert = kind === 'reboot', big = false }) {
  const r = big ? 5 : 4;
  if (kind === 'reboot') {
    return (
      <path
        d={`M${cx},${cy - r - 1}L${cx + r + 1},${cy}L${cx},${cy + r + 1}L${cx - r - 1},${cy}Z`}
        className={`tl-glyph tl-reboot ${alert ? 'is-alert' : ''}`}
      />
    );
  }
  if (kind === 'combo')
    return <rect x={cx - r + 0.5} y={cy - r + 0.5} width={2 * r - 1} height={2 * r - 1} rx="1.5" className="tl-glyph tl-combo" />;
  return <circle cx={cx} cy={cy} r={r} className="tl-glyph tl-cell" />;
}

function MarkerTip({ cluster, left, top }) {
  const shown = cluster.items.slice(-TIP_ITEMS).reverse();
  const more = cluster.items.length - shown.length;
  return (
    <div className="tooltip tl-tip" style={{ left, top }} role="status">
      <div className="tooltip-title">{cluster.from === cluster.to ? formatFull(cluster.from) : formatSpan(cluster.from, cluster.to)}</div>
      <ul>
        {shown.map((m) => (
          <li key={`${m.ts}-${m.kind}-${m.message}`}>
            <b>{MARKER_KINDS[m.kind]?.label ?? m.kind}</b>
            {cluster.items.length > 1 && <span className="muted"> · {formatFull(m.ts)}</span>}
            <span className="tl-tip-msg">{m.message}</span>
          </li>
        ))}
      </ul>
      {more > 0 && <div className="muted">+{more} earlier</div>}
      <div className="tl-tip-hint">Click to zoom in and see the logs</div>
    </div>
  );
}

/** Tooltip value and label for an outage: its length, what was down and why. */
function spanRow(o) {
  const why = o.reason ? ` (${o.reason})` : '';
  return {
    value: formatDuration((o.end - o.start) / 1000),
    label: `${OUTAGE_KINDS[o.kind]?.label ?? 'Outage'}${why}${o.ongoing ? ' · ongoing' : ''}`,
  };
}

const plural = (n, k) => (n === 1 ? k.one : k.many);

function Summary({ summary, truncated }) {
  const { outages, byKind, downSec, ongoing, unmonitoredSec, counts } = summary;
  return (
    <ul className="tl-summary" aria-label="In this range">
      {outages ? (
        <>
          {Object.entries(OUTAGE_KINDS).map(([kind, k]) =>
            byKind[kind] ? (
              <li key={kind} className={kind === 'wan' ? 'tone-warning' : 'tone-critical'}>
                <b>{byKind[kind]}</b> {plural(byKind[kind], k)}
              </li>
            ) : null,
          )}
          <li className={byKind.router ? 'tone-critical' : 'tone-warning'}>
            <b>{formatDuration(downSec)}</b> down{ongoing && ' · ongoing'}
          </li>
        </>
      ) : (
        <li className="tone-good">No outages</li>
      )}
      {Object.entries(MARKER_KINDS).map(([kind, k]) =>
        counts[kind] ? (
          <li key={kind}>
            <b>{counts[kind]}</b> {counts[kind] === 1 ? k.label.toLowerCase() : k.plural}
          </li>
        ) : null,
      )}
      {unmonitoredSec > 0 && (
        <li className="muted" title={UNMONITORED.detail}>
          <b>{formatDuration(unmonitoredSec)}</b> not monitored
        </li>
      )}
      {truncated && <li className="muted">Showing the latest events only</li>}
    </ul>
  );
}

function EventTable({ outages, unmonitored, markers, onShow }) {
  const rows = [
    ...outages.map((o) => ({
      key: `o-${o.kind}-${o.start}`,
      from: o.start,
      to: o.end,
      what: OUTAGE_KINDS[o.kind]?.label ?? 'Outage',
      detail: `${OUTAGE_KINDS[o.kind]?.detail ?? 'Down'} for ${formatDuration((o.end - o.start) / 1000)}${o.reason ? ` (${o.reason})` : ''}${o.ongoing ? ', still ongoing' : ''}`,
    })),
    ...unmonitored.map((g) => ({
      key: `u-${g.start}`,
      from: g.start,
      to: g.end,
      what: UNMONITORED.label,
      detail: `${UNMONITORED.detail} (${formatDuration((g.end - g.start) / 1000)})`,
    })),
    ...markers.map((m) => ({
      key: `m-${m.ts}-${m.kind}-${m.message}`,
      from: m.ts,
      to: m.ts,
      what: MARKER_KINDS[m.kind]?.label ?? m.kind,
      detail: m.message,
    })),
  ].sort((a, b) => b.from - a.from);

  if (!rows.length) return <p className="empty-inline panel-body">No outages, gaps, reboots or cell changes in this range.</p>;
  return (
    <div className="mini-table-wrap">
      <table className="mini-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>Detail</th>
            <th aria-label="Logs" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.from === r.to ? formatFull(r.from) : formatSpan(r.from, r.to)}</td>
              <td>{r.what}</td>
              <td className="tl-detail">{r.detail}</td>
              <td className="num">
                <button className="btn btn-ghost btn-sm" onClick={() => onShow(r.from, r.to)}>
                  Logs
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function markerLabel(c) {
  const when = c.from === c.to ? formatFull(c.from) : formatSpan(c.from, c.to);
  if (c.items.length === 1) return `${MARKER_KINDS[c.kind]?.label ?? c.kind} at ${when}: ${c.items[0].message}`;
  return `${c.items.length} events at ${when}`;
}

function describe({ outages, byKind, downSec, unmonitoredSec, counts }) {
  const parts = outages
    ? [
        ...Object.entries(OUTAGE_KINDS)
          .filter(([kind]) => byKind[kind])
          .map(([kind, k]) => `${byKind[kind]} ${plural(byKind[kind], k)}`),
        `${formatDuration(downSec)} down`,
      ]
    : ['no outages'];
  if (unmonitoredSec) parts.push(`${formatDuration(unmonitoredSec)} not monitored`);
  for (const [kind, k] of Object.entries(MARKER_KINDS)) if (counts[kind]) parts.push(`${counts[kind]} ${k.plural}`);
  return parts.join(', ');
}
