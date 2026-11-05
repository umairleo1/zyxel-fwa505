import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO, describeBands, parseBands, selectionError, serialiseBands } from '../radio.js';

const supported = {
  technologies: ['Auto', 'NR5G-SA', 'NR5G-NSA', 'LTE'],
  bands: ['B1', 'B3', 'B7', 'B20', 'n1', 'n28', 'n78'],
};

test('bands parse and serialise the way the router stores them', () => {
  assert.equal(parseBands('Auto'), AUTO);
  assert.equal(parseBands(''), AUTO);
  assert.deepEqual(parseBands('B3,n78'), ['B3', 'n78']);
  // The router UI's plain .sort(): B20 before B3, as a string.
  assert.equal(serialiseBands(['n78', 'B3', 'B20']), 'B20,B3,n78');
  assert.equal(serialiseBands(AUTO), 'Auto');
});

test('a selection is checked as the router page checks it', () => {
  assert.equal(selectionError({ technology: 'NR5G-NSA', bands: AUTO }, supported), null);
  assert.equal(selectionError({ technology: 'NR5G-NSA', bands: ['B3', 'n78'] }, supported), null);
  assert.match(selectionError({ technology: 'NR5G-NSA', bands: ['B3'] }, supported), /5G band/);
  assert.match(selectionError({ technology: 'NR5G-NSA', bands: ['n78'] }, supported), /4G anchor/);
  assert.match(selectionError({ technology: 'Auto', bands: ['B3'] }, supported), /5G band/);
  assert.equal(selectionError({ technology: 'LTE', bands: ['B3', 'B7'] }, supported), null);
  assert.match(selectionError({ technology: 'LTE', bands: ['B3', 'n78'] }, supported), /can't use n78/);
  assert.match(selectionError({ technology: 'NR5G-SA', bands: ['B3', 'n78'] }, supported), /can't use B3/);
  assert.match(selectionError({ technology: 'LTE', bands: ['B42'] }, supported), /Not supported/);
  assert.match(selectionError({ technology: 'GPRS', bands: AUTO }, supported), /Unknown network mode/);
  assert.match(selectionError({ technology: 'LTE', bands: [] }, supported), /at least one/);
  assert.match(selectionError({ technology: 'LTE', bands: ['B3', 'B3'] }, supported), /twice/);
});

test('selections are summarised for logs and labels', () => {
  assert.equal(describeBands(AUTO), 'all bands (automatic)');
  assert.equal(describeBands(['B3', 'n1', 'n28', 'n78'], supported.bands), 'B3 + all 5G');
  assert.equal(describeBands(['B3', 'B7'], supported.bands), 'B3+B7');
});
