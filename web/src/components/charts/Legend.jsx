/** Series legend; `kind` mirrors the mark (line for lines, swatch for bars/areas). */
export default function Legend({ series, kind = 'line' }) {
  return (
    <ul className="legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className={kind === 'line' ? 'key-line' : 'swatch'} style={{ background: s.color }} />
          {s.label}
          {s.note && <span className="muted"> {s.note}</span>}
        </li>
      ))}
    </ul>
  );
}
