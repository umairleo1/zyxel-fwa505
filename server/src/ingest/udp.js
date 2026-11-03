import dgram from 'node:dgram';

/**
 * Bind a UDP socket and track listener health. onMessage(buf, rinfo, socket) may
 * return false to count a packet as rejected. Used by syslog and SNMP traps.
 */
export function createUdpListener({ name, host, port, onMessage, log = console }) {
  const socket = dgram.createSocket({ type: host.includes(':') ? 'udp6' : 'udp4', reuseAddr: true });
  const state = { listening: false, port, received: 0, rejected: 0, lastAt: null, lastFrom: null, error: null };

  socket.on('message', (buf, rinfo) => {
    let accepted;
    try {
      accepted = onMessage(buf, rinfo, socket) !== false;
    } catch (e) {
      accepted = false;
      log.warn(`[${name}] dropped packet from ${rinfo.address}: ${e.message}`);
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
    close() {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}
