import { qualityTone } from '../../lib/domain.js';
import { StatusIcon } from './Icons.jsx';

/** "⚠ Fair" style badge for any quality word (signal, Wi-Fi). Never colour alone: icon + text. */
export function QualityBadge({ label, size = 13 }) {
  if (!label) return null;
  const tone = qualityTone(label);
  return (
    <span className={`quality quality-${tone}`}>
      <StatusIcon tone={tone} size={size} />
      {label}
    </span>
  );
}

/** Signal bars (`n` of `max` lit), tinted by how many are lit. */
export function Bars({ n, max = 5 }) {
  const ratio = n / max;
  const tone = ratio >= 0.75 ? 'good' : ratio >= 0.5 ? 'warning' : 'critical';
  return (
    <span className={`bars bars-${tone}`} aria-hidden="true">
      {Array.from({ length: max }, (_, i) => (
        <i key={i} className={i < n ? 'on' : ''} style={{ height: 3 + (i + 1) * (12 / max) }} />
      ))}
    </span>
  );
}

/** A reading such as "−104 dBm ⚠ Fair". */
export function Reading({ value, unit, quality, format = (v) => String(v).replace('-', '−') }) {
  if (value == null) return <span className="muted">—</span>;
  return (
    <span className="reading" title={quality ?? ''}>
      <b>{format(value)}</b>
      <span className="muted"> {unit}</span>
      {quality && (
        <span className="reading-q">
          <QualityBadge label={quality} size={12} />
        </span>
      )}
    </span>
  );
}
