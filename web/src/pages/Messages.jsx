import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useInterval, useMediaQuery } from '../hooks/index.js';
import { useToast } from '../app/live.js';
import { LIMITS, isValidNumber, measure } from '@zyxel-insight/shared/sms';
import { byDay, dayLabel, filterThreads, groupThreads, listTime, threadKey } from '../lib/sms.js';
import { formatFull } from '../lib/format.js';
import { ErrorNote, PageHeader, PageLoader } from '../components/ui/index.js';
import { ChevronLeft, Message, Pencil, Plus, Refresh, Search, Send, Trash, User, X } from '../components/ui/Icons.jsx';

const REFRESH_MS = 20_000; // new texts show up without a reload
const ONE_PANE = '(max-width: 760px)';
const GROUP_MS = 3 * 60e3; // bubbles this close together, same direction, sit as one group
const COMPOSE_MIN_PX = 44;
const COMPOSE_MAX_PX = 180;

/**
 * SMS on the router's SIM. Messages are read live from the router (Insight keeps no
 * copy); sending, marking read and deleting are the only things Insight ever changes
 * on the router.
 */
export default function Messages() {
  // Not useLive: that changes on every status push and would re-render the whole page each second.
  const toast = useToast();
  const onePane = useMediaQuery(ONE_PANE);
  const r = useAsync(() => api.sms(), []);
  const reload = r.reload; // stable
  // The spinner is for refreshes you ask for; the background ones every 20 s stay invisible.
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (!r.loading) setManual(false);
  }, [r.loading]);
  useInterval(() => document.visibilityState === 'visible' && reload(), REFRESH_MS);

  const threads = useMemo(() => groupThreads(r.data?.messages), [r.data]);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterThreads(threads, query), [threads, query]);
  const [openKey, setOpenKey] = useState(null); // null: nothing chosen yet; 'new': writing to a new number
  // Side by side, the newest conversation opens by default, but as a real choice: a text
  // arriving in another conversation reorders the list, it doesn't switch what you're reading.
  useEffect(() => {
    if (!onePane && openKey == null && threads.length) setOpenKey(threads[0].key);
  }, [onePane, openKey, threads]);
  const open = openKey === 'new' ? null : (threads.find((t) => t.key === openKey) ?? null);
  // Sends in flight or failed, shown in their thread until the router lists them.
  const [pending, setPending] = useState([]);
  // A first text to a new number has no thread yet: keep showing the composer until it does.
  const composingNew = openKey === 'new' || (openKey && !open && pending.some((p) => p.key === openKey)) || (r.data && !threads.length);
  const showList = !onePane || openKey == null;
  const showThread = !onePane || openKey != null;

  const send = async (to, text, retryOf = null) => {
    const id = retryOf ?? `p${Date.now()}${Math.random()}`;
    const item = { id, key: threadKey(to), to, text, status: 'sending', at: Date.now() };
    setPending((p) => [...p.filter((x) => x.id !== id), item]);
    try {
      await api.smsSend(to, text);
      // Shown as sent until the next read of the SIM lists it, so it never blinks out.
      setPending((p) => p.map((x) => (x.id === id ? { ...x, status: 'sent' } : x)));
      reload();
      return true;
    } catch (e) {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, status: 'failed', error: e.message } : x)));
      return false;
    }
  };

  useEffect(() => {
    setPending((p) => (p.some((x) => x.status === 'sent') ? p.filter((x) => x.status !== 'sent') : p));
  }, [r.data]);

  // Opening a conversation reads it, like a phone: mark its unread messages read on the router.
  const marking = useRef(new Set());
  useEffect(() => {
    const unread = (open?.messages ?? []).filter((m) => m.unread && !marking.current.has(m.id));
    if (!unread.length) return;
    for (const m of unread) marking.current.add(m.id);
    (async () => {
      try {
        for (const m of unread) await api.smsMarkRead(m.id);
        reload();
      } catch (e) {
        for (const m of unread) marking.current.delete(m.id); // try again next time
        toast(`Couldn't mark as read: ${e.message}`, 'critical');
      }
    })();
  }, [open, reload, toast]);

  const removeThread = async (t) => {
    try {
      // Every SIM slot of every message: a long text occupies several.
      await api.smsDelete(t.messages.flatMap((m) => m.slots));
      if (openKey === t.key) setOpenKey(null);
      toast(`Conversation with ${t.title} deleted from the SIM`);
      reload();
    } catch (e) {
      toast(`Couldn't delete: ${e.message}`, 'critical');
    }
  };
  const removeMessage = async (m) => {
    try {
      await api.smsDelete(m.slots);
      reload();
    } catch (e) {
      toast(`Couldn't delete: ${e.message}`, 'critical');
    }
  };
  const openPending = composingNew ? pending.filter((p) => p.key === openKey) : [];

  return (
    <div className="page sms-page">
      {!r.data && r.loading && <PageLoader />}
      <PageHeader
        title={
          <span className="sms-title">
            Messages
            <OwnNumber />
          </span>
        }
        subtitle="Texts on the router's SIM, read live from the router. Sending, marking read and deleting here are the only things Insight changes on your router."
      >
        {r.data?.total > 0 && <SimMeter used={r.data.used} total={r.data.total} />}
        <button
          className="btn btn-sm btn-icon"
          onClick={() => {
            setManual(true);
            reload();
          }}
          aria-label="Refresh messages"
          title="Refresh"
        >
          <Refresh size={14} className={manual && r.loading ? 'spin' : undefined} />
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => setOpenKey('new')}>
          <Plus size={14} /> New message
        </button>
      </PageHeader>
      <ErrorNote error={r.error} />
      {r.data?.total > 0 && r.data.used >= r.data.total && (
        <div className="banner banner-warning inline-banner" role="status">
          The SIM is full: new texts may not arrive until you delete some.
        </div>
      )}

      <div className={`sms ${onePane ? 'is-one-pane' : ''}`}>
        {showList && (
          <aside className="sms-list panel" aria-label="Conversations">
            <div className="sms-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search conversations"
              />
            </div>
            <div className="sms-list-scroll">
              {r.data && !threads.length && <p className="sms-empty-list">No texts on the SIM yet.</p>}
              {r.data && threads.length > 0 && !shown.length && <p className="sms-empty-list">Nothing matches “{query.trim()}”.</p>}
              <ul>
                {shown.map((t) => (
                  <ThreadRow
                    key={t.key}
                    thread={t}
                    active={open?.key === t.key}
                    onOpen={() => setOpenKey(t.key)}
                    onDelete={() => removeThread(t)}
                  />
                ))}
              </ul>
            </div>
          </aside>
        )}

        {showThread && (
          <section className="sms-view panel" aria-label={open ? `Conversation with ${open.title}` : 'New message'}>
            {composingNew ? (
              <NewMessage
                pending={openPending}
                // Nothing to go back to before the first text; otherwise ✕ or Escape cancels.
                onClose={threads.length ? () => setOpenKey(null) : null}
                onRetry={(p) => send(p.to, p.text, p.id)}
                onDismiss={(p) => setPending((x) => x.filter((y) => y.id !== p.id))}
                onSend={(to, text) => {
                  setOpenKey(threadKey(to));
                  return send(to, text);
                }}
              />
            ) : open ? (
              <>
                <header className="sms-view-head">
                  {onePane && (
                    <button className="btn btn-ghost btn-icon" onClick={() => setOpenKey(null)} aria-label="Back to conversations">
                      <ChevronLeft />
                    </button>
                  )}
                  <Avatar thread={open} />
                  <div className="sms-view-title">
                    <h2>{open.title}</h2>
                    <p>
                      {open.messages.length} message{open.messages.length === 1 ? '' : 's'}
                      {open.named && ' · named sender, no replies'}
                    </p>
                  </div>
                </header>
                <Thread
                  messages={open.messages}
                  pending={pending.filter((p) => p.key === open.key)}
                  onDelete={removeMessage}
                  onRetry={(p) => send(p.to, p.text, p.id)}
                  onDismiss={(p) => setPending((x) => x.filter((y) => y.id !== p.id))}
                />
                {open.named ? (
                  <p className="sms-noreply">{open.title} is a named sender, so it can&apos;t receive replies.</p>
                ) : (
                  <Composer key={open.key} onSend={(text) => send(open.replyTo, text)} />
                )}
              </>
            ) : (
              <div className="sms-placeholder">
                <span className="sms-placeholder-icon" aria-hidden="true">
                  <Message size={26} />
                </span>
                <p>{threads.length ? 'Choose a conversation' : 'Reading the SIM…'}</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * Your own number beside the title. The SIM rarely reports it, so it can be typed in
 * once; that's kept in Insight's database, not on the router.
 */
function OwnNumber() {
  const toast = useToast();
  const r = useAsync(() => api.smsOwnNumber(), []);
  const [draft, setDraft] = useState(null); // null: not editing
  const [saving, setSaving] = useState(false);
  const own = r.data;
  if (!own) return null;

  const save = async () => {
    setSaving(true);
    try {
      await api.smsSetOwnNumber(draft.trim());
      setDraft(null);
      r.reload();
    } catch (e) {
      toast(e.message, 'critical');
    } finally {
      setSaving(false);
    }
  };

  if (draft != null) {
    const ok = draft.trim() === '' || isValidNumber(draft);
    return (
      <form
        className="sms-own is-editing"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) save();
        }}
        onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
      >
        <input
          type="tel"
          inputMode="tel"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Your number"
          aria-label="Your phone number"
          aria-invalid={!ok}
          autoFocus
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!ok || saving}>
          Save
        </button>
        <button type="button" className="sms-close is-small" onClick={() => setDraft(null)} aria-label="Cancel">
          <X size={14} />
        </button>
      </form>
    );
  }
  if (!own.number) {
    return (
      <button type="button" className="sms-own is-empty" onClick={() => setDraft('')} title="The SIM doesn't report its own number">
        <Plus size={13} /> Add your number
      </button>
    );
  }
  return (
    <span className="sms-own" title={own.source === 'sim' ? 'Reported by the SIM' : 'Entered by you, kept in Insight'}>
      <span className="sms-own-number">{own.number}</span>
      {own.source === 'sim' ? (
        <span className="sms-own-tag">from SIM</span>
      ) : (
        <button type="button" className="sms-own-edit" onClick={() => setDraft(own.number)} aria-label="Change your number">
          <Pencil size={12} />
        </button>
      )}
    </span>
  );
}

/** "7 of 50 on SIM" with a small bar: the SIM holds a fixed number of texts. */
function SimMeter({ used, total }) {
  const pct = Math.min(100, Math.round((used / total) * 100));
  const tone = pct >= 100 ? 'is-full' : pct >= 80 ? 'is-high' : '';
  return (
    <span className={`sms-meter ${tone}`} title={`${used} of ${total} message slots on the SIM in use`}>
      <span className="sms-meter-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      {used} of {total} on SIM
    </span>
  );
}

function Avatar({ thread }) {
  return (
    <span className={`sms-avatar ${thread.named ? 'is-named' : ''}`} aria-hidden="true">
      {thread.named ? thread.title.slice(0, 1).toUpperCase() : <User size={16} />}
    </span>
  );
}

function ThreadRow({ thread: t, active, onOpen, onDelete }) {
  return (
    <li className={`sms-row ${active ? 'is-active' : ''} ${t.unread ? 'is-unread' : ''}`}>
      <button className="sms-row-open" onClick={onOpen} aria-current={active ? 'true' : undefined}>
        <Avatar thread={t} />
        <span className="sms-row-body">
          <span className="sms-row-top">
            <span className="sms-row-name">{t.title}</span>
            <time
              className="sms-row-time"
              dateTime={t.last.at ? new Date(t.last.at).toISOString() : undefined}
              title={t.last.at ? formatFull(t.last.at) : ''}
            >
              {listTime(t.last.at)}
            </time>
          </span>
          <span className="sms-row-preview">
            {t.last.direction === 'out' && <span className="sms-you">You: </span>}
            {t.last.text}
          </span>
        </span>
        {t.unread > 0 && (
          <span className="sms-unread" aria-label={`${t.unread} unread`}>
            {t.unread}
          </span>
        )}
      </button>
      {/* Beside the open button, not inside it: one control per element. */}
      <span className="sms-row-actions">
        <ConfirmButton round label={`Delete conversation with ${t.title}`} confirm="Delete?" onConfirm={onDelete} />
      </span>
    </li>
  );
}

function PendingBubbles({ pending, onRetry, onDismiss }) {
  if (!pending.length) return null;
  return (
    <ol className="sms-bubbles">
      {pending.map((p) => (
        <li key={p.id} className={`sms-bubble is-out is-${p.status} is-fresh`}>
          <p className="sms-text">{p.text}</p>
          <span className="sms-meta">
            {p.status === 'sending' ? (
              'Sending…'
            ) : p.status === 'sent' ? (
              'Sent'
            ) : (
              <>
                <span title={p.error}>Not sent</span>
                <button type="button" className="sms-link" onClick={() => onRetry(p)}>
                  Retry
                </button>
                <button type="button" className="sms-link" onClick={() => onDismiss(p)}>
                  Discard
                </button>
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Thread({ messages, pending, onDelete, onRetry, onDismiss }) {
  const scroller = useRef(null);
  const count = messages.length + pending.length;
  // Follow new messages only when already at the bottom (or when you send): reading
  // further up, the view stays put.
  const pinned = useRef(true);
  const sending = pending.some((p) => p.status === 'sending');
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && (pinned.current || sending)) el.scrollTop = el.scrollHeight;
  }, [count, sending]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  // Only texts that arrive while the thread is open animate in. Your own sent text was
  // already shown (as "Sending…"), so its arrival from the router isn't a new event.
  const known = useRef(null);
  known.current ??= new Set(messages.map((m) => m.id));
  const fresh = (m) => !known.current.has(m.id) && m.direction === 'in';
  useEffect(() => {
    for (const m of messages) known.current.add(m.id);
  }, [messages]);

  return (
    <div className="sms-scroll" ref={scroller} onScroll={onScroll}>
      {byDay(messages).map((day) => (
        <section key={day.key} className="sms-day">
          <h3 className="sms-day-label">
            <span>{day.key ? dayLabel(day.key) : 'Time unknown'}</span>
          </h3>
          <ol className="sms-bubbles">
            {day.messages.map((m, i) => {
              const prev = day.messages[i - 1];
              const grouped = prev && prev.direction === m.direction && m.at - prev.at < GROUP_MS;
              return (
                <li key={m.id} className={`sms-bubble is-${m.direction} ${grouped ? 'is-grouped' : ''} ${fresh(m) ? 'is-fresh' : ''}`}>
                  <p className="sms-text">{m.text}</p>
                  <span className="sms-meta">
                    <time dateTime={m.at ? new Date(m.at).toISOString() : undefined} title={m.at ? formatFull(m.at) : ''}>
                      {m.at ? listTime(m.at, m.at) : ''}
                    </time>
                    <ConfirmButton small label="Delete message" confirm="Delete?" onConfirm={() => onDelete(m)} />
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      <PendingBubbles pending={pending} onRetry={onRetry} onDismiss={onDismiss} />
    </div>
  );
}

/** A delete that asks once, inline (no browser dialog): click, then confirm within 4 s. */
function ConfirmButton({ label, confirm, onConfirm, small = false, round = false }) {
  const size = round ? 'is-round' : small ? 'is-small' : '';
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <button
        type="button"
        className={`btn btn-sm sms-confirm ${size}`}
        onClick={(e) => {
          e.stopPropagation();
          setArmed(false);
          onConfirm();
        }}
        onBlur={() => setArmed(false)}
        autoFocus
      >
        {confirm}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm btn-icon sms-delete ${size}`}
      onClick={(e) => {
        e.stopPropagation();
        setArmed(true);
      }}
      aria-label={label}
      title={label}
    >
      <Trash size={small ? 13 : 14} />
    </button>
  );
}

/** Textarea that grows with its text between COMPOSE_MIN_PX and COMPOSE_MAX_PX, then scrolls. */
function useAutoGrow(ref, value) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(COMPOSE_MAX_PX, Math.max(COMPOSE_MIN_PX, el.scrollHeight))}px`;
    el.style.overflowY = el.scrollHeight > COMPOSE_MAX_PX ? 'auto' : 'hidden';
  }, [ref, value]);
}

/** Message box with the router's own costing: GSM or Unicode, characters and SMS parts, live. */
function Composer({ onSend, disabled = false }) {
  const [text, setText] = useState('');
  const area = useRef(null);
  useAutoGrow(area, text);
  const m = measure(text);
  const canSend = m.ok && !disabled;

  const submit = async () => {
    if (!canSend) return;
    const sending = text;
    setText(''); // it shows as "Sending…" in the thread straight away
    await onSend(sending);
    area.current?.focus();
  };

  return (
    <form
      className="sms-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="sms-composer-box">
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Text message"
          rows={1}
          aria-label="Message"
          aria-describedby="sms-cost"
        />
        <button type="submit" className="sms-send" disabled={!canSend} aria-label="Send" title="Send (⌘/Ctrl + Enter)">
          <Send size={16} />
        </button>
      </div>
      <p id="sms-cost" className={`sms-cost ${m.length > m.max ? 'tone-critical' : ''}`} aria-live="polite">
        {text === '' ? '⌘/Ctrl + Enter to send · standard SMS charges from your plan apply' : costLine(m)}
      </p>
    </form>
  );
}

function NewMessage({ onSend, onClose, pending, onRetry, onDismiss }) {
  const [to, setTo] = useState('');
  const numberOk = isValidNumber(to);
  return (
    // Escape anywhere in the composer cancels, like closing a dialog.
    <div className="sms-new" onKeyDown={(e) => e.key === 'Escape' && onClose?.()}>
      <header className="sms-view-head">
        <span className="sms-avatar" aria-hidden="true">
          <Plus size={16} />
        </span>
        <div className="sms-view-title">
          <h2>New message</h2>
          <p>To a phone number or short code</p>
        </div>
        {onClose && (
          <button type="button" className="sms-close" onClick={onClose} aria-label="Cancel new message" title="Cancel (Esc)">
            <X size={16} />
          </button>
        )}
      </header>
      <div className="sms-to">
        <label htmlFor="sms-to">To</label>
        <input
          id="sms-to"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+44 7700 900123"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-invalid={to !== '' && !numberOk}
          aria-describedby="sms-to-hint"
          autoFocus
        />
        <span id="sms-to-hint" className={to !== '' && !numberOk ? 'tone-warning' : 'muted'}>
          {to !== '' && !numberOk ? 'A phone number (10–15 digits) or a short code' : 'Any format: +44 7700 900123 or 07700 900123'}
        </span>
      </div>
      <div className="sms-scroll">
        <PendingBubbles pending={pending} onRetry={onRetry} onDismiss={onDismiss} />
      </div>
      <Composer disabled={!numberOk} onSend={(text) => onSend(to, text)} />
    </div>
  );
}

/** "38/160 · 1 SMS": characters against what the parts in use hold, like a phone shows it. */
function costLine(m) {
  const lim = LIMITS[m.charset];
  if (m.length > m.max) return `${m.length}/${m.max} · too long: a message can be up to ${m.max / lim.part} SMS`;
  const room = m.concatenated ? lim.part * m.parts : lim.single;
  const why =
    m.charset === 'UCS2' ? ` · Unicode because of ${m.nonGsm.slice(0, 3).join(' ')}${m.nonGsm.length > 3 ? '…' : ''} (70 per SMS)` : '';
  return `${m.length}/${room} · ${m.parts} SMS${why}`;
}
