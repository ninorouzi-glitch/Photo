import type { Criterion, Stats } from './types.ts';
import { MIN_CONTRAST } from './types.ts';
import { CRITERIA, THRESHOLDS } from './deviation.ts';
import { DIRECTION, mitArtikel } from './copy.ts';

/**
 * Ausreißererkennung, Rechenkern (Etappe 5).
 *
 * **Typ A, technischer Ausreißer:** weicht auf einer der gemessenen Achsen so
 * weit ab, dass die Angleichung ihn zwar erreicht, aber mit sichtbaren Kosten.
 * Konsequenz für den Benutzer: das Ergebnis genau ansehen.
 *
 * Einen **Typ B** (farblicher Ausreißer) gibt es nicht: an acht Sätzen und 50
 * Bildern gemessen fand er null Ausreißer und im Eindringlingstest eins von
 * acht Fremdbildern, wo Typ A acht von acht fand. Ein globales Farbhistogramm
 * misst den Bildinhalt, nicht die Farbwelt. Zahlen und Herleitung in
 * `MESSUNG-ausreisser.md`, Befund 1; das Farbgitter selbst bleibt (Etappe 3c).
 *
 * Hier steht nur die Rechnung. Markierung, Klartext im UI und der Schalter
 * „nicht in die Zielwerte einrechnen" sind Etappe 6.
 */

/**
 * Unter vier Bildern wird Typ A nicht ausgewertet.
 *
 * Der Median-Absolutabstand braucht eine Mitte, gegen die sich messen lässt.
 * Bei drei Bildern ist jedes zweite Bild der Median selbst, bei zweien gibt es
 * nur ein Paar und keine Aussage darüber, welches der beiden aus der Reihe
 * fällt — die Rechnung liefe zwar durch, ihr Ergebnis wäre aber eine Münze.
 */
export const MIN_SET = 4;

/**
 * Grenze des modifizierten z-Scores. 3,5 ist der übliche Wert nach
 * Iglewicz/Hoaglin und bleibt hier stehen, weil er sich nicht aus diesem
 * Projekt herleiten lässt, sondern aus der Normalverteilung.
 */
export const Z_GRENZE = 3.5;

/** 0,6745 = Φ⁻¹(0,75): macht den MAD an der Normalverteilung mit σ vergleichbar. */
const MAD_KONSTANTE = 0.6745;

/**
 * Ersatzkonstante, wenn der MAD 0 ist und die mittlere absolute Abweichung
 * einspringt: √(π/2) ≈ 1,2533 ist deren Erwartungswert im Verhältnis zu σ.
 */
const MAD_ERSATZ_KONSTANTE = 1.2533;

export type Ausreisser = {
  index: number; // Position im übergebenen Array
  /**
   * Sorte des Befundes. Steht heute immer auf 'A' und bleibt trotzdem im Typ:
   * das PRD unterscheidet Sorten von Ausreißern, und die zweite füllt Etappe 4
   * mit dem Clipping-Guard — ein Bild, dessen Angleichung sichtbar etwas
   * kostet, ist ein anderer Befund als eines, das aus der Reihe fällt.
   */
  typ: 'A';
  /** Die Achse des Befundes. Nullbar für Sorten ohne einzelne Achse (Etappe 4). */
  criterion: Criterion | null;
  z: number; // vorzeichenbehaftet
  value: number; // Abweichung vom frischen Median, Einheit der Achse
  text: string; // fertig formulierter deutscher Klartext
};

/**
 * Der Messwert einer Achse in dem Raum, in dem `deviation.ts` ihre Abweichung
 * bildet: `warmth`, `tint` und `noise` sind Differenzen, alles Übrige
 * log2-Verhältnisse. Deshalb steht hier der Logarithmus, und die Differenz
 * zweier solcher Werte ist genau das, was `deviationValues` ausrechnet.
 *
 * Die Klemmwerte sind dieselben wie dort (`MIN_CONTRAST`, 0,004, 0,05, und
 * die 4 aus der dokumentierten Abweichung Nr. 1 bei der Belichtung) — sie
 * gehören zum Maß, nicht zum Vergleich.
 */
function achsenWert(s: Stats, c: Criterion): number {
  switch (c) {
    case 'aspect': return Math.log2(s.aspect);
    case 'exposure': return Math.log2(Math.max(4, s.p50));
    case 'warmth': return s.warmth;
    case 'tint': return s.tint;
    case 'contrast': return Math.log2(Math.max(MIN_CONTRAST, s.contrast));
    case 'saturation': return Math.log2(Math.max(0.004, s.saturation));
    case 'sharpness': return 0.5 * Math.log2(Math.max(0.05, s.sharpness));
    case 'noise': return s.noise;
  }
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Modifizierter z-Score je Element, robust gegen die Ausreißer, die er sucht.
 *
 * Der Median wird hier **frisch** über die übergebenen Werte gebildet und
 * kommt ausdrücklich nicht aus `computeTarget`: bei Ankerwahl ist der Zielwert
 * das Messergebnis eines einzelnen Bildes und damit kein Lagemaß der Messmenge
 * — ein Ankerbild, das selbst am Rand liegt, machte sonst das halbe Set zu
 * Ausreißern.
 *
 * MAD = 0 kommt vor, sobald mehr als die Hälfte der Bilder denselben Wert
 * trägt (fünfmal dieselbe Datei, ein Set aus Standbildern). Dann springt die
 * mittlere absolute Abweichung ein; ist auch die 0, sind alle Werte gleich und
 * es gibt nichts zu melden — Rückgabe lauter Nullen statt einer Division durch
 * Null.
 */
export function robustZ(values: number[]): { z: number[]; median: number } {
  const median = medianOf(values);
  const abw = values.map((v) => Math.abs(v - median));
  const mad = medianOf(abw);
  if (mad > 0) {
    return { z: values.map((v) => (MAD_KONSTANTE * (v - median)) / mad), median };
  }
  const mittel = abw.reduce((a, b) => a + b, 0) / abw.length;
  if (mittel > 0) {
    return { z: values.map((v) => (v - median) / (MAD_ERSATZ_KONSTANTE * mittel)), median };
  }
  return { z: values.map(() => 0), median };
}

const ADVERB = (betrag: number, c: Criterion) =>
  betrag >= THRESHOLDS[c].crit ? 'deutlich' : 'spürbar';

function textA(index: number, c: Criterion, value: number): string {
  // Qualitativ, ohne Zahl: die `exposure`-Achse misst log2 gammakodierter
  // Mediane und ist gegenüber echten EV um rund Faktor 2,2 gestaucht — eine
  // Zahl im Satz behauptete eine Genauigkeit, die die Achse nicht hat. Die
  // Zahlen stehen in `z` und `value` und gehören in die Befundmatrix.
  const richtung = DIRECTION[c][value > 0 ? 0 : 1];
  return (
    `Bild ${index + 1} ist ${ADVERB(Math.abs(value), c)} ${richtung} als die übrigen Bilder — ` +
    `${mitArtikel(c)} fällt hier aus der Reihe. Die Angleichung zieht das nach, ` +
    `aber sieh dir das Ergebnis genau an.`
  );
}

/**
 * Typ A: technische Ausreißer über den modifizierten z-Score je Achse.
 *
 * Zwei Bedingungen, **und** verknüpft:
 *
 * 1. `|z| > Z_GRENZE` — das Bild liegt statistisch außerhalb des Sets.
 * 2. `|Abweichung| ≥ THRESHOLDS[c].warn` — die Abweichung ist auch absolut
 *    groß genug, um überhaupt aufzufallen.
 *
 * Die zweite Bedingung ist nicht Zierrat, sie ist der Kern: in einem sehr
 * homogenen Set ist der MAD winzig, und eine Abweichung, die niemand sieht,
 * bekommt einen riesigen z-Score. Ohne die Schwelle meldete genau das Set
 * Ausreißer, das keine hat. Umgekehrt fängt der z-Score die Fälle ab, in denen
 * ein ganzes Set weit vom Zielwert liegt, aber einträchtig — dann ist keines
 * der Bilder ein Ausreißer.
 *
 * Je Bild wird höchstens ein Befund gemeldet, auf der Achse mit dem größten
 * |z|. Mehrere Achsen zugleich sind der Normalfall (eine Fehlbelichtung zieht
 * Kontrast und Sättigung mit), und acht Sätze über dasselbe Bild sagen nicht
 * mehr als einer.
 */
export function typA(stats: Stats[]): Ausreisser[] {
  if (stats.length < MIN_SET) return [];

  const befund = new Map<number, Ausreisser>();
  for (const c of CRITERIA) {
    const werte = stats.map((s) => achsenWert(s, c));
    const { z, median } = robustZ(werte);
    for (let i = 0; i < stats.length; i++) {
      const value = werte[i]! - median;
      if (Math.abs(z[i]!) <= Z_GRENZE) continue;
      if (Math.abs(value) < THRESHOLDS[c].warn) continue;
      const alt = befund.get(i);
      if (alt && Math.abs(alt.z) >= Math.abs(z[i]!)) continue;
      befund.set(i, { index: i, typ: 'A', criterion: c, z: z[i]!, value, text: textA(i, c, value) });
    }
  }

  return [...befund.values()].sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
