import type { Stats } from './types.ts';
import { MIN_CONTRAST } from './types.ts';

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Zielwerte nach §9.1.
 *
 * Standard ist der Median jedes Messwerts über das Set — er bewegt jedes Bild
 * so wenig wie möglich. Für die Tonwertkorrektur zusätzlich eine Ziel-CDF als
 * binweiser Median über alle CDFs: das Ergebnis ist wieder monoton und damit
 * eine gültige Verteilung.
 *
 * Bei Ankerwahl treten schlicht die Werte des Ankerbildes an die Stelle der
 * Mediane (P1: das Set ist die Referenz, nicht ein Ideal).
 */
export function computeTarget(stats: Stats[], anchor?: Stats | null): Stats {
  if (anchor) return anchor;
  if (stats.length === 0) throw new Error('computeTarget braucht mindestens ein Bild');
  if (stats.length === 1) return stats[0]!;

  const of = (pick: (s: Stats) => number) => median(stats.map(pick));

  const binMedian = (pick: (s: Stats) => Float64Array) => {
    const out = new Float64Array(256);
    for (let i = 0; i < 256; i++) out[i] = median(stats.map((s) => pick(s)[i]!));
    return out;
  };
  const cdf = binMedian((s) => s.cdf);
  // Die kanalweisen CDFs werden mitgeführt, damit `target` ein vollständiges
  // `Stats` ist. Sie dienen nur der Clipping-Abschätzung, nicht dem Matching
  // (siehe `Stats.cdfR`).
  const cdfR = binMedian((s) => s.cdfR);
  const cdfG = binMedian((s) => s.cdfG);
  const cdfB = binMedian((s) => s.cdfB);

  const p10 = of((s) => s.p10);
  const p90 = of((s) => s.p90);

  return {
    aspect: of((s) => s.aspect),
    p01: of((s) => s.p01),
    p10,
    p50: of((s) => s.p50),
    p90,
    p99: of((s) => s.p99),
    contrast: Math.max(MIN_CONTRAST, p90 - p10),
    cdf,
    cdfR,
    cdfG,
    cdfB,
    warmth: of((s) => s.warmth),
    tint: of((s) => s.tint),
    clippedRatio: of((s) => s.clippedRatio),
    saturation: of((s) => s.saturation),
    sharpness: of((s) => s.sharpness),
    noise: of((s) => s.noise),
    palette: [],
  };
}
