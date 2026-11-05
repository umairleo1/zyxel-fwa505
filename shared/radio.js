// Band selection rules for the FWA505's cellwan_band setting, as its own Broadband → Band
// page applies them (V1.71), so Insight never sends a combination the router's UI wouldn't.

// The router's names for its network modes, in the order its UI lists them.
export const TECHNOLOGIES = {
  Auto: 'Automatic',
  'NR5G-SA': '5G only (SA)',
  'NR5G-NSA': '5G with 4G anchor (NSA)',
  LTE: '4G only',
};

export const isLte = (band) => /^B\d+$/.test(band);
export const isNr = (band) => /^n\d+$/.test(band);
export const AUTO = 'Auto';

/** "B1,B3,n78" → ['B1', 'B3', 'n78']; "Auto" → 'Auto'. */
export function parseBands(value) {
  const s = String(value ?? '').trim();
  if (!s || s === AUTO) return AUTO;
  return s.split(',').filter(Boolean);
}

/** As the router UI saves them: sorted the way JavaScript sorts strings, comma-joined. */
export function serialiseBands(bands) {
  return bands === AUTO ? AUTO : [...bands].sort().toString();
}

/** Bands a network mode can use: 4G only takes LTE bands, 5G SA only NR bands. */
export function bandsForTechnology(technology, supported) {
  if (technology === 'LTE') return supported.filter(isLte);
  if (technology === 'NR5G-SA') return supported.filter(isNr);
  return supported;
}

/**
 * Pure: is { technology, bands } a selection the router accepts? Returns an error
 * message, or null. `supported`: { technologies: [...], bands: [...] } from cellwan_band.
 */
export function selectionError({ technology, bands }, supported) {
  if (!supported.technologies.includes(technology)) return `Unknown network mode: ${technology}`;
  if (bands === AUTO) return null;
  if (!Array.isArray(bands) || !bands.length) return 'Choose at least one band, or Automatic';
  if (new Set(bands).size !== bands.length) return 'A band is listed twice';
  const unknown = bands.filter((b) => !supported.bands.includes(b));
  if (unknown.length) return `Not supported by this router: ${unknown.join(', ')}`;
  const usable = new Set(bandsForTechnology(technology, supported.bands));
  const wrong = bands.filter((b) => !usable.has(b));
  if (wrong.length) return `${TECHNOLOGIES[technology] ?? technology} can't use ${wrong.join(', ')}`;
  // 5G NSA rides on a 4G anchor, so it needs both kinds (the router's page refuses either missing).
  if (technology === 'Auto' || technology === 'NR5G-NSA') {
    if (!bands.some(isLte)) return 'Keep at least one 4G band: 5G NSA needs a 4G anchor';
    if (!bands.some(isNr)) return 'Keep at least one 5G band, or choose 4G only';
  }
  return null;
}

/** "B3 + 9 5G bands" style summary of a selection, for logs and labels. */
export function describeBands(bands, supportedBands = []) {
  if (bands === AUTO) return 'all bands (automatic)';
  const lte = bands.filter(isLte);
  const nr = bands.filter(isNr);
  const part = (list, all, kind) => {
    if (!list.length) return null;
    if (all.length && list.length === all.length) return `all ${kind}`;
    return list.length > 4 ? `${list.length} ${kind} bands` : list.join('+');
  };
  return [part(lte, supportedBands.filter(isLte), '4G'), part(nr, supportedBands.filter(isNr), '5G')].filter(Boolean).join(' + ');
}
