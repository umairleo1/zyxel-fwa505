import { parseSyslog } from '../logs/parse.js';
import { createUdpListener } from './udp.js';

/** UDP syslog receiver. Batches inserts so a burst doesn't mean one transaction per packet. */
export function startSyslog({ host, port, db, log = console }) {
  let batch = [];
  let flushTimer = null;

  const flush = () => {
    flushTimer = null;
    const rows = batch;
    batch = [];
    try {
      db.insertMany(rows);
    } catch (e) {
      log.error('[syslog] insert failed', e);
    }
  };

  const listener = createUdpListener({
    name: 'syslog',
    host,
    port,
    log,
    onMessage(buf, rinfo) {
      const raw = buf.toString('utf8');
      batch.push({ ...parseSyslog(raw, rinfo.address), source: 'syslog', raw });
      if (batch.length >= 500) flush();
      else flushTimer ??= setTimeout(flush, 500);
    },
  });

  return {
    state: listener.state,
    close() {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      listener.close();
    },
  };
}
