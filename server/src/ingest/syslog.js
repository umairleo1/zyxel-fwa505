import { parseSyslog } from '../logs/parse.js';
import { createUdpListener } from './udp.js';
import { createRateLimit, SYSLOG_ROWS_PER_MIN } from './guard.js';

/**
 * UDP syslog receiver. Batches inserts so a burst doesn't mean one transaction per packet.
 * `allows(address)` filters senders (default: anyone); rows are capped per minute.
 */
// Longest syslog message stored (bytes); the rest is dropped.
const MAX_MESSAGE_BYTES = 2048;

export function startSyslog({ host, port, db, allows, ratePerMin = SYSLOG_ROWS_PER_MIN, log = console }) {
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
    allows,
    rateLimit: createRateLimit(ratePerMin),
    onMessage(buf, rinfo) {
      // RFC 5424 receivers need only accept 480 bytes; real router lines are far
      // shorter. Cap what's stored so a 64 KB packet can't cost 128 KB of disk.
      const raw = buf.subarray(0, MAX_MESSAGE_BYTES).toString('utf8');
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
