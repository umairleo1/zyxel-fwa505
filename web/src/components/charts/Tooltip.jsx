/**
 * Chart tooltip. rows: [{ key, color, value, label }]; `mark` draws a line key
 * (for line charts) or a square key (for bars). Value leads, label follows.
 * `note` adds a muted line under the rows.
 */
export default function Tooltip({ left, top = 0, title, rows, mark = 'line', note = null }) {
  return (
    <div className="tooltip" style={{ left, top }} role="status">
      <div className="tooltip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="tooltip-row">
          <span className={mark === 'line' ? 'key-line' : 'key-rect'} style={{ background: r.color }} />
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
      {note && <div className="tooltip-note">{note}</div>}
    </div>
  );
}
