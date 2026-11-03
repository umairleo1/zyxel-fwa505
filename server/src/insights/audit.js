// Configuration audit. Runs server-side on raw (unmasked) config so e.g. a default
// SNMP community can be flagged without ever sending it to the browser.

const isDfs = (ch) => ch >= 52 && ch <= 144;
const check = (id, area, status, title, detail, fix) => ({ id, area, status, title, detail, fix: fix ?? null });

/** Configuration audit. `get(id)` returns unwrapped raw data for a catalog endpoint. */
export async function runAudit(get) {
  // Router arrays can contain null placeholders; drop them so checks stay simple.
  const safe = async (id) => {
    try {
      const d = await get(id);
      return Array.isArray(d) ? d.filter((x) => x && typeof x === 'object') : d;
    } catch {
      return null;
    }
  };
  const [mgmt, wlan, wps, snmp, firewall, lanadv, natConf, nat, tr69, sim, fota, time, logset, user, status, lan, hosts] =
    await Promise.all(
      [
        'mgmt_srv',
        'wlan',
        'wps',
        'snmp',
        'firewall',
        'lanadv',
        'nat_conf',
        'nat',
        'tr69',
        'cellwan_sim',
        'periodic_FOTA_config',
        'time',
        'logset',
        'user_account',
        'status',
        'lan',
        'lanhosts',
      ].map(safe),
    );
  const out = [];

  // Remote management exposure
  if (mgmt) {
    const exposed = mgmt.filter((s) => /WAN/i.test(s.Mode || ''));
    const insecure = exposed.filter((s) => /TELNET|FTP|HTTP$/i.test(s.Name));
    out.push(
      insecure.length
        ? check(
            'remote-mgmt',
            'Access',
            'fail',
            'Unencrypted management reachable from the Internet',
            `${insecure.map((s) => `${s.Name}:${s.Port}`).join(', ')} accept WAN connections.`,
            'Maintenance → Remote Management: set these to LAN only or Disable.',
          )
        : exposed.length
          ? check(
              'remote-mgmt',
              'Access',
              'warn',
              'Management reachable from the Internet',
              `${exposed.map((s) => `${s.Name}:${s.Port}`).join(', ')} accept WAN connections.`,
              'Restrict to trusted IPs (Trust Domain) or LAN only.',
            )
          : check(
              'remote-mgmt',
              'Access',
              'pass',
              'Router management is LAN-only',
              `${mgmt
                .filter((s) => s.Mode)
                .map((s) => s.Name)
                .join(', ')} restricted to the LAN; others disabled.`,
            ),
    );
    const telnet = mgmt.find((s) => /TELNET/i.test(s.Name));
    if (telnet && telnet.Mode)
      out.push(
        check(
          'telnet',
          'Access',
          'warn',
          'Telnet is enabled',
          `Telnet (${telnet.Mode}) sends credentials in clear text.`,
          'Disable Telnet; use SSH if needed.',
        ),
      );
  }

  // Wi-Fi security
  if (wlan) {
    const enabled = wlan.filter((w) => w.wlEnable);
    const weak = enabled.filter((w) => /none|wep|open/i.test(w.SecurityMode || ''));
    const wpa3Capable = wlan.some((w) => /WPA3/i.test(w.ModesSupported || ''));
    const wpa3 = enabled.filter((w) => /WPA3/i.test(w.SecurityMode || ''));
    out.push(
      weak.length
        ? check(
            'wifi-sec',
            'Wi-Fi',
            'fail',
            'Open or WEP Wi-Fi network',
            weak.map((w) => `${w.SSID} (${w.band}): ${w.SecurityMode}`).join('; '),
            'Network Setting → Wireless: use WPA2/WPA3-Personal.',
          )
        : check(
            'wifi-sec',
            'Wi-Fi',
            wpa3.length || !wpa3Capable ? 'pass' : 'info',
            `Wi-Fi encryption: ${[...new Set(enabled.map((w) => w.SecurityMode))].join(', ') || '—'}`,
            `${enabled.length} active SSID${enabled.length === 1 ? '' : 's'}${wpa3Capable && !wpa3.length ? '. WPA3 is supported but not enabled.' : '.'}`,
            wpa3Capable && !wpa3.length ? 'Consider WPA2/WPA3 mixed mode once all your devices support it.' : null,
          ),
    );
    if (enabled.some((w) => /^Zyxel_/i.test(w.SSID)))
      out.push(
        check(
          'ssid-default',
          'Wi-Fi',
          'info',
          'Default network name',
          'The SSID reveals the router brand, which helps attackers pick known exploits.',
          'Rename the SSID to something neutral.',
        ),
      );
    const guest = wlan.filter((w) => !w.MainSSID && w.wlEnable);
    out.push(
      check(
        'guest',
        'Wi-Fi',
        'info',
        guest.length ? `${guest.length} guest network(s) enabled` : 'No guest network',
        guest.length ? guest.map((w) => w.SSID).join(', ') : 'Visitors would join your main network.',
        guest.length ? null : 'Enable a guest SSID with isolation for visitors and IoT devices.',
      ),
    );
    const radio24 = enabled.find((w) => w.band === '2.4GHz' && w.MainSSID);
    if (radio24 && ![1, 6, 11].includes(Number(radio24.channel)))
      out.push(
        check(
          'ch24',
          'Wi-Fi',
          'warn',
          `2.4 GHz on overlapping channel ${radio24.channel}`,
          "Only channels 1, 6 and 11 don't overlap.",
          'Pick 1, 6 or 11 (or leave Auto).',
        ),
      );
    const radio5 = enabled.find((w) => w.band === '5GHz' && w.MainSSID);
    if (radio5 && isDfs(Number(radio5.channel)))
      out.push(
        check(
          'dfs',
          'Wi-Fi',
          'info',
          `5 GHz uses DFS channel ${radio5.channel}`,
          'DFS channels must vacate when radar is detected, causing brief 5 GHz drop-outs (~1 min).',
          'If you see periodic 5 GHz disconnects, prefer channels 36–48.',
        ),
      );
  }
  if (wps) {
    const on = wps.filter((w) => w.Enable);
    if (on.length) {
      const pin = on.some((w) => w.X_ZYXEL_WPS_EnableAPPin || w.X_ZYXEL_WPS_EnableStaPin);
      out.push(
        check(
          'wps',
          'Wi-Fi',
          pin ? 'fail' : 'warn',
          pin ? 'WPS PIN is enabled' : 'WPS push-button is enabled',
          pin ? 'WPS PINs can be brute-forced in hours.' : 'Anyone with physical access can pair a device by pressing the button.',
          "Disable WPS if you don't use it.",
        ),
      );
    } else out.push(check('wps', 'Wi-Fi', 'pass', 'WPS is disabled', 'No push-button or PIN pairing.'));
  }

  // Network services
  if (snmp?.[0]) {
    const s = snmp[0];
    const defaults = ['public', 'private'].filter((c) => [s.GetCommunity, s.SetCommunity].includes(c));
    out.push(
      s.Enable
        ? check(
            'snmp',
            'Services',
            defaults.length ? 'fail' : 'warn',
            defaults.length ? 'SNMP enabled with default communities' : 'SNMP is enabled',
            defaults.length
              ? `Uses the well-known community string(s) ${defaults.map((d) => `"${d}"`).join(', ')}.`
              : 'SNMP agent is running.',
            'Change the Get/Set communities, or disable SNMP (traps work without the agent being reachable from WAN).',
          )
        : check(
            'snmp',
            'Services',
            defaults.length ? 'info' : 'pass',
            'SNMP agent is disabled',
            defaults.length ? 'Communities are still the defaults; change them before enabling SNMP.' : 'Not reachable.',
          ),
    );
  }
  if (lanadv) {
    const upnp = lanadv.some((a) => a.UPnPEnable);
    out.push(
      check(
        'upnp',
        'Services',
        upnp ? 'warn' : 'pass',
        upnp ? 'UPnP is enabled' : 'UPnP is disabled',
        upnp ? 'Any LAN device (or malware) can open inbound ports without asking.' : "Devices can't open ports on their own.",
        upnp ? 'Disable UPnP unless a game console or app needs it.' : null,
      ),
    );
  }
  if (tr69?.[0])
    out.push(
      check(
        'tr069',
        'Services',
        'info',
        tr69[0].EnableCWMP ? 'ISP remote management (TR-069) is on' : 'ISP remote management (TR-069) is off',
        tr69[0].EnableCWMP ? `ACS: ${tr69[0].URL || '—'}` : "Your ISP can't reconfigure the router remotely.",
      ),
    );

  // Firewall & exposure
  if (firewall?.[0]) {
    const f = firewall[0];
    out.push(
      check(
        'fw',
        'Firewall',
        f.IPv4_Enable && f.IPv6_Enable ? 'pass' : 'fail',
        f.IPv4_Enable && f.IPv6_Enable ? `Firewall on (IPv4 + IPv6, level ${f.Level_GUI})` : 'Firewall partly disabled',
        `IPv4 ${f.IPv4_Enable ? 'on' : 'off'}, IPv6 ${f.IPv6_Enable ? 'on' : 'off'}, DoS protection ${f.enableDos ? 'on' : 'off'}.`,
        f.IPv4_Enable && f.IPv6_Enable ? null : 'Security → Firewall: enable both.',
      ),
    );
  }
  const fwInfo = status?.[0]?.FirewallInfo;
  if (fwInfo)
    out.push(
      check(
        'ping',
        'Firewall',
        fwInfo.X_ZYXEL_DenyPing ? 'pass' : 'info',
        fwInfo.X_ZYXEL_DenyPing ? 'Router ignores pings from the Internet' : 'Router answers pings from the Internet',
        fwInfo.X_ZYXEL_DenyPing ? 'Harder to discover by scanners.' : 'Makes the router visible to scanners.',
      ),
    );
  if (natConf?.[0]) {
    const dmz = natConf[0].DMZHost;
    out.push(
      check(
        'dmz',
        'Firewall',
        dmz && dmz !== '0.0.0.0' ? 'fail' : 'pass',
        dmz && dmz !== '0.0.0.0' ? `DMZ host ${dmz} is fully exposed` : 'No DMZ host',
        dmz && dmz !== '0.0.0.0' ? 'All unsolicited inbound traffic is forwarded to this device.' : 'No device is fully exposed.',
        dmz && dmz !== '0.0.0.0' ? 'Use specific port forwards instead.' : null,
      ),
    );
  }
  if (nat)
    out.push(
      check(
        'portfwd',
        'Firewall',
        nat.length ? 'info' : 'pass',
        nat.length ? `${nat.length} port forward rule(s)` : 'No port forwards',
        nat.length
          ? nat
              .map((r) => `${r.Description || r.ServiceName || 'rule'} → ${r.InternalClient || r.X_ZYXEL_InternalClient || '?'}`)
              .join('; ')
          : 'Nothing on your LAN is published to the Internet.',
      ),
    );

  // Account, device & maintenance
  if (user?.[0]) {
    const u = user[0];
    out.push(
      check(
        'lockout',
        'Account',
        u.AccountRetryTime > 0 && u.AccountRetryTime <= 5 ? 'pass' : 'warn',
        `Login lockout after ${u.AccountRetryTime} failures (${Math.round(u.AccountLockTime / 60)} min)`,
        `Sessions idle out after ${Math.round(u.AccountIdleTime / 60)} min.`,
      ),
    );
  }
  if (sim?.[0])
    out.push(
      check(
        'simpin',
        'Device',
        sim[0].USIM_PIN_Protection ? 'pass' : 'info',
        sim[0].USIM_PIN_Protection ? 'SIM PIN protection is on' : 'SIM PIN protection is off',
        sim[0].USIM_PIN_Protection ? "A stolen SIM can't be used elsewhere." : 'If the router is stolen, the SIM works in any device.',
        sim[0].USIM_PIN_Protection ? null : 'Optional: enable the SIM PIN (Broadband → SIM).',
      ),
    );
  if (fota?.[0])
    out.push(
      check(
        'fota',
        'Maintenance',
        fota[0].PeriodicCheckEnable ? 'pass' : 'warn',
        fota[0].PeriodicCheckEnable ? 'Automatic firmware updates are on' : 'Automatic firmware updates are off',
        fota[0].PeriodicCheckEnable ? 'Security fixes install without intervention.' : 'Security fixes need to be installed manually.',
      ),
    );
  const dev = status?.[0]?.DeviceInfo;
  const modem = status?.[0]?.CellIntfInfo?.X_ZYXEL_ModuleSoftwareVersion;
  if (dev)
    out.push(
      check(
        'fw-version',
        'Maintenance',
        'info',
        `Firmware ${dev.SoftwareVersion}`,
        `Model ${dev.ModelName}, hardware ${dev.HardwareVersion}${modem ? `, modem ${modem}` : ''}.`,
      ),
    );
  if (time?.[0])
    out.push(
      check(
        'ntp',
        'Maintenance',
        time[0].NTPServer1 && time[0].NTPServer1 !== 'None' ? 'pass' : 'warn',
        'Clock synced via NTP',
        `${time[0].NTPServer1} · ${time[0].TimeZone}`,
      ),
    );
  if (logset?.[0]) {
    const remote = /remote/i.test(logset[0].LogMode) && logset[0].LogServer && logset[0].LogServer !== '0.0.0.0';
    out.push(
      check(
        'syslog',
        'Maintenance',
        remote ? 'pass' : 'warn',
        remote ? `Logs are sent to ${logset[0].LogServer}:${logset[0].UDPPort}` : 'Logs are only kept on the router (last 100 lines)',
        remote ? 'History survives reboots.' : 'Events are lost after ~8 hours or on reboot.',
        remote ? null : 'Maintenance → Log Setting: send to Insight (see the banner on the dashboard).',
      ),
    );
  }

  // LAN
  if (lan?.[0] && hosts?.[0]) {
    const ipNum = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
    const size = ipNum(lan[0].DHCP_MaxAddress) - ipNum(lan[0].DHCP_MinAddress) + 1;
    const used = (hosts[0].lanhosts ?? []).filter((h) => h.AddressSource === 'DHCP').length;
    out.push(
      check(
        'dhcp-pool',
        'LAN',
        used / size > 0.8 ? 'warn' : 'pass',
        `DHCP pool ${used}/${size} leases in use`,
        `${lan[0].DHCP_MinAddress} – ${lan[0].DHCP_MaxAddress}, lease ${Math.round(lan[0].DHCP_LeaseTime / 3600)} h.`,
      ),
    );
  }

  const order = { fail: 0, warn: 1, info: 2, pass: 3 };
  out.sort((a, b) => order[a.status] - order[b.status]);
  const counts = { pass: 0, info: 0, warn: 0, fail: 0 };
  for (const c of out) counts[c.status]++;
  // Simple score: passes count fully, infos half, warnings a quarter, fails zero.
  const scored = out.length ? Math.round(((counts.pass + counts.info * 0.75 + counts.warn * 0.25) / out.length) * 100) : null;
  return { checks: out, counts, score: scored, at: Date.now() };
}
