import type { Criterion, Deviations, Stats, Status } from './types.ts';
import { MIN_CONTRAST } from './types.ts';

/**
 * Schwellen nach PRD §10.
 *
 * Kontrast und Schärfe liegen bewusst weiter als Belichtung und Weißabgleich:
 * sie hängen stärker vom Motiv als von der Bearbeitung ab und lösen sonst
 * dauernd Fehlalarm aus.
 *
 * Diese Zahlen sind ein Startpunkt, kein Gesetz. Sie stammen aus Messungen an
 * den synthetischen Testbildern (§13) und sollten nach den ersten zwanzig
 * echten Sets nachjustiert werden. Genau dafür stehen sie hier an einer Stelle.
 */
export const THRESHOLDS: Record<Criterion, { warn: number; crit: number }> = {
  aspect: { warn: 0.06, crit: 0.2 },
  exposure: { warn: 0.18, crit: 0.45 },
  warmth: { warn: 0.07, crit: 0.18 },
  contrast: { warn: 0.24, crit: 0.52 },
  saturation: { warn: 0.18, crit: 0.4 },
  sharpness: { warn: 0.5, crit: 1.1 },
  noise: { warn: 0.8, crit: 2.0 },
};

export const CRITERIA: Criterion[] = [
  'aspect', 'exposure', 'warmth', 'contrast', 'saturation', 'sharpness', 'noise',
];

/**
 * Belichtungsmaß.
 *
 * Abweichung vom PRD, bewusst und einzeln: §10 schreibt `log2((P50+4)/(Ziel+4))`.
 * Der additive Offset soll Division durch Null bei schwarzen Bildern verhindern,
 * verkleinert aber jede echte Abweichung systematisch — ein um exakt 1,2 EV
 * abgedunkeltes Testbild misst damit nur −1,15 und reißt die Abnahme A-01
 * (±0,03 auf −1,20). `max(4, …)` leistet dasselbe am schwarzen Bild, ohne den
 * Normalfall zu verzerren; gemessen: −1,208.
 */
export function exposureDelta(p50: number, target: number): number {
  // Diese 4 ist der Tonwert-Offset aus §10 und ausdrücklich *nicht* MIN_CONTRAST,
  // auch wenn dieselbe Zahl gleich darunter als Konstante steht. Sie gehört zur
  // dokumentierten Abweichung Nr. 1 (siehe CLAUDE.md); zieht jemand die beiden
  // zusammen, hängt A-01 an einem Tuning-Punkt, der von Kontrast handelt.
  return Math.log2(Math.max(4, p50) / Math.max(4, target));
}

const ratio = (a: number, b: number, floor: number) =>
  Math.log2(Math.max(floor, a) / Math.max(floor, b));

export function deviationValues(s: Stats, t: Stats): Record<Criterion, number> {
  return {
    aspect: Math.log2(s.aspect / t.aspect),
    exposure: exposureDelta(s.p50, t.p50),
    warmth: s.warmth - t.warmth,
    contrast: ratio(s.contrast, t.contrast, MIN_CONTRAST),
    saturation: ratio(s.saturation, t.saturation, 0.004),
    sharpness: 0.5 * ratio(s.sharpness, t.sharpness, 0.05),
    noise: s.noise - t.noise,
  };
}

export function statusOf(criterion: Criterion, value: number): Status {
  const { warn, crit } = THRESHOLDS[criterion];
  const a = Math.abs(value);
  return a >= crit ? 'crit' : a >= warn ? 'warn' : 'ok';
}

export function deviations(s: Stats, t: Stats): Deviations {
  const values = deviationValues(s, t);
  const out = {} as Deviations;
  for (const c of CRITERIA) out[c] = { value: values[c], status: statusOf(c, values[c]) };
  return out;
}

/** §F-11: das Kriterium mit der größten Streuung im Set, relativ zur Schwelle. */
export function widestSpread(all: Deviations[]): { criterion: Criterion; spread: number } {
  let best: Criterion = 'exposure';
  let bestScore = -1;
  let bestSpread = 0;
  for (const c of CRITERIA) {
    const vs = all.map((d) => d[c].value);
    const spread = Math.max(...vs) - Math.min(...vs);
    const score = spread / THRESHOLDS[c].warn;
    if (score > bestScore) { bestScore = score; best = c; bestSpread = spread; }
  }
  return { criterion: best, spread: bestSpread };
}
