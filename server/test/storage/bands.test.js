import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/storage/db.js';
import { comboBands, legacyMatches } from '../../src/storage/bands.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'insight-bands-')), 'test.db');

test('combo labels split into bands in carrier order', () => {
  assert.deepEqual(comboBands('B7+B3 + n78+n1'), ['B7', 'B3', 'n78', 'n1']);
  assert.deepEqual(comboBands(''), []);
  assert.deepEqual(comboBands(null), []);
});

test('carriers are folded into per-band and per-cell rows', () => {
  const db = openDb(tmpFile());
  const b3 = (rsrp) => ({ role: 'primary', rat: 'LTE', band: 'B3', bandwidth: 20, pci: 391, channel: 1617, rsrp, sinr: 16 });
  const b3scc = { role: 'secondary', rat: 'LTE', band: 'B3', bandwidth: 15, pci: 291, channel: 1815, rsrp: -95, sinr: 6 };
  const n78 = { role: 'nr-anchor', rat: 'NR', band: 'n78', bandwidth: 40, pci: 958, channel: 636768, rsrp: -92, sinr: 7 };
  db.recordCarriers(1_000, [b3(-88), b3scc, n78]);
  db.recordCarriers(6_000, [b3(-86), b3scc, n78]);
  db.recordCarriers(600_000, [b3(-87)]); // after a long gap: counted as 30 s at most

  const [b3row, n78row] = db.bandsSeen();
  assert.equal(b3row.band, 'B3');
  assert.equal(b3row.seconds, 35); // two B3 carriers in one sample count once
  assert.equal(b3row.primarySeconds, 35);
  assert.equal(b3row.bestRsrp, -86);
  assert.equal(b3row.maxBandwidth, 20);
  assert.deepEqual(
    b3row.cells.map((c) => [c.pci, c.channel]),
    [
      [391, 1617],
      [291, 1815],
    ],
  );
  assert.equal(n78row.band, 'n78');
  assert.equal(n78row.seconds, 5);
  assert.equal(n78row.lastSeen, 6_000);
  assert.equal(n78row.runStart, 1_000);
  assert.equal(n78row.lastRunSeconds, 5);
  assert.equal(b3row.runStart, 600_000); // the long gap started a new session
  db.close();
});

test('a band that drops out and returns starts a new session', () => {
  const db = openDb(tmpFile());
  const c = (band) => ({ role: 'primary', rat: band.startsWith('n') ? 'NR' : 'LTE', band, pci: 1 });
  db.recordCarriers(0, [c('B3')]);
  db.recordCarriers(5_000, [c('B3')]);
  db.recordCarriers(10_000, [c('B7')]);
  db.recordCarriers(15_000, [c('B3')]);
  db.recordCarriers(20_000, [c('B3')]);
  const byBand = Object.fromEntries(db.bandsSeen().map((b) => [b.band, b]));
  assert.equal(byBand.B3.runStart, 15_000);
  assert.equal(byBand.B3.seconds, 15); // the total still counts both sessions
  assert.equal(byBand.B7.lastRunSeconds, 0);
  db.close();
});

test('existing signal history is backfilled once, on first migration', () => {
  const file = tmpFile();
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE metrics (ts INTEGER PRIMARY KEY, uptime INTEGER, lte_rsrp REAL, lte_rsrq REAL, lte_sinr REAL, lte_rssi REAL,
    nr_rsrp REAL, nr_rsrq REAL, nr_sinr REAL, nr_rssi REAL, combo TEXT, cell TEXT)`);
  const ins = raw.prepare('INSERT INTO metrics (ts, lte_rsrp, lte_sinr, nr_rsrp, nr_sinr, combo, cell) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run(0, -104, 7, -96, 4, 'B7+B3 + n78+n1', '2960903/274');
  ins.run(5_000, -102, 8, -95, 5, 'B7+B3 + n78+n1', '2960903/274');
  ins.run(10_000, -87, 15, -92, 6, 'B3+B3 + n78+n78', '2960897/391');
  raw.close();

  const db = openDb(file);
  const byBand = Object.fromEntries(db.bandsSeen().map((b) => [b.band, b]));
  assert.deepEqual(Object.keys(byBand).sort(), ['B3', 'B7', 'n1', 'n78']);
  assert.equal(byBand.B7.bestRsrp, -102);
  assert.equal(byBand.B7.avgSinr, 7.5);
  assert.equal(byBand.B7.lastSeen, 5_000);
  assert.equal(byBand.B3.lastSeen, 10_000);
  assert.equal(byBand.B3.seconds, 10); // gaps: 0 + 5 s (first combo), 5 s (second)
  assert.equal(byBand.B3.runStart, 0); // in every sample, so one unbroken session
  assert.equal(byBand.B7.runStart, 0);
  assert.equal(byBand.n1.lastRunSeconds, 5);
  assert.equal(byBand.n1.bestRsrp, null); // secondary carriers had no stored signal
  assert.deepEqual(
    byBand.B7.cells.map((c) => c.pci),
    [274],
  );
  db.close();

  // Reopening does not count the history twice.
  const again = openDb(file);
  assert.equal(again.bandsSeen().find((b) => b.band === 'B3').seconds, 10);
  again.close();
});

test('a band that drops out and returns inside one write batch still starts a new session', () => {
  const db = openDb(tmpFile());
  const c = (band) => ({ role: 'primary', rat: 'LTE', band, pci: 1 });
  // All within 60 s, so nothing is written until bandsSeen() flushes.
  db.recordCarriers(0, [c('B3')]);
  db.recordCarriers(5_000, [c('B7')]);
  db.recordCarriers(10_000, [c('B3')]);
  db.recordCarriers(15_000, [c('B3')]);
  const b3 = db.bandsSeen().find((b) => b.band === 'B3');
  assert.equal(b3.runStart, 10_000);
  assert.equal(b3.firstSeen, 0);
  assert.equal(b3.lastSeen, 15_000);
  db.close();
});

test('an empty carrier list (no signal) ends every session', () => {
  const db = openDb(tmpFile());
  const c = { role: 'primary', rat: 'LTE', band: 'B3', pci: 1 };
  db.recordCarriers(0, [c]);
  db.recordCarriers(5_000, []);
  db.recordCarriers(10_000, [c]);
  assert.equal(db.bandsSeen()[0].runStart, 10_000);
  db.close();
});

const EE = { plmn: '23430', operator: 'EE' };
const VODAFONE = { plmn: '23415', operator: 'Vodafone UK' };
const carrier = (band, pci = 1, channel = null, rsrp = -90) => ({
  role: 'primary',
  rat: band.startsWith('n') ? 'NR' : 'LTE',
  band,
  pci,
  channel,
  rsrp,
});

test('history is kept per network: a new SIM starts empty and the old network is kept', () => {
  const db = openDb(tmpFile());
  db.recordCarriers(0, [carrier('B3', 391)], EE);
  db.recordCarriers(5_000, [carrier('B3', 391)], EE);
  db.recordCarriers(10_000, [carrier('B20', 120)], VODAFONE);
  db.recordCarriers(15_000, [carrier('B20', 120)], VODAFONE);

  assert.deepEqual(
    db.bandsSeen().map((b) => b.band),
    ['B20'],
    'defaults to the network in use',
  );
  assert.deepEqual(
    db.bandsSeen({ plmn: '23430' }).map((b) => b.band),
    ['B3'],
  );
  assert.deepEqual(db.bandNetwork(), VODAFONE);
  assert.deepEqual(
    db.bandNetworks().map((n) => [n.plmn, n.operator, n.bands]),
    [
      ['23415', 'Vodafone UK', 1],
      ['23430', 'EE', 1],
    ],
  );
  db.close();
});

test('a network change ends sessions: time does not carry over to the new network', () => {
  const db = openDb(tmpFile());
  db.recordCarriers(0, [carrier('B3')], EE);
  db.recordCarriers(5_000, [carrier('B3')], EE);
  db.recordCarriers(10_000, [carrier('B3')], VODAFONE); // same band number, different network
  db.recordCarriers(15_000, [carrier('B3')], VODAFONE);
  assert.equal(db.bandsSeen({ plmn: '23430' })[0].seconds, 5);
  const voda = db.bandsSeen({ plmn: '23415' })[0];
  assert.equal(voda.seconds, 5, 'the 5 s across the switch belong to neither');
  assert.equal(voda.runStart, 10_000);
  db.close();
});

test('a read that does not name the network belongs to the one in use; with none known, to unknown', () => {
  const db = openDb(tmpFile());
  db.recordCarriers(0, [carrier('B7')]); // network not known yet
  db.recordCarriers(5_000, [carrier('B3')], EE);
  db.recordCarriers(10_000, [carrier('B3')]); // field missing this once
  assert.equal(db.bandsSeen({ plmn: '23430' })[0].seconds, 5);
  assert.deepEqual(
    db.bandsSeen({ plmn: '' }).map((b) => b.band),
    ['B7'],
  );
  db.close();
});

test('after a restart, before the first read, the default is the network seen last', () => {
  const file = tmpFile();
  const db = openDb(file);
  db.recordCarriers(0, [carrier('B3')], EE);
  db.recordCarriers(5_000, [carrier('B20')], VODAFONE);
  db.close();
  const again = openDb(file);
  assert.equal(again.bandNetwork().plmn, '23415');
  assert.deepEqual(
    again.bandsSeen().map((b) => b.band),
    ['B20'],
  );
  again.close();
});

test('legacy matching: one cell on band, PCI and channel, or two on band and PCI', () => {
  const cells = [
    { band: 'B3', pci: 391, channel: 1617 },
    { band: 'B7', pci: 274, channel: null },
    { band: 'n78', pci: 958, channel: null },
  ];
  assert.ok(legacyMatches(cells, [carrier('B3', 391, 1617)]), 'same cell, same channel');
  assert.ok(!legacyMatches(cells, [carrier('B3', 391, 1815)]), 'same PCI on another channel is another cell');
  assert.ok(!legacyMatches(cells, [carrier('B7', 274)]), 'one PCI alone could be chance');
  assert.ok(legacyMatches(cells, [carrier('B7', 274), carrier('n78', 958)]));
  assert.ok(!legacyMatches(cells, [carrier('B20', 120, 6300)]));
});

/** A database from before band history was kept per network. */
function legacyFile() {
  const file = tmpFile();
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE metrics (ts INTEGER PRIMARY KEY, uptime INTEGER, lte_rsrp REAL, lte_rsrq REAL, lte_sinr REAL, lte_rssi REAL,
      nr_rsrp REAL, nr_rsrq REAL, nr_sinr REAL, nr_rssi REAL, combo TEXT, cell TEXT);
    CREATE TABLE bands (band TEXT PRIMARY KEY, rat TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, run_start INTEGER,
      seconds REAL NOT NULL DEFAULT 0, primary_seconds REAL NOT NULL DEFAULT 0, best_rsrp REAL,
      rsrp_sum REAL NOT NULL DEFAULT 0, rsrp_n INTEGER NOT NULL DEFAULT 0, sinr_sum REAL NOT NULL DEFAULT 0, sinr_n INTEGER NOT NULL DEFAULT 0, max_bw REAL);
    CREATE TABLE band_cells (band TEXT NOT NULL, pci INTEGER NOT NULL, channel INTEGER, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      best_rsrp REAL, PRIMARY KEY (band, pci));
    INSERT INTO bands VALUES ('B3', 'LTE', 0, 1000, 0, 3600, 3600, -86, -90000, 1000, 12000, 1000, 20);
    INSERT INTO bands VALUES ('B7', 'LTE', 0, 1000, 0, 7200, 7200, -88, -207000, 2000, 14000, 2000, 20);
    INSERT INTO band_cells VALUES ('B3', 391, 1617, 0, 1000, -86);
    INSERT INTO band_cells VALUES ('B7', 274, 3350, 0, 1000, -88);
  `);
  raw.close();
  return file;
}

test('an old database is migrated with every row kept, as history from an unknown network', () => {
  const db = openDb(legacyFile());
  assert.deepEqual(
    db.bandNetworks().map((n) => [n.plmn, n.bands]),
    [['', 2]],
  );
  const b7 = db.bandsSeen({ plmn: '' }).find((b) => b.band === 'B7');
  assert.equal(b7.seconds, 7200);
  assert.equal(b7.avgRsrp, -103.5);
  assert.equal(b7.cells[0].channel, 3350);
  db.close();
});

test('old history joins the network whose cells match it, adding to what was recorded since', () => {
  const db = openDb(legacyFile());
  db.recordCarriers(2_000, [carrier('B3', 391, 1617, -85)], EE);
  db.recordCarriers(7_000, [carrier('B3', 391, 1617, -85)], EE);
  const ee = db.bandsSeen({ plmn: '23430' });
  assert.deepEqual(ee.map((b) => b.band).sort(), ['B3', 'B7'], 'B7 came along with the rest of the old history');
  const b3 = ee.find((b) => b.band === 'B3');
  assert.equal(b3.seconds, 3605, 'old and new time added together');
  assert.equal(b3.bestRsrp, -85);
  assert.equal(b3.runStart, 2_000, 'the live session wins');
  assert.equal(db.bandsSeen({ plmn: '' }).length, 0);
  assert.deepEqual(
    db.bandNetworks().map((n) => n.plmn),
    ['23430'],
  );
  db.close();
});

test('old history is not given to a network whose cells do not match: a new SIM starts clean', () => {
  const db = openDb(legacyFile());
  db.recordCarriers(2_000, [carrier('B20', 120, 6300)], VODAFONE);
  db.recordCarriers(7_000, [carrier('B20', 120, 6300)], VODAFONE);
  assert.deepEqual(
    db.bandsSeen().map((b) => b.band),
    ['B20'],
  );
  assert.equal(db.bandsSeen({ plmn: '' }).length, 2, 'kept for the network it belongs to');
  db.close();
});
