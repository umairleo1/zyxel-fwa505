import { isLte, isNr } from '@zyxel-insight/shared/radio';
import { formatSigned } from './format.js';

// A band counts as "known here" for suggestions once it has served this long.
const MIN_HISTORY_SEC = 600;

/**
 * Pure: band lists worth trying, from what Insight has measured here. Each keeps every
 * 5G band so NSA still has its 5G leg; only the 4G side is narrowed.
 */
export function suggestions({ supported, history, inUse }) {
  const nr = supported.filter(isNr);
  const lteSeen = supported
    .filter(isLte)
    .map((b) => history.get(b.toUpperCase()))
    .filter((h) => h && h.seconds >= MIN_HISTORY_SEC && h.avgRsrp != null)
    .sort((a, b) => b.avgRsrp - a.avgRsrp);
  const name = (h) => supported.find((s) => s.toUpperCase() === h.band.toUpperCase());
  const out = [];
  if (lteSeen.length > 1) {
    const best = lteSeen[0];
    const runner = lteSeen[1];
    out.push({
      label: `Strongest 4G: ${name(best)} + all 5G`,
      bands: [name(best), ...nr],
      why: `${name(best)} averages ${formatSigned(best.avgRsrp)} dBm here, ${Math.round(best.avgRsrp - runner.avgRsrp)} dB above ${name(runner)}`,
    });
    const strong = lteSeen.filter((h) => h.avgRsrp >= best.avgRsrp - 6);
    if (strong.length > 1 && strong.length < lteSeen.length) {
      out.push({
        label: `Strong 4G only: ${strong.map(name).join('+')} + all 5G`,
        bands: [...strong.map(name), ...nr],
        why: 'Every 4G band within 6 dB of the strongest; weaker ones left out',
      });
    }
  }
  const now = supported.filter((b) => inUse.has(b.toUpperCase()));
  if (now.some(isLte) && now.some(isNr)) {
    out.push({
      label: `Current carriers: ${now.join('+')}`,
      bands: now,
      why: 'Only the bands serving you right now, so the modem cannot fall back to others',
    });
  }
  return out;
}
