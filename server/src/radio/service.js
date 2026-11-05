// Radio control: the router's preferred network mode and bands (cellwan_band), the one
// setting besides SMS that Insight may change; see RouterClient#isBandWrite. Every change
// is a trial: unless it's kept, the previous selection comes back by itself, so a bad
// choice can't leave the router off the network with nobody around to undo it.
import { AUTO, describeBands, parseBands, selectionError, serialiseBands, TECHNOLOGIES } from '@zyxel-insight/shared/radio';
import { RouterError } from '../router/client.js';

const BAND_PATH = '/cgi-bin/DAL?oid=cellwan_band';
// A trial reverts unless kept within this long: enough for a couple of speed tests.
export const TRIAL_MS = 5 * 60_000;
// The modem needs about 12 s to re-register after a change (the router's own page waits
// that long); a second change before then just makes it start over.
export const MIN_GAP_MS = 15_000;
// A revert that fails (router busy, Insight paused) is tried again this often.
const RETRY_MS = 30_000;
// The trial survives a restart of Insight: { previous, until } in the meta table.
const TRIAL_META = 'radioTrial';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** cellwan_band's object as the page shows it. Pure. */
export function normaliseBand(o = {}) {
  return {
    technology: {
      supported: String(o.INTF_Supported_Access_Technologies ?? '')
        .split(',')
        .filter(Boolean),
      preferred: o.INTF_Preferred_Access_Technology ?? null,
      current: o.INTF_Current_Access_Technology ?? null,
    },
    bands: {
      supported: String(o.INTF_Supported_Bands ?? '')
        .split(',')
        .filter(Boolean),
      preferred: parseBands(o.INTF_Preferred_Bands),
      current: o.INTF_Current_Band ?? null,
    },
  };
}

const sameBands = (a, b) => serialiseBands(a) === serialiseBands(b);
const label = ({ technology, bands }, supported) => `${describeBands(bands, supported)}, ${TECHNOLOGIES[technology] ?? technology}`;

export function createRadioService({ client, db, enabled, now = Date.now, onChange = () => {} }) {
  let trial = null; // { previous: { technology, bands }, until, selection }
  let lastWriteAt = 0;
  let timer = null;

  const audit = (level, message) => {
    try {
      db.insertMany([{ ts: now(), source: 'insight', facility: 'radio', level, message }]);
    } catch {
      // the log is a record, not a gate
    }
  };
  const requireEnabled = () => {
    if (!enabled) throw Object.assign(new Error('Band control is disabled (RADIO_CONTROL_ENABLED=false)'), { status: 404 });
  };
  const saveTrial = () => {
    try {
      db.setMeta(TRIAL_META, trial ? JSON.stringify(trial) : '');
    } catch {
      // the in-memory timer still reverts; only a restart in between would miss it
    }
  };
  const loadTrial = () => {
    try {
      const raw = db.getMeta(TRIAL_META);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  async function readRaw() {
    const data = await client.getJson(BAND_PATH, { priority: 'high' });
    if (data?.result && data.result !== 'ZCFG_SUCCESS') throw new RouterError('http', `cellwan_band: ${data.result}`);
    const o = Array.isArray(data?.Object) ? data.Object[0] : null;
    if (!o?.INTF_Supported_Bands) throw new RouterError('http', 'This router does not report band selection');
    return o;
  }

  /** PUT the whole object back with the new choice, as the router's page does. Returns the new state. */
  async function write(raw, { technology, bands }) {
    const t = now();
    if (t - lastWriteAt < MIN_GAP_MS) {
      const wait = Math.ceil((MIN_GAP_MS - (t - lastWriteAt)) / 1000);
      throw Object.assign(new Error(`The modem is still reconnecting from the last change. Try again in ${wait} s.`), { status: 429 });
    }
    lastWriteAt = t;
    const body = { ...raw, INTF_Preferred_Access_Technology: technology, INTF_Preferred_Bands: serialiseBands(bands) };
    await client.bandWrite(body);
    return normaliseBand(body);
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!trial) return;
    timer = setTimeout(() => revertTrial('expired'), Math.max(0, trial.until - now()));
    timer.unref?.();
  }

  async function revertTrial(why) {
    if (!trial) return null;
    try {
      const raw = await readRaw();
      lastWriteAt = 0; // a revert is the safe way back: never make it wait
      const { previous } = trial;
      const current = normaliseBand(raw);
      const state =
        current.technology.preferred === previous.technology && sameBands(current.bands.preferred, previous.bands)
          ? current
          : await write(raw, previous);
      audit(
        why === 'expired' ? 'warning' : 'notice',
        `${why === 'expired' ? 'Band trial not kept: restored' : 'Band selection reverted to'} ${label(previous, state.bands.supported)}`,
      );
      trial = null;
      saveTrial();
      schedule();
      onChange();
      return state;
    } catch (e) {
      if (why !== 'expired') throw e;
      // Couldn't reach the router: keep the trial and try again shortly.
      clearTimeout(timer);
      timer = setTimeout(() => revertTrial('expired'), RETRY_MS);
      timer.unref?.();
      return null;
    }
  }

  const view = (state) => ({
    enabled,
    ...state,
    trial: trial && { until: trial.until, previous: trial.previous, selection: trial.selection },
  });

  return {
    enabled,

    /** Trial in progress, for the status payload: { until } or null. */
    get trial() {
      return trial && { until: trial.until };
    },

    start() {
      if (!enabled) return;
      trial = loadTrial();
      schedule(); // overdue: reverts straight away
    },
    stop() {
      clearTimeout(timer);
      timer = null;
    },

    async get() {
      requireEnabled();
      return view(normaliseBand(await readRaw()));
    },

    /**
     * Try { technology, bands } (bands: 'Auto' or a list). Reverts after TRIAL_MS unless
     * kept. A second change during a trial keeps the original as what it reverts to.
     */
    async apply(selection) {
      requireEnabled();
      const bands = selection?.bands === AUTO ? AUTO : Array.isArray(selection?.bands) ? selection.bands.map(String) : null;
      const raw = await readRaw();
      const current = normaliseBand(raw);
      const technology = String(selection?.technology ?? current.technology.preferred);
      const next = { technology, bands: bands ?? current.bands.preferred };
      const error = selectionError(next, { technologies: current.technology.supported, bands: current.bands.supported });
      if (error) throw badRequest(error);
      if (current.technology.preferred === next.technology && sameBands(current.bands.preferred, next.bands)) return view(current);

      const state = await write(raw, next);
      const previous = trial?.previous ?? { technology: current.technology.preferred, bands: current.bands.preferred };
      const backToStart = previous.technology === next.technology && sameBands(previous.bands, next.bands);
      // Going back to where the trial started (or to fully automatic) needs no safety net.
      trial =
        backToStart || (next.bands === AUTO && next.technology === 'Auto')
          ? null
          : { previous, until: now() + TRIAL_MS, selection: next, supported: state.bands.supported };
      saveTrial();
      schedule();
      audit(
        'notice',
        `Band selection set to ${label(next, state.bands.supported)}${trial ? `; reverts in ${TRIAL_MS / 60_000} min unless kept` : ''}`,
      );
      onChange();
      return view(state);
    },

    /** Keep the trial's selection: it no longer reverts. */
    async keep() {
      requireEnabled();
      if (trial) {
        audit('notice', `Band selection kept: ${label(trial.selection, trial.supported ?? [])}`);
        trial = null;
        saveTrial();
        schedule();
        onChange();
      }
      return this.get();
    },

    /** Undo the trial now. */
    async revert() {
      requireEnabled();
      if (!trial) return this.get();
      return view(await revertTrial('asked'));
    },

    /** Back to the router's default: every band, network mode unchanged. */
    async automatic() {
      requireEnabled();
      const raw = await readRaw();
      const current = normaliseBand(raw);
      lastWriteAt = 0; // like a revert, the way back is never rate limited
      const state =
        current.bands.preferred === AUTO ? current : await write(raw, { technology: current.technology.preferred, bands: AUTO });
      if (trial || current.bands.preferred !== AUTO) audit('notice', 'Band selection reset to automatic (all bands)');
      trial = null;
      saveTrial();
      schedule();
      onChange();
      return view(state);
    },
  };
}
