import crypto from 'node:crypto';
import fs from 'node:fs';

const clone = (value) => structuredClone(value);
const envelope = (Object = []) => ({ result: 'ZCFG_SUCCESS', Object });
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};
const denied = (res) => json(res, 403, { result: 'ZCFG_PERMISSION_DENIED' });
const fixture = (oid) => {
  const path = new URL(`./fixtures/DAL_oid_${oid}.json`, import.meta.url);
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')).Object : [];
};

async function bytes(req, max = 17 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const b = await bytes(req, 1024 * 1024);
  return b.length ? JSON.parse(b.toString()) : {};
}

/** Stateful native endpoint simulator. No network listener or background timer is started on import. */
export function createControlMock(options = {}) {
  const sessions = options.sessions ?? new Map();
  const delayMs = Number(options.delayMs ?? process.env.MOCK_CONTROL_DELAY_MS ?? 50);
  const rebootMs = Number(options.rebootMs ?? process.env.MOCK_REBOOT_MS ?? 500);
  // Like the real router, keep answering for a moment after accepting a restart, then go down.
  const lingerMs = Number(options.lingerMs ?? process.env.MOCK_REBOOT_LINGER_MS ?? 0);
  const overrideLevel = options.level ?? process.env.MOCK_ACCOUNT_LEVEL;
  const denyControl = options.denyControl ?? process.env.MOCK_DENY_CONTROL ?? false;
  const flags = {
    showOnline_FirmwareUpgrade: true,
    OnlineFirmwareUpgradeForDT: true,
    SHOW_ENABLE_ONLINE_FW_UPGRADE: true,
    showPartialReset: true,
    supportSpeedTest: options.speedTestEnabled ?? process.env.MOCK_SPEEDTEST_ENABLED !== 'false',
    show_zconsole_log: options.zconsoleEnabled ?? process.env.MOCK_ZCONSOLE_ENABLED === 'true',
    ABOG_GUI_Customization: false,
    ...options.flags,
  };
  const accounts = [
    {
      Index: 1,
      Enabled: true,
      Username: 'supervisor',
      group: 'Supervisor',
      AccountRetryTime: 3,
      AccountIdleTime: 300,
      AccountLockTime: 300,
    },
    { Index: 2, Enabled: true, Username: 'admin', group: 'Administrator', AccountRetryTime: 3, AccountIdleTime: 300, AccountLockTime: 300 },
    { Index: 3, Enabled: true, Username: 'user', group: 'User', AccountRetryTime: 3, AccountIdleTime: 300, AccountLockTime: 300 },
  ];
  const passwords = new Map(accounts.map((a) => [a.Username, 'mock']));
  const state = {
    flags,
    device: { ModelName: 'FWA505', SoftwareVersion: 'V1.71(ACKO.0)C0' },
    accounts,
    privileges: [
      { Index0: 2, Index1: 0, Page: 'Broadband,Wireless,Home_Networking,Maintenance', HiddenPage: '' },
      { Index0: 3, Index1: 0, Page: 'Log,Diagnostic_id', HiddenPage: '' },
      ...accounts.map((a) => ({ Index0: a.Index, Index1: 1, Username: a.Username, EnableQuickStart: true })),
    ],
    fota: fixture('periodic_FOTA_config')?.[0] ?? {
      PeriodicCheckEnable: false,
      PeriodicMode: 0,
      PeriodicStartDay: 0,
      StartTime: 1,
      ShiftTimeRange: 14400,
      ForceUpgrade: false,
    },
    firmware: { FWVersion: 'V1.72(ACKO.0)C0', FWReleaseDate: '2026-12-01', FWSize: '64000000' },
    zconsole: { zconsole_log: { Enable: false, LogServerIP: '192.168.1.2', LogServerPort: 514, BufferSize: 64, ...options.zconsole } },
    wan: clone(options.wan ?? fixture('wan')),
    reset: {
      SupportedFactoryResetUnpurgedList: 'ResetKeep_1,ResetKeep_2,ResetKeep_3,ResetKeep_4,ResetKeep_5',
      FactoryResetUnpurgedList: 'ResetKeep_2',
    },
    diagnostics: { PINGTEST: { DiagnosticsState: 'None' }, IPERFTEST: { DiagnosticsState: 'None' } },
    diagnosticText: '',
    romd: null,
    romdExport: new Set(),
    restored: null,
    downUntil: 0,
    actions: [],
    logins: 0,
  };
  const levelFor = (account) =>
    ['high', 'medium', 'low'].includes(overrideLevel)
      ? overrideLevel
      : account.group === 'Supervisor'
        ? 'high'
        : account.group === 'Administrator'
          ? 'medium'
          : 'low';
  const authenticate = (req) => {
    const cookie = /Authentication=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const session = cookie ? sessions.get(cookie) : undefined;
    return { authed: !!session, ...session, token: cookie };
  };
  const restart = (kind) => {
    const down = () => {
      state.downUntil = Date.now() + rebootMs;
      sessions.clear();
      options.onRestart?.(kind, rebootMs);
    };
    if (lingerMs > 0) setTimeout(down, lingerMs).unref?.();
    else down();
  };
  const blocked = (name) => denyControl === true || denyControl === 'true' || String(denyControl).split(',').includes(name);

  async function handleAuth(req, res) {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/getRSAPublickKey') {
      json(res, 200, { RSAPublicKey: 'None' });
      return true;
    }
    if (url.pathname === '/UserLogin' && req.method === 'POST') {
      state.logins++;
      const body = await readJson(req);
      const account = state.accounts.find((a) => a.Username === body.Input_Account && a.Enabled);
      if (!account || passwords.get(account.Username) !== Buffer.from(body.Input_Passwd ?? '', 'base64').toString()) {
        json(res, 401, { result: 'Invalid Username or Password' });
        return true;
      }
      const token = crypto.randomBytes(16).toString('hex');
      const sessionKey = String(crypto.randomInt(1, 1e9));
      const level = levelFor(account);
      sessions.set(token, { level, username: account.Username, sessionKey });
      json(
        res,
        200,
        { sessionkey: sessionKey, loginAccount: account.Username, loginLevel: level },
        { 'Set-Cookie': `Authentication=${token}; Path=/; HttpOnly` },
      );
      return true;
    }
    if (url.pathname === '/cgi-bin/UserLogout') {
      sessions.delete(authenticate(req).token);
      json(res, 200, { result: 'ZCFG_SUCCESS' });
      return true;
    }
    return false;
  }

  function configuration() {
    return Buffer.from(
      JSON.stringify({
        format: 'FWA505-MOCK-CONFIG-1',
        fota: state.fota,
        wan: state.wan,
        zconsole: state.zconsole,
        marker: 'native configuration export',
      }),
    );
  }

  async function handle(req, res, session = authenticate(req)) {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/getWebGuiFlag') {
      json(res, 200, flags);
      return true;
    }
    if (url.pathname === '/getCustomizationData') {
      json(res, 200, { ACCOUNT_MGT: true, SHOW_ENABLE_ONLINE_FW_UPGRADE: flags.SHOW_ENABLE_ONLINE_FW_UPGRADE });
      return true;
    }
    if (url.pathname === '/getBasicInformation') {
      json(res, 200, { result: 'ZCFG_SUCCESS', ...state.device });
      return true;
    }
    const oid = url.pathname === '/cgi-bin/DAL' ? url.searchParams.get('oid') : '';
    const handledOid = [
      'periodic_FOTA_config',
      'online_fw_info',
      'zconsole',
      'wan',
      'user_account',
      'login_privilege',
      'PINGTEST',
      'IPERFTEST',
      'backupRestore_config',
    ].includes(oid);
    const nativePaths = [
      '/cgi-bin/loginAccountLevel',
      '/cgi-bin/Online_Firmware_Upgrade',
      '/cgi-bin/ROMD',
      '/tagRomdBackupFlag',
      '/cgi-bin/Backup_Restore',
      '/cgi-bin/Diagnostic_Result',
    ];
    if (!handledOid && !nativePaths.includes(url.pathname)) return false;
    if (!session.authed) {
      json(res, 401, { result: 'Unauthorized' });
      return true;
    }
    if (blocked(oid || url.pathname)) {
      denied(res);
      return true;
    }
    const high = session.level === 'high';
    const low = session.level === 'low';
    if (url.pathname === '/cgi-bin/loginAccountLevel') {
      json(res, 200, [{ level: session.level }]);
      return true;
    }
    if (req.method !== 'GET' && url.searchParams.get('sessionkey') !== session.sessionKey) {
      json(res, 401, { result: 'Invalid session key' });
      return true;
    }
    const key = session.token ?? session.username ?? session.sessionKey;
    if (url.pathname === '/tagRomdBackupFlag') {
      if (!high) denied(res);
      else {
        state.romdExport.add(key);
        json(res, 200, { Recv_tagRomdBackupFlag: 1 });
      }
      return true;
    }
    if (url.pathname === '/cgi-bin/ROMD') {
      if (!high) {
        denied(res);
        return true;
      }
      const action = url.searchParams.get('action');
      if (req.method !== 'POST' || !['save', 'clean'].includes(action)) {
        json(res, 400, { Ret: 'ZCFG_INVALID_PARAM_VALUE' });
        return true;
      }
      state.romd = action === 'save' ? configuration() : null;
      state.actions.push(`romd:${action}`);
      json(res, 200, { Ret: 'ZCFG_SUCCESS' });
      return true;
    }
    if (url.pathname === '/cgi-bin/Backup_Restore') {
      const action = url.searchParams.get('action');
      if (low) {
        denied(res);
        return true;
      }
      if (req.method === 'GET' && action === 'Backup') {
        const romd = state.romdExport.delete(key);
        if (romd && !high) {
          denied(res);
          return true;
        }
        if (romd && !state.romd) {
          json(res, 409, { result: 'ZCFG_NOT_FOUND' });
          return true;
        }
        const body = romd ? state.romd : configuration();
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${romd ? 'defaults' : 'configuration'}.rom"`,
        });
        res.end(body);
        return true;
      }
      if (req.method === 'POST' && action === 'Restore') {
        const raw = await bytes(req);
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] ?? '');
        const prefix = raw.indexOf('\r\n\r\n');
        const end = boundary ? raw.lastIndexOf(Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}--`)) : -1;
        if (!boundary || prefix < 0 || end < prefix || !raw.subarray(0, prefix).includes('name="mtenRestoreCfg"')) {
          json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
          return true;
        }
        const payload = raw.subarray(prefix + 4, end);
        let restored;
        try {
          restored = JSON.parse(payload.toString());
        } catch {
          /* rejected below */
        }
        if (restored?.format !== 'FWA505-MOCK-CONFIG-1') {
          json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
          return true;
        }
        state.restored = Buffer.from(payload);
        state.fota = clone(restored.fota);
        state.wan = clone(restored.wan);
        state.zconsole = clone(restored.zconsole);
        state.actions.push('configuration:restore');
        json(res, 200, { result: 'ZCFG_SUCCESS' });
        restart('restore');
        return true;
      }
      if (req.method === 'POST' && action === 'PartialReset' && flags.showPartialReset) {
        state.actions.push('configuration:partialReset');
        json(res, 200, { result: 'ZCFG_SUCCESS' });
        restart('partialReset');
        return true;
      }
      json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
      return true;
    }
    if (url.pathname === '/cgi-bin/Online_Firmware_Upgrade') {
      if (low || !flags.showOnline_FirmwareUpgrade) {
        denied(res);
        return true;
      }
      state.actions.push(url.searchParams.get('action') === 'online' ? 'firmware:install' : 'firmware:check');
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      json(res, 200, { result: 'ZCFG_SUCCESS' });
      if (url.searchParams.get('action') === 'online') {
        state.device.SoftwareVersion = state.firmware.FWVersion;
        restart('firmware');
      }
      return true;
    }
    if (url.pathname === '/cgi-bin/Diagnostic_Result') {
      json(res, 200, [{ result: state.diagnosticText }]);
      return true;
    }
    if (
      (oid === 'zconsole' && (!high || !flags.show_zconsole_log)) ||
      (oid === 'IPERFTEST' && !high) ||
      (oid === 'login_privilege' && !high)
    ) {
      denied(res);
      return true;
    }
    if (low && !['PINGTEST', 'user_account'].includes(oid)) {
      denied(res);
      return true;
    }
    if (req.method === 'GET') {
      if (oid === 'PINGTEST' || oid === 'IPERFTEST') {
        const run = state.diagnostics[oid];
        if (run.DiagnosticsState === 'Requested' && Date.now() >= run.completeAt) {
          run.DiagnosticsState = /fail\.example/.test(run.Host ?? run.value ?? '') ? 'Error_CannotResolveHostName' : 'Complete';
          state.diagnosticText =
            run.DiagnosticsState === 'Complete'
              ? oid === 'IPERFTEST'
                ? '[SUM] 0.00-10.00 sec 112 MBytes 94.0 Mbits/sec sender'
                : Number(run.type) === 8
                  ? 'Download: 312.5 Mbps\nUpload: 48.2 Mbps\nLatency: 21 ms'
                  : '4 packets transmitted, 4 received, 0% packet loss'
              : 'Unable to resolve the diagnostic host';
        }
        json(res, 200, envelope([{ ...run, completeAt: undefined }]));
        return true;
      }
      const values = {
        periodic_FOTA_config: [state.fota],
        online_fw_info: [state.firmware],
        zconsole: [state.zconsole],
        wan: state.wan,
        user_account: state.accounts.filter((a) => high || a.Username === session.username).map((a) => ({ ...a })),
        login_privilege: state.privileges,
        backupRestore_config: [state.reset],
      };
      json(res, 200, envelope(clone(values[oid])));
      return true;
    }
    const body = req.method === 'DELETE' ? Object.fromEntries(url.searchParams) : await readJson(req);
    if (oid === 'periodic_FOTA_config' || oid === 'zconsole' || oid === 'backupRestore_config') {
      if (req.method !== 'PUT' || low) {
        denied(res);
        return true;
      }
      if (oid === 'zconsole') {
        if (!Array.isArray(body) || !body[0]?.zconsole_log) {
          json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
          return true;
        }
        state.zconsole = clone(body[0]);
      } else Object.assign(oid === 'periodic_FOTA_config' ? state.fota : state.reset, body);
    } else if (oid === 'PINGTEST' || oid === 'IPERFTEST') {
      if (req.method !== 'PUT' || (Number(body.type) === 8 && !flags.supportSpeedTest)) {
        denied(res);
        return true;
      }
      state.diagnostics[oid] = { ...body, DiagnosticsState: 'Requested', completeAt: Date.now() + Math.max(30, delayMs) };
      state.diagnosticText = 'Test running…';
    } else if (oid === 'wan') {
      if (low || !['POST', 'PUT'].includes(req.method)) {
        denied(res);
        return true;
      }
      const index = Number(body.Index ?? body.index);
      const row = state.wan.find((w) => Number(w.Index ?? w.index) === index);
      const locked = [
        'pppUsername',
        'pppPassword',
        'pppConnectionTrigger',
        'VLANID',
        'VLANPriority',
        'VLANEnable',
        'Encapsulation',
        'Mode',
        'VPI',
        'VCI',
      ];
      if (!high && flags.ABOG_GUI_Customization && locked.some((k) => Object.hasOwn(body, k) && body[k] !== row?.[k])) {
        denied(res);
        return true;
      }
      if (req.method === 'POST') state.wan.push({ ...body, index: Math.max(0, ...state.wan.map((w) => w.index ?? 0)) + 1 });
      else if (row) Object.assign(row, body);
      else {
        json(res, 404, { result: 'ZCFG_NOT_FOUND' });
        return true;
      }
    } else if (oid === 'user_account') {
      if (low || (!high && body.Username !== session.username)) {
        denied(res);
        return true;
      }
      if (req.method === 'DELETE') {
        const account = state.accounts.find((a) => a.Username === body.Username);
        if (!account || account.Username === session.username) {
          json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
          return true;
        }
        state.accounts.splice(state.accounts.indexOf(account), 1);
        passwords.delete(account.Username);
        state.privileges = state.privileges.filter((p) => p.Username !== account.Username);
      } else if (req.method === 'POST') {
        if (!high) {
          denied(res);
          return true;
        }
        if (state.accounts.some((a) => a.Username === body.Username)) {
          json(res, 409, { result: 'ZCFG_REQUEST_REJECT' });
          return true;
        }
        const account = { ...body, Index: Math.max(...state.accounts.map((a) => a.Index)) + 1 };
        delete account.Password;
        delete account.verifyNewpassword;
        delete account.oldPw;
        state.accounts.push(account);
        passwords.set(account.Username, body.Password || 'mock');
        state.privileges.push({
          Index0: account.Index,
          Index1: 1,
          Username: account.Username,
          Page: '',
          HiddenPage: '',
          EnableQuickStart: false,
        });
      } else if (req.method === 'PUT') {
        const updates = Array.isArray(body) ? body : [body];
        for (const update of updates) {
          const account = state.accounts.find((a) => a.Index === update.Index);
          if (!account || (!high && (account.Username !== session.username || (update.group && update.group !== account.group)))) {
            denied(res);
            return true;
          }
          if (update.Username && state.accounts.some((a) => a !== account && a.Username === update.Username)) {
            json(res, 409, { result: 'ZCFG_REQUEST_REJECT' });
            return true;
          }
          const clean = { ...update };
          delete clean.Password;
          delete clean.verifyNewpassword;
          delete clean.oldPw;
          if (update.Password) passwords.set(update.Username ?? account.Username, update.Password);
          Object.assign(account, clean);
        }
      } else {
        json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
        return true;
      }
    } else if (oid === 'login_privilege') {
      if (!high || req.method !== 'PUT') {
        denied(res);
        return true;
      }
      const [key, update] = Array.isArray(body) ? body : [];
      if (
        body.length !== 2 ||
        ![2, 3].includes(key?.Index0) ||
        key.Index1 !== key.Index0 - 1 ||
        !update ||
        typeof update.Page !== 'string' ||
        typeof update.EnableQuickStart !== 'boolean'
      ) {
        json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
        return true;
      }
      const row = state.privileges.find((p) => p.Index0 === key.Index0 && p.Index1 === 0);
      row.Page = update.Page;
      for (const account of state.privileges.filter((p) => p.Index0 === key.Index0 && p.Index1 > 0))
        account.EnableQuickStart = update.EnableQuickStart;
    } else {
      json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
      return true;
    }
    state.actions.push(`${req.method}:${oid}`);
    json(res, 200, envelope(oid === 'PINGTEST' || oid === 'IPERFTEST' ? [{ ...state.diagnostics[oid], completeAt: undefined }] : []));
    return true;
  }

  const handler = async (req, res) => {
    try {
      if (Date.now() < state.downUntil) return req.socket.destroy();
      if (await handleAuth(req, res)) return;
      if (await handle(req, res)) return;
      json(res, 404, { result: 'ZCFG_NOT_FOUND' });
    } catch {
      if (!res.headersSent) json(res, 400, { result: 'ZCFG_INVALID_PARAM_VALUE' });
      else res.end();
    }
  };
  return { handle, handleAuth, authenticate, handler, sessions, state };
}
