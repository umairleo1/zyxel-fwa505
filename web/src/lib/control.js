const ACTIVE = new Set(['running', 'reconnecting']);
const MASK = '••••••••';

export const operationActive = (operation) => ACTIVE.has(operation?.state);
// An unknown outcome blocks new commands until its deadline, or until it is acknowledged.
export const operationBlocks = (operation, now = Date.now()) =>
  operationActive(operation) || (operation?.state === 'unknown' && !(operation.deadline <= now));
// The server accepts an acknowledgement once the deadline has passed, or as soon as the
// router's configuration has been read back after a restart.
export const operationAcknowledgeable = (operation, now = Date.now()) =>
  operation?.state === 'unknown' && (operation.deadline <= now || !!operation.result?.configurationReadable);

const OPERATIONS = {
  firmwareCheck: 'Firmware check',
  firmwareSettings: 'Update schedule',
  firmwareInstall: 'Firmware installation',
  'backup:configuration': 'Configuration download',
  'backup:romd': 'ROM-D download',
  restore: 'Configuration restore',
  'romd:save': 'Save ROM-D',
  'romd:clear': 'Clear ROM-D',
  partialReset: 'Partial reset',
  zconsole: 'Z-console settings',
  speedtest: 'Speed test',
  iperf: 'iperf test',
  wan: 'WAN change',
  'wan:create': 'New WAN connection',
  account: 'Account change',
  'account:create': 'New account',
  'account:delete': 'Account deletion',
  privileges: 'Login privileges',
};
export const operationLabel = (kind) => OPERATIONS[kind] ?? kind ?? 'Router operation';

const STATES = {
  running: 'Running',
  reconnecting: 'Waiting for the router',
  complete: 'Complete',
  failed: 'Failed',
  unknown: 'Outcome unverified',
  acknowledged: 'Acknowledged',
};
export const operationStateLabel = (state) => STATES[state] ?? state;

const FIELDS = {
  PeriodicCheckEnable: 'Automatic checks',
  PeriodicMode: 'Check period',
  PeriodicStartDay: 'Check day',
  StartTime: 'Start hour',
  ShiftTimeRange: 'Update window',
  ForceUpgrade: 'Install automatically',
  Enable: 'Enabled',
  Enabled: 'Enabled',
  Type: 'Interface type',
  Mode: 'Connection mode',
  Encapsulation: 'Encapsulation',
  VLANEnable: 'VLAN',
  VLANID: 'VLAN ID',
  VLANPriority: 'VLAN priority',
  MaxMTUSize: 'MTU',
  NatEnable: 'NAT',
  FullConeEnabled: 'Full-cone NAT',
  sysGwEnable: 'IPv4 default route',
  sysGw6Enable: 'IPv6 default route',
  ipMode: 'IP protocol',
  pppUsername: 'PPP username',
  pppPassword: 'PPP password',
  ConnectionTrigger: 'Connection trigger',
  IdleDisconnectTime: 'Idle disconnect',
  IGMPEnable: 'IGMP proxy',
  MLDEnable: 'MLD proxy',
  ipStatic: 'Static IPv4',
  IPAddress: 'IP address',
  SubnetMask: 'Subnet mask',
  GatewayIPAddress: 'Gateway',
  ipDnsStatic: 'Static IPv4 DNS',
  DNSServer: 'DNS servers',
  ip6Static: 'Static IPv6',
  IP6Address: 'IPv6 address',
  NextHop: 'IPv6 next hop',
  ip6DnsStatic: 'Static IPv6 DNS',
  DNS6Server: 'IPv6 DNS servers',
  Name: 'Name',
  Username: 'Username',
  group: 'Group',
  Password: 'Password',
  AccountRetryTime: 'Failed attempts before lock',
  AccountIdleTime: 'Idle timeout',
  AccountLockTime: 'Lock period',
  LogServerIP: 'Receiver address',
  LogServerPort: 'Receiver port',
  BufferSize: 'Buffer size',
  BufferOverwrite: 'Overwrite old entries',
  UseCommonServer: 'Common TCP receiver',
};
const minutes = (s) => `${Number(s) / 60} min`;
const VALUES = {
  PeriodicMode: (v) => ['Daily', 'Weekly', 'Monthly'][v] ?? v,
  ShiftTimeRange: (v) => `${Number(v) / 3600} h`,
  StartTime: (v) => `${String(v).padStart(2, '0')}:00`,
  IdleDisconnectTime: (v) => `${v} s`,
  AccountIdleTime: minutes,
  AccountLockTime: minutes,
  Mode: (v) => ({ IP_Routed: 'Routing', IP_Bridged: 'Bridge' })[v] ?? v,
};
const showValue = (key, value) =>
  typeof value === 'boolean' ? (value ? 'on' : 'off') : VALUES[key] ? String(VALUES[key](value)) : String(value);

/** Only send edited fields; an empty password means keep the router's current secret. */
export function controlPatch(original, draft, keys, secrets = []) {
  const secretSet = new Set(secrets);
  return Object.fromEntries(
    keys
      .filter((key) => draft[key] !== undefined)
      .filter((key) => !secretSet.has(key) || (draft[key] !== '' && draft[key] !== MASK))
      .filter((key) => draft[key] !== original[key])
      .map((key) => [key, draft[key]]),
  );
}

export function controlSummary(patch) {
  return Object.entries(patch).map(
    ([key, value]) => `${FIELDS[key] ?? key}: ${/pass|secret|oldPw/i.test(key) ? 'change password' : showValue(key, value)}`,
  );
}

/** The row's own index, as the server reads it; null when the router didn't send one (never a position). */
export const controlIndex = (row) => row.Index ?? row.index ?? row.Iid ?? null;

/** Keep unknown native page identifiers available when editing an existing group. */
export function privilegePages(value) {
  return [...new Set((Array.isArray(value) ? value : String(value ?? '').split(',')).map((v) => String(v).trim()).filter(Boolean))];
}

// Router menu identifiers whose names don't read well with underscores replaced.
const PAGES = {
  connect: 'Connection status',
  McastSt: 'Multicast status',
  CallHistory_id: 'Call history',
  Diagnostic_id: 'Diagnostics',
  TR369_LocalAgent: 'TR-369 local agent',
  'TR-069_Client': 'TR-069 client',
  xDSL_Statistics: 'xDSL statistics',
  WLAN_Table: 'WLAN table',
  WWAN_Statistics: 'WWAN statistics',
  GPON_Status: 'GPON status',
  CellWan_Status: 'Cellular WAN status',
  ARP_Table: 'ARP table',
  QoS: 'QoS',
  NAT: 'NAT',
  DNS: 'DNS',
  SIP: 'SIP',
  SNMP: 'SNMP',
  EoGRE: 'EoGRE',
  PPTP_VPN: 'PPTP VPN',
  IPsec_VPN: 'IPsec VPN',
  VPN_Status: 'VPN status',
  USB_Service: 'USB service',
  MAC_Filter: 'MAC filter',
  Remote_MGMT: 'Remote management',
  SP_Domain: 'SP domain',
  IGMP_MLD: 'IGMP/MLD',
};
export const pageLabel = (value) => PAGES[value] ?? value.replaceAll('_', ' ');
