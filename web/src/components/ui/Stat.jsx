export function Stat({ label, value, unit, sub, tone, children }) {
  return (
    <section className={`tile ${tone ? `tile-${tone}` : ''}`}>
      <h3 className="tile-label">{label}</h3>
      <p className="tile-value">
        {value ?? '—'}
        {unit && <span className="unit">{unit}</span>}
      </p>
      {sub && <p className="tile-sub">{sub}</p>}
      {children}
    </section>
  );
}
