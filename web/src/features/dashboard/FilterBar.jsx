import { forwardRef, useEffect, useState } from 'react';
import { formatSpan } from '../../lib/format.js';
import { LEVELS, RANGES, SOURCE_LABELS, levelGroup, SEVERITY_SERIES } from '../../lib/domain.js';
import MultiSelect from '../../components/ui/MultiSelect.jsx';
import { Download, Search, X } from '../../components/ui/Icons.jsx';

const sevColor = Object.fromEntries(SEVERITY_SERIES.map((s) => [s.key, s.color]));

const FilterBar = forwardRef(function FilterBar({ filters, setFilters, facets, exportHref }, searchRef) {
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => q !== filters.q && setFilters({ q }), 250);
    return () => clearTimeout(t);
  }, [q, filters.q, setFilters]);

  const count = (list, v) => list?.find((x) => x.value === v)?.count ?? 0;
  const sourceOpts = Object.keys(SOURCE_LABELS).map((v) => ({ value: v, label: SOURCE_LABELS[v], count: count(facets?.sources, v) }));
  const levelOpts = LEVELS.filter((l) => count(facets?.levels, l) || filters.level.includes(l)).map((l) => ({
    value: l,
    count: count(facets?.levels, l),
    swatch: sevColor[levelGroup(l)],
  }));
  const facilityOpts = (facets?.facilities ?? []).map((f) => ({ value: f.value, count: f.count }));
  const active = filters.q || filters.source.length || filters.level.length || filters.facility.length;

  return (
    <div className="filterbar" role="search">
      <div className="seg" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={filters.range === r.key ? 'on' : ''}
            aria-pressed={filters.range === r.key}
            onClick={() => setFilters({ range: r.key, from: null, to: null })}
          >
            {r.label}
          </button>
        ))}
      </div>
      {filters.range === 'custom' && (
        <span className="chip-custom">
          {formatSpan(filters.from, filters.to)}
          <button aria-label="Clear custom range" onClick={() => setFilters({ range: '24h', from: null, to: null })}>
            <X size={12} />
          </button>
        </span>
      )}

      <label className="search">
        <Search size={15} />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search messages"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search messages"
        />
        {!q && <kbd>/</kbd>}
      </label>

      <MultiSelect label="Source" options={sourceOpts} selected={filters.source} onChange={(source) => setFilters({ source })} />
      <MultiSelect label="Level" options={levelOpts} selected={filters.level} onChange={(level) => setFilters({ level })} />
      <MultiSelect label="Facility" options={facilityOpts} selected={filters.facility} onChange={(facility) => setFilters({ facility })} />
      {active ? (
        <button className="btn btn-ghost" onClick={() => setFilters({ q: '', source: [], level: [], facility: [] })}>
          Reset
        </button>
      ) : null}

      <a className="btn filterbar-export" href={exportHref} download>
        <Download /> Export CSV
      </a>
    </div>
  );
});

export default FilterBar;
