import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/index.js';
import { useToast } from '../../app/live.js';
import { href, navigate } from '../../app/route.jsx';
import { formatBytes, formatFull } from '../../lib/format.js';
import { networkLabel } from '../../lib/domain.js';
import { ErrorNote, Panel } from '../../components/ui/index.js';
import Segmented from '../../components/ui/Segmented.jsx';

const STEP = {
  switching: 'switching bands',
  settling: 'waiting for the connection to settle',
  testing: 'speed test',
  restoring: 'restoring',
};
// Per test: the modem's switch and settle (20–90 s) plus the test itself (~20 s).
const SEC_PER_TEST = 55;
const ENDED = {
  cancelled: 'Cancelled. The router is back on its starting setting; partial results give no verdict.',
  interrupted: 'Interrupted when Insight stopped. The band trial it left switched back by itself.',
  failed: 'Stopped by an error. The router was returned to its starting setting.',
};

const mbps = (v) => (v == null ? '—' : `${Math.round(v * 10) / 10}`);
const pct = (g) => (g == null ? '—' : `${g >= 0 ? '+' : '−'}${Math.abs(Math.round(g * 100))}%`);

/**
 * The band optimiser: shows the plan, runs it (as radio trials, on the server), follows its
 * progress through status pushes, and offers the winner as an ordinary Radio control trial.
 */
export default function Optimiser({ state, maxBytes, radioTrial, speedRunning }) {
  const toast = useToast();
  const running = state.running;
  const r = useAsync(() => api.optimiser(), [running?.id ?? null, state.last?.id ?? null, state.last?.state ?? null]);
  const [picked, setPicked] = useState(null); // Set of arm keys; null = every arm
  const [rounds, setRounds] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const plan = r.data?.plan;
  const planKeys = plan?.arms.map((a) => a.key).join('\n');
  useEffect(() => setPicked(null), [planKeys]);
  const chosen = useMemo(() => (plan ? plan.arms.filter((a) => !picked || picked.has(a.key)) : []), [plan, picked]);

  async function act(fn, message) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (message) toast(message);
      r.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (key) => {
    const next = new Set(picked ?? plan.arms.map((a) => a.key));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };

  const tests = rounds * (chosen.length + 1);
  const last = r.data?.history?.[0];
  return (
    <Panel
      title="Optimiser"
      subtitle="Tries a few band and network-mode setups as radio trials and speed-tests each one beside your current setting, round after round. A setup only wins if it's clearly faster in most rounds without hurting upload or latency. The router always ends back on the setting it started with."
    >
      <ErrorNote error={error ?? (r.data?.planError && !running ? r.data.planError : null)} />
      {running ? (
        <div className="opt-run" role="status" aria-live="polite">
          <div className="opt-bar" aria-hidden="true">
            <span style={{ width: `${Math.round((running.done / Math.max(1, running.total)) * 100)}%` }} />
          </div>
          <p>
            <strong>
              Round {running.step?.round ?? 1} of {running.rounds}
            </strong>
            {running.step && (
              <>
                : {running.step.label} — {STEP[running.step.phase] ?? running.step.phase}
              </>
            )}
            <span className="muted tabular">
              {' '}
              · {running.done}/{running.total} tests
            </span>
          </p>
          <p className="muted small">
            Mobile data drops briefly at each switch. Other band changes and router controls wait until this finishes.
          </p>
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => api.optimiserCancel(), 'Cancelling: restoring the starting setting')}
          >
            Cancel and restore
          </button>
        </div>
      ) : (
        plan && (
          <>
            <p className="small">
              Compared against: <b>{plan.baseline.why}</b>
              {plan.network && (
                <span className="muted">
                  {' '}
                  ·{' '}
                  {plan.network.historyBands
                    ? `ranked from your band history on ${networkLabel(plan.network)}`
                    : `no band history on ${networkLabel(plan.network)} yet, so anchors are the bands serving you now`}
                </span>
              )}
            </p>
            {plan.arms.length ? (
              <ul className="opt-arms">
                {plan.arms.map((a) => (
                  <li key={a.key}>
                    <label>
                      <input type="checkbox" checked={!picked || picked.has(a.key)} onChange={() => toggle(a.key)} />
                      <span>
                        <b>{a.label}</b>
                        <span className="muted small"> {a.why}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nothing to try: this router offers no alternative setups from here.</p>
            )}
            <div className="radio-apply opt-start">
              <div>
                <Segmented
                  label="Rounds"
                  options={[1, 2, 3].map((n) => ({ value: n, label: `${n} round${n === 1 ? '' : 's'}` }))}
                  value={rounds}
                  onChange={setRounds}
                />
                <p className="muted small">
                  {tests} tests, about {Math.round((tests * SEC_PER_TEST) / 60)} min, up to {formatBytes(tests * (maxBytes ?? 0))} of mobile
                  data. More rounds make the verdict more trustworthy.
                </p>
              </div>
              <button
                className="btn btn-primary"
                disabled={busy || !chosen.length || !!radioTrial || speedRunning}
                title={radioTrial ? 'Keep or revert the band trial on Radio control first' : undefined}
                onClick={() =>
                  act(
                    () => api.optimiserStart({ rounds, arms: chosen.map((a) => a.key) }),
                    'Optimiser started: the router will switch bands as it goes',
                  )
                }
              >
                Start optimiser
              </button>
            </div>
          </>
        )
      )}
      {last && !running && <LastRun run={last} trialActive={!!radioTrial} />}
    </Panel>
  );
}

function LastRun({ run, trialActive }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const arms = new Map([[run.plan?.baseline?.key, run.plan?.baseline], ...(run.plan?.arms ?? []).map((a) => [a.key, a])]);
  const res = run.result;
  const winner = res?.winner ? arms.get(res.winner) : null;
  const rows = res ? [{ ...res.baseline, isBaseline: true }, ...res.arms] : [];

  async function tryWinner() {
    setBusy(true);
    try {
      await api.radioApply(winner.selection);
      toast('Winner applied as a trial: keep it on Radio control if it holds up');
      navigate(href('radio'));
    } catch (e) {
      toast(`Couldn't apply: ${e.message}`, 'critical');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="opt-last" aria-label="Last optimiser run">
      <h3>
        Last run <span className="muted small">{formatFull(run.finishedAt ?? run.startedAt)}</span>
      </h3>
      {run.state === 'running' && <p className="muted">Still running.</p>}
      {ENDED[run.state] && <p className="muted">{ENDED[run.state]}</p>}
      {rows.length > 0 && (
        <div className="dt-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Setup</th>
                <th className="num">Down (Mbps)</th>
                <th className="num">Up (Mbps)</th>
                <th className="num">Added latency</th>
                <th className="num">vs current</th>
                <th className="num">Rounds ahead</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.key} className={a.key === res.winner ? 'opt-winner' : ''}>
                  <td>
                    {a.isBaseline ? 'Current setting' : (arms.get(a.key)?.label ?? a.key)}
                    {a.key === res.winner && <span className="audit-tag tag-pass">Winner</span>}
                    {a.failed > 0 && <span className="audit-tag tag-warn">{a.failed} failed</span>}
                  </td>
                  <td className="num tabular">{mbps(a.downMbps)}</td>
                  <td className="num tabular">{mbps(a.upMbps)}</td>
                  <td className="num tabular">{a.addedMs == null ? '—' : `+${Math.round(a.addedMs)} ms`}</td>
                  <td className="num tabular">{a.isBaseline ? '—' : pct(a.gain)}</td>
                  <td className="num tabular">{a.isBaseline ? '—' : `${a.wins}/${a.paired}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res && run.state === 'complete' && <p className="rec-detail">{res.reason}</p>}
      {winner && (
        <button className="btn btn-primary" disabled={busy || trialActive} onClick={tryWinner}>
          Try “{winner.label}” as a trial
        </button>
      )}
    </section>
  );
}
