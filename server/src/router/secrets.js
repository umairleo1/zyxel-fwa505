// Credentials the router happily returns in plain text (Wi-Fi passphrase in
// `status`, SNMP communities, ACS/SMTP/DDNS passwords, TR-069 provisioning
// keys, certificates...). They are replaced before anything leaves the server;
// audits run on the raw values instead.

const SECRET = /(pass(word|phrase)?|psk|secret|key|devicepin|pin$|pin_?code|puk$|token|credential|community|cert|provision|private)/i;
// Look-alikes that describe a secret rather than hold one (flags, counters, sizes, interface refs).
const NOT_SECRET =
  /passthr(u|ough)|remaining|enable|protection|state|status|type|mode|display_?flag|length|size|bits|interval|lifetime|expir|rekey|interface|intf|index|check|verify|method|format|algorithm|source|number|count|policy/i;
export const MASK = '••••••••';

// Names that always hold a secret, whatever else they contain ("PasswordVerify",
// "SourcePassword"): the look-alike list must not unmask these.
const ALWAYS_SECRET = /pass(word|phrase|wd)|psk|secret|private_?key|credential/i;

export const isSecretKey = (k) => ALWAYS_SECRET.test(k) || (SECRET.test(k) && !NOT_SECRET.test(k));

/**
 * Replace secret strings and numbers (PINs, numeric keys) with MASK. `keep` lists
 * keys to leave alone even if they look secret (e.g. identifiers the UI shows).
 */
export function maskSecrets(value, { keep = null } = {}) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const masked = isSecretKey(k) && !keep?.test(k) && ((typeof x === 'string' && x !== '') || typeof x === 'number');
        out[k] = masked ? MASK : walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
