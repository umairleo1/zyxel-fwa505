import { wifiQuality } from '../../lib/domain.js';
import { Bars } from './Quality.jsx';

const BARS = { Excellent: 4, Good: 3, Fair: 2, Poor: 1 };

/** Wi-Fi RSSI as 4 bars + number; the quality word is in the tooltip and accessible label. */
export default function SignalBars({ rssi, showValue = true }) {
  if (rssi == null) return <span className="muted">—</span>;
  const q = wifiQuality(rssi);
  return (
    <span className="sigbars" title={`${q} (${rssi} dBm)`} aria-label={`${q}, ${rssi} dBm`}>
      <Bars n={BARS[q]} max={4} />
      {showValue && <span className="num-val">{String(rssi).replace('-', '−')}</span>}
    </span>
  );
}
