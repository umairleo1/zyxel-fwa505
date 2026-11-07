import { useState } from 'react';
import { api } from '../../api/client.js';
import { controlIndex, controlPatch, controlSummary } from '../../lib/control.js';
import { ControlPanel, Field, Toggle } from './Common.jsx';

const KEYS = [
  'Name',
  'Enable',
  'Type',
  'Mode',
  'Encapsulation',
  'VLANEnable',
  'VLANID',
  'VLANPriority',
  'MaxMTUSize',
  'NatEnable',
  'FullConeEnabled',
  'sysGwEnable',
  'sysGw6Enable',
  'ipMode',
  'pppUsername',
  'pppPassword',
  'ConnectionTrigger',
  'IdleDisconnectTime',
  'IGMPEnable',
  'MLDEnable',
  'ipStatic',
  'IPAddress',
  'SubnetMask',
  'GatewayIPAddress',
  'ipDnsStatic',
  'DNSServer',
  'ip6Static',
  'IP6Address',
  'NextHop',
  'ip6DnsStatic',
  'DNS6Server',
];
const TYPES = { ETH: 'Ethernet WAN', CELL: 'Cellular WAN', ATM: 'ADSL (ATM)', PTM: 'VDSL (PTM)' };
// The server's rule for new connection names.
const WAN_NAME = String.raw`[A-Za-z0-9_. \-]{1,32}`;
const NEW_WAN = {
  Name: '',
  Enable: true,
  Type: 'ETH',
  Mode: 'IP_Routed',
  Encapsulation: 'IPoE',
  VLANEnable: false,
  VLANID: 1,
  VLANPriority: 0,
  MaxMTUSize: 1500,
  NatEnable: true,
  FullConeEnabled: false,
  sysGwEnable: true,
  sysGw6Enable: true,
  ipMode: 'DualStack',
  pppUsername: '',
  pppPassword: '',
  ConnectionTrigger: 'AlwaysOn',
  IdleDisconnectTime: 0,
  IGMPEnable: true,
  MLDEnable: false,
  ipStatic: false,
  ipDnsStatic: false,
  ip6Static: false,
  ip6DnsStatic: false,
};

function WanEditor({ original, index, flags, disabled, ask, create = false }) {
  const [draft, setDraft] = useState(() => ({ ...(create ? NEW_WAN : original), pppPassword: '' }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const cell = draft.Type === 'CELL';
  const routed = draft.Mode !== 'IP_Bridged';
  const ppp = !cell && draft.Encapsulation === 'PPPoE';
  const ipv4 = draft.ipMode !== 'IPv6';
  const ipv6 = draft.ipMode !== 'IPv4';
  // PPPoE adds 8 bytes of header, unless the firmware supports a 1500-byte PPPoE MTU.
  const pppoe1500 = [true, 1, 'true'].includes(flags?.SUPPORT_PPPOE_MTU_1500);
  const maxMtu = !cell && draft.Encapsulation === 'PPPoE' && !pppoe1500 ? 1492 : 1500;
  function submit(e) {
    e.preventDefault();
    const relevant = KEYS.filter((key) => {
      if (
        cell &&
        [
          'Encapsulation',
          'VLANEnable',
          'VLANID',
          'VLANPriority',
          'pppUsername',
          'pppPassword',
          'ConnectionTrigger',
          'IdleDisconnectTime',
        ].includes(key)
      )
        return false;
      if (!ppp && ['pppUsername', 'pppPassword', 'ConnectionTrigger', 'IdleDisconnectTime'].includes(key)) return false;
      if (!draft.VLANEnable && ['VLANID', 'VLANPriority'].includes(key)) return false;
      if (!draft.ipStatic && ['IPAddress', 'SubnetMask', 'GatewayIPAddress'].includes(key)) return false;
      if (!draft.ipDnsStatic && key === 'DNSServer') return false;
      if (!draft.ip6Static && ['IP6Address', 'NextHop'].includes(key)) return false;
      if (!draft.ip6DnsStatic && key === 'DNS6Server') return false;
      return true;
    });
    const patch = controlPatch(create ? {} : original, draft, relevant, ['pppPassword']);
    if (!Object.keys(patch).length) return ask({ empty: true });
    ask({
      title: create ? 'Create WAN connection?' : `Save ${original.Name || 'WAN connection'}?`,
      message:
        'This can interrupt Internet access or make the router unreachable. Automatic rollback is not available for WAN changes. Keep a configuration backup and a local way to reconnect.',
      summary: controlSummary(patch),
      phrase: 'SAVE WAN',
      danger: true,
      button: 'Save WAN settings',
      action: () => api.controlWan(create ? null : index, patch),
      success: 'WAN settings submitted. Check connectivity and the refreshed settings.',
    });
  }
  return (
    <form onSubmit={submit} className="control-editor">
      <fieldset className="control-fields" disabled={disabled}>
        <div className="control-grid">
          <Field
            label="Connection name"
            value={draft.Name}
            onChange={(v) => set('Name', v)}
            disabled={!create}
            required
            maxLength="32"
            pattern={WAN_NAME}
            title="1 to 32 letters, numbers, spaces, dots, underscores or hyphens"
          />
          <Field
            label="Interface type"
            value={draft.Type}
            onChange={(v) => set('Type', v)}
            options={create ? [['ETH', 'Ethernet WAN']] : [[draft.Type, TYPES[draft.Type] ?? draft.Type]]}
            disabled
          />
          <Field
            label="Connection mode"
            value={draft.Mode}
            onChange={(v) => set('Mode', v)}
            options={
              cell
                ? [['IP_Routed', 'Routing']]
                : [
                    ['IP_Routed', 'Routing'],
                    ['IP_Bridged', 'Bridge'],
                  ]
            }
          />
          {!cell && (
            <Field
              label="Encapsulation"
              value={draft.Encapsulation}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  Encapsulation: v,
                  // Switching to PPPoE: bring a 1500-byte MTU down to what PPPoE allows.
                  ...(v === 'PPPoE' && !pppoe1500 && Number(d.MaxMTUSize) > 1492 ? { MaxMTUSize: 1492 } : {}),
                }))
              }
              options={['IPoE', 'PPPoE']}
            />
          )}
          <Field
            label="IP protocol"
            value={draft.ipMode}
            onChange={(v) => set('ipMode', v)}
            options={[
              ['IPv4', 'IPv4'],
              ['IPv6', 'IPv6'],
              ['DualStack', 'Dual stack'],
            ]}
          />
          <Field
            label="MTU (bytes)"
            value={draft.MaxMTUSize}
            onChange={(v) => set('MaxMTUSize', v)}
            type="number"
            min="576"
            max={maxMtu}
            required
            help={maxMtu < 1500 ? 'At most 1492 with PPPoE.' : undefined}
          />
        </div>
        <Toggle label="Connection enabled" value={draft.Enable} onChange={(v) => set('Enable', v)} />
        {!cell && (
          <>
            <Toggle label="Use an 802.1Q VLAN" value={draft.VLANEnable} onChange={(v) => set('VLANEnable', v)} />
            {draft.VLANEnable && (
              <div className="control-grid">
                <Field label="VLAN ID" type="number" min="1" max="4094" required value={draft.VLANID} onChange={(v) => set('VLANID', v)} />
                <Field
                  label="VLAN priority"
                  type="number"
                  min="0"
                  max="7"
                  required
                  value={draft.VLANPriority}
                  onChange={(v) => set('VLANPriority', v)}
                />
              </div>
            )}
          </>
        )}
        {ppp && (
          <div className="control-subsection">
            <h3>PPP authentication</h3>
            <div className="control-grid">
              <Field label="PPP username" value={draft.pppUsername} onChange={(v) => set('pppUsername', v)} required autoComplete="off" />
              <Field
                label="New PPP password"
                type="password"
                value={draft.pppPassword}
                onChange={(v) => set('pppPassword', v)}
                autoComplete="new-password"
                help={create ? 'Password supplied by your Internet provider.' : 'Leave blank to preserve the current password.'}
              />
              <Field
                label="Connection trigger"
                value={draft.ConnectionTrigger ?? 'AlwaysOn'}
                onChange={(v) => set('ConnectionTrigger', v)}
                options={[
                  ['AlwaysOn', 'Always on'],
                  ['OnDemand', 'On demand'],
                ]}
              />
              {draft.ConnectionTrigger === 'OnDemand' && (
                <Field
                  label="Idle disconnect (seconds)"
                  type="number"
                  min="0"
                  max="18000"
                  value={draft.IdleDisconnectTime ?? 0}
                  onChange={(v) => set('IdleDisconnectTime', v)}
                />
              )}
            </div>
          </div>
        )}
        {routed && (
          <>
            <div className="control-checks">
              <Toggle label="NAT" value={draft.NatEnable} onChange={(v) => set('NatEnable', v)} />
              <Toggle label="Full-cone NAT" value={draft.FullConeEnabled} onChange={(v) => set('FullConeEnabled', v)} />
              <Toggle label="IPv4 default route" value={draft.sysGwEnable} onChange={(v) => set('sysGwEnable', v)} />
              <Toggle label="IPv6 default route" value={draft.sysGw6Enable} onChange={(v) => set('sysGw6Enable', v)} />
              <Toggle label="IGMP proxy" value={draft.IGMPEnable} onChange={(v) => set('IGMPEnable', v)} />
              <Toggle label="MLD proxy" value={draft.MLDEnable} onChange={(v) => set('MLDEnable', v)} />
            </div>
            {ipv4 && (
              <div className="control-subsection">
                <h3>IPv4</h3>
                <Toggle label="Static IPv4 address" value={draft.ipStatic} onChange={(v) => set('ipStatic', v)} />
                {draft.ipStatic && (
                  <div className="control-grid">
                    <Field label="IP address" value={draft.IPAddress} onChange={(v) => set('IPAddress', v)} required />
                    <Field label="Subnet mask" value={draft.SubnetMask} onChange={(v) => set('SubnetMask', v)} required />
                    <Field label="Gateway address" value={draft.GatewayIPAddress} onChange={(v) => set('GatewayIPAddress', v)} />
                  </div>
                )}
                <Toggle label="Set IPv4 DNS servers" value={draft.ipDnsStatic} onChange={(v) => set('ipDnsStatic', v)} />
                {draft.ipDnsStatic && (
                  <Field
                    label="DNS servers"
                    value={draft.DNSServer}
                    onChange={(v) => set('DNSServer', v)}
                    help="Separate multiple addresses with commas."
                    required
                  />
                )}
              </div>
            )}
            {ipv6 && (
              <div className="control-subsection">
                <h3>IPv6</h3>
                <Toggle label="Static IPv6 address" value={draft.ip6Static} onChange={(v) => set('ip6Static', v)} />
                {draft.ip6Static && (
                  <div className="control-grid">
                    <Field label="IPv6 address / prefix" value={draft.IP6Address} onChange={(v) => set('IP6Address', v)} required />
                    <Field label="Next hop" value={draft.NextHop} onChange={(v) => set('NextHop', v)} />
                  </div>
                )}
                <Toggle label="Set IPv6 DNS servers" value={draft.ip6DnsStatic} onChange={(v) => set('ip6DnsStatic', v)} />
                {draft.ip6DnsStatic && (
                  <Field
                    label="IPv6 DNS servers"
                    value={draft.DNS6Server}
                    onChange={(v) => set('DNS6Server', v)}
                    help="Separate multiple addresses with commas."
                    required
                  />
                )}
              </div>
            )}
          </>
        )}
        <div className="control-actions">
          <button className="btn btn-primary" type="submit">
            Review WAN changes
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export default function Wan({ snapshot, disabled, ask }) {
  const cap = snapshot.capabilities?.wan;
  return (
    <ControlPanel
      title="WAN connections"
      subtitle="Edit supported Ethernet and cellular connection settings."
      capability={cap}
      error={snapshot.errors?.wan}
    >
      <p className="control-description">
        Changing routing, VLANs or bridge mode can disconnect this computer. WAN changes have no automatic rollback.
      </p>
      {(snapshot.wan ?? []).map((row, i) => (
        <details className="control-details" key={JSON.stringify(row)}>
          <summary>
            <span>
              <strong>{row.Name || `WAN ${i + 1}`}</strong>
              <small>
                {row.Type} · {row.Encapsulation ?? 'IPoE'} · {row.Enable ? 'Enabled' : 'Disabled'}
              </small>
            </span>
            <span className="muted">Edit</span>
          </summary>
          {controlIndex(row) == null ? (
            <p className="control-note">The router did not report this connection’s index, so it can’t be edited here.</p>
          ) : (
            <WanEditor original={row} index={controlIndex(row)} flags={snapshot.flags} disabled={disabled || !cap?.available} ask={ask} />
          )}
        </details>
      ))}
      {!snapshot.wan?.length && <p className="empty-inline">No WAN connections were returned.</p>}
      <details className="control-details">
        <summary>
          <strong>Add Ethernet WAN connection</strong>
        </summary>
        <WanEditor original={{}} create flags={snapshot.flags} disabled={disabled || !cap?.available} ask={ask} />
      </details>
    </ControlPanel>
  );
}
