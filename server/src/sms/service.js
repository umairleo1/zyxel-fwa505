// The Messages tab: the router SIM's SMS inbox and outbox, read live from the router
// (Insight keeps no copy of your messages), plus send / mark read / delete. These are
// the only writes Insight makes to the router; see RouterClient#isSmsWrite.
import crypto from 'node:crypto';
import { buildOutbox, decodeContent, decodeSender, isValidNumber, measure, normaliseNumber, parseSmsTime } from '@zyxel-insight/shared/sms';
import { RouterError } from '../router/client.js';

// A runaway script (or a stuck key) shouldn't be able to run up a bill.
export const SEND_LIMITS = [
  { windowMs: 60_000, max: 5 },
  { windowMs: 3600e3, max: 30 },
];
const SMS_PATH = '/cgi-bin/DAL?oid=cellwan_sms';
// The router keeps no time on sent messages (its own UI posts an empty one). Insight logs
// every send it makes, so each sent message gets the time of its send, remembered here
// as { "<id>:<content hash>": epoch ms }. A hash, never the text.
const SENT_AT_META = 'smsSentAt';
const SENT_LOG = /^SMS sent to \S*?(\d{3}) \(/; // "SMS sent to 07••••••505 (1 part, GSM)"
const lastDigits = (n) => normaliseNumber(n).slice(-3);

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** "+44•••••••123": enough to recognise a number in the log, not to read it off. */
export const maskNumber = (n) => {
  const s = String(n ?? '');
  const head = s.startsWith('+') ? 3 : 2;
  // Short codes (and anything too short to hide part of) are shown as they are.
  return s.length <= head + 3 ? s : `${s.slice(0, head)}${'•'.repeat(s.length - head - 3)}${s.slice(-3)}`;
};

/**
 * SIM slots a message occupies. The router joins a multi-part text into one entry and
 * lists its slots as a string ("4,5,"); a single-part one has a plain number.
 */
export function slotsOf(objIndex) {
  if (typeof objIndex === 'number') return Number.isInteger(objIndex) && objIndex >= 0 ? [objIndex] : [];
  const parts = String(objIndex ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  return parts.length && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : [];
}

/** Pure: the router's cellwan_sms object -> what the UI needs, newest first. */
export function normaliseSms(o = {}) {
  const messages = (Array.isArray(o.SMS_Inbox) ? o.SMS_Inbox : [])
    .filter((m) => m && typeof m === 'object')
    .map((m, i) => ({
      // "4,5" for a text stored in slots 4 and 5; what the UI deletes and marks read by.
      id: slotsOf(m.ObjIndex).join(',') || `msg-${m.MsgID ?? i}`,
      slots: slotsOf(m.ObjIndex),
      seq: Math.min(...slotsOf(m.ObjIndex), Number.MAX_SAFE_INTEGER), // router order, for ties
      // Identifies the message even if the router reuses an index after a delete.
      fingerprint: crypto.createHash('sha1').update(`${m.From}|${m.Content}`).digest('hex').slice(0, 12),
      // State: 0 unread, 1 read, 2 sent (the router keeps sent messages in the same list).
      direction: Number(m.State) === 2 ? 'out' : 'in',
      unread: Number(m.State) === 0,
      number: decodeSender(m.FromType, m.From),
      text: decodeContent(m.CharacterSet, m.Content),
      at: parseSmsTime(m.TimeStamp),
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.seq - a.seq);
  return {
    enabled: o.SMS_Enable !== false,
    used: o.SMS_UsedSpace ?? null,
    total: o.SMS_TotalSpace ?? null,
    messages,
  };
}

/**
 * Pure: times for sent messages the router left undated. Each takes the earliest send
 * logged for the same number (last 3 digits, which is what the log keeps) that no other
 * message has claimed, in the order the router numbered them. `known` (from earlier
 * reads) wins, so a time never moves once given. Returns the map for messages still on
 * the SIM, so deleted ones drop out.
 */
export function datesForSent(messages, sendLog, known = {}) {
  const key = (m) => `${m.id}:${m.fingerprint}`;
  const claimed = new Set(Object.values(known));
  const pool = new Map(); // last 3 digits -> unclaimed send times, oldest first
  for (const { ts, message } of [...sendLog].sort((a, b) => a.ts - b.ts)) {
    const d = SENT_LOG.exec(message)?.[1];
    if (!d || claimed.has(ts)) continue;
    pool.set(d, [...(pool.get(d) ?? []), ts]);
  }
  const next = {};
  const undated = messages.filter((m) => m.direction === 'out' && m.at == null).sort((a, b) => a.seq - b.seq);
  for (const m of undated) {
    const t = known[key(m)] ?? pool.get(lastDigits(m.number))?.shift();
    if (t != null) next[key(m)] = t;
  }
  return next;
}

// How often the unread count behind the sidebar badge is refreshed in the background: a
// new text shows within this on any page. Only while someone has Insight open (see
// isReady in index.js).
export const UNREAD_CHECK_MS = 60_000;

/**
 * onUnread(n) fires when the unread count changes (the router's own SMSNew flag isn't
 * cleared by marking messages read, so the badge counts the inbox instead). isReady()
 * says whether the router may be read right now (collector running, not paused).
 */
// Your own number, typed in on the Messages page when the SIM doesn't report it (most don't).
const OWN_NUMBER_META = 'smsOwnNumber';

/**
 * simNumber() resolves to the SIM's own number if the router reports one (MSISDN), or
 * null: it's empty on most SIMs, so a number entered on the page is the fallback.
 */
export function createSmsService({
  client,
  db,
  enabled,
  now = Date.now,
  onUnread = () => {},
  isReady = () => true,
  simNumber = async () => null,
}) {
  const sent = []; // send times, for SEND_LIMITS
  let unread = null; // unknown until the first read
  let timer = null;
  const noteUnread = (sms) => {
    const n = sms.messages.filter((m) => m.unread).length;
    if (n !== unread) {
      unread = n;
      onUnread(n);
    }
    return sms;
  };

  const audit = (level, message) => {
    try {
      db.insertMany([{ ts: now(), source: 'insight', facility: 'sms', level, message }]);
    } catch {
      // the log is a record, not a gate: a full disk mustn't block a send
    }
  };
  const readSentAt = () => {
    try {
      return JSON.parse(db.getMeta(SENT_AT_META) ?? '{}') ?? {};
    } catch {
      return {};
    }
  };
  /** Fill in sent messages' times from Insight's send log (see datesForSent). */
  function withSentTimes(sms) {
    if (!sms.messages.some((m) => m.direction === 'out' && m.at == null)) return sms;
    try {
      const known = readSentAt();
      const log = db.query({ sources: ['insight'], facilities: ['sms'] }, 1000);
      const times = datesForSent(sms.messages, log, known);
      if (JSON.stringify(times) !== JSON.stringify(known)) db.setMeta(SENT_AT_META, JSON.stringify(times));
      const timed = (m) => (m.at == null ? (times[`${m.id}:${m.fingerprint}`] ?? null) : m.at);
      const messages = sms.messages.map((m) => ({ ...m, at: timed(m) })).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.seq - a.seq);
      return { ...sms, messages };
    } catch {
      return sms; // times are a nicety; the messages are what matter
    }
  }
  const requireEnabled = () => {
    if (!enabled) throw Object.assign(new Error('SMS is disabled (SMS_ENABLED=false)'), { status: 404 });
  };

  return {
    enabled,
    /** { number, source: 'sim' | 'manual' } or { number: null }: the SIM's own number wins. */
    async ownNumber() {
      requireEnabled();
      const sim = await simNumber().catch(() => null);
      if (sim) return { number: String(sim), source: 'sim' };
      const manual = db.getMeta(OWN_NUMBER_META);
      return manual ? { number: manual, source: 'manual' } : { number: null, source: null };
    },

    /** Remember (or with '' forget) the number shown when the SIM doesn't report one. Stored in Insight only. */
    async setOwnNumber(number) {
      requireEnabled();
      const n = String(number ?? '').trim();
      if (n && !isValidNumber(n)) throw badRequest('Enter a phone number (10-15 digits)');
      db.setMeta(OWN_NUMBER_META, n);
      return this.ownNumber();
    },

    /** Unread received messages at the last read, or null before the first. */
    get unread() {
      return unread;
    },

    /** Keep the unread count fresh in the background (no-op when SMS is off). */
    start() {
      if (!enabled || timer) return;
      const check = () => isReady() && this.list().catch(() => {}); // a missed check just waits for the next
      setTimeout(check, 8_000).unref?.(); // after the collector's first login
      timer = setInterval(check, UNREAD_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },

    async list() {
      requireEnabled();
      const data = await client.getJson(SMS_PATH, { priority: 'high' });
      if (data?.result && data.result !== 'ZCFG_SUCCESS') throw new RouterError('http', `cellwan_sms: ${data.result}`);
      return noteUnread(withSentTimes(normaliseSms(Array.isArray(data?.Object) ? data.Object[0] : {})));
    },

    async send(to, text) {
      requireEnabled();
      if (!isValidNumber(to)) throw badRequest('Enter a phone number (10-15 digits) or a short code');
      const m = measure(text);
      if (!m.ok) throw badRequest(m.length ? `Too long: ${m.length} of ${m.max} characters` : 'The message is empty');
      const t = now();
      for (const { windowMs, max } of SEND_LIMITS) {
        if (sent.filter((s) => t - s < windowMs).length >= max) {
          throw Object.assign(new Error(`Sending is limited to ${max} messages per ${windowMs >= 3600e3 ? 'hour' : 'minute'}`), {
            status: 429,
          });
        }
      }
      sent.push(t);
      sent.splice(0, Math.max(0, sent.length - 100));
      await client.smsWrite('POST', { query: { timedelay: 1 }, body: buildOutbox(to, text) });
      audit(
        'notice',
        // The number as the router stores it (digits), so the log lines up with the message (datesForSent).
        `SMS sent to ${maskNumber(normaliseNumber(to))} (${m.parts} part${m.parts === 1 ? '' : 's'}, ${m.charset === 'UCS2' ? 'Unicode' : 'GSM'})`,
      );
      return { parts: m.parts, charset: m.charset };
    },

    /** id: the message's slots, "2" or "2,3". Sent back the way the router listed it. */
    async markRead(id) {
      requireEnabled();
      const slots = slotsOf(id);
      if (!slots.length) throw badRequest('Unknown message');
      // As the router's own page does: its ObjIndex as given, "2,3," for a multi-part text.
      const objId = slots.length === 1 ? slots[0] : `${slots.join(',')},`;
      await client.smsWrite('PUT', { body: { setSmsState: 1, SMS_InboxObjId: objId } });
      this.list().catch(() => {}); // badge follows straight away
    },

    /** ids: SIM slots (every slot of every message to delete). */
    async remove(ids) {
      requireEnabled();
      if (!ids.length || !ids.every((id) => Number.isInteger(id) && id >= 0)) throw badRequest('Unknown message');
      await client.smsWrite('DELETE', { query: { objIndex: ids.join(',') } });
      this.list().catch(() => {});
      audit('notice', `Deleted ${ids.length} SMS from the SIM`);
    },
  };
}
