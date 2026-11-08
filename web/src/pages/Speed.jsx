import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/index.js';
import { useLive, useToast } from '../app/live.js';
import { formatBytes, formatFull, formatSigned, formatWhen } from '../lib/format.js';
import { SERIES, networkLabel } from '../lib/domain.js';
import { addedLatency, bufferbloatGrade } from '@zyxel-insight/shared/speed';
import { DataTable, ErrorNote, PageHeader, PageLoader, Panel, Stat } from '../components/ui/index.js';
import Segmented from '../components/ui/Segmented.jsx';
import { StatusIcon } from '../components/ui/Icons.jsx';
import TimeSeries from '../components/charts/TimeSeries.jsx';
import Legend from '../components/charts/Legend.jsx';
import Optimiser from '../features/speed/Optimiser.jsx';

const RANGES = [
  { value: '7d', label: '7 days', ms: 7 * 86400e3 },
  { value: '30d', label: '30 days', ms: 30 * 86400e3 },
  { value: '90d', label: '90 days', ms: 90 * 86400e3 },
];
const SPEED_SERIES = [SERIES.speedDown, SERIES.speedUp];
const LATENCY_SERIES = [SERIES.latencyIdle, SERIES.latencyLoaded];
const TONE = { warn: 'warning', info: 'neutral', good: 'good' };
const TRIGGER = { manual: 'By hand', schedule: 'Scheduled', optimiser: 'Optimiser' };
export const PHASE = { latency: 'Measuring idle latency', download: 'Downloading', upload: 'Uploading' };

const mbps = (v) => (v == null ? '—' : `${Math.round(v * 10) / 10}`);
const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);

export default function Speed() {
  const { status } = useLive();
  const toast = useToast();
  const [range, setRange] = useState('30d');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const running = status?.speed?.running;
  const span = RANGES.find((r) => r.value === range).ms;
  // Re-read when a test or an optimiser run finishes, wherever it was started.
  const r = useAsync(
    () => api.speed({ from: Date.now() - span }),
    [span, running?.startedAt ?? null, status?.optimiser?.last?.id ?? null, status?.optimiser?.running?.done ?? null],
  );
  const d = r.data;

  if (!d) {
    return (
      <div className="page">
        {r.loading && <PageLoader />}
        <PageHeader title="Speed" />
        <ErrorNote error={r.error} />
      </div>
    );
  }

  const optimiserBusy = !!status?.optimiser?.running;
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const t = await api.speedRun();
      toast(`${mbps(t.downMbps)} Mbps down · ${mbps(t.upMbps)} Mbps up`);
      r.reload();
    } catch (e) {
      if (!/cancelled/i.test(e.message)) setError(e);
      r.reload();
    } finally {
      setBusy(false);
    }
  }

  const s = d.diagnosis.summary;
  const ok = d.tests.filter((t) => t.state === 'ok' && t.trigger !== 'optimiser');
  const latest = ok[0];
  const points = [...ok].reverse().map((t) => ({ t: t.ts, down: t.downMbps, up: t.upMbps }));
  const latencyPoints = [...ok].reverse().map((t) => {
    const loaded = [t.loadedDownMs, t.loadedUpMs].filter((v) => v != null);
    return { t: t.ts, idle: t.idleMs, loaded: loaded.length ? Math.max(...loaded) : null };
  });
  const to = Date.now();
  const schedule = d.state.schedule;

  return (
    <div className="page">
      <PageHeader
        title="Speed"
        subtitle="Speed tests run from this computer through the router: download, upload, and latency both idle and while the line is loaded. Each result is stored with the bands and signal it ran under."
      >
        {running ? (
          <button className="btn" onClick={() => api.speedCancel().catch(() => {})}>
            Cancel test
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy || optimiserBusy}
            onClick={run}
            title={optimiserBusy ? 'The optimiser is running' : undefined}
          >
            Run speed test
          </button>
        )}
      </PageHeader>
      <ErrorNote error={error ?? r.error} />

      {running && <Running running={running} />}

      <div className="tiles">
        <Stat
          label="Download"
          value={mbps(s.downMbps)}
          unit="Mbps"
          sub={latest ? `Latest ${mbps(latest.downMbps)} Mbps · median of ${s.ok}` : 'No tests yet'}
        />
        <Stat
          label="Upload"
          value={mbps(s.upMbps)}
          unit="Mbps"
          sub={s.p10DownMbps != null ? `Slowest 10%: ${mbps(s.p10DownMbps)} Mbps down` : latest ? `Latest ${mbps(latest.upMbps)} Mbps` : ''}
        />
        <Stat
          label="Idle latency"
          value={s.idleMs != null ? Math.round(s.idleMs) : '—'}
          unit="ms"
          sub={latest ? `Latest ${ms(latest.idleMs)}` : ''}
        />
        <Stat
          label="Latency under load"
          value={s.addedMs != null ? `+${Math.round(s.addedMs)}` : '—'}
          unit="ms"
          sub={s.grade ? `Bufferbloat grade ${s.grade}` : 'How much a busy line adds'}
        />
      </div>

      <Panel
        title="What limits your speed"
        subtitle={`From your own tests on ${networkLabel(d.network)} (optimiser runs excluded) and the signal during each${
          d.otherNetworks ? `. ${d.otherNetworks} test${d.otherNetworks === 1 ? '' : 's'} on other networks left out.` : ''
        }`}
      >
        <ul className="recs">
          {d.diagnosis.findings.map((f, i) => (
            <li key={i} className={`rec rec-${f.severity}`}>
              <StatusIcon tone={TONE[f.severity]} size={15} />
              <div>
                <p className="rec-title">{f.title}</p>
                <p className="rec-detail">{f.detail}</p>
                {f.action && <p className="rec-action">→ {f.action}</p>}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {status?.optimiser && (
        <Optimiser state={status.optimiser} maxBytes={d.state.maxBytes} radioTrial={status.radioTrial} speedRunning={!!running} />
      )}

      <Panel
        title="Speed history"
        subtitle={
          <>
            Your tests by hand and on schedule.{' '}
            {schedule.everyHours > 0
              ? `Scheduled every ${schedule.everyHours} h${schedule.nextAt ? `, next ${formatWhen(schedule.nextAt)}` : ''}.`
              : 'No schedule: set SPEEDTEST_EVERY_HOURS to build the picture through the day.'}
            {schedule.lastSkip && ` Last scheduled test skipped: ${schedule.lastSkip.reason}.`}
          </>
        }
        actions={
          <>
            <Legend series={SPEED_SERIES} />
            <Segmented label="Range" options={RANGES} value={range} onChange={setRange} />
          </>
        }
      >
        <TimeSeries
          points={points}
          series={SPEED_SERIES}
          from={to - span}
          to={to}
          height={220}
          format={(v) => `${mbps(v)} Mbps`}
          yMin={0}
          gapMs={Infinity}
          empty="No speed tests in this range yet."
          ariaLabel="Download and upload speed per test"
        />
      </Panel>

      <Panel
        title="Latency"
        subtitle="Idle, and the worse of download and upload while the line was full"
        actions={<Legend series={LATENCY_SERIES} />}
      >
        <TimeSeries
          points={latencyPoints}
          series={LATENCY_SERIES}
          from={to - span}
          to={to}
          height={180}
          format={ms}
          yMin={0}
          gapMs={Infinity}
          empty="No speed tests in this range yet."
          ariaLabel="Idle and loaded latency per test"
        />
      </Panel>

      <Panel title="Tests" subtitle={`Each test uses up to ${formatBytes(d.state.maxBytes)} of mobile data.`} flush>
        <DataTable
          rows={d.tests}
          rowKey={(t) => t.id}
          empty="No tests yet. Run one above."
          columns={[
            { key: 'ts', label: 'When', render: (t) => <span title={formatFull(t.ts)}>{formatWhen(t.ts)}</span> },
            { key: 'trigger', label: 'How', render: (t) => TRIGGER[t.trigger] ?? t.trigger },
            { key: 'downMbps', label: 'Down (Mbps)', align: 'right', render: (t) => mbps(t.downMbps) },
            { key: 'upMbps', label: 'Up (Mbps)', align: 'right', render: (t) => mbps(t.upMbps) },
            { key: 'idleMs', label: 'Idle', align: 'right', render: (t) => ms(t.idleMs) },
            {
              key: 'loaded',
              label: 'Under load',
              align: 'right',
              render: (t) => {
                const added = addedLatency(t);
                return added == null ? '—' : `+${Math.round(added)} ms (${bufferbloatGrade(t.idleMs, t.idleMs + added)})`;
              },
            },
            { key: 'combo', label: 'Bands', render: (t) => (t.trigger === 'optimiser' && t.bandsPref ? t.bandsPref : (t.combo ?? '—')) },
            { key: 'nrSinr', label: '5G SINR', align: 'right', render: (t) => (t.nrSinr == null ? '—' : `${formatSigned(t.nrSinr)} dB`) },
            {
              key: 'state',
              label: 'Result',
              render: (t) => (t.state === 'ok' ? 'OK' : <span className="radio-invalid">{t.error ?? 'Failed'}</span>),
            },
          ]}
        />
      </Panel>
      <p className="tile-sub radio-note">
        Tests measure the whole path from this computer, so its own link counts too: run Insight on a machine wired to the router (or close
        to it on 5 GHz Wi-Fi) for numbers about the mobile connection rather than your Wi-Fi.
      </p>
    </div>
  );
}

function Running({ running }) {
  return (
    <div className="banner banner-info speed-live" role="status" aria-live="polite">
      <span className="dot-spinner speed-spinner" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} style={{ '--i': i }} />
        ))}
      </span>
      <div>
        <strong>{PHASE[running.phase] ?? 'Testing'}…</strong>
        {running.mbps != null && <span className="tabular"> {mbps(running.mbps)} Mbps</span>}
        {running.latencyMs != null && <span className="muted tabular"> · {Math.round(running.latencyMs)} ms latency</span>}
        {running.trigger !== 'manual' && <span className="muted"> ({TRIGGER[running.trigger]?.toLowerCase()})</span>}
      </div>
    </div>
  );
}
