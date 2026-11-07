import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { MASK, maskSecrets } from '../router/secrets.js';

const META = 'routerControlOperation';
const ACTIVE = new Set(['running', 'reconnecting']);
const NORMAL = new Set(['high', 'medium']);
const PAGE_NAMES =
  `connect Broadband Wireless Home_Networking Routing QoS NAT DNS IGMP_MLD Vlan_Group Interface_Grouping USB_Service Nebula Tunnel_Setting Home_Connectivity Firewall MAC_Filter Parental_Control Scheduler_Rule Certificates PPTP_VPN IPsec_VPN EoGRE SIP Phone Call_Rule CallHistory_id Log Traffic_Status VoIP_Status ARP_Table Routing_Table McastSt xDSL_Statistics WLAN_Table Steering_Status WWAN_Statistics GPON_Status CellWan_Status VPN_Status System User_Account Remote_MGMT SP_Domain TR-069_Client TR369_LocalAgent SNMP Time Email_Notify Log_Setting Firmware_Upgrade Backup_Restore Reboot Diagnostic_id Proximity_Sensor`.split(
    ' ',
  );
const FOTA = new Set(['PeriodicCheckEnable', 'PeriodicMode', 'PeriodicStartDay', 'StartTime', 'ShiftTimeRange', 'ForceUpgrade']);
const ZCONSOLE = new Set(['Enable', 'LogServerIP', 'LogServerPort', 'BufferSize', 'BufferOverwrite', 'UseCommonServer']);
const WAN = new Set(
  `Name Enable Type Mode Encapsulation VLANEnable VLANID VLANPriority MaxMTUSize NatEnable FullConeEnabled sysGwEnable sysGw6Enable ipMode pppUsername pppPassword ConnectionTrigger IdleDisconnectTime IGMPEnable MLDEnable ipStatic IPAddress SubnetMask GatewayIPAddress ipDnsStatic DNSServer ip6Static IP6Address NextHop ip6DnsStatic DNS6Server`.split(
    ' ',
  ),
);
const ACCOUNT = new Set(['Username', 'Enabled', 'group', 'Password', 'oldPw', 'AccountRetryTime', 'AccountIdleTime', 'AccountLockTime']);
const PRIVILEGE = new Set(['Page', 'EnableQuickStart']);
const BOOL = new Set(
  `PeriodicCheckEnable ForceUpgrade Enable Enabled VLANEnable NatEnable FullConeEnabled sysGwEnable sysGw6Enable IGMPEnable MLDEnable ipStatic ipDnsStatic ip6Static ip6DnsStatic BufferOverwrite UseCommonServer EnableQuickStart`.split(
    ' ',
  ),
);
const clone = (v) => structuredClone(v);
const fail = (message, status = 400, kind = 'validation') => Object.assign(new Error(message), { status, kind });
const notFound = (message) => fail(message, 404, 'not-found');
const conflict = (message) => fail(message, 409, 'conflict');
const sameName = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const boolFlag = (flags, key) => flags?.[key] === true || flags?.[key] === 1 || flags?.[key] === 'true';
const idOf = (o) => Number(o?.Index ?? o?.index ?? o?.Iid);
const currentVersion = (d) => d?.FirmwareVersion ?? d?.SoftwareVersion ?? d?.DeviceInfo?.SoftwareVersion ?? d?.FWVersion ?? null;
// The native diagnostic response is text, including occasional terminal escapes.
/* eslint-disable no-control-regex */
const safeText = (v) =>
  String(v ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .split('\n')
    .filter((line) => !/iperf3?\s+-c|(?:password|passwd|secret|token)\s*[:=]/i.test(line))
    .join('\n')
    .slice(0, 64_000);
/* eslint-enable no-control-regex */
const publicData = (value) => {
  const clean = (v) =>
    Array.isArray(v)
      ? v.map(clean)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !['PreRunCommand', 'iperf_Req', 'oldPw'].includes(k))
              .map(([k, x]) => [k, clean(x)]),
          )
        : v;
  return clean(maskSecrets(value));
};

function patchObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length)
    throw fail('Provide at least one setting to change.');
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!allowed.has(key)) throw fail(`Unsupported setting: ${key}`);
    if (BOOL.has(key) && typeof v !== 'boolean') throw fail(`${key} must be true or false.`);
    if (typeof v === 'string' && (v.includes(MASK) || Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)))
      throw fail(`${key} contains an invalid value.`);
    if (v === null || !['string', 'boolean', 'number'].includes(typeof v)) throw fail(`${key} has an invalid value.`);
    out[key] = v;
  }
  return out;
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw fail(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

function indexNumber(index) {
  if (!/^\d+$/.test(String(index))) throw fail('Invalid entry index.');
  return integer(Number(index), 1, 65535, 'Entry index');
}

function string(value, min, max, label) {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    throw fail(`${label} must contain ${min} to ${max} characters.`);
  return value;
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw fail(`Confirm this operation with ${expected}.`);
}

// New values must be real integers; the router's own copy may store them as strings.
function checkFota(o, patch) {
  for (const key of ['PeriodicMode', 'PeriodicStartDay', 'StartTime', 'ShiftTimeRange'])
    if (patch[key] !== undefined && !Number.isInteger(patch[key])) throw fail(`${key} must be a whole number.`);
  integer(Number(o.PeriodicMode), 0, 2, 'Check frequency');
  integer(Number(o.PeriodicStartDay), 0, Number(o.PeriodicMode) === 2 ? 28 : 7, 'Check day');
  integer(Number(o.StartTime), 0, 23, 'Start hour');
  integer(Number(o.ShiftTimeRange), 0, 86400, 'Time window');
}

function checkAccount(o, { creating = false } = {}) {
  if (o.Username !== undefined && !/^[A-Za-z0-9_.-]{1,32}$/.test(o.Username))
    throw fail('Use 1 to 32 letters, numbers, dots, underscores or hyphens for the username.');
  if (o.group !== undefined && !['Administrator', 'User'].includes(o.group)) throw fail('Account group must be Administrator or User.');
  if (creating && (!o.Username || !o.Password)) throw fail('A username and password are required.');
  if (o.Password !== undefined) string(o.Password, 1, 128, 'Password');
  if (o.oldPw !== undefined) string(o.oldPw, 1, 128, 'Existing password');
  for (const [key, min, max] of [
    ['AccountRetryTime', 1, 5],
    ['AccountIdleTime', 60, 3600],
    ['AccountLockTime', 300, 5400],
  ])
    if (o[key] !== undefined) integer(o[key], min, max, key);
}

function checkWan(o, patch, flags, level, creating) {
  if (creating) {
    const types = boolFlag(flags, 'hideDSL') ? ['ETH'] : ['ETH', 'ATM', 'PTM'];
    if (!types.includes(o.Type)) throw fail('This WAN type cannot be created on this router.');
    if (!/^[A-Za-z0-9_. -]{1,32}$/.test(o.Name ?? ''))
      throw fail('Provide a WAN name with 1 to 32 letters, numbers, spaces, dots, underscores or hyphens.');
  } else if (Object.hasOwn(patch, 'Name') || Object.hasOwn(patch, 'Type'))
    throw fail('The name and type of an existing WAN interface cannot be changed.');
  if (
    boolFlag(flags, 'ABOG_GUI_Customization') &&
    level !== 'high' &&
    Object.keys(patch).some((k) => /^(ppp|VLAN|ConnectionTrigger|IdleDisconnectTime|Encapsulation)/.test(k))
  )
    throw fail('This firmware reserves these WAN settings for a high account.', 403, 'permission');
  if (o.Type === 'CELL' && Object.keys(patch).some((k) => /^(ppp|VLAN|ConnectionTrigger|IdleDisconnectTime)/.test(k)))
    throw fail('PPP and VLAN settings do not apply to this cellular WAN.');
  if (o.Type === 'CELL' && (o.Mode === 'IP_Bridged' || o.Encapsulation !== 'IPoE')) throw fail('Cellular WAN requires routed IPoE.');
  if (o.Mode !== undefined && !['IP_Routed', 'IP_Bridged'].includes(o.Mode)) throw fail('Invalid WAN mode.');
  if (o.ipMode !== undefined && !['IPv4', 'IPv6', 'DualStack'].includes(o.ipMode)) throw fail('Invalid IP mode.');
  if (
    o.Encapsulation !== undefined &&
    !(o.Type === 'ATM' ? ['IPoE', 'PPPoE', 'IPoA', 'PPPoA'] : ['IPoE', 'PPPoE']).includes(o.Encapsulation)
  )
    throw fail('Invalid WAN encapsulation.');
  if (o.MaxMTUSize !== undefined)
    integer(o.MaxMTUSize, 68, o.Encapsulation === 'PPPoE' && !boolFlag(flags, 'SUPPORT_PPPOE_MTU_1500') ? 1492 : 1500, 'MTU');
  if (o.VLANEnable) {
    integer(o.VLANID, 1, 4094, 'VLAN ID');
    integer(o.VLANPriority, 0, 7, 'VLAN priority');
  }
  if (o.ConnectionTrigger !== undefined && !['AlwaysOn', 'OnDemand'].includes(o.ConnectionTrigger))
    throw fail('Invalid PPP connection trigger.');
  if (o.IdleDisconnectTime !== undefined) integer(o.IdleDisconnectTime, 0, 18000, 'PPP idle timeout');
  for (const key of ['pppUsername', 'pppPassword'])
    if (patch[key] !== undefined) string(patch[key], key === 'pppPassword' ? 1 : 0, 256, key);
  for (const key of ['IPAddress', 'SubnetMask', 'GatewayIPAddress'])
    if ((patch[key] || o.ipStatic) && !isIP(String(o[key] ?? ''))) throw fail(`${key} must be an IP address.`);
  for (const key of ['DNSServer', 'DNS6Server'])
    if (
      patch[key] !== undefined &&
      String(o[key])
        .split(',')
        .filter(Boolean)
        .some((ip) => !isIP(ip.trim()))
    )
      throw fail(`${key} must contain IP addresses separated by commas.`);
  if (patch.IP6Address && !isIP(String(patch.IP6Address).split('/')[0])) throw fail('Invalid IPv6 address.');
  if (patch.NextHop && isIP(patch.NextHop) !== 6) throw fail('Invalid IPv6 gateway.');
}

/** Explicit operations over the native web API; it never changes an account's authority. */
export function createControlService({
  client,
  db,
  collector,
  radio,
  routerData,
  enabled = false,
  onChange = () => {},
  now = Date.now,
  pollMs = 1500,
  reconnectMs = 3000,
}) {
  let info = null;
  let loadedAt = 0;
  let loading = null;
  let operation = null;
  let timer = null;
  let stopped = false;
  let holding = false;
  // The latest test output, kept when a later operation replaces `operation`.
  let lastDiagnostic = null;
  const raw = {};
  let errors = {};
  try {
    operation = JSON.parse(db?.getMeta(META) || 'null');
    if (operation && ACTIVE.has(operation.state))
      operation = {
        ...operation,
        state: 'unknown',
        finishedAt: now(),
        message: 'Insight restarted during the operation. Its outcome is unknown; it has not been sent again.',
      };
  } catch {
    operation = null;
  }
  const persist = () => db?.setMeta(META, JSON.stringify(operation));
  if (operation?.state === 'unknown') persist();
  const update = (patch) => {
    operation = { ...operation, ...patch };
    persist();
    onChange();
  };
  const audit = (message) => {
    try {
      db?.insertMany?.([{ ts: now(), source: 'insight', facility: 'control', level: 'notice', message }]);
    } catch {
      /* Status persistence, rather than logging, gates the operation. */
    }
  };
  const requireEnabled = () => {
    if (!enabled) throw fail('Router controls are disabled (HIGH_CONTROL_ENABLED=false).', 404, 'disabled');
  };
  const capability = (available, reason) => ({ available: !!available, reason: available ? null : reason });
  function capabilities() {
    const normal = enabled && NORMAL.has(info?.level);
    const high = enabled && info?.level === 'high';
    const disabled = !enabled
      ? 'Router controls are disabled.'
      : !info?.level
        ? 'The router account level has not been verified.'
        : 'This operation needs an administrator account.';
    const flags = info?.flags ?? {};
    return {
      firmware: capability(
        normal && (boolFlag(flags, 'showOnline_FirmwareUpgrade') || boolFlag(flags, 'OnlineFirmwareUpgradeForDT')),
        normal ? 'The router does not advertise online firmware upgrades.' : disabled,
      ),
      backup: capability(normal, disabled),
      romd: capability(high, enabled ? 'ROMD operations require a high account.' : disabled),
      partialReset: capability(
        normal && boolFlag(flags, 'showPartialReset'),
        normal ? 'This firmware does not advertise partial reset.' : disabled,
      ),
      zconsole: capability(
        high && boolFlag(flags, 'show_zconsole_log'),
        high ? 'This firmware does not advertise Z-console log redirection.' : 'Z-console requires a high account and firmware support.',
      ),
      speedtest: capability(
        normal && boolFlag(flags, 'supportSpeedTest'),
        normal ? 'The router does not advertise its speed test.' : disabled,
      ),
      iperf: capability(high, enabled ? 'iperf requires a high account.' : disabled),
      wan: capability(normal, disabled),
      // A medium (administrator) login may only edit its own account, which Insight protects.
      accounts: capability(high, enabled ? 'Managing router accounts requires a high account.' : disabled),
      privileges: capability(high, enabled ? 'Login privilege management requires a high account.' : disabled),
    };
  }
  async function read(oid) {
    const reply = await client.controlRead(oid);
    if (reply?.result !== 'ZCFG_SUCCESS')
      throw fail('The router refused or does not support this data.', reply?.result?.includes('PERMISSION') ? 403 : 502, 'router');
    if (!Array.isArray(reply.Object)) throw fail('The router returned an unsupported data format.', 502, 'unsupported');
    return clone(reply.Object);
  }
  async function load(force = false) {
    if (!enabled) return;
    if (operation && ACTIVE.has(operation.state)) {
      if (force) throw fail('Another router operation is still in progress.', 409, 'busy');
      return;
    }
    if (!force && info && now() - loadedAt < 10000) return;
    if (loading) return loading;
    loading = (async () => {
      if (collector?.state && !['ok', 'starting'].includes(collector.state.phase) && !holding)
        throw fail('Resume router collection before using router controls.', 409, 'unavailable');
      info = await client.controlInfo();
      if (!['high', 'medium', 'low'].includes(info?.level))
        throw fail('The router account level could not be verified.', 502, 'permission');
      const caps = capabilities();
      errors = {};
      const entries = [
        ['firmware', 'periodic_FOTA_config', caps.firmware],
        ['wan', 'wan', caps.wan],
        ['accounts', 'user_account', caps.accounts],
        ['privileges', 'login_privilege', caps.privileges],
        ['zconsole', 'zconsole', caps.zconsole],
        ['partialReset', 'backupRestore_config', caps.partialReset],
      ];
      for (const [section, oid, cap] of entries) {
        if (!cap.available) {
          delete raw[oid];
          continue;
        }
        try {
          raw[oid] = await read(oid);
        } catch (e) {
          delete raw[oid];
          errors[section] = { kind: e.kind ?? 'router', message: `The router did not provide ${section} settings.` };
        }
      }
      loadedAt = now();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }
  async function requireCapability(name) {
    requireEnabled();
    if (operation && ACTIVE.has(operation.state)) throw fail('Another router operation is still in progress.', 409, 'busy');
    await load(true);
    const cap = capabilities()[name];
    if (!cap?.available) throw fail(cap?.reason ?? 'Operation unavailable.', 403, 'permission');
    if (errors[name]) throw fail(errors[name].message, 502, errors[name].kind);
  }
  async function release() {
    if (holding) {
      holding = false;
      await collector?.endMaintenance?.();
    }
  }
  async function begin(kind, { long = false, deadline = 180000 } = {}) {
    if (stopped) throw fail('Router controls are stopping.', 409, 'unavailable');
    if (operation && ACTIVE.has(operation.state)) throw fail('Another router operation is still in progress.', 409, 'busy');
    if (operation?.state === 'unknown' && operation.deadline > now())
      throw fail(
        operation.result?.configurationReadable
          ? 'The previous operation has an unverified outcome. Review and acknowledge it before sending another command.'
          : 'The previous operation has an unknown outcome. Wait for its deadline before sending another command.',
        409,
        'unknown',
      );
    if (radio?.trial) throw fail('Keep or revert the active radio trial before using router controls.', 409, 'busy');
    if (client.suspended || (collector?.state && !['ok', 'starting'].includes(collector.state.phase)))
      throw fail('Resume router collection before changing the router.', 409, 'unavailable');
    operation = {
      id: crypto.randomUUID(),
      kind,
      state: 'running',
      startedAt: now(),
      finishedAt: null,
      deadline: now() + deadline,
      message: 'Sending the request to the router.',
    };
    persist();
    onChange();
    if (long) {
      try {
        holding = true;
        await collector?.beginMaintenance?.(kind);
      } catch (e) {
        update({ state: 'failed', finishedAt: now(), message: 'The router could not be prepared for maintenance.' });
        await release();
        throw e;
      }
    }
    audit(`Router control requested: ${kind}`);
  }
  function isAmbiguous(e) {
    return e?.kind === 'network' || /ECONNRESET|EPIPE|socket hang up|timed out|timeout/i.test(e?.message ?? '');
  }
  async function finishError(e) {
    update({
      state: isAmbiguous(e) ? 'unknown' : 'failed',
      finishedAt: now(),
      message: isAmbiguous(e)
        ? 'The connection ended before the outcome could be verified. The request has not been sent again.'
        : e?.kind === 'readback'
          ? `${e.message} Check the current settings before trying again.`
          : 'The router refused the request.',
    });
    await release();
    throw fail(operation.message, isAmbiguous(e) ? 502 : (e?.status ?? 502), isAmbiguous(e) ? 'unknown' : (e?.kind ?? 'router'));
  }
  async function run(kind, fn, options) {
    await begin(kind, options);
    try {
      const result = await fn();
      if (operation.state === 'running')
        update({
          state: 'complete',
          finishedAt: now(),
          message: 'The router accepted the operation.',
          ...(result === undefined ? {} : { result: maskSecrets(result) }),
        });
      if (!ACTIVE.has(operation.state)) await release();
      return operation;
    } catch (e) {
      return finishError(e);
    }
  }
  async function verifyPatch(oid, before, patch, find) {
    const rows = await read(oid);
    const after = find ? rows.find(find) : rows[0];
    if (!after || Object.entries(patch).some(([key, value]) => !/pass(word|wd)?|oldPw/i.test(key) && !isDeepStrictEqual(after[key], value)))
      throw fail('The router accepted the request but did not keep all requested settings.', 409, 'readback');
    raw[oid] = rows;
    routerData?.invalidate?.(oid);
    return after;
  }
  function schedule(fn, delay = pollMs) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void fn().catch(async () => {
        update({ state: 'unknown', finishedAt: now(), message: 'Status monitoring stopped before the outcome could be verified.' });
        await release();
      });
    }, delay);
    timer.unref?.();
  }
  const RESTARTED = {
    restore: 'The router restarted and its configuration is readable. Check that the restored settings are the ones you expected.',
    partialReset: 'The router restarted and its configuration is readable. Check the settings that were reset before relying on them.',
  };
  /**
   * Watch a restart that the router performs after the request: first see it go down, then
   * come back. A router answers for a few seconds before it reboots, so a reply straight after
   * the request proves nothing. While it's down only an unauthenticated probe is sent, so a
   * half-started web server never costs a login attempt.
   */
  function reconnect(kind, baseline, target) {
    if (stopped) return;
    let wentDown = false;
    const finish = async (patch) => {
      update({ finishedAt: now(), ...patch });
      await release();
    };
    const check = async () => {
      if (now() >= operation.deadline) {
        await finish({
          state: 'unknown',
          message: wentDown
            ? 'The router did not return with a verifiable result before the deadline.'
            : 'The router was not seen restarting before the deadline. It may not have applied the request.',
        });
        return;
      }
      const up = await client.probe();
      if (!wentDown || !up) {
        if (!up && !wentDown) {
          wentDown = true;
          update({ message: 'The router is restarting. Waiting for it to come back; the operation will not be resent.' });
        }
        schedule(check, reconnectMs);
        return;
      }
      try {
        const next = await client.controlInfo();
        const version = currentVersion(next.device);
        if (kind === 'firmwareInstall') {
          if (
            version &&
            sameName(version.trim(), target.trim()) &&
            !sameName(version.trim(), String(currentVersion(baseline.device) ?? '').trim())
          ) {
            info = next;
            loadedAt = 0;
            await finish({
              state: 'complete',
              message: 'The router returned and reports the requested firmware version.',
              result: { firmwareVersion: version },
            });
            return;
          }
        } else {
          raw.wan = await read('wan');
          raw.user_account = await read('user_account');
          info = next;
          loadedAt = 0;
          await finish({ state: 'unknown', message: RESTARTED[kind], result: { reachable: true, configurationReadable: true } });
          return;
        }
      } catch (e) {
        // A refused login won't fix itself (a restore may have changed the password): stop asking.
        if (e?.kind === 'auth') {
          await finish({ state: 'unknown', message: `The router is back, but Insight could not log in: ${e.message}` });
          return;
        }
        // Otherwise the router is still starting its services: keep watching.
      }
      schedule(check, reconnectMs);
    };
    update({
      state: 'reconnecting',
      message: 'Waiting for the router to restart and checking its state. The operation will not be resent.',
    });
    schedule(check, reconnectMs);
  }
  const pages = () =>
    [
      ...new Set([
        ...PAGE_NAMES,
        ...(raw.login_privilege ?? []).flatMap((r) => `${r.Page ?? ''},${r.HiddenPage ?? ''}`.split(',').filter(Boolean)),
      ]),
    ].map((value) => ({ value, label: value.replaceAll('_', ' ') }));
  function view() {
    const caps = capabilities();
    for (const key of Object.keys(errors)) if (caps[key]) caps[key] = capability(false, errors[key].message);
    return {
      enabled,
      level: info?.level ?? null,
      username: client.username ?? info?.username ?? null,
      device: publicData(info?.device ?? {}),
      flags: publicData(info?.flags ?? {}),
      capabilities: caps,
      operation: operation ? clone(operation) : null,
      firmware: {
        settings: maskSecrets(raw.periodic_FOTA_config?.[0] ?? null),
        available: maskSecrets(raw.online_fw_info?.[0] ?? null),
        currentVersion: currentVersion(info?.device),
      },
      wan: publicData(raw.wan ?? []),
      accounts: publicData(raw.user_account ?? []),
      privileges: publicData(
        (raw.login_privilege ?? []).map((row) =>
          Number(row.Index1) === 0
            ? {
                ...row,
                EnableQuickStart:
                  (raw.login_privilege ?? []).find((account) => Number(account.Index0) === Number(row.Index0) && Number(account.Index1) > 0)
                    ?.EnableQuickStart ?? null,
              }
            : row,
        ),
      ),
      zconsole: publicData(raw.zconsole?.[0] ?? null),
      partialReset: maskSecrets(raw.backupRestore_config?.[0] ?? null),
      privilegePages: pages(),
      diagnostic: lastDiagnostic ? clone(lastDiagnostic) : null,
      errors: clone(errors),
    };
  }
  return {
    enabled,
    get busy() {
      return !!operation && ACTIVE.has(operation.state);
    },
    get operation() {
      return operation ? clone(operation) : null;
    },
    async snapshot() {
      try {
        await load();
      } catch {
        errors.connection = { kind: 'unavailable', message: 'Router controls are unavailable until the router connection is ready.' };
      }
      return view();
    },
    async refresh() {
      await load(true);
      return view();
    },
    async firmwareCheck() {
      await requireCapability('firmware');
      return run('firmwareCheck', async () => {
        await client.controlAction('firmwareCheck');
        raw.online_fw_info = await read('online_fw_info');
        return { available: maskSecrets(raw.online_fw_info[0] ?? {}) };
      });
    },
    async acknowledge(id, confirm) {
      requireEnabled();
      requireConfirmation(confirm, 'ACKNOWLEDGE');
      if (operation?.id !== id || operation.state !== 'unknown') throw conflict('This operation no longer needs acknowledgement.');
      if (operation.deadline > now() && !operation.result?.configurationReadable) {
        throw conflict('The router may still be working. Wait for the operation deadline before acknowledging its outcome.');
      }
      update({
        state: 'acknowledged',
        message: 'You acknowledged the unverified outcome. The previous operation has not been sent again.',
      });
      audit(`Router control outcome acknowledged: ${operation.kind}`);
      return view();
    },
    async firmwareSettings(value) {
      await requireCapability('firmware');
      const patch = patchObject(value, FOTA);
      const before = (await read('periodic_FOTA_config'))[0];
      if (!before) throw fail('Firmware settings are unavailable.', 502);
      const next = { ...before, ...patch };
      checkFota(next, patch);
      return run('firmwareSettings', async () => {
        await client.controlWrite('periodic_FOTA_config', 'PUT', next);
        await verifyPatch('periodic_FOTA_config', before, patch);
      });
    },
    async firmwareInstall(confirm) {
      requireConfirmation(confirm, 'UPGRADE');
      await requireCapability('firmware');
      const available = (await read('online_fw_info'))[0];
      const target = available?.FWVersion;
      if (
        !target ||
        target.trim().toLowerCase() ===
          String(currentVersion(info.device) ?? '')
            .trim()
            .toLowerCase()
      )
        throw conflict('Check for a newer firmware version before requesting an upgrade.');
      const baseline = clone(info);
      return run(
        'firmwareInstall',
        async () => {
          collector?.expectRestart?.(now());
          try {
            await client.controlAction('firmwareInstall');
          } catch (e) {
            if (!isAmbiguous(e)) throw e;
          }
          reconnect('firmwareInstall', baseline, target);
        },
        { long: true, deadline: 10 * 60000 },
      );
    },
    async backup(kind) {
      if (!['configuration', 'romd'].includes(kind)) throw fail('Unknown backup kind.');
      await requireCapability(kind === 'romd' ? 'romd' : 'backup');
      let file;
      await run(`backup:${kind}`, async () => {
        file = await client.controlDownload(kind);
        if (!Buffer.isBuffer(file?.body) || !file.body.length) throw fail('The router returned an empty backup.', 502, 'readback');
      });
      return file;
    },
    async restore(buffer, filename, confirm) {
      requireConfirmation(confirm, 'RESTORE');
      await requireCapability('backup');
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail('Choose a configuration backup file.');
      if (buffer.length > 8 * 1024 * 1024) throw fail('Choose a configuration backup no larger than 8 MB.');
      // Browsers name repeat downloads "backup (1).conf"; the router only needs a plain name.
      const name =
        String(filename ?? '')
          .replace(/[^A-Za-z0-9_. -]/g, '_')
          .replace(/^[. ]+/, '')
          .slice(0, 128) || 'configuration.rom';
      const head = buffer.subarray(0, 512).toString('utf8').trimStart();
      if (/^(?:<!doctype|<html|<script)/i.test(head)) throw fail('This file is a webpage, not a configuration backup.');
      const baseline = clone(info);
      return run(
        'restore',
        async () => {
          collector?.expectRestart?.(now());
          try {
            await client.controlRestore(buffer, name);
          } catch (e) {
            if (!isAmbiguous(e)) throw e;
          }
          reconnect('restore', baseline);
        },
        { long: true, deadline: 5 * 60000 },
      );
    },
    async romd(action, confirm) {
      if (!['save', 'clear'].includes(action)) throw fail('Unknown ROMD operation.');
      requireConfirmation(confirm, action === 'save' ? 'SAVE ROMD' : 'CLEAR ROMD');
      await requireCapability('romd');
      return run(`romd:${action}`, async () => {
        await client.controlAction(action === 'save' ? 'romdSave' : 'romdClear');
      });
    },
    async partialReset(confirm, keep) {
      requireConfirmation(confirm, 'RESET');
      await requireCapability('partialReset');
      const before = (await read('backupRestore_config'))[0];
      const supported = String(before?.SupportedFactoryResetUnpurgedList ?? '')
        .split(',')
        .filter(Boolean);
      const selected =
        keep ??
        String(before?.FactoryResetUnpurgedList ?? '')
          .split(',')
          .filter((item) => supported.includes(item));
      if (!Array.isArray(selected) || selected.some((item) => typeof item !== 'string' || !supported.includes(item)))
        throw fail('Choose only settings that this router supports retaining during reset.');
      const patch = { FactoryResetUnpurgedList: [...new Set(selected)].sort().join(',') };
      const baseline = clone(info);
      return run(
        'partialReset',
        async () => {
          await client.controlWrite('backupRestore_config', 'PUT', { ...before, ...patch });
          await verifyPatch('backupRestore_config', before, patch);
          collector?.expectRestart?.(now());
          try {
            await client.controlAction('partialReset');
          } catch (e) {
            if (!isAmbiguous(e)) throw e;
          }
          reconnect('partialReset', baseline);
        },
        { long: true, deadline: 5 * 60000 },
      );
    },
    async zconsole(value) {
      await requireCapability('zconsole');
      const patch = patchObject(value, ZCONSOLE);
      if (patch.LogServerIP !== undefined && isIP(patch.LogServerIP) !== 4) throw fail('Z-console needs an IPv4 log-server address.');
      if (patch.LogServerPort !== undefined) integer(patch.LogServerPort, 1, 65535, 'Log server port');
      if (patch.BufferSize !== undefined) integer(patch.BufferSize, 5, 10240, 'Log buffer size');
      const rows = await read('zconsole');
      if (!rows[0]?.zconsole_log) throw fail('This router does not provide Z-console settings.', 502, 'unsupported');
      const next = clone(rows);
      next[0].zconsole_log = { ...next[0].zconsole_log, ...patch };
      return run('zconsole', async () => {
        await client.controlWrite('zconsole', 'PUT', next);
        const after = await read('zconsole');
        if (Object.entries(patch).some(([k, v]) => !isDeepStrictEqual(after[0]?.zconsole_log?.[k], v)))
          throw fail('The router did not keep the Z-console settings.', 409, 'readback');
        raw.zconsole = after;
      });
    },
    async diagnostics(input) {
      const kind = input?.kind;
      if (!['speedtest', 'iperf'].includes(kind)) throw fail('Choose speedtest or iperf.');
      await requireCapability(kind);
      const oid = kind === 'speedtest' ? 'PINGTEST' : 'IPERFTEST';
      let body = { ProtocolVersion: '', Host: '', DiagnosticsState: 'Requested', DNSServer: '', NumberOfRepetitions: '', type: 8 };
      if (kind === 'iperf') {
        const host = input.host;
        if (
          typeof host !== 'string' ||
          host.length > 253 ||
          !host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
        )
          throw fail('Provide an IPv4 address or hostname for the iperf server.');
        const port = integer(input.port ?? 5201, 1, 65535, 'iperf port');
        const duration = integer(input.duration ?? 10, 1, 60, 'iperf duration');
        if (input.reverse !== undefined && typeof input.reverse !== 'boolean') throw fail('iperf reverse must be true or false.');
        body = {
          ProtocolVersion: 'IPv4',
          iperf_Req: `iperf3 -c ${host} -p ${port} -t ${duration}${input.reverse ? ' -R' : ''}`,
          DiagnosticsState: 'Requested',
          NumberOfRepetitions: 20,
          type: 0,
        };
      }
      return run(
        kind,
        async () => {
          await client.controlWrite(oid, 'PUT', body);
          update({ message: 'The router is running the test.', result: { state: 'Requested', text: '' } });
          const poll = async () => {
            if (now() >= operation.deadline) {
              update({
                state: 'unknown',
                finishedAt: now(),
                message: 'The test did not finish before the deadline. Monitoring stopped; the router test was not cancelled.',
              });
              await release();
              return;
            }
            try {
              const status = (await read(oid))[0]?.DiagnosticsState;
              const result = await client.diagnosticResult();
              const text = safeText(result?.[0]?.result);
              if (status && status !== 'Requested') {
                lastDiagnostic = { kind, state: status, text, finishedAt: now() };
                update({
                  state: /complete/i.test(status) ? 'complete' : 'failed',
                  finishedAt: now(),
                  message: /complete/i.test(status) ? 'The router completed the test.' : 'The router reported a diagnostic error.',
                  result: { state: status, text },
                });
                await release();
                return;
              }
              update({ result: { state: status ?? 'Requested', text } });
            } catch {
              /* Read-only polling can recover without sending the test again. */
            }
            schedule(poll);
          };
          schedule(poll);
          update({ state: 'reconnecting', message: 'The router is running the test; waiting for results.' });
        },
        { long: true, deadline: 180000 },
      );
    },
    async wan(index, value, confirm) {
      requireConfirmation(confirm, 'SAVE WAN');
      await requireCapability('wan');
      const id = indexNumber(index);
      const patch = patchObject(value, WAN);
      const rows = await read('wan');
      const before = rows.find((o) => idOf(o) === id);
      if (!before) throw notFound('WAN interface not found.');
      const next = { ...before, ...patch };
      checkWan(next, patch, info.flags, info.level, false);
      return run(
        'wan',
        async () => {
          await client.controlWrite('wan', 'PUT', next);
          await verifyPatch('wan', before, patch, (o) => idOf(o) === id);
        },
        { long: true },
      );
    },
    async createWan(value, confirm) {
      requireConfirmation(confirm, 'SAVE WAN');
      await requireCapability('wan');
      const patch = patchObject(value, WAN);
      const next = {
        Enable: true,
        Mode: 'IP_Routed',
        Encapsulation: 'IPoE',
        ipMode: 'DualStack',
        VLANEnable: false,
        VLANID: -1,
        VLANPriority: -1,
        MaxMTUSize: 1500,
        NatEnable: true,
        ...patch,
      };
      checkWan(next, patch, info.flags, info.level, true);
      const existing = await read('wan');
      if (existing.some((o) => sameName(o.Name, next.Name))) throw conflict(`A WAN connection named ${next.Name} already exists.`);
      const known = new Set(existing.map(idOf));
      return run(
        'wan:create',
        async () => {
          await client.controlWrite('wan', 'POST', next);
          await verifyPatch('wan', null, patch, (o) => o.Name === next.Name && !known.has(idOf(o)));
        },
        { long: true },
      );
    },
    async createAccount(value) {
      await requireCapability('accounts');
      const patch = patchObject(value, ACCOUNT);
      checkAccount(patch, { creating: true });
      const rows = await read('user_account');
      if (sameName(patch.Username, client.username) || rows.some((o) => sameName(o.Username, patch.Username)))
        throw conflict('An account with this username already exists.');
      const next = { Enabled: true, group: 'User', AccountRetryTime: 3, AccountIdleTime: 300, AccountLockTime: 300, ...patch };
      return run('account:create', async () => {
        await client.controlWrite('user_account', 'POST', next);
        await verifyPatch('user_account', null, patch, (o) => o.Username === next.Username);
      });
    },
    async account(index, value) {
      await requireCapability('accounts');
      const id = indexNumber(index);
      const patch = patchObject(value, ACCOUNT);
      checkAccount(patch);
      const rows = await read('user_account');
      const before = rows.find((o) => idOf(o) === id);
      if (!before) throw notFound('Account not found.');
      if (patch.Username !== undefined && rows.some((o) => idOf(o) !== id && sameName(o.Username, patch.Username)))
        throw conflict('Another account already uses this username.');
      if (
        before.Username === client.username &&
        Object.keys(patch).some((k) => ['Username', 'Password', 'oldPw', 'group', 'Enabled'].includes(k))
      )
        throw conflict(
          'Change the account Insight uses in the router admin page, then update ROUTER_USER / ROUTER_PASSWORD and restart Insight. This screen cannot change its active credentials.',
        );
      const next = { ...before, ...patch };
      if (
        before.Enabled &&
        before.group === 'Administrator' &&
        (!next.Enabled || next.group !== 'Administrator') &&
        !rows.some((o) => idOf(o) !== id && o.Enabled && o.group === 'Administrator')
      )
        throw conflict('Keep at least one enabled administrator account.');
      return run('account', async () => {
        await client.controlWrite('user_account', 'PUT', next);
        await verifyPatch('user_account', before, patch, (o) => idOf(o) === id);
      });
    },
    async deleteAccount(index, confirm) {
      requireConfirmation(confirm, 'DELETE ACCOUNT');
      await requireCapability('accounts');
      const id = indexNumber(index);
      const rows = await read('user_account');
      const before = rows.find((o) => idOf(o) === id);
      if (!before) throw notFound('Account not found.');
      if (before.Username === client.username) throw conflict('Insight cannot delete the account it is using.');
      if (
        before.Enabled &&
        before.group === 'Administrator' &&
        !rows.some((o) => idOf(o) !== id && o.Enabled && o.group === 'Administrator')
      )
        throw conflict('Keep at least one enabled administrator account.');
      return run('account:delete', async () => {
        await client.controlWrite('user_account', 'DELETE', { Username: before.Username });
        const after = await read('user_account');
        if (after.some((o) => o.Username === before.Username)) throw fail('The router did not delete the account.', 409, 'readback');
        raw.user_account = after;
      });
    },
    async privileges(index, value) {
      await requireCapability('privileges');
      const id = indexNumber(index);
      if (![2, 3].includes(id)) throw fail('Only administrator and user menu permissions can be edited here.');
      const patch = patchObject(value, PRIVILEGE);
      const rows = await read('login_privilege');
      const before = rows.find((o) => Number(o.Index0) === id && Number(o.Index1) === 0);
      if (!before) throw notFound('The router does not expose this privilege group.');
      if (patch.Page !== undefined) {
        string(patch.Page, 0, 4096, 'Menu permissions');
        const known = new Set(pages().map((p) => p.value));
        if (
          patch.Page.split(',')
            .filter(Boolean)
            .some((p) => !known.has(p))
        )
          throw fail('A menu permission is not supported by this firmware.');
      }
      if (patch.EnableQuickStart !== undefined && !rows.some((o) => Number(o.Index0) === id && Number(o.Index1) > 0))
        throw conflict('Quick start is stored per account, and this group has no accounts yet.');
      const settings = {
        Page: patch.Page ?? before.Page ?? '',
        EnableQuickStart:
          patch.EnableQuickStart ??
          before.EnableQuickStart ??
          rows.find((o) => Number(o.Index0) === id && Number(o.Index1) > 0)?.EnableQuickStart ??
          false,
      };
      return run('privileges', async () => {
        await client.controlWrite('login_privilege', 'PUT', [{ Index0: id, Index1: id - 1 }, settings]);
        const after = await read('login_privilege');
        const group = after.find((o) => Number(o.Index0) === id && Number(o.Index1) === 0);
        const accounts = after.filter((o) => Number(o.Index0) === id && Number(o.Index1) > 0);
        if (
          !group ||
          (patch.Page !== undefined && group.Page !== patch.Page) ||
          (patch.EnableQuickStart !== undefined &&
            (!accounts.length || accounts.some((account) => account.EnableQuickStart !== patch.EnableQuickStart)))
        )
          throw fail('The router did not keep the requested login privileges.', 409, 'readback');
        raw.login_privilege = after;
      });
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      if (operation && ACTIVE.has(operation.state))
        update({
          state: 'unknown',
          finishedAt: now(),
          message: 'Insight stopped before the outcome could be verified. The request will not be resent.',
        });
      await release();
    },
  };
}
