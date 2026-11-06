import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCarriers } from '../../src/collector/carriers.js';

const cell = {
  X_ZYXEL_CurrentBand: 'B7',
  X_ZYXEL_DownlinkBandwidth: '20M',
  X_ZYXEL_PhyCellID: 274,
  X_ZYXEL_RFCN: '3350',
  X_ZYXEL_RSRP: -105,
  X_ZYXEL_RSRQ: -12,
  X_ZYXEL_SINR: 3,
  RSSI: -92,
};
const nr = { Enable: true, Band: 'N78', DownlinkBandwidth: '40M', PhyCellID: 1006, RFCN: 646080, RSRP: -97, RSRQ: -12, SINR: 4, RSSI: -84 };

test('LTE primary + NR leg from the status objects alone', () => {
  const s = summarizeCarriers({ cell, nr });
  assert.equal(s.combo, 'B7 + n78');
  assert.equal(s.totalBandwidth, 60);
  assert.deepEqual(
    s.carriers.map((c) => [c.role, c.band, c.bandwidth, c.channel]),
    [
      ['primary', 'B7', 20, 3350],
      ['nr-anchor', 'n78', 40, 646080],
    ],
  );
});

test('adds LTE and NR secondary carriers from cellwan_status SCC_Info', () => {
  const cellwan = {
    INTF_RSRP: -101,
    INTF_RSRQ: -11,
    INTF_SINR: 6,
    INTF_RSSI: -90,
    NSA_Enable: true,
    NSA_Band: 'N78',
    NSA_RSRP: -95,
    NSA_SINR: 9,
    NSA_DownlinkBandwidth: '40M',
    SCC_Info: [
      { CC_Type: 'SCC', Band: 'B3', Bandwidth: '15M', PhyCellID: 101, RFCN: 1617, RSRP: -108, RSRQ: -13, SINR: 1 },
      { CC_Type: 'SCC', Band: 'B20', Bandwidth: '10M', PhyCellID: 55, RFCN: 6300, RSRP: -99 },
      { CC_Type: 'PCC', Band: 'N78', Bandwidth: '40M' }, // NR anchor duplicate: skipped
      { CC_Type: 'SCC', Band: 'n1', Bandwidth: '20M', RSRP: -110 },
    ],
  };
  const s = summarizeCarriers({ cell, nr, cellwan });
  assert.equal(s.combo, 'B7+B3+B20 + n78+n1');
  assert.equal(s.totalBandwidth, 20 + 15 + 10 + 40 + 20);
  assert.equal(s.carriers[0].rsrp, -101); // cellwan wins over the slower status poll
  assert.deepEqual(
    s.carriers.map((c) => `${c.role}:${c.band}`),
    ['primary:B7', 'secondary:B3', 'secondary:B20', 'nr-anchor:n78', 'secondary:n1'],
  );
  assert.equal(s.carriers[1].pci, 101);
});

test('matches the real FWA505 SCC_Info shape (PhysicalCellID, padding rows)', () => {
  const cellwan = {
    INTF_RSRP: -103,
    INTF_Current_Band: 'B7',
    INTF_Downlink_Bandwidth: '20M',
    INTF_RFCN: '3350',
    INTF_PhyCell_ID: 274,
    NSA_Enable: true,
    NSA_Band: 'N78',
    NSA_RSRP: -95,
    NSA_DownlinkBandwidth: '40M',
    SCC_Info: [
      {
        Enable: true,
        PhysicalCellID: 391,
        RFCN: 1617,
        Band: 'B3',
        RSRP: -89,
        SINR: 14,
        UplinkBandwidth: '20M',
        DownlinkBandwidth: '20M',
        CC_Type: 'SCC',
      },
      {
        Enable: true,
        PhysicalCellID: 957,
        RFCN: 431070,
        Band: 'N1',
        RSRP: -100,
        SINR: 5,
        UplinkBandwidth: '',
        DownlinkBandwidth: '20M',
        CC_Type: 'SCC',
      },
      {
        Enable: true,
        PhysicalCellID: -1,
        RFCN: 0,
        Band: '',
        RSSI: -120,
        RSRP: -140,
        RSRQ: -240,
        SINR: -20,
        DownlinkBandwidth: '',
        CC_Type: '',
      },
    ],
  };
  const s = summarizeCarriers({ cell, nr, cellwan });
  assert.equal(s.combo, 'B7+B3 + n78+n1');
  assert.equal(s.totalBandwidth, 20 + 20 + 40 + 20);
  assert.equal(s.carriers.find((c) => c.band === 'B3').pci, 391);
  assert.equal(s.carriers.find((c) => c.band === 'B3').bandwidth, 20);
  assert.equal(s.carriers[0].channel, 3350);
});

test('an SCC with a filler RSRP shows no readings at all, but still counts as a carrier', () => {
  const cellwan = {
    INTF_RSRP: -87,
    INTF_Current_Band: 'B3',
    INTF_Downlink_Bandwidth: '20M',
    SCC_Info: [
      // As the FWA505 sent it: the modem didn't measure this carrier.
      {
        Enable: true,
        PhysicalCellID: 393,
        RFCN: 1815,
        Band: 'B3',
        RSSI: -120,
        RSRP: -140,
        RSRQ: -20,
        SINR: 10,
        DownlinkBandwidth: '20M',
        CC_Type: 'SCC',
      },
    ],
  };
  const s = summarizeCarriers({ cell, nr: null, cellwan });
  const scc = s.carriers.find((c) => c.pci === 393);
  assert.deepEqual([scc.rsrp, scc.rsrq, scc.sinr, scc.rssi, scc.measured], [null, null, null, null, false]);
  assert.equal(scc.bandwidth, 20);
  assert.equal(s.totalBandwidth, 40);
  assert.equal(s.carriers[0].measured, true);
});

test('inactive NR leg is dropped', () => {
  assert.equal(summarizeCarriers({ cell, nr: { ...nr, RSRP: 0 } }).combo, 'B7');
});
