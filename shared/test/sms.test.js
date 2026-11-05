import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutbox,
  decodeContent,
  decodeGsm,
  decodeSender,
  isValidNumber,
  measure,
  normaliseNumber,
  packGsm,
  parseSmsTime,
} from '../sms.js';

// ── The router UI's own encoder (FWA505 V1.71 web UI, "AddNewCellWanSms"), ported verbatim
// as the oracle: what the modem is known to accept.
const DEF = [
  ...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
];
const EXT = Array(128).fill('');
Object.assign(EXT, { 20: '^', 40: '{', 41: '}', 47: '\\', 60: '[', 61: '~', 62: ']', 64: '|', 101: '€' });
function uiGsm(t, concatenated) {
  const n = [];
  let a = '';
  if (concatenated) for (let i = 0; i <= 6; i++) n.push('0000000');
  t.replace(/(.|[\r\n])/g, (ch) => {
    let tbl = DEF;
    if (EXT.indexOf(ch) !== -1) {
      n.push('0011011');
      tbl = EXT;
    }
    const b = tbl.indexOf(ch).toString(2).slice(-7);
    n.push('0000000'.substring(b.length) + b);
  });
  n.forEach((t, e, arr) => {
    if ((e + 1) % 8 !== 0) {
      const o = arr[e + 1] ?? '';
      const i = o.slice(-(e + 1) % 8) + t.slice(0, 7 - (e % 8));
      const s = parseInt(i, 2).toString(16);
      a += '00'.substring(s.length) + s;
    }
  });
  return concatenated ? a.substring(12) : a;
}

test('GSM packing matches the standard vector and the router UI, byte for byte', () => {
  assert.equal(packGsm([...'hello'].map((c) => DEF.indexOf(c))), 'e8329bfd06');
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?@£$¥èé€[]{}~^|\\\n';
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 300; k++) {
    const len = 1 + Math.floor(rnd() * 150);
    const text = Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
    for (const concatenated of [false, true]) {
      const codes = [...text].flatMap((ch) => (EXT.includes(ch) && ch ? [27, EXT.indexOf(ch)] : [DEF.indexOf(ch)]));
      assert.equal(packGsm(codes, { afterHeader: concatenated }), uiGsm(text, concatenated), JSON.stringify({ text, concatenated }));
    }
  }
});

test('measure: GSM vs Unicode, escapes cost two, parts at 160/153 and 70/67', () => {
  assert.deepEqual(measure('Hi'), { charset: 'GSM', length: 2, parts: 1, concatenated: false, max: 1071, ok: true, nonGsm: [] });
  assert.equal(measure('€5').length, 3, 'the euro sign is an escaped character');
  assert.equal(measure('a'.repeat(160)).parts, 1);
  assert.equal(measure('a'.repeat(161)).parts, 2);
  assert.equal(measure('a'.repeat(307)).parts, 3);
  const u = measure('Salām سلام');
  assert.deepEqual([u.charset, u.parts], ['UCS2', 1]);
  assert.deepEqual(u.nonGsm.slice(0, 2), ['ā', 'س']);
  assert.equal(measure('😀'.repeat(36)).parts, 2, '72 code units > 70');
  assert.equal(measure('').ok, false);
  assert.equal(measure('a'.repeat(1072)).ok, false);
});

test('buildOutbox: a short GSM message is what the router UI would POST', () => {
  const o = buildOutbox('+44 7700 900123', 'Hello');
  assert.deepEqual(o, {
    SMS_Format: 0,
    SMS_CharacterSet: 'GSM',
    SMS_To: '447700900123',
    SMS_ContentLength: 5,
    SMS_TimeStamp: '',
    SMS_Content: uiGsm('Hello', false),
    SMS_Content_divLen: [5],
    SMS_Content_divData: [uiGsm('Hello', false)],
  });
});

test('buildOutbox: long messages become parts with a header, Unicode as UCS-2', () => {
  const text = `${'a'.repeat(153)}${'b'.repeat(10)}`; // 163 > 160: two parts
  const o = buildOutbox('07700900123', text, { reference: 0x2a });
  assert.equal(o.SMS_Content_divData.length, 2);
  assert.equal(o.SMS_Content_divData[0].slice(0, 12), '0500032a0201');
  assert.equal(o.SMS_Content_divData[1].slice(0, 12), '0500032a0202');
  assert.equal(o.SMS_Content_divData[0].slice(12), uiGsm('a'.repeat(153), true));
  assert.equal(o.SMS_Content_divData[1].slice(12), uiGsm('b'.repeat(10), true));
  assert.deepEqual(o.SMS_Content_divLen, [7 + 153, 7 + 10]);
  assert.equal(o.SMS_ContentLength, 10, 'the last part, as the UI leaves it');
  assert.ok(buildOutbox('07700900123', 'a'.repeat(160)).SMS_Content_divData[0].length < 300, '160 still fits one SMS');

  const u = buildOutbox('07700900123', 'Привет');
  assert.equal(u.SMS_CharacterSet, 'UCS2');
  assert.equal(u.SMS_Content, '041f04400438043204350442');
  assert.deepEqual(u.SMS_Content_divLen, [6]);
});

test('buildOutbox never splits an emoji or an escaped character across parts', () => {
  const emoji = buildOutbox('07700900123', `${'x'.repeat(66)}😀tail`, { reference: 1 });
  const parts = emoji.SMS_Content_divData.map((d) => d.slice(12));
  assert.ok(parts[0].endsWith('0078'), 'the first part stops before the emoji');
  assert.ok(parts[1].startsWith('d83dde00'), 'both halves travel together');

  // 152 + € (2 septets) + 10 = 164: the euro sign would straddle septets 153/154, so it moves on.
  const gsm = buildOutbox('07700900123', `${'a'.repeat(152)}€${'b'.repeat(10)}`, { reference: 1 });
  assert.deepEqual(gsm.SMS_Content_divLen, [7 + 152, 7 + 12]);
  assert.throws(() => buildOutbox('07700900123', ''), /empty/);
});

test('reading: GSM septets with escapes, UCS-2, alphanumeric senders, timestamps', () => {
  assert.equal(decodeGsm('48656C6C6F'), 'Hello');
  assert.equal(decodeGsm('1B6535'), '€5');
  assert.equal(decodeContent(2, '041F04400438043204350442'), 'Привет');
  assert.equal(decodeContent(2, 'D83DDE00'), '😀');
  assert.equal(decodeContent(1, 'plain'), 'plain');
  assert.equal(decodeSender(0xd0, '566F6461666F6E65'), 'Vodafone');
  assert.equal(decodeSender(0x91, '+447700900123'), '+447700900123');
  assert.equal(parseSmsTime('26/11/04,14:22:01+00'), Date.UTC(2026, 10, 4, 14, 22, 1));
  assert.equal(parseSmsTime('26/07/04,14:22:01+04'), Date.UTC(2026, 6, 4, 13, 22, 1), 'BST is +4 quarter hours');
  assert.equal(parseSmsTime('nonsense'), null);
});

test('numbers: any common grouping, or a short code', () => {
  for (const ok of ['+447700900123', '+44 7700 900123', '07700900123', '(077) 009-00123', '+1 (415) 555-0100', '85075', '150']) {
    assert.ok(isValidNumber(ok), ok);
  }
  for (const bad of ['', 'abc', '12', '+150', '07700 9001', '4477009001234567', '0770090012x', '++447700900123']) {
    assert.ok(!isValidNumber(bad), bad);
  }
  assert.equal(normaliseNumber('+44 (0) 7700-900123'), '4407700900123');
});
