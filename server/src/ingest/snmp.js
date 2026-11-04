import { decodeTrap, trapToRow } from './snmpTrap.js';
import { createUdpListener } from './udp.js';
import { createRateLimit, TRAPS_PER_MIN } from './guard.js';

/**
 * UDP SNMP trap receiver. onTrap(trap, row) fires after each accepted trap.
 * `allows(address)` filters senders (default: anyone); traps are capped per minute,
 * which also caps the status re-reads onTrap triggers.
 */
export function startSnmpTraps({ host, port, community, db, onTrap, allows, ratePerMin = TRAPS_PER_MIN, log = console }) {
  const listener = createUdpListener({
    name: 'snmp',
    host,
    port,
    log,
    allows,
    rateLimit: createRateLimit(ratePerMin),
    onMessage(buf, rinfo, socket) {
      const trap = decodeTrap(buf); // throws on garbage -> counted as rejected
      if (community && trap.community !== community) return false;
      // Acknowledge informs by echoing the message as a Response PDU (same length, so only the tag changes).
      if (trap.type === 'inform') {
        const ack = Buffer.from(buf);
        ack[trap.pduOffset] = 0xa2;
        socket.send(ack, rinfo.port, rinfo.address);
      }
      const row = trapToRow(trap, rinfo.address);
      db.insertMany([row]);
      listener.state.lastTrap = trap.name;
      onTrap?.(trap, row);
    },
  });
  return listener;
}
