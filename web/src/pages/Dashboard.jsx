import { useMemo, useRef } from 'react';
import { api } from '../api/client.js';
import { resolveRange, useAsync, useUrlFilters } from '../hooks/index.js';
import { PageLoader } from '../components/ui/index.js';
import { useLive } from '../app/live.js';
import FilterBar from '../features/dashboard/FilterBar.jsx';
import Kpis from '../features/dashboard/Kpis.jsx';
import ConnectionTimeline from '../features/dashboard/ConnectionTimeline.jsx';
import SignalChart from '../features/cellular/SignalChart.jsx';
import Carriers from '../features/cellular/Carriers.jsx';
import LogTable from '../features/dashboard/LogTable.jsx';

export default function Dashboard() {
  const { status, live, ticks, toast } = useLive();
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
  // Throughput arrives with traffic samples; outages, reboots and cell changes are logged as events.
  const timeline = useAsync(() => api.timeline(resolveRange(filtersRef.current, Date.now())), [rangeKey, ticks.traffic, ticks.data]);
  const zoom = ({ from, to }) => setFilters({ range: 'custom', from: Math.round(from), to: Math.round(to) });

  return (
    <>
      {!histogram.data && histogram.loading && <PageLoader />}
      <FilterBar ref={searchRef} filters={filters} setFilters={setFilters} facets={facets.data} exportHref={api.exportUrl(query)} />
      <Kpis router={status?.collector.router} metrics={metrics.data} histogram={histogram.data} />
      <div className="charts">
        <ConnectionTimeline data={timeline.data} loading={timeline.loading} onRange={zoom} />
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
