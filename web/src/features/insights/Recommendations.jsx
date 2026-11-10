import { useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useAsync, useNow } from '../../hooks/index.js';
import { formatFull } from '../../lib/format.js';
import { Panel, Segmented } from '../../components/ui/index.js';
import { Info, Sparkle, StatusIcon } from '../../components/ui/Icons.jsx';

const TONE = { fail: 'critical', warn: 'warning', info: 'neutral' };
const SKELETON = [92, 78, 85];

/**
 * The Insights page's recommendations, from two sources kept visibly apart: an AI analysis by
 * the local model (when the server has one configured) and the rule-based findings, which are
 * always there. The AI answer takes tens of seconds, so it loads on its own with its progress
 * shown, and falls back to the rules with the reason when the model can't answer.
 * `extra(rec)` renders a rule-based finding's own controls (e.g. a band trial).
 */
export default function Recommendations({ rules = [], span, ai: aiStatus, extra }) {
  // Offered while Ollama answers (null = not checked yet). Without it the page is rule-based only,
  // with no error: most installs never set up a model.
  const aiOn = !!aiStatus && aiStatus.reachable !== false;
  const [fresh, setFresh] = useState(0);
  const ai = useAsync((signal) => (aiOn ? api.aiInsights({ from: Date.now() - span, fresh }, { signal }) : null), [span, fresh, aiOn]);
  const answer = !ai.loading && ai.data?.source === 'ai' ? ai.data : null;
  const failure = !ai.loading && aiOn && !answer ? (ai.data?.reason ?? ai.error?.message ?? null) : null;

  // null = follow the state: the AI tab unless the model couldn't answer.
  const [picked, setPicked] = useState(null);
  const tab = !aiOn ? 'rules' : (picked ?? (failure ? 'rules' : 'ai'));

  const model = aiStatus?.model ?? ai.data?.model ?? 'the local model';
  const days = Math.round(span / 86400e3);

  return (
    <Panel
      title="Recommendations"
      subtitle={
        tab === 'ai'
          ? `AI analysis of the last ${days === 1 ? '24 hours' : `${days} days`}`
          : 'Rule-based findings from current readings and history'
      }
      actions={
        aiOn && (
          <Segmented
            label="Recommendation source"
            value={tab}
            onChange={setPicked}
            options={[
              { value: 'ai', label: 'AI analysis' },
              { value: 'rules', label: `Rule-based · ${rules.length}` },
            ]}
          />
        )
      }
    >
      {tab === 'ai' ? (
        ai.loading ? (
          <AiProgress model={model} days={days} lastMs={aiStatus?.lastMs} onShowRules={() => setPicked('rules')} />
        ) : answer ? (
          <>
            {answer.summary && (
              <div className="ai-summary">
                <span className="ai-summary-label">
                  <Sparkle width={13} height={13} /> Summary
                </span>
                <p>{answer.summary}</p>
              </div>
            )}
            <RecList recs={answer.recommendations} />
            <footer className="ai-foot">
              <span>
                Generated on this computer by <b>{answer.model}</b> · {formatFull(answer.at)} · {Math.round(answer.ms / 1000)} s. AI output
                can be wrong: check it against the figures on this page.
              </span>
              <button className="btn btn-sm" onClick={() => setFresh(Date.now())}>
                Regenerate
              </button>
            </footer>
          </>
        ) : (
          <AiUnavailable reason={failure} onRetry={() => setFresh(Date.now())} />
        )
      ) : (
        <>
          {aiOn && failure && (
            <div className="ai-note" role="status">
              <Info width={14} height={14} />
              <span>
                AI analysis unavailable: {failure}. Showing the rule-based findings.{' '}
                <button className="link-btn" onClick={() => setFresh(Date.now())}>
                  Try again
                </button>
              </span>
            </div>
          )}
          {rules.length ? <RecList recs={rules} extra={extra} /> : <p className="muted">Nothing to act on in this period.</p>}
        </>
      )}
    </Panel>
  );
}

function RecList({ recs, extra }) {
  if (!recs.length) return <p className="muted">Nothing to act on in this period.</p>;
  return (
    <ul className="recs">
      {recs.map((rec, i) => (
        <li key={i} className={`rec rec-${rec.severity}`}>
          <StatusIcon tone={TONE[rec.severity]} size={15} />
          <div>
            <p className="rec-title">{rec.title}</p>
            {rec.detail && <p className="rec-detail">{rec.detail}</p>}
            {rec.action && <p className="rec-action">→ {rec.action}</p>}
            {extra?.(rec)}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** While the model works: what it's doing, for how long so far, and a way to the rules meanwhile. */
function AiProgress({ model, days, lastMs, onShowRules }) {
  const started = useRef(Date.now());
  const now = useNow(1000);
  const sec = Math.max(0, Math.round((now - started.current) / 1000));
  // Expect what this machine took last time; a guess until the first run.
  const usual = lastMs ? Math.max(5, Math.round(lastMs / 1000)) : null;
  const slow = sec >= Math.max(90, (usual ?? 0) * 2);
  return (
    <div className="ai-progress" role="status" aria-live="polite">
      <div className="ai-progress-head">
        <span className="ring-spinner" aria-hidden="true" />
        <div>
          <p className="ai-progress-title">
            Analysing {days === 1 ? '24 hours' : `${days} days`} of router data with {model}
          </p>
          <p className="ai-progress-sub">
            Running locally · {sec} s elapsed · {usual ? `last run took ${usual} s` : 'usually 30–60 s'}
            {slow ? '. Taking longer than usual: the computer may be busy.' : ''}
          </p>
        </div>
      </div>
      <div className="ai-skeleton" aria-hidden="true">
        {SKELETON.map((w, i) => (
          <span key={i} style={{ width: `${w}%` }} />
        ))}
      </div>
      <button className="link-btn" onClick={onShowRules}>
        View the rule-based findings meanwhile
      </button>
    </div>
  );
}

function AiUnavailable({ reason, onRetry }) {
  const hint = /not reachable/i.test(reason ?? '') ? 'Start Ollama (open the app or run ollama serve), then try again.' : null;
  return (
    <div className="ai-empty">
      <p className="ai-empty-title">AI analysis unavailable</p>
      <p className="muted">{reason ?? 'The model did not answer.'}</p>
      {hint && <p className="muted small">{hint}</p>}
      <button className="btn btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
