import { useMemo, useRef } from 'react';
import { api } from '../api/client.js';
import { resolveRange, useAsync, useUrlFilters } from '../hooks/index.js';
import { useLive } from '../app/live.js';
import FilterBar from '../features/dashboard/FilterBar.jsx';
import Kpis from '../features/dashboard/Kpis.jsx';
import VolumeChart from '../features/dashboard/VolumeChart.jsx';
import SignalChart from '../features/cellular/SignalChart.jsx';
import Carriers from '../features/cellular/Carriers.jsx';
import LogTable from '../features/dashboard/LogTable.jsx';

export default function Dashboard() {
  const { status, now, live, ticks, toast } = useLive();
  const [filters, setFilters] = useUrlFilters();
  const searchRef = useRef(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const rangeKey = filters.range === 'custom' ? `${filters.from}-${filters.to}` : filters.range;
  const filterKey = JSON.stringify(filters);
  const range = useMemo(() => resolveRange(filters, Date.now()), [rangeKey, ticks.data, ticks.metrics]); // eslint-disable-line react-hooks/exhaustive-deps
  const query = useMemo(
    () => ({
      from: range.from,
      to: filters.range === 'custom' ? range.to : undefined,
      q: filters.q,
      source: filters.source,
      level: filters.level,
      facility: filters.facility,
    }),
    [range, filters],
  );
  const histogram = useAsync(() => api.histogram({ ...query, to: range.to }), [filterKey, ticks.data]);
  const facets = useAsync(() => api.facets(range), [rangeKey, ticks.data]);
  const metrics = useAsync(() => api.metrics(resolveRange(filtersRef.current, Date.now())), [rangeKey, ticks.metrics]);

  return (
    <>
      <FilterBar ref={searchRef} filters={filters} setFilters={setFilters} facets={facets.data} exportHref={api.exportUrl(query)} />
      <Kpis router={status?.collector.router} now={now} metrics={metrics.data} histogram={histogram.data} />
      <div className="charts">
        <VolumeChart data={histogram.data} loading={histogram.loading} onBrush={(from, to) => setFilters({ range: 'custom', from, to })} />
        <SignalChart metrics={metrics.data} range={range} signal={status?.collector.router?.signal} loading={metrics.loading} />
      </div>
      <Carriers ca={status?.collector.router?.carriers} />
      <LogTable
        query={query}
        filterKey={filterKey}
        refreshKey={ticks.data}
        live={live}
        setFilters={setFilters}
        toast={toast}
        searchRef={searchRef}
      />
    </>
  );
}
