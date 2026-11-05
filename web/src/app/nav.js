import * as I from '../components/ui/Icons.jsx';

// Sidebar structure. "settings" pages mirror the router's admin menu, read-only.
// `requires` hides an item unless the server reports that feature (status.smsEnabled, status.radioEnabled).
export const NAV = [
  {
    group: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: I.Grid },
      { id: 'insights', label: 'Insights', icon: I.Sparkle },
      // The only pages that write to the router: SMS, and the preferred network mode and bands.
      { id: 'messages', label: 'Messages', icon: I.Message, requires: 'smsEnabled' },
      { id: 'radio', label: 'Radio control', icon: I.Sliders, requires: 'radioEnabled' },
    ],
  },
  {
    group: 'Monitor',
    items: [
      { id: 'cellular', label: 'Cellular', icon: I.Antenna },
      { id: 'devices', label: 'Devices', icon: I.Laptop },
      { id: 'wifi', label: 'Wi-Fi', icon: I.Wifi },
      { id: 'traffic', label: 'Traffic', icon: I.Activity },
      { id: 'system', label: 'System', icon: I.Cpu },
      { id: 'tables', label: 'Network tables', icon: I.Table },
    ],
  },
  {
    group: 'Router settings',
    note: 'read-only',
    items: [
      { id: 'settings/broadband', label: 'Broadband', icon: I.Globe },
      { id: 'settings/wireless', label: 'Wireless', icon: I.Wifi },
      { id: 'settings/lan', label: 'Home networking', icon: I.Home },
      { id: 'settings/routing', label: 'Routing & NAT', icon: I.Route },
      { id: 'settings/qos', label: 'QoS', icon: I.Gauge },
      { id: 'settings/security', label: 'Security', icon: I.Shield },
      { id: 'settings/access', label: 'Remote access', icon: I.Key },
      { id: 'settings/voip', label: 'VoIP', icon: I.Phone },
      { id: 'settings/maintenance', label: 'Maintenance', icon: I.Wrench },
    ],
  },
];

export const NAV_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
