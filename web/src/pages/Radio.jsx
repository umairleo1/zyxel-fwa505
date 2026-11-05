import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useNow, useRouterData } from '../hooks/index.js';
import { useLive, useToast } from '../app/live.js';
import { formatDuration, formatSigned } from '../lib/format.js';
import { BAND_FREQ, rsrpQuality } from '../lib/domain.js';
import { AUTO, TECHNOLOGIES, bandsForTechnology, describeBands, isLte, isNr, selectionError } from '@zyxel-insight/shared/radio';
import { ErrorNote, KV, PageHeader, PageLoader, Panel, Stat } from '../components/ui/index.js';
import { QualityBadge } from '../components/ui/Quality.jsx';
import Segmented from '../components/ui/Segmented.jsx';
import Carriers from '../features/cellular/Carriers.jsx';
import { suggestions } from '../lib/radio.js';

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const toSelection = (technology, mode, picked) => ({ technology, bands: mode === 'auto' ? AUTO : [...picked] });

export default function Radio() {
  const { status, ticks } = useLive();
  const toast = useToast();
  const trialUntil = status?.radioTrial?.until ?? null;
  // Re-read when a trial starts or ends anywhere (including a revert by the timer).
  const r = useAsync(() => api.radio(), [trialUntil]);
  const seen = useAsync(() => api.bands(), [Math.floor(ticks.metrics / 12)]);
  const cell = useRouterData(['cellwan_status'], [Math.floor(ticks.metrics / 6)]);
  const [state, setState] = useState(null); // the latest reply from a change, ahead of a re-read
  const [draft, setDraft] = useState(null); // { technology, mode: 'auto' | 'custom', picked: Set }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const radio = state ?? r.data;
  useEffect(() => setState(null), [r.data]);
  const router = status?.collector.router;
  const ca = router?.carriers;
  const cw = cell.get('cellwan_status')?.[0];

  const saved = useMemo(() => {
    if (!radio) return null;
    const auto = radio.bands.preferred === AUTO;
    return { technology: radio.technology.preferred, mode: auto ? 'auto' : 'custom', picked: new Set(auto ? [] : radio.bands.preferred) };
  }, [radio]);
  const d = draft ?? saved;
  const history = useMemo(() => new Map((seen.data?.bands ?? []).map((b) => [b.band.toUpperCase(), b])), [seen.data]);
  const inUse = new Set((ca?.carriers ?? []).map((c) => c.band?.toUpperCase()));
  const live = useMemo(() => liveByBand(ca?.carriers), [ca]);
  const primary = ca?.carriers.find((c) => c.role === 'primary')?.band;

  if (!radio) {
    return (
      <div className="page">
        {r.loading && <PageLoader />}
        <PageHeader title="Radio control" />
        <ErrorNote error={r.error} />
      </div>
    );
  }

  const supported = radio.bands.supported;
  const usable = new Set(bandsForTechnology(d.technology, supported));
  const selection = toSelection(
    d.technology,
    d.mode,
    [...d.picked].filter((b) => usable.has(b)),
  );
  const invalid = selectionError(selection, { technologies: radio.technology.supported, bands: supported });
  const dirty =
    d.technology !== saved.technology || d.mode !== saved.mode || (d.mode === 'custom' && !sameSet(new Set(selection.bands), saved.picked));
  const presets = suggestions({ supported, history, inUse });

  const edit = (patch) => setDraft({ ...d, ...patch });
  const toggle = (band) => {
    const picked = new Set(d.picked);
    if (picked.has(band)) picked.delete(band);
    else picked.add(band);
    edit({ mode: 'custom', picked });
  };
  const setGroup = (bands, on) => {
    const picked = new Set(d.picked);
    for (const b of bands) on ? picked.add(b) : picked.delete(b);
    edit({ mode: 'custom', picked });
  };

  async function run(action, message) {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
      setDraft(null);
      if (message) toast(message);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Radio control"
        subtitle="Choose which network mode and bands the modem may use. Every change is a 5-minute trial: it switches back by itself unless you keep it, so a bad choice can't strand the router."
      />
      <ErrorNote error={error ?? r.error} />

      {radio.trial && (
        <Trial
          trial={radio.trial}
          supported={supported}
          busy={busy}
          onKeep={() => run(() => api.radioKeep(), 'Band selection kept')}
          onRevert={() => run(() => api.radioRevert(), 'Previous band selection restored')}
        />
      )}

      <div className="tiles">
        <Stat
          label="Network mode"
          value={TECHNOLOGIES[radio.technology.current] ?? radio.technology.current ?? '—'}
          sub={`Preferred: ${TECHNOLOGIES[radio.technology.preferred] ?? radio.technology.preferred}`}
        />
        <Stat
          label="Band selection"
          value={radio.bands.preferred === AUTO ? 'Automatic' : 'Custom'}
          sub={describeBands(radio.bands.preferred, supported)}
        />
        <Stat
          label="Primary band"
          value={primary ?? radio.bands.current ?? '—'}
          sub={primary && BAND_FREQ[primary] ? BAND_FREQ[primary] : ''}
        />
        <Stat label="Aggregated" value={ca?.totalBandwidth ?? '—'} unit="MHz" sub={ca?.combo ?? '—'} />
      </div>

      <Panel
        title="Network mode"
        subtitle="5G NSA uses a 4G band as its anchor; 5G SA needs a network that offers standalone 5G where you are."
      >
        <Segmented
          label="Network mode"
          options={radio.technology.supported.map((t) => ({ value: t, label: TECHNOLOGIES[t] ?? t }))}
          value={d.technology}
          onChange={(technology) => edit({ technology })}
        />
      </Panel>

      <Panel
        title="Bands"
        subtitle="Automatic lets the network choose from every band. A custom list limits the modem to the bands you tick: it can only attach to, and aggregate, those."
        actions={
          <Segmented
            label="Band selection"
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'custom', label: 'Custom' },
            ]}
            value={d.mode}
            onChange={(mode) =>
              edit({
                mode,
                picked:
                  mode === 'custom' && !d.picked.size
                    ? new Set([...inUse].map((b) => supported.find((s) => s.toUpperCase() === b)).filter(Boolean))
                    : d.picked,
              })
            }
          />
        }
      >
        {presets.length > 0 && (
          <div className="radio-presets">
            <span className="muted small">Suggestions from your history</span>
            {presets.map((p) => (
              <button
                key={p.label}
                className="btn btn-sm"
                title={p.why}
                onClick={() =>
                  setDraft({
                    technology: d.technology === 'LTE' || d.technology === 'NR5G-SA' ? 'NR5G-NSA' : d.technology,
                    mode: 'custom',
                    picked: new Set(p.bands),
                  })
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <div className={`radio-groups ${d.mode === 'auto' ? 'is-auto' : ''}`}>
          {[
            ['4G LTE', supported.filter(isLte)],
            ['5G NR', supported.filter(isNr)],
          ].map(([title, bands]) => (
            <BandGroup
              key={title}
              title={title}
              bands={bands}
              picked={d.mode === 'auto' ? new Set(bands) : d.picked}
              usable={usable}
              history={history}
              live={live}
              primary={primary}
              onToggle={toggle}
              onAll={(on) =>
                setGroup(
                  bands.filter((b) => usable.has(b)),
                  on,
                )
              }
            />
          ))}
        </div>
      </Panel>

      <div className="radio-apply">
        <div>
          {dirty ? (
            invalid ? (
              <span className="radio-invalid">{invalid}</span>
            ) : (
              <>
                <b>{describeBands(selection.bands, supported)}</b>, {TECHNOLOGIES[selection.technology]}. Mobile data drops for about 10–20
                s while the modem re-registers.
              </>
            )
          ) : (
            <span className="muted">No changes.</span>
          )}
        </div>
        <div className="radio-apply-actions">
          {radio.bands.preferred !== AUTO && (
            <button className="btn" disabled={busy} onClick={() => run(() => api.radioAutomatic(), 'Bands reset to automatic')}>
              Reset to automatic
            </button>
          )}
          {dirty && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => setDraft(null)}>
              Discard
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={busy || !dirty || !!invalid}
            onClick={() => run(() => api.radioApply(selection), 'Applied: switches back in 5 minutes unless you keep it')}
          >
            {busy ? 'Applying…' : 'Apply as trial'}
          </button>
        </div>
      </div>

      <Carriers ca={ca} />
      <p className="tile-sub radio-note">
        Carrier aggregation is decided by the network, not the router: there’s no setting for it. You shape it through the bands you allow;
        a band you untick can’t be aggregated, and keeping a strong band in the list is how it gets used.
      </p>

      <div className="two-col">
        <Panel title="Serving mast" subtitle="Where your 4G anchor comes from, to look up on a coverage map">
          {cw ? <Mast cw={cw} operator={router?.signal?.operator} /> : <p className="muted">Loading…</p>}
        </Panel>
        <Panel title="Cell lock" subtitle="Pinning the modem to one specific cell (PCI)">
          <p>
            Not available on this router. Firmware V1.71 doesn’t offer PCI lock: its admin page hides the setting and the router returns
            nothing for it, so Insight can’t lock to a cell either.
          </p>
          <p className="muted small">
            The closest you can get is limiting bands above: with only the mast’s bands allowed, the modem can’t drift to weaker ones.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function Trial({ trial, supported, busy, onKeep, onRevert }) {
  const now = useNow(1000);
  const left = Math.max(0, Math.round((trial.until - now) / 1000));
  return (
    <div className="banner banner-info radio-trial" role="status">
      <div>
        <strong>On trial: {describeBands(trial.selection?.bands ?? AUTO, supported)}.</strong> Run a speed test now. Switching back to{' '}
        {describeBands(trial.previous.bands, supported)} ({TECHNOLOGIES[trial.previous.technology] ?? trial.previous.technology}) in{' '}
        <b className="tabular">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </b>
        .
      </div>
      <button className="btn" disabled={busy} onClick={onRevert}>
        Revert now
      </button>
      <button className="btn btn-primary" disabled={busy} onClick={onKeep}>
        Keep
      </button>
    </div>
  );
}

function BandGroup({ title, bands, picked, usable, history, live, primary, onToggle, onAll }) {
  const allowed = bands.filter((b) => usable.has(b));
  return (
    <section className="radio-group" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {allowed.length > 0 && (
          <span className="radio-group-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => onAll(true)}>
              All
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => onAll(false)}>
              None
            </button>
          </span>
        )}
      </header>
      <ul>
        {bands.map((b) => {
          const h = history.get(b.toUpperCase());
          const now = live.get(b.toUpperCase());
          const off = !usable.has(b);
          return (
            <li key={b} className={`radio-band ${picked.has(b) && !off ? 'is-on' : ''} ${off ? 'is-off' : ''}`}>
              <label>
                <input type="checkbox" checked={picked.has(b) && !off} disabled={off} onChange={() => onToggle(b)} />
                <span className="radio-band-name">{b}</span>
                <span className="radio-band-freq">{BAND_FREQ[b] ?? ''}</span>
              </label>
              <span className="radio-band-stats">
                {now && (
                  <span className="radio-band-line">
                    <span className="radio-tag is-live">{b.toUpperCase() === primary?.toUpperCase() ? 'Primary now' : 'In use'}</span>
                    <span title="Live reading, updated with every status read">
                      <b>Now</b> {formatSigned(now.rsrp)} dBm · SINR {formatSigned(now.sinr)} dB
                      {now.count > 1 ? ` · ${now.count} carriers` : ''}
                    </span>
                    <QualityBadge label={rsrpQuality(now.rsrp)} />
                  </span>
                )}
                {h ? (
                  <span className="radio-band-line muted">
                    <span title="Average over all the time this band was in use">
                      Avg {formatSigned(h.avgRsrp)} dBm · SINR {formatSigned(h.avgSinr)} dB
                    </span>
                    <span title="Every session added together, while Insight was running">
                      {formatDuration(h.seconds)} in use in total · {formatDuration(h.primarySeconds ?? 0)} as{' '}
                      {isNr(b) ? 'main 5G' : 'primary'}
                    </span>
                    {!now && <QualityBadge label={rsrpQuality(h.avgRsrp)} />}
                  </span>
                ) : (
                  !now && <span className="muted">Not seen here</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Mast({ cw, operator }) {
  const cellId = Number(cw.INTF_Cell_ID);
  const known = Number.isFinite(cellId) && cellId > 0;
  return (
    <>
      <KV
        obj={{
          Operator: `${operator ?? '—'} (MCC ${cw.NSA_MCC ?? '—'} / MNC ${cw.NSA_MNC ?? '—'})`,
          'Cell ID': known ? cellId : '—',
          // LTE cell identity = eNodeB ID × 256 + sector: the eNB is the mast, the sector its antenna.
          'eNodeB (mast) ID': known ? Math.floor(cellId / 256) : '—',
          Sector: known ? cellId % 256 : '—',
          TAC: cw.INTF_TAC,
          PCI: cw.INTF_PhyCell_ID,
          'Band / EARFCN': `${cw.INTF_Current_Band || '—'} / ${cw.INTF_RFCN ?? '—'}`,
          '5G PCI / NR-ARFCN': `${cw.NSA_PhyCellID ?? '—'} / ${cw.NSA_RFCN ?? '—'}`,
        }}
        showAll
      />
      <p className="muted small">
        The router can’t tell where the mast is. To find it, search the eNodeB ID for your operator on a crowd-sourced map such as
        cellmapper.net. Insight doesn’t send it anywhere.
      </p>
    </>
  );
}

/**
 * Live reading per band from the carriers in use. A band can carry two carriers (B3+B3):
 * show the one the connection hangs on (primary or 5G anchor), else the strongest.
 */
function liveByBand(carriers = []) {
  const map = new Map();
  for (const c of carriers) {
    const key = c.band?.toUpperCase();
    if (!key) continue;
    const prev = map.get(key);
    const main = c.role === 'primary' || c.role === 'nr-anchor';
    const better = !prev || (main && !prev.main) || (main === prev.main && (c.rsrp ?? -999) > (prev.rsrp ?? -999));
    const count = (prev?.count ?? 0) + 1;
    map.set(key, better ? { rsrp: c.rsrp, sinr: c.sinr, main, count } : { ...prev, count });
  }
  return map;
}
