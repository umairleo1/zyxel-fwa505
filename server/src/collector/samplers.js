/**
 * Background samplers for data the router only exposes as "current state":
 * interface byte counters (-> throughput, daily usage) and the client list
 * (-> presence history, new-device alerts, per-device Wi-Fi signal).
 */

const deviceName = (h) => h.curHostName || h.DeviceName || h.HostName || null;

/** Sum byte counters of IP interfaces by name ("WAN" rows include idle cellular/ETH WANs at 0). */
export function trafficTotals(trafficStatus) {
  const t = trafficStatus?.[0];
  const totals = { wan_rx: 0, wan_tx: 0, lan_rx: 0, lan_tx: 0 };
  (t?.ipIface ?? []).forEach((iface, i) => {
    const st = t.ipIfaceSt?.[i];
    if (!st) return;
    const side = iface.Name === 'LAN' ? 'lan' : iface.Name === 'WAN' ? 'wan' : null;
    if (!side) return;
    totals[`${side}_rx`] += Number(st.BytesReceived) || 0;
    totals[`${side}_tx`] += Number(st.BytesSent) || 0;
  });
  return totals;
}

export function startSamplers({ routerData, db, log = console, emit = () => {}, trafficMs = 30_000, devicesMs = 60_000 }) {
  const missing = new Map(); // mac -> consecutive polls absent
  const timers = [];

  async function sampleTraffic() {
    try {
      const { data } = await routerData.raw('Traffic_Status', 0);
      db.insertTraffic({ ts: Date.now(), ...trafficTotals(data) });
      emit('traffic');
    } catch (e) {
      if (e.status !== 409) log.warn(`[samplers] traffic: ${e.message}`);
    }
  }

  async function sampleDevices() {
    let hosts;
    let stations;
    try {
      [hosts, stations] = await Promise.all([routerData.raw('lanhosts', 0), routerData.raw('stations', 0)]);
    } catch (e) {
      if (e.status !== 409) log.warn(`[samplers] devices: ${e.message}`);
      return;
    }
    const now = Date.now();
    const firstRun = db.getMeta('devicesSeeded') !== '1';
    const wifi = new Map(stations.data.map((s) => [s.mac, s]));
    const seen = new Set();
    const events = [];

    for (const h of hosts.data?.[0]?.lanhosts ?? []) {
      const mac = String(h.PhysAddress || '').toLowerCase();
      if (!mac) continue;
      const st = wifi.get(mac);
      const online = h.Active === true || !!st;
      if (!online) continue;
      seen.add(mac);
      missing.delete(mac);
      const prev = db.device(mac);
      const name = deviceName(h);
      const conn = st ? `Wi-Fi ${st.band}` : h.X_ZYXEL_ConnectionType || null;
      db.upsertDevice({ mac, name, ip: h.IPAddress || null, conn, icon: h.icon || h.DeviceIcon || null, ts: now, online: true });
      const label = `${name ?? mac} (${[conn, h.IPAddress].filter(Boolean).join(', ')})`;
      if (!prev && !firstRun)
        events.push({ level: 'warning', message: `New device joined the network for the first time: ${label} · ${mac}` });
      else if (prev && !prev.online) events.push({ level: 'info', message: `${label} connected` });
    }
    // Wi-Fi stations the host table hasn't caught up with yet.
    for (const st of stations.data) {
      if (seen.has(st.mac)) continue;
      seen.add(st.mac);
      const prev = db.device(st.mac);
      db.upsertDevice({ mac: st.mac, name: null, ip: null, conn: `Wi-Fi ${st.band}`, icon: null, ts: now, online: true });
      if (!prev && !firstRun)
        events.push({ level: 'warning', message: `New device joined the network for the first time: ${st.mac} (Wi-Fi ${st.band})` });
    }
    // Debounce departures: two consecutive misses.
    for (const d of db.devices()) {
      if (!d.online || seen.has(d.mac)) continue;
      const n = (missing.get(d.mac) ?? 0) + 1;
      missing.set(d.mac, n);
      if (n >= 2) {
        db.upsertDevice({ mac: d.mac, name: null, ip: null, conn: null, icon: null, ts: now, online: false });
        missing.delete(d.mac);
        events.push({
          level: 'info',
          message: `${d.name ?? d.mac} disconnected (last seen ${new Date(d.last_seen).toLocaleTimeString()})`,
        });
      }
    }

    if (stations.data.length) db.insertStations(now, stations.data);
    if (events.length) db.insertMany(events.map((e) => ({ ts: now, source: 'insight', facility: 'devices', ...e })));
    if (firstRun) db.setMeta('devicesSeeded', '1');
    emit('devices');
  }

  const every = (fn, ms) => {
    fn();
    timers.push(setInterval(fn, ms));
  };
  // Stagger the first runs so they don't land on top of the collector's login.
  timers.push(setTimeout(() => every(sampleTraffic, trafficMs), 4000));
  timers.push(setTimeout(() => every(sampleDevices, devicesMs), 6000));

  return {
    stop() {
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
    },
  };
}

/**
 * Turn cumulative counter samples into throughput buckets and per-day usage.
 * Counter resets (reboot) are handled by treating a drop as a restart from 0.
 */
// Above any rate this class of router can carry (the FWA505's RG500L modem peaks
// around 2.5 Gbps). A bigger jump means the counters were replaced (router swap,
// firmware reset, bad sample), not real traffic.
const MAX_PLAUSIBLE_BPS = 3e9;

export function summarizeTraffic(rows, { bucketMs, from, to, tzOffsetMin = new Date().getTimezoneOffset() }) {
  const buckets = new Map();
  const days = new Map();
  let peak = { rx: 0, tx: 0, rxAt: null, txAt: null };
  let gapBytes = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    const dt = (b.ts - a.ts) / 1000;
    if (dt <= 0) continue;
    const d = (k) => (b[k] >= a[k] ? b[k] - a[k] : b[k]);
    const rx = d('wan_rx');
    const tx = d('wan_tx');
    if (((rx + tx) * 8) / dt > MAX_PLAUSIBLE_BPS) continue; // counter discontinuity
    const dayKey = Math.floor((b.ts - tzOffsetMin * 60e3) / 86400e3);
    const day = days.get(dayKey) ?? { day: dayKey * 86400e3 + tzOffsetMin * 60e3, rx: 0, tx: 0 };
    days.set(dayKey, day);
    if (dt > 15 * 60) {
      // Sampling gap (Insight stopped / Mac asleep): we don't know *when* those bytes
      // moved, so no throughput, but if the counters didn't reset they still count
      // towards usage (credited to the day sampling resumed).
      if (b.wan_rx >= a.wan_rx && b.wan_tx >= a.wan_tx) {
        day.rx += rx;
        day.tx += tx;
        gapBytes += rx + tx;
      }
      continue;
    }
    const rxBps = (rx * 8) / dt;
    const txBps = (tx * 8) / dt;
    if (rxBps > peak.rx) peak = { ...peak, rx: rxBps, rxAt: b.ts };
    if (txBps > peak.tx) peak = { ...peak, tx: txBps, txAt: b.ts };
    const t = Math.floor(b.ts / bucketMs) * bucketMs;
    const bk = buckets.get(t) ?? { t, rx: 0, tx: 0, secs: 0 };
    bk.rx += rx;
    bk.tx += tx;
    bk.secs += dt;
    buckets.set(t, bk);
    day.rx += rx;
    day.tx += tx;
  }
  const series = [...buckets.values()].map((b) => ({ t: b.t, rxBps: (b.rx * 8) / b.secs, txBps: (b.tx * 8) / b.secs }));
  const totals = [...days.values()].reduce((s, d) => ({ rx: s.rx + d.rx, tx: s.tx + d.tx }), { rx: 0, tx: 0 });
  return { from, to, bucketMs, series, days: [...days.values()].sort((x, y) => x.day - y.day), totals, peak, gapBytes };
}
