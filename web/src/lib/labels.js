// Turn router field names ("X_ZYXEL_DHCP_LeaseTime", "wlEnable") into readable labels.
const ACRONYMS = [
  'IPv4',
  'IPv6',
  'IP',
  'DNS',
  'DHCP',
  'MTU',
  'SSID',
  'BSSID',
  'WPS',
  'WMM',
  'NAT',
  'MAC',
  'LAN',
  'WAN',
  'NTP',
  'APN',
  'PDP',
  'SIM',
  'PIN',
  'PUK',
  'IMSI',
  'ICCID',
  'IMEI',
  'RSRP',
  'RSRQ',
  'SINR',
  'RSSI',
  'RSCP',
  'CQI',
  'MCS',
  'PMI',
  'RI',
  'PCI',
  'RFCN',
  'TAC',
  'LAC',
  'RAC',
  'BSIC',
  'UPnP',
  'QoS',
  'ALG',
  'DMZ',
  'SIP',
  'RTSP',
  'PPTP',
  'FTP',
  'TFTP',
  'L2TP',
  'URL',
  'ID',
  'ACL',
  'DoS',
  'IGMP',
  'MLD',
  'VLAN',
  'USB',
  'UDP',
  'TCP',
  'SNMP',
  'TR069',
  'CWMP',
  'ACS',
  'MQTT',
  'NSA',
  'NR',
  'LTE',
  'MCC',
  'MNC',
  'ULA',
  'DUID',
  'STB',
  'HTTP',
  'HTTPS',
  'SSH',
  'GW',
  'IPsec',
  'FOTA',
  'EUI64',
  'RA',
  'CLAT',
  'XLAT',
  'PSK',
  'AES',
  'TKIP',
  'WEP',
  'WPA',
  'OUI',
];
const ACR = new Map(ACRONYMS.map((a) => [a.toLowerCase(), a]));
const OVERRIDES = {
  wlEnable: 'Enabled',
  wlHide: 'Hidden SSID',
  PskDisplay: 'Password',
  encryp: 'Encryption',
  extcha: 'Extension channel',
  band: 'Band',
  DHCP_LeaseTime: 'DHCP lease time',
  USIM_Status: 'SIM status',
  INTF_Network_In_Use: 'Network in use',
  DMZHost: 'DMZ host',
  EnableCWMP: 'TR-069 (CWMP) enabled',
  UpTime: 'Uptime',
  CPUUsage: 'CPU usage',
  Level_GUI: 'Security level',
  enableDos: 'DoS protection',
};

export function humanize(key) {
  if (OVERRIDES[key]) return OVERRIDES[key];
  // Already a display label (hand-written in a page): leave it alone.
  if (/[\s()/]/.test(key)) return key;
  const clean = key.replace(/^(X_ZYXEL_|INTF_|Intf_)/, '');
  const words = clean
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ACR.get(w.toLowerCase()) ?? w.toLowerCase());
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Fields that are plumbing, not information.
const NOISE = /(^|_)(iid|idx)$|^index\d*$|path$|numberofentries$|^obj_|_ref$|^changeiconname$|^tr181path$|^iid$/i;
export const isNoise = (key) => NOISE.test(key);

export const isEmpty = (v) => v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** Router enums worth translating. */
const ENUMS = {
  USIM_Status: {
    DEVST_SIM_RDY: 'Ready',
    DEVST_SIM_NOT_INSERTED: 'Not inserted',
    DEVST_SIM_PIN: 'PIN required',
    DEVST_SIM_PUK: 'PUK required',
  },
  Antenna_Status: { 0: 'External', 1: 'Internal' },
};
export const enumLabel = (key, v) => ENUMS[key]?.[v] ?? null;

const SECONDS_KEY = /(lease_?time|interval|_time$|idletime|locktime|uptime)$/i;
export function secondsHint(key, v) {
  if (typeof v !== 'number' || v < 60 || !SECONDS_KEY.test(key)) return null;
  const d = Math.floor(v / 86400);
  const h = Math.floor((v % 86400) / 3600);
  const m = Math.floor((v % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || null;
}
