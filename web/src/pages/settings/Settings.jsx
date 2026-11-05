import { useState } from 'react';
import { useRouterData } from '../../hooks/index.js';
import { DataTable, KV, PageHeader, SourceNote, ErrorNote, PageLoader } from '../../components/ui/index.js';
import { isEmpty } from '../../lib/labels.js';
import { SETTINGS } from './definitions.js';
import { ChevronDown } from '../../components/ui/Icons.jsx';

const hasContent = (rows) => Array.isArray(rows) && rows.some((r) => r && Object.values(r).some((v) => !isEmpty(v)));

function Section({ def, data, error }) {
  const [raw, setRaw] = useState(false);
  const rows = def.pick ? def.pick(data) : data;
  const list = Array.isArray(rows) ? rows.filter(Boolean) : rows ? [rows] : [];
  const kind = def.kind ?? (list.length === 1 && !def.fields ? 'kv' : 'table');
  return (
    <section className="panel settings-section" id={def.id}>
      <header className="panel-head">
        <div>
          <h2>{def.title}</h2>
          <p className="panel-sub mono">{def.id}</p>
        </div>
        <div className="panel-tools">
          <button className="btn btn-ghost btn-sm" onClick={() => setRaw((r) => !r)} aria-pressed={raw}>
            {raw ? 'Formatted' : 'Raw JSON'}
          </button>
        </div>
      </header>
      <div className="panel-body">
        {error ? (
          <p className="error-text">{error}</p>
        ) : raw ? (
          <pre className="raw-json">{JSON.stringify(rows, null, 2)}</pre>
        ) : kind === 'kv' ? (
          <KV obj={list[0]} />
        ) : (
          <DataTable
            rows={list}
            columns={def.fields?.filter((f) => list.some((r) => f in r)).map((key) => ({ key }))}
            search={list.length > 8}
          />
        )}
      </div>
    </section>
  );
}

export default function Settings({ pageId }) {
  const key = pageId.split('/')[1];
  const page = SETTINGS[key];
  const ids = page ? page.sections.map((s) => s.id) : [];
  const r = useRouterData(ids);
  const [showUnused, setShowUnused] = useState(false);
  if (!page) return <p>Unknown page</p>;

  const sections = page.sections.map((def) => {
    const entry = r.raw[def.id];
    const rows = entry?.data ? (def.pick ? def.pick(entry.data) : entry.data) : null;
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    return { def, data: entry?.data, error: entry?.error, used: !!entry?.error || hasContent(list) };
  });
  const used = sections.filter((s) => s.used);
  const unused = sections.filter((s) => !s.used && r.data);

  return (
    <div className="page">
      {!r.data && r.loading && <PageLoader />}
      <PageHeader title={page.title} subtitle={page.intro}>
        <SourceNote fetchedAt={r.fetchedAt} stale={r.stale} onRefresh={r.reload} loading={r.loading} />
      </PageHeader>
      <div className="readonly-note">Read-only view. Change these settings in the router’s admin page.</div>
      <ErrorNote error={r.error} />
      {used.length > 0 && (
        <nav className="toc" aria-label="Sections">
          {used.map((s) => (
            <a
              key={s.def.id}
              href={`#${s.def.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.def.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {s.def.title}
            </a>
          ))}
        </nav>
      )}
      <div className="settings-grid">
        {used.map((s) => (
          <Section key={s.def.id} def={s.def} data={s.data} error={s.error} />
        ))}
      </div>
      {unused.length > 0 && (
        <section className="panel unused">
          <button className="unused-head" onClick={() => setShowUnused((v) => !v)} aria-expanded={showUnused}>
            <span>
              <b>Not configured</b> <span className="muted">· {unused.map((s) => s.def.title).join(', ')}</span>
            </span>
            <ChevronDown size={16} />
          </button>
          {showUnused && (
            <div className="settings-grid unused-body">
              {unused.map((s) => (
                <Section key={s.def.id} def={s.def} data={s.data} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
