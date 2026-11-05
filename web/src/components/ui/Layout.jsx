export function PageHeader({ title, subtitle, children }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

const DOTS = Array.from({ length: 12 }, (_, i) => i);

// Fills the content area with a centred spinner until a page's first data arrives.
export function PageLoader() {
  return (
    <div className="page-loading" role="status" aria-busy="true" aria-label="Loading">
      <span className="dot-spinner">
        {DOTS.map((i) => (
          <span key={i} style={{ '--i': i }} />
        ))}
      </span>
    </div>
  );
}

export function Panel({ title, subtitle, actions, children, className = '', flush = false }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel-tools">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'panel-body'}>{children}</div>
    </section>
  );
}
