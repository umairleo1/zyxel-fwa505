import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { parseRouterLine } from '../logs/parse.js';
import { createRateLimit, createWarnThrottle, normalizeIp, SYSLOG_ROWS_PER_MIN } from './guard.js';

const MAX_LINE_CHARS = 4096;
const MAX_CONNECTIONS = 4;
// A router that reboots drops its connection without a FIN, so the socket would never close
// on its own: keep-alive probes find the dead peer, and a new connection replaces the oldest.
const KEEPALIVE_MS = 30_000;
// eslint-disable-next-line no-control-regex -- console streams may contain terminal control bytes
const CONSOLE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Line-framed TCP receiver for the router's "Use Common TCP Server" console output. */
export function startZconsole({ host, port, db, allows = () => false, log = console, ratePerMin = SYSLOG_ROWS_PER_MIN }) {
  const state = { listening: false, port, received: 0, denied: 0, dropped: 0, connections: 0, lastAt: null, error: null };
  const sockets = new Set();
  const rate = createRateLimit(ratePerMin);
  const warn = createWarnThrottle(log);
  const server = net.createServer((socket) => {
    const address = normalizeIp(socket.remoteAddress);
    if (!allows(address)) {
      state.denied++;
      socket.destroy();
      return;
    }
    if (sockets.size >= MAX_CONNECTIONS) {
      const oldest = sockets.values().next().value;
      sockets.delete(oldest);
      oldest.destroy();
    }
    socket.setKeepAlive(true, KEEPALIVE_MS);
    sockets.add(socket);
    state.connections = sockets.size;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let discard = false;

    function line(text) {
      const raw = text.replace(/\r$/, '').replace(CONSOLE_CONTROLS, '').trim();
      if (!raw) return;
      if (!rate.take()) {
        state.dropped++;
        return;
      }
      try {
        db.insertMany([{ ...parseRouterLine(raw), source: 'router-console', host: address, raw }]);
        state.received++;
        state.lastAt = Date.now();
      } catch (e) {
        warn('insert', `[zconsole] insert failed: ${e.message}`);
      }
    }

    socket.on('data', (chunk) => {
      // Work on bounded chunks: a sender cannot retain an unbounded unfinished line.
      const text = decoder.write(chunk);
      for (const part of text.split(/(?<=\n)/)) {
        const end = part.endsWith('\n');
        if (!discard) {
          pending += part;
          if (pending.length > MAX_LINE_CHARS) {
            discard = true;
            pending = '';
            state.dropped++;
          }
        }
        if (end) {
          if (!discard) line(pending.slice(0, -1));
          pending = '';
          discard = false;
        }
      }
    });
    socket.on('end', () => {
      const tail = decoder.end();
      if (!discard && pending.length + tail.length <= MAX_LINE_CHARS) line(pending + tail);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      state.connections = sockets.size;
    });
  });
  server.on('error', (e) => {
    state.listening = false;
    state.error = e.message;
    log.error(`[zconsole] ${e.message}`);
  });
  server.on('listening', () => {
    state.listening = true;
    state.port = server.address().port;
    log.info(`[zconsole] listening on tcp ${host}:${state.port}`);
  });
  server.on('close', () => (state.listening = false));
  server.listen(port, host);
  return {
    state,
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
