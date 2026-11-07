import { useState } from 'react';
import { api } from '../../api/client.js';
import { controlIndex, controlPatch, controlSummary, pageLabel, privilegePages } from '../../lib/control.js';
import { ControlPanel, Field, Toggle } from './Common.jsx';

const ACCOUNT_KEYS = ['Username', 'Enabled', 'group', 'Password', 'AccountRetryTime', 'AccountIdleTime', 'AccountLockTime'];
// The server's rule for usernames (an input pattern: `-` must be escaped inside a class).
const USERNAME = String.raw`[A-Za-z0-9_.\-]{1,32}`;
// Shown in minutes, stored in seconds; empty stays undefined so it is never sent.
const toSeconds = (v) => (v === '' ? undefined : v * 60);
const toMinutes = (v) => (v == null || v === '' ? '' : Number(v) / 60);
const NEW_ACCOUNT = {
  Username: '',
  Enabled: true,
  group: 'User',
  Password: '',
  AccountRetryTime: 3,
  AccountIdleTime: 300,
  AccountLockTime: 300,
};

function AccountEditor({ original, index, current, disabled, ask, create = false }) {
  const [draft, setDraft] = useState(() => ({ ...(create ? NEW_ACCOUNT : original), Password: '' }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  function submit(e) {
    e.preventDefault();
    const patch = controlPatch(create ? {} : original, draft, ACCOUNT_KEYS, ['Password']);
    if (!Object.keys(patch).length) return ask({ empty: true });
    ask({
      title: create ? 'Create router account?' : `Save account ${original.Username}?`,
      message: 'This changes an account on the router. Passwords stay on the server and are never included in the review.',
      summary: controlSummary(patch),
      action: () => (create ? api.controlAccountCreate(patch) : api.controlAccountSave(index, patch)),
      success: create ? 'Router account created.' : 'Router account updated.',
    });
  }
  return (
    <form onSubmit={submit} className="control-editor" autoComplete="off">
      {current && (
        <p className="control-note">
          Insight uses this account. Its name, password, group and enabled state are protected to preserve the connection.
        </p>
      )}
      <fieldset disabled={disabled} className="control-fields">
        <div className="control-grid">
          <Field
            label="Username"
            value={draft.Username}
            onChange={(v) => set('Username', v)}
            required
            maxLength="32"
            pattern={USERNAME}
            title="1 to 32 letters, numbers, dots, underscores or hyphens"
            disabled={current}
            autoComplete="off"
          />
          <Field
            label="Group"
            value={draft.group}
            onChange={(v) => set('group', v)}
            options={['Administrator', 'User']}
            disabled={current}
          />
          <Field
            label={create ? 'Password' : 'New password'}
            type="password"
            value={draft.Password}
            onChange={(v) => set('Password', v)}
            required={create}
            disabled={current}
            autoComplete="new-password"
            maxLength="64"
            help={create ? 'Choose a unique router password.' : 'Leave blank to preserve the existing password.'}
          />
          <Field
            label="Failed attempts before lock"
            type="number"
            min="1"
            max="5"
            required={create}
            value={draft.AccountRetryTime}
            onChange={(v) => set('AccountRetryTime', v)}
          />
          <Field
            label="Idle timeout (minutes)"
            type="number"
            min="1"
            max="60"
            required={create}
            value={toMinutes(draft.AccountIdleTime)}
            onChange={(v) => set('AccountIdleTime', toSeconds(v))}
          />
          <Field
            label="Lock period (minutes)"
            type="number"
            min="5"
            max="90"
            required={create}
            value={toMinutes(draft.AccountLockTime)}
            onChange={(v) => set('AccountLockTime', toSeconds(v))}
          />
        </div>
        <Toggle label="Account enabled" value={draft.Enabled} onChange={(v) => set('Enabled', v)} disabled={current} />
        <div className="control-actions">
          <button type="submit" className="btn btn-primary">
            Review account changes
          </button>
          {!create && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={current}
              onClick={() =>
                ask({
                  title: `Delete account ${original.Username}?`,
                  message: 'This permanently removes the router account. Keep another enabled management account available.',
                  phrase: 'DELETE ACCOUNT',
                  danger: true,
                  button: 'Delete account',
                  action: () => api.controlAccountDelete(index),
                  success: 'Router account deleted.',
                })
              }
            >
              Delete account
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function PrivilegeEditor({ original, options, disabled, ask }) {
  const [selected, setSelected] = useState(() => privilegePages(original.Page));
  // Quick start is stored on the group's accounts: null when the group has none yet.
  const hasQuickStart = original.EnableQuickStart != null;
  const [quickStart, setQuickStart] = useState(!!original.EnableQuickStart);
  const choices = options.map(({ value }) => value);
  for (const value of privilegePages(original.Page)) if (!choices.includes(value)) choices.push(value);
  function submit(e) {
    e.preventDefault();
    const patch = controlPatch(
      original,
      {
        ...(Object.hasOwn(original, 'Page') ? { Page: selected.join(',') } : {}),
        ...(hasQuickStart ? { EnableQuickStart: quickStart } : {}),
      },
      ['Page', 'EnableQuickStart'],
    );
    if (!Object.keys(patch).length) return ask({ empty: true });
    ask({
      title: 'Update login privileges?',
      message: 'The selected router pages will be available to this account group. The router still enforces its own access rules.',
      summary: [
        Number(original.Index0) === 2 ? 'Administrator group' : 'User group',
        ...(patch.Page !== undefined ? [`${selected.length} pages allowed`] : []),
        ...(patch.EnableQuickStart !== undefined ? [`Quick start: ${quickStart ? 'on' : 'off'}`] : []),
      ],
      action: () => api.controlPrivileges(original.Index0, patch),
      success: 'Login privileges updated.',
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={disabled} className="control-fields">
        {hasQuickStart ? (
          <Toggle label="Enable quick start" value={quickStart} onChange={setQuickStart} />
        ) : (
          <p className="control-note">Quick start is set per account; this group has no accounts yet.</p>
        )}
        <h3>Allowed router pages</h3>
        {!Object.hasOwn(original, 'Page') && (
          <p className="control-note">
            The router has not returned the group’s selected pages. Refresh settings before changing its page access.
          </p>
        )}
        <div className="control-page-options">
          {choices.map((value) => (
            <Toggle
              key={value}
              label={pageLabel(value)}
              value={selected.includes(value)}
              disabled={!Object.hasOwn(original, 'Page')}
              onChange={(checked) => setSelected((current) => (checked ? [...current, value] : current.filter((v) => v !== value)))}
            />
          ))}
        </div>
        <div className="control-actions">
          <button type="submit" className="btn btn-primary">
            Review privileges
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export default function Accounts({ snapshot, disabled, ask }) {
  const caps = snapshot.capabilities ?? {};
  const groups = new Map();
  for (const row of snapshot.privileges ?? []) {
    if (![2, 3].includes(Number(row.Index0))) continue;
    const group = Number(row.Index0);
    if (!groups.has(group) || Number(row.Index1) === 0) groups.set(group, row);
  }
  for (const [index, row] of groups) {
    const account = (snapshot.privileges ?? []).find((item) => Number(item.Index0) === index && Number(item.Index1) > 0);
    if (account && Object.hasOwn(account, 'EnableQuickStart')) groups.set(index, { ...row, EnableQuickStart: account.EnableQuickStart });
  }
  return (
    <>
      <ControlPanel
        title="Router accounts"
        subtitle="Manage accounts stored on the router."
        capability={caps.accounts}
        error={snapshot.errors?.accounts}
      >
        {(snapshot.accounts ?? []).map((row) => (
          <details className="control-details" key={JSON.stringify(row)}>
            <summary>
              <span>
                <strong>{row.Username}</strong>
                <small>
                  {row.group ?? 'Account'} · {row.Enabled ? 'Enabled' : 'Disabled'}
                  {row.Username === snapshot.username ? ' · Current connection' : ''}
                </small>
              </span>
              <span className="muted">Edit</span>
            </summary>
            {controlIndex(row) == null ? (
              <p className="control-note">The router did not report this account’s index, so it can’t be edited here.</p>
            ) : (
              <AccountEditor
                original={row}
                index={controlIndex(row)}
                current={row.Username === snapshot.username}
                disabled={disabled || !caps.accounts?.available}
                ask={ask}
              />
            )}
          </details>
        ))}
        {caps.accounts?.available && !snapshot.accounts?.length && <p className="empty-inline">No accounts were returned.</p>}
        {caps.accounts?.available && (
          <details className="control-details">
            <summary>
              <strong>Add router account</strong>
            </summary>
            <AccountEditor original={{}} create disabled={disabled} ask={ask} />
          </details>
        )}
      </ControlPanel>
      <ControlPanel
        title="Login privileges"
        subtitle="Choose which router pages each account group may access."
        capability={caps.privileges}
        error={snapshot.errors?.privileges}
      >
        {[...groups.values()].map((row) => (
          <details className="control-details" key={JSON.stringify(row)}>
            <summary>
              <strong>{Number(row.Index0) === 2 ? 'Administrator group' : 'User group'}</strong>
            </summary>
            <div className="control-editor">
              <PrivilegeEditor
                original={row}
                options={snapshot.privilegePages ?? []}
                disabled={disabled || !caps.privileges?.available}
                ask={ask}
              />
            </div>
          </details>
        ))}
        {!groups.size && <p className="empty-inline">No editable group privileges were returned.</p>}
      </ControlPanel>
    </>
  );
}
