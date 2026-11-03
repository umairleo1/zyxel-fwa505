// ── Minimal BER decoder: just enough for SNMP v1/v2c traps and informs ──

function readTlv(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let off = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error('Bad BER length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + i];
    off += n;
  }
  if (off + len > buf.length) throw new Error('Truncated BER value');
  return { tag, start: pos, valueStart: off, end: off + len };
}

function children(buf, tlv) {
  const out = [];
  for (let p = tlv.valueStart; p < tlv.end;) {
    const c = readTlv(buf, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

function decodeInt(buf, { valueStart, end }, signed = true) {
  let v = 0n;
  for (let i = valueStart; i < end; i++) v = (v << 8n) | BigInt(buf[i]);
  if (signed && end > valueStart && buf[valueStart] & 0x80) v -= 1n << BigInt(8 * (end - valueStart));
  return Number(v);
}

function decodeOid(buf, { valueStart, end }) {
  if (end <= valueStart) return '';
  const first = buf[valueStart];
  const parts = [Math.min(2, Math.floor(first / 40)), first - Math.min(2, Math.floor(first / 40)) * 40];
  let v = 0;
  for (let i = valueStart + 1; i < end; i++) {
    v = v * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

// Printable ASCII plus tab/newline/CR: show as text, otherwise as hex.
const isPrintable = (bytes) => bytes.every((b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e));

function decodeValue(buf, tlv) {
  const raw = buf.subarray(tlv.valueStart, tlv.end);
  switch (tlv.tag) {
    case 0x02:
      return decodeInt(buf, tlv); // INTEGER
    case 0x04:
      return isPrintable(raw) ? raw.toString('latin1') : raw.toString('hex'); // OCTET STRING
    case 0x05:
      return null; // NULL
    case 0x06:
      return decodeOid(buf, tlv);
    case 0x40:
      return [...raw].join('.'); // IpAddress
    case 0x41:
    case 0x42:
    case 0x43:
    case 0x46:
      return decodeInt(buf, tlv, false); // Counter32, Gauge32, TimeTicks, Counter64
    default:
      return `0x${raw.toString('hex')}`; // noSuchObject etc.
  }
}

const varbinds = (buf, listTlv) =>
  children(buf, listTlv).map((vb) => {
    const [name, value] = children(buf, vb);
    return { oid: decodeOid(buf, name), value: decodeValue(buf, value) };
  });

const V1_GENERIC = ['coldStart', 'warmStart', 'linkDown', 'linkUp', 'authenticationFailure', 'egpNeighborLoss', 'enterpriseSpecific'];
const STD_TRAPS = Object.fromEntries(V1_GENERIC.slice(0, 6).map((n, i) => [`1.3.6.1.6.3.1.1.5.${i + 1}`, n]));
const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
const TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';

/**
 * Decode an SNMP v1/v2c Trap or InformRequest.
 * Returns { version, community, type, trapOid, name, uptimeTicks, agent, varbinds, pduOffset }.
 */
export function decodeTrap(buf) {
  const msg = readTlv(buf, 0);
  if (msg.tag !== 0x30) throw new Error('Not an SNMP message');
  const [ver, comm, pdu] = children(buf, msg);
  const version = ['v1', 'v2c'][decodeInt(buf, ver)] ?? 'unsupported';
  const community = buf.subarray(comm.valueStart, comm.end).toString('latin1');
  if (version === 'unsupported') throw new Error('Only SNMP v1/v2c are supported');

  if (pdu.tag === 0xa4) {
    // v1 Trap-PDU: enterprise, agent-addr, generic, specific, time-stamp, varbinds
    const [ent, addr, gen, spec, ts, vbl] = children(buf, pdu);
    const generic = decodeInt(buf, gen);
    const enterprise = decodeOid(buf, ent);
    const specific = decodeInt(buf, spec);
    return {
      version,
      community,
      type: 'trap',
      pduOffset: pdu.start,
      trapOid: generic === 6 ? `${enterprise}.0.${specific}` : `1.3.6.1.6.3.1.1.5.${generic + 1}`,
      name: V1_GENERIC[generic] ?? 'unknown',
      uptimeTicks: decodeInt(buf, ts, false),
      agent: decodeValue(buf, addr),
      varbinds: varbinds(buf, vbl),
    };
  }
  if (pdu.tag === 0xa7 || pdu.tag === 0xa6) {
    // v2c SNMPv2-Trap / InformRequest: request-id, error-status, error-index, varbinds
    const [, , , vbl] = children(buf, pdu);
    const all = varbinds(buf, vbl);
    const trapOid = all.find((v) => v.oid === TRAP_OID)?.value ?? null;
    return {
      version,
      community,
      type: pdu.tag === 0xa6 ? 'inform' : 'trap',
      pduOffset: pdu.start,
      trapOid,
      name: STD_TRAPS[trapOid] ?? trapOid ?? 'unknown',
      uptimeTicks: all.find((v) => v.oid === SYS_UPTIME)?.value ?? null,
      agent: null,
      varbinds: all.filter((v) => v.oid !== TRAP_OID && v.oid !== SYS_UPTIME),
    };
  }
  throw new Error(`Unsupported PDU type 0x${pdu.tag.toString(16)}`);
}

// Friendly names for varbinds that commonly ride on standard traps.
const KNOWN_OIDS = [
  ['1.3.6.1.2.1.2.2.1.1.', 'ifIndex'],
  ['1.3.6.1.2.1.2.2.1.2.', 'ifDescr'],
  ['1.3.6.1.2.1.2.2.1.7.', 'ifAdminStatus'],
  ['1.3.6.1.2.1.2.2.1.8.', 'ifOperStatus'],
  ['1.3.6.1.2.1.31.1.1.1.1.', 'ifName'],
  ['1.3.6.1.6.3.18.1.3.0', 'snmpTrapAddress'],
];
const IF_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 5: 'dormant', 7: 'lowerLayerDown' };
const LEVELS = { coldStart: 'warning', warmStart: 'warning', linkDown: 'warning', authenticationFailure: 'warning', linkUp: 'notice' };
const DESCRIPTIONS = {
  coldStart: 'Router restarted (cold start)',
  warmStart: 'Router agent restarted (warm start)',
  linkDown: 'Interface went down',
  linkUp: 'Interface came up',
  authenticationFailure: 'SNMP authentication failure',
};

/** Turn a decoded trap into a log row. */
export function trapToRow(trap, remoteAddress, now = Date.now()) {
  const details = trap.varbinds.map(({ oid, value }) => {
    const known = KNOWN_OIDS.find(([p]) => oid === p || oid.startsWith(p));
    const name = known ? known[1] : oid;
    const v = /^if(Admin|Oper)Status$/.test(name) ? (IF_STATUS[value] ?? value) : value;
    return `${name}=${v}`;
  });
  const ifName = trap.varbinds.find((v) => /^1\.3\.6\.1\.2\.1\.(2\.2\.1\.2|31\.1\.1\.1\.1)\./.test(v.oid))?.value;
  const base = DESCRIPTIONS[trap.name] ?? `Trap ${trap.name}`;
  return {
    ts: now,
    source: 'snmp',
    host: trap.agent || remoteAddress,
    category: trap.name,
    facility: 'snmp',
    level: LEVELS[trap.name] ?? 'info',
    message: `${base}${ifName ? `: ${ifName}` : ''}${details.length ? ` (${details.join(', ')})` : ''}`,
    raw: JSON.stringify({
      version: trap.version,
      type: trap.type,
      trapOid: trap.trapOid,
      uptimeTicks: trap.uptimeTicks,
      varbinds: trap.varbinds,
    }),
  };
}
