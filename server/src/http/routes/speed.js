import { Router } from 'express';
import { int, sendError } from '../params.js';
import { diagnose } from '../../speed/diagnose.js';

const DEFAULT_SPAN_MS = 30 * 86400e3;

/** Speed tests, the optimiser and placement. Writes go through the CSRF guard like every other non-GET. */
export function speedRoutes({ db, collector, speed, optimiser, placement }) {
  const r = Router();
  // Results are compared within one network: the one in use, or before the first read the one seen last.
  const network = () => db.bandNetwork(collector.state.router?.signal?.plmn ?? undefined);
  const json = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      sendError(res, e);
    }
  };

  if (speed) {
    // History and diagnosis over ?from= (default 30 days).
    r.get(
      '/speed',
      json((req) => {
        const to = Date.now();
        const from = int(req.query.from) ?? to - DEFAULT_SPAN_MS;
        const all = db.speedTests({ from, to });
        const net = network();
        // Tests from before results recorded their network can't be told apart: they stay in.
        const tests = net.plmn ? all.filter((t) => !t.plmn || t.plmn === net.plmn) : all;
        return { state: speed.state, network: net, otherNetworks: all.length - tests.length, tests, diagnosis: diagnose(tests) };
      }),
    );
    // Runs a test and answers when it's done (~20 s); progress arrives with status pushes meanwhile.
    r.post(
      '/speed/run',
      json(() => speed.run({ trigger: 'manual' })),
    );
    r.post(
      '/speed/cancel',
      json(() => speed.cancel()),
    );
  }

  if (optimiser) {
    r.get(
      '/speed/optimiser',
      json(async () => {
        let plan = null;
        let planError = null;
        try {
          plan = await optimiser.plan();
        } catch (e) {
          planError = e.message;
        }
        return { state: optimiser.state, plan, planError, history: optimiser.history() };
      }),
    );
    // { rounds, arms?: [plan keys] }: starts in the background; follow it via status.
    r.post(
      '/speed/optimiser',
      json((req) => optimiser.start({ rounds: req.body?.rounds, arms: req.body?.arms })),
    );
    r.post(
      '/speed/optimiser/cancel',
      json(() => optimiser.cancel()),
    );
  }

  if (placement) {
    r.get(
      '/placement',
      json(() => {
        const net = network();
        return { state: placement.state, network: net, ...placement.spots(net.plmn || null) };
      }),
    );
    r.post(
      '/placement/boost',
      json((req) => placement.boost(req.body?.seconds)),
    );
    // { name, seconds }: measures for that long, then answers with the saved spot.
    r.post(
      '/placement/spots',
      json((req) => placement.capture({ name: req.body?.name, seconds: req.body?.seconds })),
    );
    r.delete(
      '/placement/spots/:id',
      json((req) => placement.remove(Number(req.params.id))),
    );
  }

  return r;
}
