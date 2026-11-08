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

const controlRequest = (path, method = 'POST', body) =>
  request(`/api/control${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });

async function controlDownload(kind) {
  const res = await fetch(`/api/control/backup/${encodeURIComponent(kind)}`, { method: 'POST', headers: { 'X-Insight-Request': '1' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Backup failed: ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('The router returned an empty backup.');
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = (/filename="?([^";]+)"?/.exec(disposition)?.[1] ?? `zyxel-${kind}-backup.conf`).replace(/[/\\\r\n]/g, '_');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { filename };
}

export const api = {
  // Live status & control
  status: () => request('/api/status'),
  collector: (action) => request(`/api/collector/${action}`, { method: 'POST' }),
  restartRouter: () => request('/api/router/reboot', { method: 'POST' }),

  // Event log
  logs: (query, cursor, limit = 200) => request(`/api/logs${qs({ ...query, cursor, limit })}`),
  histogram: (query) => request(`/api/histogram${qs(query)}`),
  facets: ({ from, to }) => request(`/api/facets${qs({ from, to })}`),
  exportUrl: (query) => `/api/export.csv${qs(query)}`,

  // Collected time series
  metrics: ({ from, to }) => request(`/api/metrics${qs({ from, to })}`),
  traffic: ({ from, to }) => request(`/api/traffic${qs({ from, to })}`),
  timeline: ({ from, to }) => request(`/api/timeline${qs({ from, to })}`),
  system: ({ from, to }) => request(`/api/system${qs({ from, to })}`),
  bands: () => request('/api/bands'),
  devices: () => request('/api/devices'),
  device: (mac, { from } = {}) => request(`/api/devices/${encodeURIComponent(mac)}${qs({ from })}`),
  insights: ({ from, fresh }) => request(`/api/insights${qs({ from, fresh })}`),

  // SMS on the router's SIM: the only calls that change anything on the router.
  sms: () => request('/api/sms'),
  smsSend: (to, text) =>
    request('/api/sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, text }) }),
  smsMarkRead: (id) => request(`/api/sms/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  smsDelete: (ids) => request(`/api/sms${qs({ ids })}`, { method: 'DELETE' }),
  smsOwnNumber: () => request('/api/sms/own-number'),
  // Band selection: every change is a trial that reverts unless kept.
  radio: () => request('/api/radio'),
  radioApply: ({ technology, bands }) =>
    request('/api/radio', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ technology, bands }) }),
  radioKeep: () => request('/api/radio/keep', { method: 'POST' }),
  radioRevert: () => request('/api/radio/revert', { method: 'POST' }),
  radioAutomatic: () => request('/api/radio/automatic', { method: 'POST' }),
  // Speed tests from this machine, the band optimiser and placement.
  speed: ({ from } = {}) => request(`/api/speed${qs({ from })}`),
  speedRun: () => request('/api/speed/run', { method: 'POST' }),
  speedCancel: () => request('/api/speed/cancel', { method: 'POST' }),
  optimiser: () => request('/api/speed/optimiser'),
  optimiserStart: ({ rounds, arms }) =>
    request('/api/speed/optimiser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rounds, arms }),
    }),
  optimiserCancel: () => request('/api/speed/optimiser/cancel', { method: 'POST' }),
  placement: () => request('/api/placement'),
  placementBoost: (seconds) =>
    request('/api/placement/boost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds }) }),
  placementCapture: ({ name, seconds }) =>
    request('/api/placement/spots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, seconds }),
    }),
  placementDelete: (id) => request(`/api/placement/spots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  smsSetOwnNumber: (number) =>
    request('/api/sms/own-number', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number }) }),

  // Read-only router endpoints (allowlisted on the server)
  router: (ids, { fresh } = {}) => request(`/api/router${qs({ ids, fresh })}`),

  // Explicit router management operations; every mutation carries the CSRF header.
  control: () => controlRequest('', 'GET'),
  controlRefresh: () => controlRequest('/refresh'),
  controlAcknowledge: (id) => controlRequest('/operation/acknowledge', 'POST', { id, confirm: 'ACKNOWLEDGE' }),
  controlFirmwareCheck: () => controlRequest('/firmware/check'),
  controlFirmwareSettings: (patch) => controlRequest('/firmware/settings', 'PUT', { patch }),
  controlFirmwareInstall: () => controlRequest('/firmware/install', 'POST', { confirm: 'UPGRADE' }),
  controlBackup: controlDownload,
  controlRestore: (file) =>
    request('/api/control/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-Confirm': 'RESTORE' },
      body: file,
    }),
  controlRomd: (action) => controlRequest(`/romd/${action}`, 'POST', { confirm: action === 'save' ? 'SAVE ROMD' : 'CLEAR ROMD' }),
  controlPartialReset: (keep) => controlRequest('/reset/partial', 'POST', { confirm: 'RESET', keep }),
  controlDiagnostic: (options) => controlRequest('/diagnostics', 'POST', options),
  controlWan: (index, patch) =>
    controlRequest(index == null ? '/wan' : `/wan/${encodeURIComponent(index)}`, index == null ? 'POST' : 'PUT', {
      patch,
      confirm: 'SAVE WAN',
    }),
  controlAccountCreate: (account) => controlRequest('/accounts', 'POST', { account }),
  controlAccountSave: (index, patch) => controlRequest(`/accounts/${encodeURIComponent(index)}`, 'PUT', { patch }),
  controlAccountDelete: (index) => controlRequest(`/accounts/${encodeURIComponent(index)}`, 'DELETE', { confirm: 'DELETE ACCOUNT' }),
  controlPrivileges: (index, patch) => controlRequest(`/privileges/${encodeURIComponent(index)}`, 'PUT', { patch }),
  controlZconsole: (patch) => controlRequest('/zconsole', 'PUT', { patch }),
};
