import { useState } from 'react';
import { api } from '../../api/client.js';
import { ControlPanel, Field, Toggle } from './Common.jsx';

// The server's rule: dot-separated labels of letters, digits and inner hyphens.
const HOST = String.raw`[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*`;

export default function Diagnostics({ snapshot, disabled, run, ask }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(5201);
  const [duration, setDuration] = useState(10);
  const [reverse, setReverse] = useState(false);
  const caps = snapshot.capabilities ?? {};
  const operation = snapshot.operation;
  // The running test's output, or the last finished one after a different operation took over.
  const result = ['speedtest', 'iperf'].includes(operation?.kind) && operation.result?.text ? operation.result : snapshot.diagnostic;
  function iperf(e) {
    e.preventDefault();
    ask({
      title: 'Start iperf throughput test?',
      message: 'The router will connect to your iperf3 server and generate test traffic. Other devices may slow down while the test runs.',
      summary: [
        `Server: ${host}:${port}`,
        `Duration: ${duration} seconds`,
        `Direction: ${reverse ? 'Download to router' : 'Upload from router'}`,
      ],
      button: 'Start iperf',
      action: () => api.controlDiagnostic({ kind: 'iperf', host, port, duration, reverse }),
      success: 'iperf test started.',
    });
  }
  return (
    <>
      <ControlPanel
        title="Internet speed test"
        subtitle="Runs on the router, using its built-in speed-test service."
        capability={caps.speedtest}
        error={snapshot.errors?.speedtest}
      >
        <p className="control-description">
          The ordinary speed test is available when the router advertises support. It uses mobile data and can temporarily slow other
          devices.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || !caps.speedtest?.available}
          onClick={() =>
            ask({
              title: 'Run router speed test?',
              message:
                'This measures the router’s connection and uses data from your plan. Avoid other heavy traffic for a useful comparison.',
              button: 'Start speed test',
              action: () => api.controlDiagnostic({ kind: 'speedtest' }),
              success: 'Router speed test started.',
            })
          }
        >
          Run speed test
        </button>
      </ControlPanel>
      <ControlPanel
        title="iperf3"
        subtitle="Test throughput between the router and an iperf3 server you choose."
        capability={caps.iperf}
        error={snapshot.errors?.iperf}
      >
        <form onSubmit={iperf}>
          <fieldset disabled={disabled || !caps.iperf?.available} className="control-fields">
            <div className="control-grid">
              <Field
                label="Server address"
                value={host}
                onChange={setHost}
                required
                maxLength="253"
                placeholder="192.168.1.20 or server.example.com"
                pattern={HOST}
                title="An IPv4 address or host name"
                autoCapitalize="none"
                spellCheck="false"
              />
              <Field label="Server port" type="number" min="1" max="65535" required value={port} onChange={setPort} />
              <Field label="Duration (seconds)" type="number" min="1" max="60" required value={duration} onChange={setDuration} />
            </div>
            <Toggle label="Reverse direction: download to router" value={reverse} onChange={setReverse} />
            <div className="control-actions">
              <button type="submit" className="btn">
                Review iperf test
              </button>
            </div>
          </fieldset>
        </form>
      </ControlPanel>
      <section className="panel control-panel">
        <header className="panel-head">
          <div>
            <h2>Diagnostic output</h2>
            <p className="panel-sub">Updates while a test runs. Leaving this page stops watching, not the router’s test.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => run(() => api.controlRefresh())}>
            Refresh
          </button>
        </header>
        <div className="panel-body">
          {result?.text ? (
            <pre className="control-output" tabIndex="0">
              {result.text}
            </pre>
          ) : (
            <p className="empty-inline">Results appear here after a test starts.</p>
          )}
        </div>
      </section>
    </>
  );
}
