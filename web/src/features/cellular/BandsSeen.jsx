import { BAND_FREQ, rsrpQuality, sinrQuality } from '../../lib/domain.js';
import { formatDayMonth, formatDuration, formatFull, formatHM } from '../../lib/format.js';
import { DataTable, Panel, Reading } from '../../components/ui/index.js';

// Fixed band order (4G before 5G, then by band number), so rows don't swap as the totals change.
const bandRank = (band) => (band.startsWith('n') ? 1000 : 0) + Number(band.slice(1));

// A clock time rather than "4m 12s ago": it doesn't change width on every re-render.
const seenAt = (ts) => (new Date(ts).toDateString() === new Date().toDateString() ? formatHM(ts) : `${formatDayMonth(ts)} ${formatHM(ts)}`);

// Whole minutes, so the live session length only changes width once a minute.
const minutes = (sec) => (sec < 60 ? '<1m' : sec < 3600 ? `${Math.floor(sec / 60)}m` : formatDuration(sec));

const cellList = (cells) => cells.map((c) => (c.channel != null ? `${c.pci} (ch ${c.channel})` : String(c.pci))).join(', ');

/**
 * Every band the router has connected on, so far. The router only reports the
 * carriers in use right now; anything listed here is broadcast near you.
 */
export default function BandsSeen({ bands, active, loading }) {
  const now = Date.now();
  const inUse = (b) => active.has(b.band.toUpperCase());
  // In-use bands first; the rest by when they were last used (fixed once a band is left).
  const rows = [...(bands ?? [])].sort(
    (a, b) => inUse(b) - inUse(a) || (inUse(a) ? 0 : b.lastSeen - a.lastSeen) || bandRank(a.band) - bandRank(b.band),
  );
  return (
    <Panel
      title="Bands seen here"
      subtitle={`Every band the router has used since Insight started recording · ${rows.length} band${rows.length === 1 ? '' : 's'}`}
      flush
    >
      <DataTable
        rows={rows}
        rowKey={(b) => b.band}
        empty={loading ? 'Loading…' : 'No bands recorded yet. They appear after the first status read.'}
        columns={[
          {
            key: 'band',
            label: 'Band',
            render: (b) => (
              <span className="nowrap">
                <span className={`band-chip ${inUse(b) ? 'is-active' : ''}`}>{b.band}</span>{' '}
                <span className="muted small">{b.rat === 'NR' ? '5G' : '4G'}</span>
              </span>
            ),
          },
          { key: 'freq', label: 'Frequency', render: (b) => <span className="nowrap">{BAND_FREQ[b.band] ?? '—'}</span> },
          {
            key: 'lastSeen',
            label: 'Last seen',
            render: (b) =>
              inUse(b) ? (
                <b>In use now</b>
              ) : (
                <span className="nowrap" title={formatFull(b.lastSeen)}>
                  {seenAt(b.lastSeen)}
                </span>
              ),
          },
          {
            key: 'session',
            label: 'This session',
            align: 'right',
            render: (b) => (
              <span
                className="nowrap"
                title={`Total on this band: ${formatDuration(b.seconds)} (as primary / 5G anchor: ${formatDuration(b.primarySeconds)})`}
              >
                {b.runStart == null ? '—' : inUse(b) ? minutes((now - b.runStart) / 1000) : `ended after ${minutes(b.lastRunSeconds)}`}
              </span>
            ),
          },
          {
            key: 'bestRsrp',
            label: 'Strongest RSRP',
            render: (b) => <Reading value={b.bestRsrp} unit="dBm" quality={rsrpQuality(b.bestRsrp)} />,
          },
          {
            key: 'avgSinr',
            label: 'Avg SINR',
            render: (b) => <Reading value={b.avgSinr} unit="dB" quality={sinrQuality(b.avgSinr)} />,
          },
          { key: 'maxBandwidth', label: 'Width', align: 'right', render: (b) => (b.maxBandwidth ? `${b.maxBandwidth} MHz` : '—') },
          {
            key: 'cells',
            label: 'Cells (PCI)',
            render: (b) => (b.cells.length ? <span className="mono small">{cellList(b.cells)}</span> : <span className="muted">—</span>),
          },
        ]}
      />
      <div className="panel-body">
        <p className="tile-sub">
          Signal for older history covers the primary carrier only. Bands the masts broadcast but the router has never used do not appear
          here; a network scan in the router&apos;s admin page would find them, at the cost of dropping the connection.
        </p>
      </div>
    </Panel>
  );
}
