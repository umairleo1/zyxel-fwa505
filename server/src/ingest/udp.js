import dgram from 'node:dgram';
import { createWarnThrottle } from './guard.js';

/**
 * Bind a UDP socket and track listener health. onMessage(buf, rinfo, socket) may
 * return false to count a packet as rejected. Used by syslog and SNMP traps.
 *
 * Packets from sources that `allows(address)` refuses are counted as `denied`;
 * packets over `rateLimit` are counted as `dropped`. Neither reaches onMessage.
 */
export function createUdpListener({ name, host, port, onMessage, allows = () => true, rateLimit = null, log = console }) {
  const socket = dgram.createSocket({ type: host.includes(':') ? 'udp6' : 'udp4', reuseAddr: true });
  const state = { listening: false, port, received: 0, rejected: 0, denied: 0, dropped: 0, lastAt: null, lastFrom: null, error: null };
  const warn = createWarnThrottle(log);

  socket.on('message', (buf, rinfo) => {
    if (!allows(rinfo.address)) {
      state.denied++;
      warn('denied', `[${name}] ignoring packets from ${rinfo.address} (not an allowed source, see INGEST_ALLOWED_SOURCES)`);
      return;
    }
    if (rateLimit && !rateLimit.take()) {
      state.dropped++;
      warn('rate', `[${name}] rate limit reached, dropping packets`);
      return;
    }
    let accepted;
    try {
      accepted = onMessage(buf, rinfo, socket) !== false;
    } catch (e) {
      accepted = false;
      warn('invalid', `[${name}] dropped packet from ${rinfo.address}: ${e.message}`);
    }
    if (!accepted) {
      state.rejected++;
      return;
    }
    state.received++;
    state.lastAt = Date.now();
    state.lastFrom = rinfo.address;
  });
  socket.on('listening', () => {
    state.listening = true;
    log.info(`[${name}] listening on udp ${host}:${port}`);
  });
  socket.on('error', (e) => {
    state.error = e.code === 'EACCES' ? `Permission denied for UDP ${port} (ports below 1024 need root)` : e.message;
    state.listening = false;
    log.error(`[${name}] ${state.error}`);
    socket.close();
  });
  socket.bind(port, host);

  return {
    state,
    socket,
    close() {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}
