import { useEffect, useId, useRef, useState } from 'react';
import { Panel } from '../../components/ui/index.js';
import { formatFull } from '../../lib/format.js';
import { operationAcknowledgeable, operationActive, operationLabel, operationStateLabel } from '../../lib/control.js';

export function Field({ label, help, value, onChange, options, type = 'text', ...rest }) {
  const id = useId();
  return (
    <div className="control-field">
      <label htmlFor={id}>{label}</label>
      {options ? (
        <select id={id} className="control-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
          {options.map((option) => {
            const [key, text] = Array.isArray(option) ? option : [option, option];
            return (
              <option key={key} value={key}>
                {text}
              </option>
            );
          })}
        </select>
      ) : (
        <input
          id={id}
          className="control-input"
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange(type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
          {...rest}
        />
      )}
      {help && <span className="control-help">{help}</span>}
    </div>
  );
}

export function Toggle({ label, value, onChange, help, disabled }) {
  return (
    <label className="control-toggle">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>
        {label}
        {help && <small className="control-help">{help}</small>}
      </span>
    </label>
  );
}

export function Capability({ value }) {
  return (
    <div className={`control-capability ${value?.available ? 'is-available' : ''}`}>
      <span className="control-dot" />
      <span>{value?.available ? 'Available for this session' : value?.reason || 'Availability has not been confirmed.'}</span>
    </div>
  );
}

export function ControlPanel({ title, subtitle, capability, error, children }) {
  return (
    <Panel title={title} subtitle={subtitle} className="control-panel">
      <Capability value={capability} />
      {error && (
        <p className="control-error" role="status">
          {error.message ?? String(error)}
        </p>
      )}
      {children}
    </Panel>
  );
}

export function Operation({ operation, onAcknowledge }) {
  if (!operation) return null;
  const active = operationActive(operation);
  const acknowledgeable = operationAcknowledgeable(operation);
  const tone = operation.state === 'failed' || operation.state === 'unknown' ? 'warning' : 'info';
  return (
    <div className={`banner banner-${tone} control-operation`} role="status" aria-live="polite">
      <div>
        <strong>
          {operationLabel(operation.kind)} <span className="control-state">{operationStateLabel(operation.state)}</span>
        </strong>
        <span className="banner-detail">{operation.message || (active ? 'Waiting for the router…' : 'Operation finished.')}</span>
        {operation.startedAt && <span className="control-help">Started {formatFull(operation.startedAt)}</span>}
        {operation.state === 'unknown' && (
          <span className="banner-detail">
            The request may have reached the router. Check its current settings before trying again.
            {!acknowledgeable && operation.deadline && ` You can acknowledge this after ${formatFull(operation.deadline)}.`}
          </span>
        )}
      </div>
      {active && <span className="control-pulse" aria-label="Operation in progress" />}
      {acknowledgeable && onAcknowledge && (
        <button type="button" className="btn btn-sm" onClick={onAcknowledge}>
          Review unverified outcome
        </button>
      )}
    </div>
  );
}

export function ConfirmDialog({ review, busy, error, onClose, onConfirm }) {
  const ref = useRef(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="control-confirm"
      aria-labelledby="control-confirm-title"
      onCancel={(e) => (busy ? e.preventDefault() : onClose())}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !error && (!review.phrase || typed === review.phrase)) onConfirm();
        }}
      >
        <h2 id="control-confirm-title">{review.title}</h2>
        <p>{review.message}</p>
        {!!review.summary?.length && (
          <ul className="control-review-list">
            {review.summary.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        {error && (
          <p className="control-error" role="alert">
            {error.message ?? String(error)}
          </p>
        )}
        {review.phrase && !error && (
          <Field label={`Type ${review.phrase} to confirm`} value={typed} onChange={setTyped} autoComplete="off" autoFocus />
        )}
        <div className="control-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {error ? 'Close' : 'Cancel'}
          </button>
          {/* After a failure, close and review again: the router's state may have changed. */}
          {!error && (
            <button
              type="submit"
              className={`btn ${review.danger ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy || (!!review.phrase && typed !== review.phrase)}
            >
              {busy ? 'Sending…' : review.button || 'Confirm changes'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
