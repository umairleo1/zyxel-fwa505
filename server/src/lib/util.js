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

/** Union of time spans ({ start, end }), sorted and with overlapping or touching spans merged. */
export function mergeSpans(spans) {
  const out = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else if (s.end > s.start) out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** Parts of `spans` not covered by any of `holes`, dropping pieces shorter than `minMs`. */
export function subtractSpans(spans, holes, minMs = 0) {
  const cut = mergeSpans(holes);
  const out = [];
  for (const s of spans) {
    let start = s.start;
    for (const h of cut) {
      if (h.end <= start || h.start >= s.end) continue;
      if (h.start - start > minMs) out.push({ ...s, start, end: h.start });
      start = Math.max(start, h.end);
    }
    if (s.end - start > minMs) out.push({ ...s, start, end: s.end });
  }
  return out;
}
