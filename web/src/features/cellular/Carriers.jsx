import { SERIES, rsrpQuality, sinrQuality } from '../../lib/domain.js';
import { Reading } from '../../components/ui/Quality.jsx';

const ROLE = {
  primary: (c) => (c.rat === 'NR' ? '5G primary' : 'LTE primary'),
  secondary: (c) => (c.rat === 'NR' ? '5G secondary' : 'LTE secondary'),
  'nr-anchor': () => '5G NSA leg',
};
const color = (c) => (c.rat === 'NR' ? SERIES.nr.color : SERIES.lte.color);

export default function Carriers({ ca }) {
  if (!ca?.carriers?.length) return null;
  const { carriers, combo, totalBandwidth } = ca;
  const sized = carriers.filter((c) => c.bandwidth);
  const lte = carriers.filter((c) => c.rat === 'LTE').length;
  const nr = carriers.length - lte;

  return (
    <section className="panel" aria-label="Active carriers">
      <header className="panel-head">
        <div>
          <h2>Carriers</h2>
          <p className="panel-sub">
            {lte > 1 ? `${lte}CA LTE` : 'LTE'}
            {nr ? ` + ${nr > 1 ? `${nr}CA ` : ''}5G NR` : ''} · {carriers.length} carrier{carriers.length > 1 ? 's' : ''}
          </p>
        </div>
        <div className="combo">
          <span className="combo-label">Combination</span>
          <span className="combo-value">{combo ?? '—'}</span>
          {totalBandwidth && <span className="combo-bw">{totalBandwidth} MHz</span>}
        </div>
      </header>

      {sized.length > 0 && (
        <div className="bw-bar-wrap">
          <div
            className="bw-bar"
            role="img"
            aria-label={`Bandwidth by carrier: ${sized.map((c) => `${c.band} ${c.bandwidth} MHz`).join(', ')}`}
          >
            {sized.map((c, i) => (
              <div
                key={i}
                className="bw-seg"
                style={{ flexGrow: c.bandwidth, background: color(c) }}
                title={`${c.band} · ${c.bandwidth} MHz · ${ROLE[c.role](c)}`}
              >
                {/* Label only when the segment has room; the table always carries the value. */}
                {c.bandwidth / totalBandwidth >= 0.1 && (
                  <span className="bw-seg-label" style={{ color: c.rat === 'NR' ? '#0b0b0b' : '#fff' }}>
                    {c.band} · {c.bandwidth} MHz
                  </span>
                )}
              </div>
            ))}
          </div>
          <ul className="legend bw-legend">
            <li>
              <span className="swatch" style={{ background: SERIES.lte.color }} />
              LTE
            </li>
            <li>
              <span className="swatch" style={{ background: SERIES.nr.color }} />
              5G NR
            </li>
            <li className="muted">Width = channel bandwidth (MHz)</li>
          </ul>
        </div>
      )}

      <div className="table-wrap carriers-wrap">
        <table className="log-table carriers-table">
          <thead>
            <tr>
              <th>Carrier</th>
              <th>Band</th>
              <th className="num">Bandwidth</th>
              <th className="num">PCI</th>
              <th className="num">Channel</th>
              <th>RSRP</th>
              <th>RSRQ</th>
              <th>SINR</th>
            </tr>
          </thead>
          <tbody>
            {carriers.map((c, i) => (
              <tr key={i}>
                <td className="nowrap">
                  <span className="key-rect" style={{ background: color(c) }} aria-hidden="true" /> {ROLE[c.role](c)}
                </td>
                <td>
                  <span className="band-chip">{c.band ?? '—'}</span>
                </td>
                <td className="num">{c.bandwidth ? `${c.bandwidth} MHz` : '—'}</td>
                <td className="num mono">{c.pci ?? '—'}</td>
                <td className="num mono">{c.channel ?? '—'}</td>
                <td>
                  <Reading value={c.rsrp} unit="dBm" quality={rsrpQuality(c.rsrp)} />
                </td>
                <td>
                  <Reading value={c.rsrq} unit="dB" />
                </td>
                <td>
                  <Reading value={c.sinr} unit="dB" quality={sinrQuality(c.sinr)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
