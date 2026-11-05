import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmsService, datesForSent, maskNumber, normaliseSms, slotsOf } from '../../src/sms/service.js';
import { fakeDeps, serve } from '../http/helpers.js';

// Shapes as the FWA505 (V1.71) reports them in cellwan_sms.
const routerSms = {
  SMS_Enable: true,
  SMS_UsedSpace: 3,
  SMS_TotalSpace: 50,
  SMS_Inbox: [
    {
      ObjIndex: 1,
      State: 1,
      FromType: 145,
      From: '+447700900123',
      CharacterSet: 0,
      Content: '48656C6C6F',
      TimeStamp: '26/11/03,09:15:00+00',
    },
    {
      ObjIndex: 2,
      State: 0,
      FromType: 208,
      From: '566F6461666F6E65',
      CharacterSet: 2,
      Content: '004800690020D83DDE00',
      TimeStamp: '26/11/04,10:00:00+00',
    },
    { ObjIndex: 3, State: 2, FromType: 129, From: '07700900123', CharacterSet: 0, Content: '4F6B', TimeStamp: '26/11/04,10:05:00+00' },
    null,
  ],
};

function harness({ enabled = true } = {}) {
  const writes = [];
  const audit = [];
  let t = 1_000_000;
  const client = {
    getJson: async () => ({ result: 'ZCFG_SUCCESS', Object: [routerSms] }),
    smsWrite: async (method, opts) => (writes.push([method, opts]), { result: 'ZCFG_SUCCESS' }),
  };
  const db = { insertMany: (rows) => audit.push(...rows) };
  const sms = createSmsService({ client, db, enabled, now: () => t });
  return { sms, writes, audit, advance: (ms) => (t += ms) };
}

test("the router's list becomes messages, newest first, with direction and unread", () => {
  const s = normaliseSms(routerSms);
  assert.deepEqual([s.used, s.total], [3, 50]);
  assert.deepEqual(
    s.messages.map((m) => [m.id, m.direction, m.unread, m.number, m.text]),
    [
      ['3', 'out', false, '07700900123', 'Ok'],
      ['2', 'in', true, 'Vodafone', 'Hi 😀'],
      ['1', 'in', false, '+447700900123', 'Hello'],
    ],
  );
  assert.equal(s.messages[0].at, Date.UTC(2026, 10, 4, 10, 5));
});

test('send validates, encodes like the router UI, and logs a masked number', async () => {
  const { sms, writes, audit } = harness();
  await assert.rejects(sms.send('12', 'Hi'), (e) => e.status === 400);
  await assert.rejects(sms.send('07700900123', ''), (e) => e.status === 400);
  assert.deepEqual(await sms.send('+447700900123', 'Hi'), { parts: 1, charset: 'GSM' });
  assert.equal(writes.length, 1);
  const [method, { query, body }] = writes[0];
  assert.deepEqual([method, query, body.SMS_To, body.SMS_CharacterSet], ['POST', { timedelay: 1 }, '447700900123', 'GSM']);
  assert.equal(audit[0].facility, 'sms');
  assert.equal(audit[0].message, 'SMS sent to 44•••••••123 (1 part, GSM)', 'digits, as the router stores the number');
  assert.ok(!audit[0].message.includes('Hi'), 'message text is never logged');
});

test('sending is rate limited', async () => {
  const { sms, advance } = harness();
  for (let i = 0; i < 5; i++) await sms.send('07700900123', `n${i}`);
  await assert.rejects(sms.send('07700900123', 'six'), (e) => e.status === 429 && /per minute/.test(e.message));
  advance(61_000);
  await sms.send('07700900123', 'later');
});

test("mark read and delete send the router UI's requests", async () => {
  const { sms, writes } = harness();
  await sms.markRead(2);
  await sms.remove([1, 3]);
  await assert.rejects(sms.remove([]), (e) => e.status === 400);
  await assert.rejects(sms.markRead(Number.NaN), (e) => e.status === 400);
  assert.deepEqual(writes, [
    ['PUT', { body: { setSmsState: 1, SMS_InboxObjId: 2 } }],
    ['DELETE', { query: { objIndex: '1,3' } }],
  ]);
});

test('disabled: nothing is read or written', async () => {
  const { sms, writes } = harness({ enabled: false });
  await assert.rejects(sms.list(), (e) => e.status === 404);
  await assert.rejects(sms.send('07700900123', 'Hi'), (e) => e.status === 404);
  assert.equal(writes.length, 0);
});

test('maskNumber', () => {
  assert.equal(maskNumber('+447700900123'), '+44•••••••123');
  assert.equal(maskNumber('07700900123'), '07••••••123');
  assert.equal(maskNumber('85075'), '85075', 'a short code is public');
});

test('/api/sms: writes need the CSRF header, and SMS off means no routes', async (t) => {
  const { sms, writes } = harness();
  const s = await serve(fakeDeps({ sms }));
  t.after(s.close);
  assert.equal(JSON.parse((await s.request('/api/sms')).body).messages.length, 3);
  assert.equal((await s.request('/api/sms?ids=1', { method: 'DELETE' })).status, 403, 'no X-Insight-Request header');
  assert.equal((await s.request('/api/sms?ids=1', { method: 'DELETE', headers: { 'X-Insight-Request': '1' } })).status, 200);
  assert.deepEqual(writes.at(-1), ['DELETE', { query: { objIndex: '1' } }]);

  const off = await serve(fakeDeps({ sms: null }));
  t.after(off.close);
  assert.equal((await off.request('/api/sms')).status, 404);
});

test('sent messages the router left undated get their logged send time, once and for good', () => {
  const sent = (id, number, fingerprint) => ({ id, number, fingerprint, direction: 'out', at: null });
  const log = [
    { ts: 1000, message: 'SMS sent to 07••••••505 (1 part, GSM)' },
    { ts: 2000, message: 'SMS sent to 07••••••505 (1 part, GSM)' },
    { ts: 1500, message: 'SMS sent to 44•••••••123 (2 parts, GSM)' },
    { ts: 1700, message: 'Deleted 1 SMS from the SIM' },
  ];
  const msgs = [
    sent(7, '07763836505', 'a'),
    sent(9, '07763836505', 'b'),
    sent(8, '447700900123', 'c'),
    { id: 1, direction: 'in', at: null },
  ];
  const times = datesForSent(msgs, log);
  assert.deepEqual(times, { '7:a': 1000, '8:c': 1500, '9:b': 2000 }, 'in send order, matched by number');

  // A later read keeps the same times, and a deleted message drops out.
  assert.deepEqual(datesForSent([msgs[1]], log, times), { '9:b': 2000 });
  // An index reused for a different message is a different key.
  assert.deepEqual(datesForSent([sent(7, '07763836505', 'z')], log, { '7:a': 1000 }), { '7:z': 2000 });
});

test('list() fills in sent times from the log and remembers them', async () => {
  const meta = new Map();
  const db = {
    insertMany() {},
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => meta.set(k, v),
    query: () => [{ ts: 5000, message: 'SMS sent to 07••••••505 (1 part, GSM)' }],
  };
  const client = {
    // As the real FWA505 lists a sent text: State 2, no TimeStamp.
    getJson: async () => ({
      result: 'ZCFG_SUCCESS',
      Object: [
        { SMS_Inbox: [{ ObjIndex: 4, State: 2, FromType: 129, From: '07763836505', CharacterSet: 1, Content: 'Hi yeah', TimeStamp: '' }] },
      ],
    }),
  };
  const sms = createSmsService({ client, db, enabled: true });
  const first = await sms.list();
  assert.equal(first.messages[0].at, 5000);
  assert.ok(JSON.parse(meta.get('smsSentAt')), 'remembered');
  assert.ok(!meta.get('smsSentAt').includes('Hi yeah'), 'a hash, never the text');
});

test('the unread count follows the inbox, and reading it updates the badge', async () => {
  const counts = [];
  let state = 0; // the one received message: unread, then read
  const client = {
    getJson: async () => ({
      result: 'ZCFG_SUCCESS',
      Object: [
        {
          SMS_Inbox: [
            {
              ObjIndex: 1,
              State: state,
              FromType: 145,
              From: '+447700900123',
              CharacterSet: 1,
              Content: 'Hi',
              TimeStamp: '26/11/04,10:00:00+00',
            },
          ],
        },
      ],
    }),
    smsWrite: async () => {
      state = 1;
      return { result: 'ZCFG_SUCCESS' };
    },
  };
  const sms = createSmsService({ client, db: { insertMany() {} }, enabled: true, onUnread: (n) => counts.push(n) });
  assert.equal(sms.unread, null, 'unknown before the first read');
  await sms.list();
  assert.equal(sms.unread, 1);
  await sms.markRead(1);
  await new Promise((r) => setTimeout(r, 0)); // the follow-up read
  assert.equal(sms.unread, 0);
  assert.deepEqual(counts, [1, 0], 'fires only on change');
});

test('own number: the SIM wins; otherwise the one you entered, kept in Insight', async () => {
  const meta = new Map();
  const db = { insertMany() {}, getMeta: (k) => meta.get(k) ?? null, setMeta: (k, v) => meta.set(k, v) };
  let sim = null; // most SIMs leave MSISDN empty
  const sms = createSmsService({ client: {}, db, enabled: true, simNumber: async () => sim });

  assert.deepEqual(await sms.ownNumber(), { number: null, source: null });
  assert.deepEqual(await sms.setOwnNumber(' 07763 836505 '), { number: '07763 836505', source: 'manual' });
  await assert.rejects(sms.setOwnNumber('12'), (e) => e.status === 400);
  sim = '+447763836505';
  assert.deepEqual(await sms.ownNumber(), { number: '+447763836505', source: 'sim' });
  sim = null;
  assert.deepEqual(await sms.setOwnNumber(''), { number: null, source: null }, 'cleared');
});

test('multi-part texts: the router lists one entry over several SIM slots ("4,5,")', async () => {
  assert.deepEqual(slotsOf(1), [1]);
  assert.deepEqual(slotsOf('4,5,'), [4, 5]);
  assert.deepEqual(slotsOf(' 2, 3 '), [2, 3]);
  for (const bad of ['', 'x', null, undefined, -1, 1.5, '4,x,']) assert.deepEqual(slotsOf(bad), [], String(bad));

  // As read from a real FWA505 (V1.71): ObjIndex a number for one part, "a,b," for more.
  const s = normaliseSms({
    SMS_Inbox: [
      {
        ObjIndex: 1,
        MsgID: 10,
        State: 1,
        FromType: 208,
        From: '4C79636120',
        CharacterSet: 0,
        Content: '4869',
        TimeStamp: '26/10/14,09:00:00+04',
      },
      { ObjIndex: '4,5,', MsgID: 11, State: 2, FromType: 0, From: '07763836505', CharacterSet: 0, Content: '4869', TimeStamp: '' },
      {
        ObjIndex: '2,3,',
        MsgID: 12,
        State: 0,
        FromType: 208,
        From: '4C79636120',
        CharacterSet: 0,
        Content: '4869',
        TimeStamp: '26/11/03,12:00:00+00',
      },
    ],
  });
  assert.deepEqual(
    s.messages.map((m) => [m.id, m.slots]),
    [
      ['2,3', [2, 3]],
      ['1', [1]],
      ['4,5', [4, 5]],
    ],
  );

  const writes = [];
  const client = {
    getJson: async () => ({ result: 'ZCFG_SUCCESS', Object: [{ SMS_Inbox: [] }] }),
    smsWrite: async (...a) => (writes.push(a), { result: 'ZCFG_SUCCESS' }),
  };
  const sms = createSmsService({ client, db: { insertMany() {} }, enabled: true });
  await sms.markRead('2,3');
  await sms.remove([4, 5]);
  assert.deepEqual(writes, [
    ['PUT', { body: { setSmsState: 1, SMS_InboxObjId: '2,3,' } }],
    ['DELETE', { query: { objIndex: '4,5' } }],
  ]);
});
