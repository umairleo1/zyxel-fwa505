// Small, dependency-free helpers shared across the server.

/** Number or null for empty / non-numeric router values. */
export const toNumber = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Percentage with one decimal, or null when the denominator is 0. */
export const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** Depth-first search for the first property named `key` in a nested router object. */
export function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if (Object.hasOwn(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Scalar fields of an object (or of the first element of an array). */
export function scalars(obj) {
  const o = Array.isArray(obj) ? obj[0] : obj;
  if (!o || typeof o !== 'object') return null;
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || typeof v !== 'object'));
}
