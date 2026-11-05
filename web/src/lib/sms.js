// Messages tab: grouping the SIM's flat message list into conversations.
import { normaliseNumber } from '@zyxel-insight/shared/sms';

/**
 * Conversation key, so one person is one thread however their number was written:
 * received "+44 7700 900123", sent "447700900123" (the router stores digits only) and
 * typed "07700 900123" all end in the same 9 digits, which is how national and
 * international forms line up without knowing the country code. Short codes and named
 * senders ("EE") key as they are.
 */
const KEY_DIGITS = 9;
export const threadKey = (number) => {
  const s = String(number ?? '');
  if (!/^[+\d\s().-]+$/.test(s)) return `name:${s.toLowerCase()}`;
  const digits = normaliseNumber(s);
  return digits.length > KEY_DIGITS ? digits.slice(-KEY_DIGITS) : digits;
};

/** Pure: messages (any order) -> conversations, most recent first, each oldest-first inside. */
export function groupThreads(messages = []) {
  const byKey = new Map();
  for (const m of messages) {
    const key = threadKey(m.number);
    const t = byKey.get(key) ?? { key, numbers: new Set(), messages: [] };
    t.numbers.add(m.number);
    t.messages.push(m);
    byKey.set(key, t);
  }
  return [...byKey.values()]
    .map((t) => {
      const msgs = t.messages.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
      // Show the international form when we've seen it; it's the one people recognise.
      const numbers = [...t.numbers];
      return {
        key: t.key,
        title: numbers.find((n) => n.startsWith('+')) ?? numbers[0],
        replyTo: numbers.find((n) => n.startsWith('+')) ?? numbers[0],
        named: t.key.startsWith('name:'),
        messages: msgs,
        last: msgs.at(-1),
        unread: msgs.filter((m) => m.unread).length,
      };
    })
    .sort((a, b) => (b.last.at ?? 0) - (a.last.at ?? 0) || (b.last.seq ?? 0) - (a.last.seq ?? 0));
}

const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);
const DAY = 86400e3;
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Conversation list time, like a phone: "14:59" today, "Yesterday", the weekday this week, else "3 Nov". */
export function listTime(ts, now = Date.now()) {
  if (!ts) return '';
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days <= 0) return time.format(ts);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekday.format(ts);
  return dayMonth.format(ts);
}

/** Separator above each day's messages in a thread: "Today", "Yesterday", "Monday 3 November 2026". */
export function dayLabel(ts, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return full.format(ts);
}

/** Pure: a thread's messages (oldest first) split by local day, for separators. */
export function byDay(messages) {
  const days = [];
  for (const m of messages) {
    const key = m.at ? startOfDay(m.at) : 0;
    if (days.at(-1)?.key !== key) days.push({ key, messages: [] });
    days.at(-1).messages.push(m);
  }
  return days;
}

/** Conversations whose name, number or any message text contains `q` (case-insensitive). */
export function filterThreads(threads, q) {
  const s = q.trim().toLowerCase();
  if (!s) return threads;
  const digits = s.replace(/\D/g, '');
  return threads.filter(
    (t) =>
      t.title.toLowerCase().includes(s) ||
      (digits.length >= 3 && t.key.includes(digits.slice(-9))) ||
      t.messages.some((m) => m.text.toLowerCase().includes(s)),
  );
}
