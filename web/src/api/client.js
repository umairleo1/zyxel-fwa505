// The only module that knows the Insight HTTP API's URLs.

/** GET/POST JSON; throws an Error carrying the server's message on non-2xx. */
async function request(url, opts = {}) {
  const method = (opts.method ?? 'GET').toUpperCase();
  // The server rejects state-changing requests without this header. A cross-site form
  // or simple fetch can't set a custom header without a CORS preflight, so it blocks CSRF.
  if (method !== 'GET' && method !== 'HEAD') opts = { ...opts, headers: { ...opts.headers, 'X-Insight-Request': '1' } };
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

/** Query string from an object; arrays are comma-joined, empty values dropped. */
function qs(obj = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    const s = Array.isArray(v) ? v.join(',') : v;
    if (s !== undefined && s !== null && s !== '' && s !== false) p.set(k, s);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // Live status & control
  status: () => request('/api/status'),
  collector: (action) => request(`/api/collector/${action}`, { method: 'POST' }),

  // Event log
  logs: (query, cursor, limit = 200) => request(`/api/logs${qs({ ...query, cursor, limit })}`),
  histogram: (query) => request(`/api/histogram${qs(query)}`),
  facets: ({ from, to }) => request(`/api/facets${qs({ from, to })}`),
  exportUrl: (query) => `/api/export.csv${qs(query)}`,

  // Collected time series
  metrics: ({ from, to }) => request(`/api/metrics${qs({ from, to })}`),
  traffic: ({ from, to }) => request(`/api/traffic${qs({ from, to })}`),
  system: ({ from, to }) => request(`/api/system${qs({ from, to })}`),
  bands: () => request('/api/bands'),
  devices: () => request('/api/devices'),
  device: (mac, { from } = {}) => request(`/api/devices/${encodeURIComponent(mac)}${qs({ from })}`),
  insights: ({ from, fresh }) => request(`/api/insights${qs({ from, fresh })}`),

  // Read-only router endpoints (allowlisted on the server)
  router: (ids, { fresh } = {}) => request(`/api/router${qs({ ids, fresh })}`),
};
