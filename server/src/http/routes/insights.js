import { Router } from 'express';
import { runAudit } from '../../insights/audit.js';
import { computeInsights } from '../../insights/summary.js';
import { openOutages } from '../../insights/coverage.js';
import { summarizeTraffic, TRAFFIC_PAD_MS, RECENT_STATIONS_MS } from './telemetry.js';
import { bucketFor, timeRange } from '../params.js';
import { createFreshGate, INSIGHTS_FRESH_MS } from '../limits.js';

const AUDIT_TTL_MS = 5 * 60e3; // configuration rarely changes
const RESULT_TTL_MS = 30e3; // aggregates over days don't move within 30 s
const MAX_RESULTS = 20; // one entry per distinct span; bounded so odd ?from/?to can't grow it
/** ?fresh=1 / true asks for a recomputed answer; absent, empty, 0 or false don't. */
const wantsFresh = (q) => q.fresh != null && !/^(|0|false|no)$/i.test(String(q.fresh));
const AI_TTL_MS = 10 * 60e3; // a local 14B model takes tens of seconds: reuse an answer this long

export function insightsRoutes({ db, routerData, collector, internet, ai = null }) {
  const r = Router();
  let audit = null;
  const results = new Map(); // span (minutes) -> { at, body }
  // `fresh` re-runs the audit (several router reads): honoured at most once per 30 s.
  const freshGate = createFreshGate(INSIGHTS_FRESH_MS);

  async function currentAudit(force) {
    if (audit && !force && Date.now() - audit.at < AUDIT_TTL_MS) return audit;
    try {
      audit = await runAudit((id) => routerData.raw(id, AUDIT_TTL_MS).then((x) => x.data));
    } catch (e) {
      audit ??= { checks: [], counts: {}, score: null, at: Date.now(), error: e.message };
    }
    return audit;
  }

  /** The Insights page body for a span: cached for RESULT_TTL_MS per span. */
  async function insightsFor({ from, to }, fresh) {
    const key = Math.round((to - from) / 60e3);
    const hit = results.get(key);
    if (hit && !fresh && Date.now() - hit.at < RESULT_TTL_MS) return hit.body;

    const rows = db.traffic(from - TRAFFIC_PAD_MS, to);
    const traffic = summarizeTraffic(rows, { from, to, bucketMs: bucketFor(to - from, 120) });
    // Same samples in 1 h buckets, for the hour-of-day profile.
    const hourlyTraffic = summarizeTraffic(rows, { from, to, bucketMs: 3600e3 });
    // This calendar month (local time), for the usage projection.
    const now = new Date(to);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const monthRows = db.traffic(monthStart - TRAFFIC_PAD_MS, to);
    const month = {
      totals: summarizeTraffic(monthRows, { from: monthStart, to, bucketMs: 86400e3 }).totals,
      firstSampleTs: monthRows.find((r) => r.ts >= monthStart)?.ts ?? null,
      monthStart,
      monthEnd,
    };
    const stations = db.latestStations(Date.now() - RECENT_STATIONS_MS).map((s) => ({ mac: s.mac, band: s.band, rssi: s.rssi }));
    const insights = computeInsights({
      db,
      from,
      to,
      state: { ...collector.state, rangeDays: (to - from) / 86400e3 },
      traffic,
      hourlyTraffic,
      month,
      devices: db.devices(),
      stations,
      openOutages: openOutages({ collector, internet }),
    });
    const body = { ...insights, audit: await currentAudit(fresh) };
    results.delete(key);
    results.set(key, { at: Date.now(), body });
    if (results.size > MAX_RESULTS) results.delete(results.keys().next().value); // oldest first
    return body;
  }

  r.get('/insights', async (req, res) => {
    const fresh = wantsFresh(req.query) && freshGate.allow('insights');
    res.json(await insightsFor(timeRange(req.query, 7 * 86400e3), fresh));
  });

  // AI summary and advice from a local model (see insights/ai.js). Never fails: without the
  // model it answers source 'rules' with the rule-based recommendations and the reason.
  // One run per span is shared by everyone asking for it, and stopped once they all leave.
  const aiAnswers = new Map(); // span (minutes) -> { promise, done, waiters, controller }
  const aiGate = createFreshGate(AI_TTL_MS / 10);
  r.get('/insights/ai', async (req, res) => {
    const range = timeRange(req.query, 7 * 86400e3);
    const insights = await insightsFor(range, false);
    const rules = (reason) => ({ source: 'rules', reason, model: ai?.state.model ?? null, recommendations: insights.recommendations });
    if (!ai) return res.json(rules('AI insights are turned off (AI_INSIGHTS_ENABLED=false)'));

    const key = Math.round((range.to - range.from) / 60e3);
    const asked = wantsFresh(req.query);
    let hit = aiAnswers.get(key);
    // A run in progress is joined, even when asked to regenerate: a second one would only queue.
    const stale = hit?.done && (Date.now() - hit.at > AI_TTL_MS || (asked && aiGate.allow(key)));
    if (!hit || stale) {
      const controller = new AbortController();
      hit = { at: null, done: false, waiters: 0, controller };
      hit.promise = ai.advise(insights, { signal: controller.signal, recheck: asked });
      aiAnswers.delete(key);
      aiAnswers.set(key, hit);
      if (aiAnswers.size > MAX_RESULTS) aiAnswers.delete(aiAnswers.keys().next().value);
      const settle = hit;
      settle.promise.then(
        (answer) => Object.assign(settle, { done: true, at: answer.at ?? Date.now() }),
        // A failure isn't cached: the next request tries again (availability itself is cached).
        () => aiAnswers.get(key) === settle && aiAnswers.delete(key),
      );
    }

    const mine = hit;
    mine.waiters++;
    res.on('close', () => {
      mine.waiters--;
      // Nobody is waiting any more (page closed, span changed): free the model for others.
      if (!res.writableFinished && !mine.waiters && !mine.done) mine.controller.abort(new Error('nobody is waiting for this answer'));
    });
    try {
      const answer = await mine.promise;
      if (!res.writableEnded) res.json({ source: 'ai', at: mine.at, ...answer });
    } catch (e) {
      if (!res.destroyed) res.json(rules(e.message));
    }
  });

  return r;
}
