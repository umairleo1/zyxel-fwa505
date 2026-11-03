// Credentials the router happily returns in plain text (Wi-Fi passphrase in
// `status`, SNMP communities, ACS/SMTP/DDNS passwords...). They are replaced
// before anything leaves the server; audits run on the raw values instead.

const SECRET = /(pass(word|phrase)?|psk|secret|presharedkey|^key$|wepkey|devicepin|^pin$|pin_?code|^puk$|token|credential|community)/i;
const NOT_SECRET = /passthru|remaining|enable|protection|state|type|mode|display_?flag|length/i;
export const MASK = '••••••••';

export const isSecretKey = (k) => SECRET.test(k) && !NOT_SECRET.test(k);

export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) && typeof v === 'string' && v !== '' ? MASK : maskSecrets(v);
    }
    return out;
  }
  return value;
}
