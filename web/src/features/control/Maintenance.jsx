import { useState } from 'react';
import { api } from '../../api/client.js';
import { KV } from '../../components/ui/index.js';
import { formatBytes } from '../../lib/format.js';
import { controlPatch, controlSummary, privilegePages } from '../../lib/control.js';
import { ControlPanel, Field, Toggle } from './Common.jsx';

const FOTA_KEYS = ['PeriodicCheckEnable', 'PeriodicMode', 'PeriodicStartDay', 'StartTime', 'ShiftTimeRange', 'ForceUpgrade'];
const DAYS = [
  [0, 'Random day'],
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [7, 'Sunday'],
];
const KEEP_LABELS = {
  ResetKeep_1: 'Backhaul settings',
  ResetKeep_2: 'Wi-Fi settings',
  ResetKeep_3: 'Security settings',
  ResetKeep_4: 'Networking settings',
  ResetKeep_5: 'Cellular settings',
};

function PartialReset({ original, disabled, ask }) {
  const supported = privilegePages(original.SupportedFactoryResetUnpurgedList);
  // Only what can be shown and unticked: the router's list may name settings it no longer supports.
  const [keep, setKeep] = useState(() => privilegePages(original.FactoryResetUnpurgedList).filter((t) => supported.includes(t)));
  return (
    <div className="control-fields">
      <p className="control-description">Choose which settings to preserve. Download a configuration backup first.</p>
      <div className="control-checks">
        {supported.map((token) => (
          <Toggle
            key={token}
            label={KEEP_LABELS[token] ?? `Other settings (${token})`}
            value={keep.includes(token)}
            disabled={disabled}
            onChange={(checked) => setKeep((current) => (checked ? [...current, token] : current.filter((t) => t !== token)))}
          />
        ))}
      </div>
      {!keep.length && <p className="control-error">No settings selected: the router will perform a factory reset.</p>}
      <div className="control-actions">
        <button
          type="button"
          className="btn btn-danger"
          disabled={disabled || !supported.length}
          onClick={() =>
            ask({
              title: keep.length ? 'Partially reset this router?' : 'Factory reset this router?',
              message: 'Settings outside your selection will reset. Connectivity and login details may change; keep a local recovery path.',
              summary: keep.length ? keep.map((token) => `Keep ${KEEP_LABELS[token] ?? token}`) : ['No settings will be preserved.'],
              phrase: 'RESET',
              danger: true,
              button: keep.length ? 'Partial reset' : 'Factory reset',
              action: () => api.controlPartialReset(keep),
              success: 'Reset requested.',
            })
          }
        >
          Review reset
        </button>
      </div>
    </div>
  );
}

function FirmwareSettings({ original, disabled, ask }) {
  const [draft, setDraft] = useState(() => ({ ...original }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  function submit(e) {
    e.preventDefault();
    const patch = controlPatch(original, draft, FOTA_KEYS);
    if (!Object.keys(patch).length) return ask({ empty: true });
    ask({
      title: 'Save update schedule?',
      message: 'The router will use this schedule for online firmware updates. Times use the router’s clock.',
      summary: controlSummary(patch),
      action: () => api.controlFirmwareSettings(patch),
      success: 'Firmware schedule saved.',
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={disabled} className="control-fields">
        <Toggle label="Automatic firmware checks" value={draft.PeriodicCheckEnable} onChange={(v) => set('PeriodicCheckEnable', v)} />
        <Toggle
          label="Install available updates automatically"
          value={draft.ForceUpgrade}
          onChange={(v) => set('ForceUpgrade', v)}
          help="An installation restarts the router and briefly interrupts Internet access."
        />
        <div className="control-grid">
          <Field
            label="Check period"
            value={draft.PeriodicMode}
            options={[
              [0, 'Daily'],
              [1, 'Weekly'],
              [2, 'Monthly'],
            ]}
            onChange={(v) => setDraft((d) => ({ ...d, PeriodicMode: Number(v), PeriodicStartDay: Number(v) === 0 ? 0 : 1 }))}
          />
          <Field
            label="Start hour"
            type="number"
            min="0"
            max="23"
            step="1"
            required
            value={draft.StartTime}
            onChange={(v) => set('StartTime', v)}
            help="0–23, in the router’s time zone."
          />
          <Field
            label="Update window (hours)"
            type="number"
            min="1"
            max="24"
            step="1"
            required
            value={Number(draft.ShiftTimeRange ?? 0) / 3600}
            onChange={(v) => set('ShiftTimeRange', v === '' ? '' : v * 3600)}
          />
          {Number(draft.PeriodicMode) === 2 && (
            <Field
              label="Day of month"
              type="number"
              min="0"
              max="28"
              required
              value={draft.PeriodicStartDay}
              onChange={(v) => set('PeriodicStartDay', v)}
              help="0 lets the router choose a day; otherwise choose 1–28."
            />
          )}
        </div>
        {Number(draft.PeriodicMode) === 1 && (
          <Field label="Day to check" value={draft.PeriodicStartDay} options={DAYS} onChange={(v) => set('PeriodicStartDay', Number(v))} />
        )}
        <div className="control-actions">
          <button className="btn btn-primary" type="submit">
            Review schedule
          </button>
        </div>
      </fieldset>
    </form>
  );
}

const sameVersion = (a, b) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase();

/** What the update service reported, in words rather than the router's field names. */
function availableDetails(available) {
  const { FWVersion, FWReleaseDate, FWSize, ...rest } = available;
  return {
    ...(FWVersion ? { Version: FWVersion } : {}),
    ...(FWReleaseDate ? { Released: FWReleaseDate } : {}),
    ...(Number(FWSize) > 0 ? { Size: formatBytes(Number(FWSize)) } : {}),
    ...rest,
  };
}

export function Firmware({ snapshot, disabled, run, ask }) {
  const capability = snapshot.capabilities?.firmware;
  const firmware = snapshot.firmware ?? {};
  const installed = firmware.currentVersion ?? snapshot.device?.SoftwareVersion;
  const target = firmware.available?.FWVersion;
  // The server refuses an install without a newer version, so don't offer one.
  const newer = !!target && !sameVersion(target, installed);
  return (
    <>
      <ControlPanel
        title="Online firmware upgrade"
        subtitle={`Installed version: ${firmware.currentVersion ?? snapshot.device?.SoftwareVersion ?? 'unknown'}`}
        capability={capability}
        error={snapshot.errors?.firmware}
      >
        <p className="control-description">Check Zyxel’s update service, review the available version, then choose when to install it.</p>
        {firmware.available &&
          (newer ? <KV obj={availableDetails(firmware.available)} /> : <p className="control-note">This router is up to date.</p>)}
        <div className="control-actions">
          <button
            type="button"
            className="btn"
            disabled={disabled || !capability?.available}
            onClick={() => run(() => api.controlFirmwareCheck(), 'Firmware check finished.')}
          >
            Check for updates
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={disabled || !capability?.available || !newer}
            onClick={() =>
              ask({
                title: 'Install router firmware?',
                message:
                  'The router will download and install the available firmware, then restart. Internet and Wi-Fi may be unavailable for several minutes. Keep the router powered on.',
                summary: [`Installed: ${installed ?? 'unknown'}`, `Available: ${target}`],
                phrase: 'UPGRADE',
                danger: true,
                button: 'Install firmware',
                action: () => api.controlFirmwareInstall(),
                success: 'Firmware installation requested. Waiting for the router.',
              })
            }
          >
            Install available update
          </button>
        </div>
      </ControlPanel>
      <ControlPanel
        title="Automatic updates"
        subtitle="The schedule and installation policy reported by the router."
        capability={capability}
      >
        {firmware.settings ? (
          <FirmwareSettings
            key={JSON.stringify(firmware.settings)}
            original={firmware.settings}
            disabled={disabled || !capability?.available}
            ask={ask}
          />
        ) : (
          <p className="empty-inline">The router has not returned its update schedule.</p>
        )}
      </ControlPanel>
    </>
  );
}

export function Backup({ snapshot, disabled, run, ask }) {
  const [file, setFile] = useState(null);
  // Bumped after a restore so the file input clears too.
  const [picker, setPicker] = useState(0);
  const caps = snapshot.capabilities ?? {};
  return (
    <>
      <ControlPanel
        title="Configuration backup & restore"
        subtitle="Download the router’s configuration to this computer."
        capability={caps.backup}
        error={snapshot.errors?.backup}
      >
        <p className="control-description">
          Backups can contain passwords and private network settings. Store the file somewhere you trust.
        </p>
        <div className="control-actions">
          <button
            type="button"
            className="btn"
            disabled={disabled || !caps.backup?.available}
            onClick={() => run(() => api.controlBackup('configuration'), 'Configuration backup downloaded.')}
          >
            Download configuration
          </button>
        </div>
        <div className="control-divider" />
        <label className="control-field">
          <span>Configuration file to restore</span>
          <input
            key={picker}
            className="control-input control-file"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={disabled || !caps.backup?.available}
          />
          <span className="control-help">
            Use a backup made for this router model. Restore replaces its settings and may restart the router.
          </span>
        </label>
        <div className="control-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={disabled || !caps.backup?.available || !file?.size}
            onClick={() =>
              ask({
                title: 'Restore router configuration?',
                message:
                  'This replaces the router’s current settings. Its IP address, Wi-Fi details and login credentials may change. Make sure you have a local way to reconnect.',
                summary: [`File: ${file.name}`, `Size: ${file.size.toLocaleString()} bytes`],
                phrase: 'RESTORE',
                danger: true,
                button: 'Restore configuration',
                action: () => api.controlRestore(file),
                success: 'Configuration restore requested.',
                onDone: () => {
                  setFile(null);
                  setPicker((n) => n + 1);
                },
              })
            }
          >
            Review restore
          </button>
        </div>
      </ControlPanel>
      <ControlPanel
        title="ROM-D defaults"
        subtitle="Manage the persistent defaults used by the router."
        capability={caps.romd}
        error={snapshot.errors?.romd}
      >
        <p className="control-description">
          Saving ROM-D makes the current configuration the router’s saved defaults. Clearing ROM-D removes those saved defaults. These
          actions are separate from downloading a normal backup.
        </p>
        <div className="control-actions">
          <button
            type="button"
            className="btn"
            disabled={disabled || !caps.romd?.available}
            onClick={() => run(() => api.controlBackup('romd'), 'ROM-D backup downloaded.')}
          >
            Download ROM-D
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || !caps.romd?.available}
            onClick={() =>
              ask({
                title: 'Save current settings to ROM-D?',
                message: 'The router will store the current configuration as its persistent defaults.',
                phrase: 'SAVE ROMD',
                action: () => api.controlRomd('save'),
                success: 'ROM-D defaults saved.',
              })
            }
          >
            Save current as defaults
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={disabled || !caps.romd?.available}
            onClick={() =>
              ask({
                title: 'Clear ROM-D defaults?',
                message: 'This removes the saved ROM-D configuration from the router.',
                phrase: 'CLEAR ROMD',
                danger: true,
                action: () => api.controlRomd('clear'),
                success: 'ROM-D defaults cleared.',
              })
            }
          >
            Clear ROM-D
          </button>
        </div>
      </ControlPanel>
      <ControlPanel
        title="Partial reset"
        subtitle="Use the router’s configured preserve-settings policy."
        capability={caps.partialReset}
        error={snapshot.errors?.partialReset}
      >
        {snapshot.partialReset ? (
          <PartialReset
            key={JSON.stringify(snapshot.partialReset)}
            original={snapshot.partialReset}
            disabled={disabled || !caps.partialReset?.available}
            ask={ask}
          />
        ) : (
          <p className="empty-inline">The router has not returned its preserve-settings policy.</p>
        )}
      </ControlPanel>
    </>
  );
}
