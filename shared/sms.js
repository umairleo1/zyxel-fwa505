// SMS as the FWA505 speaks it, shared by the server (building what it sends, decoding
// what it reads) and the UI (the live character / part counter while you type).
//
// Mirrors the router's own web UI (V1.71, "Cellular SMS" page) rather than a textbook
// encoder, because the modem expects exactly what that page sends. Two deliberate
// differences, both noted where they happen: a Unicode message doesn't double-count
// {}[]~ (the UI counts their GSM escape even when it isn't used), and no part ever
// splits a surrogate pair (an emoji).

/** GSM 03.38 default alphabet. Index 27 is the escape to the extension table, never a character. */
const DEFAULT =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const ESC = 27;
/** Extension table: these cost two septets (escape + code). */
const EXTENSION = { 20: '^', 40: '{', 41: '}', 47: '\\', 60: '[', 61: '~', 62: ']', 64: '|', 101: '€' };
const EXT_CODE = new Map(Object.entries(EXTENSION).map(([code, ch]) => [ch, Number(code)]));
const DEFAULT_CODE = new Map([...DEFAULT].map((ch, i) => [ch, i]).filter(([, i]) => i !== ESC));

// Payload is 140 bytes; a concatenated part spends 6 of them on its header (UDH).
const PAYLOAD_BYTES = 140;
const UDH_BYTES = 6;
const MAX_PARTS = 7; // as the router's UI allows
export const LIMITS = {
  GSM: { single: 160, part: Math.floor(((PAYLOAD_BYTES - UDH_BYTES) * 8) / 7) }, // 160 / 153
  UCS2: { single: PAYLOAD_BYTES / 2, part: (PAYLOAD_BYTES - UDH_BYTES) / 2 }, // 70 / 67
};

const isGsm = (ch) => DEFAULT_CODE.has(ch) || EXT_CODE.has(ch);
const hex2 = (n) => n.toString(16).padStart(2, '0');

// ── Reading ──────────────────────────────────────────────────────────────────

/** GSM text as the router reports it: one hex byte per septet (unpacked), 1B escaping into the extension table. */
export function decodeGsm(hex) {
  const codes = (String(hex).match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16));
  let out = '';
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === ESC && i + 1 < codes.length) out += EXTENSION[codes[++i]] ?? DEFAULT[codes[i]] ?? '';
    else out += DEFAULT[codes[i]] ?? '';
  }
  return out;
}

/** Message text from the inbox: CharacterSet 0 = GSM (hex septets), 1 = plain, 2 = UCS-2 (4 hex per unit). */
export function decodeContent(characterSet, content) {
  const s = String(content ?? '');
  switch (Number(characterSet)) {
    case 0:
      return decodeGsm(s);
    case 2:
      return s.replace(/([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    default:
      return s;
  }
}

/** Sender: an alphanumeric sender (type of address 0x5_, e.g. "Vodafone") arrives GSM-encoded. */
export const decodeSender = (fromType, from) => ((Number(fromType) & 0x50) === 0x50 ? decodeGsm(from) : String(from ?? ''));

/**
 * The modem's "yy/MM/dd,hh:mm:ss+zz" (zz in quarter hours, per 3GPP TS 27.005) as epoch
 * ms, or null. Without a zone the time is taken as local, like the router's UI does.
 */
export function parseSmsTime(ts) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})(?:([+-])(\d{1,2}))?/.exec(String(ts ?? ''));
  if (!m) return null;
  const [, yy, mo, dd, hh, mi, ss, sign, q] = m;
  const parts = [2000 + Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi), Number(ss)];
  if (!sign) return new Date(...parts).getTime();
  const offsetMs = (sign === '-' ? -1 : 1) * Number(q) * 15 * 60e3;
  return Date.UTC(...parts) - offsetMs;
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * What a message will cost before sending: character set, length in septets (GSM) or
 * UTF-16 units (UCS-2), parts, and whether it's within the 7-part limit. Pure; the UI
 * shows this live.
 */
export function measure(text) {
  const s = normalise(text);
  const unicode = [...s].some((ch) => !isGsm(ch));
  const charset = unicode ? 'UCS2' : 'GSM';
  const length = unicode ? s.length : [...s].reduce((n, ch) => n + (EXT_CODE.has(ch) ? 2 : 1), 0);
  const lim = LIMITS[charset];
  const concatenated = length > lim.single;
  const parts = length === 0 ? 0 : concatenated ? Math.ceil(length / lim.part) : 1;
  const max = lim.part * MAX_PARTS;
  return {
    charset,
    length,
    parts,
    concatenated,
    max,
    ok: length > 0 && length <= max,
    nonGsm: unicode ? [...new Set([...s].filter((ch) => !isGsm(ch)))] : [],
  };
}

/** A no-break space is shown like a space but isn't one: send a space (the UI would send the GSM escape). */
const normalise = (text) => String(text ?? '').replace(/\u00a0/g, ' ');

/** The router UI's number filter: digits only ("+44 7700 900123" -> "447700900123"). */
export const normaliseNumber = (to) => String(to ?? '').replace(/\D/g, '');

/**
 * A phone number (10-15 digits, the E.164 maximum, in any common grouping such as
 * "+44 7700 900123" or "(077) 009-00123") or a 3-7 digit short code. Looser than the
 * router UI, which only takes one grouping; what's sent is the digits either way.
 */
export function isValidNumber(to) {
  const s = String(to ?? '').trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return false;
  const digits = normaliseNumber(s);
  return (digits.length >= 10 && digits.length <= 15) || (!s.startsWith('+') && /^[1-9]\d{2,6}$/.test(digits));
}

/** Split into parts of at most `size` units, never between the halves of a surrogate pair. */
function splitUnits(s, size) {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length && /[\ud800-\udbff]/.test(s[end - 1])) end--;
    parts.push(s.slice(i, end));
    i = end;
  }
  return parts;
}

/** GSM parts of at most `size` septets; an escaped character never straddles two parts. */
function splitSeptets(s, size) {
  const parts = [];
  let cur = '';
  let n = 0;
  for (const ch of s) {
    const w = EXT_CODE.has(ch) ? 2 : 1;
    if (n + w > size) {
      parts.push(cur);
      cur = '';
      n = 0;
    }
    cur += ch;
    n += w;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Septet codes for GSM text (escaped characters become 1B + code). */
const septets = (s) => [...s].flatMap((ch) => (EXT_CODE.has(ch) ? [ESC, EXT_CODE.get(ch)] : [DEFAULT_CODE.get(ch)]));

/**
 * Pack septets into octets, least significant bit first (GSM 03.38 §6.1.2.1.1), as hex.
 * With a UDH, the first character starts on a septet boundary after the header: the
 * router UI does this by packing 7 zero septets in front and dropping the 6 header
 * bytes, which leaves exactly one fill bit. Same result here.
 */
export function packGsm(codes, { afterHeader = false } = {}) {
  const all = afterHeader ? [...Array(UDH_BYTES + 1).fill(0), ...codes] : codes;
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const c of all) {
    acc |= c << bits;
    bits += 7;
    while (bits >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) bytes.push(acc & 0xff);
  return bytes
    .slice(afterHeader ? UDH_BYTES : 0)
    .map(hex2)
    .join('');
}

// Per UTF-16 code unit, as the UI does: an emoji becomes its two surrogate halves.
const toUcs2 = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('');

/**
 * The object the router's UI POSTs to /cgi-bin/DAL?oid=cellwan_sms for one message.
 * `reference` (0-255) ties the parts of a long message together; random by default.
 */
export function buildOutbox(to, text, { reference = Math.floor(Math.random() * 256) } = {}) {
  const s = normalise(text);
  const m = measure(s);
  if (!m.ok) throw new Error(m.length === 0 ? 'The message is empty' : `The message is too long (${m.length}/${m.max})`);
  const lim = LIMITS[m.charset];
  const encode = (part, afterHeader) => (m.charset === 'GSM' ? packGsm(septets(part), { afterHeader }) : toUcs2(part));
  const units = (part) => (m.charset === 'GSM' ? septets(part).length : part.length);
  const pieces = m.concatenated ? (m.charset === 'GSM' ? splitSeptets(s, lim.part) : splitUnits(s, lim.part)) : [s];

  const divData = [];
  const divLen = [];
  pieces.forEach((part, i) => {
    if (!m.concatenated) {
      divData.push(encode(part, false));
      divLen.push(units(part));
      return;
    }
    // UDH: length 05, IEI 00 (8-bit reference), IE length 03, reference, total, sequence.
    const udh = `050003${hex2(reference & 0xff)}${hex2(pieces.length)}${hex2(i + 1)}`;
    divData.push(udh + encode(part, true));
    // Length in septets including the header's 7 (48 bits rounded up), as the UI reports it.
    divLen.push(Math.ceil((UDH_BYTES * 8) / 7) + units(part));
  });

  return {
    SMS_Format: 0,
    SMS_CharacterSet: m.charset,
    SMS_To: normaliseNumber(to),
    // The UI leaves the last part's length here; the modem uses the per-part fields.
    SMS_ContentLength: units(pieces.at(-1)),
    SMS_TimeStamp: '',
    SMS_Content: m.charset === 'GSM' ? packGsm(septets(s), { afterHeader: m.concatenated }) : toUcs2(s),
    SMS_Content_divLen: divLen,
    SMS_Content_divData: divData,
  };
}
