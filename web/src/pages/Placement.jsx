import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAsync, useNow } from '../hooks/index.js';
import { useLive, useToast } from '../app/live.js';
import { formatFull, formatSigned, formatWhen } from '../lib/format.js';
import { SERIES, networkLabel, sinrQuality } from '../lib/domain.js';
import { capacityIndex, placementScore, spectralEfficiency, weightedSinr } from '@zyxel-insight/shared/speed';
import { DataTable, ErrorNote, PageHeader, Panel, Stat } from '../components/ui/index.js';
import { QualityBadge } from '../components/ui/Quality.jsx';
import { Field } from '../features/control/Common.jsx';
import TimeSeries from '../components/charts/TimeSeries.jsx';

// The server reads signal every 2 s while boosted; the page renews the boost while it's open.
const BOOST_SEC = 120;
const RENEW_MS = 60_000;
const TREND_MS = 3 * 60_000;
const CAPTURE_SEC = 20;
const ROLE = { primary: '4G primary', secondary: 'Secondary', 'nr-anchor': '5G' };
const SCORE_SERIES = [SERIES.placementScore];

export default function Placement() {
  const { status } = useLive();
  const toast = useToast();
  const router = status?.collector.router;
  const carriers = router?.carriers?.carriers ?? [];
  const score = placementScore(carriers);
  const capacity = capacityIndex(carriers);
  const sinr = weightedSinr(carriers);
  const [trend, setTrend] = useState([]);
  const [name, setName] = useState('');
  const [capturing, setCapturing] = useState(null); // { until }
  const [error, setError] = useState(null);
  const spots = useAsync(() => api.placement(), []);
  const now = useNow(1000);

  // Fast readings while this page is open (and visible).
  useEffect(() => {
    const renew = () => document.visibilityState === 'visible' && api.placementBoost(BOOST_SEC).catch(() => {});
    renew();
    const id = setInterval(renew, RENEW_MS);
    document.addEventListener('visibilitychange', renew);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', renew);
    };
  }, []);

  // A rolling trend of the score, one point per router read.
  const fetchedAt = router?.fetchedAt;
  useEffect(() => {
    if (fetchedAt == null || score == null) return;
    setTrend((t) => (t.at(-1)?.t === fetchedAt ? t : [...t.filter((p) => p.t > fetchedAt - TREND_MS), { t: fetchedAt, score }]));
  }, [fetchedAt, score]);

  async function capture(e) {
    e.preventDefault();
    setError(null);
    setCapturing({ until: Date.now() + CAPTURE_SEC * 1000 });
    try {
      const spot = await api.placementCapture({ name, seconds: CAPTURE_SEC });
      toast(`Saved “${spot.name}”: score ${spot.score ?? '—'}`);
      setName('');
      spots.reload();
    } catch (err) {
      setError(err);
    } finally {
      setCapturing(null);
    }
  }

  async function remove(id) {
    try {
      await api.placementDelete(id);
      spots.reload();
    } catch (err) {
      setError(err);
    }
  }

  const ranked = [...(spots.data?.spots ?? [])].sort((a, b) => (b.capacity ?? -1) - (a.capacity ?? -1));
  const best = ranked[0]?.id;
  const boosted = status?.collector.boostUntil > now;
  const left = capturing ? Math.max(0, Math.ceil((capturing.until - now) / 1000)) : 0;

  return (
    <div className="page">
      <PageHeader
        title="Placement"
        subtitle="Find the best spot for the router. Move it, wait a few seconds for the reading to settle, and save spots to compare. On a fixed router, signal quality (SINR) is what sets the speed, so the score follows it."
      />
      <ErrorNote error={error} />

      <div className="tiles">
        <Stat label="Placement score" value={score ?? '—'} unit="/ 100" sub={boosted ? 'Live, read every 2 s' : 'Live'} />
        <Stat
          label="Signal quality"
          value={sinr != null ? formatSigned(sinr) : '—'}
          unit="dB"
          sub="SINR, weighted by each carrier's bandwidth"
        >
          {sinr != null && <QualityBadge label={sinrQuality(sinr)} />}
        </Stat>
        <Stat
          label="Capacity index"
          value={capacity ?? '—'}
          sub="Bandwidth × quality of every carrier: higher is faster. For comparing spots."
        />
        <Stat
          label="Bands"
          value={router?.carriers?.combo ?? '—'}
          sub={router?.carriers?.totalBandwidth ? `${router.carriers.totalBandwidth} MHz aggregated` : ''}
        />
      </div>

      <div className="two-col">
        <Panel title="Score, last 3 minutes" subtitle="Watch it as you move the router: small moves can change it">
          <TimeSeries
            points={trend}
            series={SCORE_SERIES}
            from={now - TREND_MS}
            to={now}
            height={180}
            yMin={0}
            yMax={100}
            gapMs={30_000}
            empty="Waiting for readings…"
            ariaLabel="Placement score over the last three minutes"
          />
        </Panel>
        <Panel title="Carriers here" subtitle="What each carrier adds; a weak one drags the score">
          {carriers.length ? (
            <ul className="place-carriers">
              {carriers.map((c, i) => (
                <li key={`${c.band}-${c.pci}-${i}`}>
                  <span className="place-band">
                    <b>{c.band}</b> <span className="muted small">{ROLE[c.role] ?? c.role}</span>
                  </span>
                  <span className="tabular small">{c.bandwidth ? `${c.bandwidth} MHz` : '—'}</span>
                  <span className="tabular small">{c.rsrp != null ? `${formatSigned(c.rsrp)} dBm` : '—'}</span>
                  <span className="tabular small">
                    {c.sinr != null ? `SINR ${formatSigned(c.sinr)} dB` : 'not measured'}
                    {c.sinr != null && c.bandwidth ? (
                      <span className="muted"> · +{Math.round(c.bandwidth * spectralEfficiency(c.sinr))}</span>
                    ) : null}
                  </span>
                  {c.sinr != null && <QualityBadge label={sinrQuality(c.sinr)} />}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No carriers reported. Is the router being read?</p>
          )}
        </Panel>
      </div>

      <Panel
        title="Saved spots"
        subtitle={`On ${networkLabel(spots.data?.network)}. Saving measures for ${CAPTURE_SEC} seconds and keeps the median, so a lucky second doesn't decide. Ranked by capacity index.${
          spots.data?.otherNetworks
            ? ` ${spots.data.otherNetworks} spot${spots.data.otherNetworks === 1 ? '' : 's'} on other networks not shown.`
            : ''
        }`}
        actions={
          <form className="place-capture" onSubmit={capture}>
            <Field
              label="Spot name"
              value={name}
              onChange={setName}
              placeholder="e.g. Landing window"
              maxLength={60}
              disabled={!!capturing}
            />
            <button className="btn btn-primary" disabled={!!capturing || !name.trim()}>
              {capturing ? `Measuring… ${left}s` : 'Save this spot'}
            </button>
          </form>
        }
        flush
      >
        <DataTable
          rows={ranked}
          rowKey={(s) => s.id}
          empty="No spots yet. Put the router somewhere, wait a moment, then save the spot."
          columns={[
            {
              key: 'name',
              label: 'Spot',
              render: (s) => (
                <>
                  {s.name}
                  {s.id === best && ranked.length > 1 && <span className="audit-tag tag-pass">Best</span>}
                </>
              ),
            },
            { key: 'score', label: 'Score', align: 'right', render: (s) => s.score ?? '—' },
            { key: 'capacity', label: 'Capacity', align: 'right', render: (s) => s.capacity ?? '—' },
            { key: 'sinr', label: 'SINR', align: 'right', render: (s) => (s.sinr == null ? '—' : `${formatSigned(s.sinr)} dB`) },
            {
              key: 'lteRsrp',
              label: '4G RSRP',
              align: 'right',
              render: (s) => (s.lteRsrp == null ? '—' : `${formatSigned(s.lteRsrp)} dBm`),
            },
            { key: 'nrRsrp', label: '5G RSRP', align: 'right', render: (s) => (s.nrRsrp == null ? '—' : `${formatSigned(s.nrRsrp)} dBm`) },
            { key: 'combo', label: 'Bands', render: (s) => s.combo ?? '—' },
            { key: 'ts', label: 'Saved', render: (s) => <span title={formatFull(s.ts)}>{formatWhen(s.ts)}</span> },
            {
              key: 'actions',
              label: '',
              render: (s) => (
                <button className="btn btn-ghost btn-sm" onClick={() => remove(s.id)} aria-label={`Delete ${s.name}`}>
                  Delete
                </button>
              ),
            },
          ]}
        />
      </Panel>

      <Panel title="What helps" subtitle="In rough order of effect">
        <ul className="place-tips">
          <li>
            <b>Height and windows.</b> Upstairs and at a window facing the mast beats the middle of the house. Walls, especially with foil
            insulation or metal, cost a lot at 3.5 GHz (n78).
          </li>
          <li>
            <b>Small moves.</b> Interference varies over short distances: try 30–50 cm either way and a quarter turn before giving up on a
            room.
          </li>
          <li>
            <b>Clear space.</b> Keep it off the floor, away from metal shelves, TVs, microwaves and other routers.
          </li>
          <li>
            <b>Find the mast.</b> The Radio control page shows the serving mast&apos;s ID to look up on a coverage map; face the router that
            way.
          </li>
          <li>
            <b>When no spot is good.</b> The FWA505 has internal antennas only. An outdoor 5G unit (or a router with external antenna ports)
            is the step up; check its gain is for the bands you use.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
