import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useLive, useToast } from '../app/live.js';
import { PageHeader, PageLoader, ErrorNote } from '../components/ui/index.js';
import { Refresh, Shield } from '../components/ui/Icons.jsx';
import { operationActive, operationBlocks } from '../lib/control.js';
import { ConfirmDialog, Operation } from '../features/control/Common.jsx';
import { Firmware, Backup } from '../features/control/Maintenance.jsx';
import Diagnostics from '../features/control/Diagnostics.jsx';
import Wan from '../features/control/Wan.jsx';
import Accounts from '../features/control/Accounts.jsx';
import Zconsole from '../features/control/Zconsole.jsx';

const TABS = [
  ['firmware', 'Firmware'],
  ['backup', 'Backup & ROM-D'],
  ['diagnostics', 'Diagnostics'],
  ['wan', 'WAN'],
  ['accounts', 'Accounts'],
  ['zconsole', 'Z-console'],
];

export default function HighControl() {
  const toast = useToast();
  const { status } = useLive();
  // Known once the first status arrives; until then assume enabled and let the API answer.
  const featureOff = status?.controlEnabled === false;
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState(null);
  const [tab, setTab] = useState(() => {
    const selected = new URLSearchParams(location.search).get('tab');
    return TABS.some(([id]) => id === selected) ? selected : 'firmware';
  });
  const mounted = useRef(true);
  const fetching = useRef(false);
  const working = useRef(false);
  const load = useCallback(async (refresh = false) => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const data = await (refresh ? api.controlRefresh() : api.control());
      if (mounted.current) {
        setSnapshot(data);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(e);
    } finally {
      fetching.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (featureOff) setLoading(false);
    else load();
    return () => {
      mounted.current = false;
    };
  }, [load, featureOff]);
  const active = operationActive(snapshot?.operation);
  // An operation started elsewhere (another tab, the API) arrives with the status push: catch up.
  const pushed = status?.controlOperation;
  const pushedKey = pushed ? `${pushed.id}:${pushed.state}` : '';
  const shownKey = snapshot?.operation ? `${snapshot.operation.id}:${snapshot.operation.state}` : '';
  const seenPush = useRef('');
  useEffect(() => {
    // Once per pushed change, so a status that lags the page can't cause a fetch loop.
    if (!pushedKey || pushedKey === seenPush.current) return;
    seenPush.current = pushedKey;
    if (pushedKey !== shownKey && !working.current) load();
  }, [pushedKey, shownKey, load]);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      if (!working.current) load();
    }, 1800);
    return () => clearInterval(timer);
  }, [active, load]);

  /** Run one action; resolves to its error, or null. From the review dialog, the dialog shows the error. */
  async function run(action, success, { inDialog = false } = {}) {
    if (working.current) return new Error('Another action is still being sent.');
    working.current = true;
    setBusy(true);
    setError(null);
    let failure = null;
    try {
      await action();
      if (success) toast(success);
    } catch (e) {
      failure = e;
      if (!inDialog) {
        setError(e);
        toast(e.message, 'critical');
      }
    } finally {
      // Refresh only the cached operation view after sending; never repeat an action.
      try {
        const data = await api.control();
        if (mounted.current) setSnapshot(data);
      } catch {
        // Keep the action error and last known state if the router is restarting.
      }
      working.current = false;
      if (mounted.current) setBusy(false);
    }
    return failure;
  }

  // Editors call ask({ empty: true }) when nothing has changed.
  function ask(next) {
    if (next?.empty) toast('Nothing has changed yet.');
    else {
      setReviewError(null);
      setReview(next);
    }
  }

  function onTabKey(e) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const edge = { Home: 0, End: TABS.length - 1 }[e.key];
    if (step === undefined && edge === undefined) return;
    e.preventDefault();
    const at = TABS.findIndex(([id]) => id === tab);
    const next = TABS[edge ?? (at + step + TABS.length) % TABS.length][0];
    switchTab(next);
    document.getElementById(`control-tab-${next}`)?.focus();
  }

  function switchTab(id) {
    setTab(id);
    const params = new URLSearchParams(location.search);
    params.set('tab', id);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  const disabled = busy || !snapshot?.enabled || operationBlocks(snapshot?.operation);
  const props = { snapshot, disabled, run, ask };
  const available = Object.values(snapshot?.capabilities ?? {}).filter((c) => c.available).length;

  return (
    <div className="page high-control">
      <PageHeader title="High control" subtitle="Router maintenance and advanced settings, using your account’s effective permissions.">
        <button
          className="btn"
          disabled={featureOff || busy || loading || active}
          onClick={() => run(() => api.controlRefresh(), 'Permissions and settings refreshed.')}
        >
          <Refresh size={15} className={busy ? 'spin' : ''} /> Refresh permissions & settings
        </button>
      </PageHeader>
      {loading && !snapshot && <PageLoader />}
      {featureOff && (
        <div className="banner banner-info">High control is disabled in the server configuration (HIGH_CONTROL_ENABLED=false).</div>
      )}
      <ErrorNote error={featureOff ? null : error} />
      {snapshot && !featureOff && (
        <>
          <div className="control-session">
            <Shield size={22} />
            <div>
              <strong>{snapshot.username || 'Router account'}</strong>
              <span className="control-help">
                {snapshot.device?.ModelName ?? 'Zyxel router'} ·{' '}
                {snapshot.device?.SoftwareVersion ?? snapshot.firmware?.currentVersion ?? 'Firmware unknown'}
              </span>
            </div>
            <div>
              <span className={`control-role ${snapshot.level === 'high' ? 'is-high' : ''}`}>{snapshot.level || 'Unknown'} privilege</span>
              <span className="control-help">{available} controls available</span>
            </div>
          </div>
          {!snapshot.enabled && <div className="banner banner-info">High control is disabled in the server configuration.</div>}
          <Operation
            operation={snapshot.operation}
            onAcknowledge={() =>
              setReview({
                title: 'Acknowledge the unverified outcome?',
                message:
                  'Check the router’s current settings before continuing. This unlocks further controls without repeating the previous request. If the router may still be working, acknowledgement is refused until its deadline.',
                phrase: 'ACKNOWLEDGE',
                action: () => api.controlAcknowledge(snapshot.operation.id),
                success: 'Outcome acknowledged.',
              })
            }
          />
          <div className="control-tabs" role="tablist" aria-label="High control sections" onKeyDown={onTabKey}>
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                id={`control-tab-${id}`}
                role="tab"
                aria-selected={id === tab}
                aria-controls={`control-panel-${id}`}
                tabIndex={id === tab ? 0 : -1}
                className={id === tab ? 'is-active' : ''}
                onClick={() => switchTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`control-panel-${tab}`} aria-labelledby={`control-tab-${tab}`} className="control-content">
            {tab === 'firmware' && <Firmware {...props} />}
            {tab === 'backup' && <Backup {...props} />}
            {tab === 'diagnostics' && <Diagnostics {...props} />}
            {tab === 'wan' && <Wan {...props} />}
            {tab === 'accounts' && <Accounts {...props} />}
            {tab === 'zconsole' && <Zconsole {...props} />}
          </div>
        </>
      )}
      {review && (
        <ConfirmDialog
          review={review}
          busy={busy}
          error={reviewError}
          onClose={() => setReview(null)}
          onConfirm={async () => {
            const failure = await run(review.action, review.success, { inDialog: true });
            if (!mounted.current) return;
            if (failure) setReviewError(failure);
            else {
              review.onDone?.();
              setReview(null);
            }
          }}
        />
      )}
    </div>
  );
}
