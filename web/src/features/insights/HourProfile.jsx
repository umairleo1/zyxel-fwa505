import { useState } from 'react';
import { formatBps, formatSigned } from '../../lib/format.js';

const ROWS = [
  { key: 'nrSinr', label: '5G quality', unit: 'dB SINR', format: (v) => `${formatSigned(v)} dB` },
  { key: 'lteSinr', label: 'LTE quality', unit: 'dB SINR', format: (v) => `${formatSigned(v)} dB` },
  { key: 'avgDownBps', label: 'Avg download', format: formatBps },
  { key: 'peakDownBps', label: 'Peak download', format: formatBps },
];
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * The period folded onto one day: per local hour, signal quality and download.
 * Each row is shaded on its own scale (stronger colour = higher). Hours seen on too few days
 * to compare are faded. Hover or focus a cell to read its values.
 */
export default function HourProfile({ hourly }) {
  const [hour, setHour] = useState(null);
  if (!hourly?.some((h) => h.samples > 0))
    return <p className="empty-inline">Builds up as Insight collects; a few days give a useful picture.</p>;

  const rows = ROWS.filter((r) => hourly.some((h) => h[r.key] != null));
  const scale = Object.fromEntries(
    rows.map((r) => {
      const vs = hourly.map((h) => h[r.key]).filter((v) => v != null);
      return [r.key, [Math.min(...vs), Math.max(...vs)]];
    }),
  );
  const shade = (key, v) => {
    if (v == null) return null;
    const [lo, hi] = scale[key];
    return Math.round(15 + (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * 70); // 15–85 % accent
  };
  const h = hour != null ? hourly[hour] : null;

  return (
    <div className="hours">
      <table className="hours-grid" onPointerLeave={() => setHour(null)}>
        <thead>
          <tr>
            <th className="hours-label" />
            {hourly.map((x) => (
              <th key={x.hour} scope="col" className={x.hour % 6 ? 'hours-tick' : 'hours-tick is-major'}>
                {x.hour % 6 ? '' : hh(x.hour)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="hours-label">
                {r.label}
              </th>
              {hourly.map((x) => {
                const pct = shade(r.key, x[r.key]);
                return (
                  <td
                    key={x.hour}
                    tabIndex={0}
                    className={`hours-cell${x.reliable ? '' : ' is-thin'}${hour === x.hour ? ' is-active' : ''}`}
                    style={pct == null ? undefined : { '--shade': `${pct}%` }}
                    aria-label={`${hh(x.hour)}, ${r.label}: ${x[r.key] == null ? 'no data' : r.format(x[r.key])}`}
                    onPointerEnter={() => setHour(x.hour)}
                    onFocus={() => setHour(x.hour)}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hours-readout" aria-live="polite">
        {h ? (
          <>
            <b>
              {hh(h.hour)}–{hh((h.hour + 1) % 24)}
            </b>
            {rows.map((r) => (
              <span key={r.key}>
                {r.label} <b>{h[r.key] == null ? '—' : r.format(h[r.key])}</b>
              </span>
            ))}
            <span className="muted">
              seen on {h.days} day{h.days === 1 ? '' : 's'}
              {!h.reliable && ', too few to compare'}
            </span>
          </>
        ) : (
          <span className="muted">
            Stronger colour = higher, per row. Faded hours were seen on fewer than 3 days. Hover an hour for values.
          </span>
        )}
      </p>
    </div>
  );
}
