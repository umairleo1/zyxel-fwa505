// Read-only endpoints Insight may request, mapped from the router's own UI
// (FWA505 V1.71). Anything that triggers work on a GET is deliberately absent:
// cellular/PLMN scans, ping/iperf/OAM tests, azimuth calibration, backups,
// online firmware checks, SMS (reading marks messages read).

const DAL_IDS = `status cardpage_status cellwan_status cellwan_sim cellular cellwan cellwan_band cellwan_lock cellwan_nr_lock
  cellwan_mgmt cellwan_mapn cellwan_psru cellwan_esim cellwan_esim_profile lanhosts Traffic_Status VOIP_Status wlan wps wmm
  wifi_easy_mesh WIFI_SONIQ wlan_scheduler wlan_sch_access wifi_macfilter lan lanadv static_dhcp custom_dhcp ipalias wan wan_adv
  ethwanlan ethctl LanPortInfo xlat dns dns_route ddns nat nat_conf nat_addr_map nat_trigger NAT_APPLICATION static_route
  policy_route rip qos qos_queue qos_class qos_shaper qos_policer igmp_mld vlan_group intf_group tunnel_setting usb_info
  media_server print_server firewall firewall_proto firewall_acl macfilter paren_ctl scheduler ipsec pptp time region
  logset email_ntfy mgmt_srv sp_mgmt_srv trust_domain sp_trust_domain trust_domain_passthru tr69 tr369_local_agent
  tr369_local_agent_mtp tr369_local_agent_controller mqtt_client user_account login_privilege schedule_reboot
  periodic_FOTA_config sensor one_connect ncc_discovery sip_account sip_sp phone speeddial`
  .split(/\s+/)
  .filter(Boolean);

// DAL responses are {result, Object:[...]}; unwrap to the array.
const dal = (data) => (Array.isArray(data?.Object) ? data.Object : []);
// *_handle endpoints return [{ result: ... }].
const handle = (data) => (Array.isArray(data) ? data[0] : data) ?? {};

/** WLANTable_handle returns fixed-width text tables per band. */
export function parseWlanTable(data) {
  const h = handle(data);
  const rows = [];
  for (const [key, band] of [
    ['result', '2.4GHz'],
    ['result5', '5GHz'],
    ['result6', '6GHz'],
  ]) {
    const text = typeof h[key] === 'string' ? h[key] : '';
    const tokens = text
      .replace(/^\s*Address\s+Rate\(Mbps\)\s+RSSI\s+SNR\s+Level\s*/i, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (let i = 0; i + 4 < tokens.length; i += 5) {
      const [mac, rate, rssi, snr, level] = tokens.slice(i, i + 5);
      if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac)) break;
      rows.push({ mac: mac.toLowerCase(), band, rateMbps: Number(rate), rssi: Number(rssi), snr: Number(snr), level: Number(level) });
    }
  }
  return rows;
}

// State that changes minute to minute; everything else is configuration and is
// cached for minutes (it only changes when someone edits it in the admin page).
export const LIVE_IDS = new Set([
  'status',
  'cardpage_status',
  'cellwan_status',
  'lanhosts',
  'Traffic_Status',
  'VOIP_Status',
  'stations',
  'arp',
  'arp6',
  'routes',
  'routes6',
  'steering',
]);

export const CATALOG = {
  ...Object.fromEntries(DAL_IDS.map((id) => [id, { path: `/cgi-bin/DAL?oid=${id}`, unwrap: dal }])),
  arp: { path: '/cgi-bin/ARPTable_handle', unwrap: (d) => handle(d).result ?? [] },
  arp6: { path: '/cgi-bin/ARPTable_handle', unwrap: (d) => handle(d).resultv6 ?? [] },
  routes: { path: '/cgi-bin/RoutingTable_handle', unwrap: (d) => handle(d).result ?? [] },
  routes6: { path: '/cgi-bin/RoutingTable_handle', unwrap: (d) => handle(d).resultv6 ?? [] },
  stations: { path: '/cgi-bin/WLANTable_handle', unwrap: parseWlanTable },
  steering: { path: '/cgi-bin/SteeringStatus_handle', unwrap: handle },
  interfaces: { path: '/cgi-bin/WAN_LAN_LIST_Get', unwrap: dal },
  lan_ports: { path: '/cgi-bin/LAN_PORT_LIST_Get', unwrap: dal },
  snmp: { path: '/cgi-bin/System?oid=snmp', unwrap: (d) => (Array.isArray(d) ? d : [d]) },
};
