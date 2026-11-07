import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useLive } from '../../app/live.js';
import { formatFull } from '../../lib/format.js';
import { controlPatch, controlSummary } from '../../lib/control.js';
import { ControlPanel, Field, Toggle } from './Common.jsx';

const KEYS = ['Enable', 'LogServerIP', 'LogServerPort', 'BufferSize', 'BufferOverwrite', 'UseCommonServer'];

function ConsoleSettings({ original, disabled, ask }) {
  const [draft, setDraft] = useState(() => ({ ...original }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  function submit(e) {
    e.preventDefault();
    const patch = controlPatch(original, draft, KEYS);
    if (!Object.keys(patch).length) return ask({ empty: true });
    ask({
      title: 'Update console log forwarding?',
      message: 'Console and kernel messages can contain sensitive diagnostics. Send them only to a trusted receiver on your local network.',
      summary: controlSummary(patch),
      action: () => api.controlZconsole(patch),
      success: 'Console forwarding settings updated.',
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={disabled} className="control-fields">
        <Toggle label="Forward console logs" value={draft.Enable} onChange={(v) => set('Enable', v)} />
        <div className="control-grid">
          <Field
            label="Receiver IPv4 address"
            value={draft.LogServerIP}
            onChange={(v) => set('LogServerIP', v)}
            required
            placeholder="This computer’s LAN address"
          />
          <Field
            label="Receiver TCP port"
            value={draft.LogServerPort}
            onChange={(v) => set('LogServerPort', v)}
            type="number"
            min="1"
            max="65535"
            required
          />
          <Field
            label="Buffer size (log lines)"
            value={draft.BufferSize}
            onChange={(v) => set('BufferSize', v)}
            type="number"
            min="5"
            max="10240"
          />
        </div>
        <Toggle label="Overwrite old buffer entries" value={draft.BufferOverwrite} onChange={(v) => set('BufferOverwrite', v)} />
        <Toggle
          label="Use a common TCP receiver"
          value={draft.UseCommonServer}
          onChange={(v) => set('UseCommonServer', v)}
          help="Enable for Insight’s console receiver."
        />
        <div className="control-actions">
          <button className="btn btn-primary" type="submit">
            Review console settings
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export default function Zconsole({ snapshot, disabled, ask }) {
  const { status } = useLive();
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(false);
  const receiver = status?.zconsole;
  const original = snapshot.zconsole?.zconsole_log ?? snapshot.zconsole;
  const capability = snapshot.capabilities?.zconsole;
  const mounted = useRef(true);
  const loadLogs = useCallback(async () => {
    setReading(true);
    try {
      const result = await api.logs({ source: ['router-console'] }, undefined, 100);
      if (!mounted.current) return;
      setLogs(result.items ?? []);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      if (mounted.current) setReading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    loadLogs();
    return () => {
      mounted.current = false;
    };
  }, [loadLogs]);
  return (
    <>
      <ControlPanel
        title="Z-console forwarding"
        subtitle="Redirect the router’s console and kernel messages to a TCP log receiver."
        capability={capability}
        error={snapshot.errors?.zconsole}
      >
        <p className="control-description">
          This is a diagnostic log stream. The router must support console forwarding and permit this account to configure it.
        </p>
        {receiver && (
          <p className="control-note">
            Insight receiver: {receiver.listening ? `listening on TCP ${receiver.port}` : 'not listening'} · {receiver.received ?? 0} lines
            received{receiver.error ? ` · ${receiver.error}` : ''}. Use this computer’s LAN address as the destination.
          </p>
        )}
        {original ? (
          <ConsoleSettings key={JSON.stringify(original)} original={original} disabled={disabled || !capability?.available} ask={ask} />
        ) : (
          <p className="empty-inline">Console forwarding settings have not been returned.</p>
        )}
      </ControlPanel>
      <section className="panel control-panel">
        <header className="panel-head">
          <div>
            <h2>Collected console logs</h2>
            <p className="panel-sub">Latest 100 lines received by Insight.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadLogs} disabled={reading}>
            {reading ? 'Reading…' : 'Refresh logs'}
          </button>
        </header>
        <div className="panel-body">
          {error && (
            <p className="control-error" role="status">
              {error}
            </p>
          )}
          {logs.length ? (
            <pre className="control-output" tabIndex="0">
              {logs.map((line) => `${formatFull(line.ts)}  ${line.message}`).join('\n')}
            </pre>
          ) : (
            <p className="empty-inline">No console logs have been received.</p>
          )}
        </div>
      </section>
    </>
  );
}
