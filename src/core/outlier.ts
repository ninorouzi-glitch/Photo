import type { ColorGrid, Criterion, Settings, Stats } from './types.ts';
import { DEFAULT_SETTINGS, MIN_CONTRAST } from './types.ts';
import { GRID_BINS, GRID_SHIFT } from './satgrid.ts';
import { buildLuts, type Luts } from './lut.ts';
import { CRITERIA, THRESHOLDS } from './deviation.ts';
import { DIRECTION, mitArtikel } from './copy.ts';

/**
 * Ausreißererkennung, Rechenkern (Etappe 5).
 *
 * Zwei Sorten, die nichts miteinander zu tun haben:
 *
 * - **Typ A, technischer Ausreißer.** Weicht auf einer der gemessenen Achsen
 *   so weit ab, dass die Angleichung ihn zwar erreicht, aber mit sichtbaren
 *   Kosten. Konsequenz für den Benutzer: das Ergebnis genau ansehen.
 * - **Typ B, farblicher Ausreißer.** Technisch einwandfrei; nach der
 *   Angleichung sauber, passt aber farblich nicht zum Set. Nicht
 *   wegzukorrigieren — die Konsequenz ist, das Bild zu tauschen.
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
  typ: 'A' | 'B';
  criterion: Criterion | null; // Typ B hat keine einzelne Achse
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

// ── Typ B: farbliche Ausreißer ────────────────────────────────────────────

/**
 * Mindestabstand der Farbverteilung, unter dem nichts gemeldet wird.
 *
 * Dieselbe Rolle wie die Warnschwelle bei Typ A und aus demselben Grund
 * nötig: der z-Score misst nur, wie weit ein Bild gegenüber der Streuung des
 * Sets heraussteht, nicht ob der Unterschied überhaupt zu sehen ist. In einem
 * Set aus fünf Aufnahmen derselben Szene liegen die Abstände bei wenigen
 * Prozent, und eines davon ist immer das größte.
 *
 * Der Wert ist ein totaler Variationsabstand: 0 heißt deckungsgleiche
 * Verteilung, 1 heißt kein einziger gemeinsamer Farbbereich. Gemessen an den
 * Fixtures (Stärke 0,7 / 1,0): fünf Aufnahmen derselben Szene liegen bei
 * 0,009…0,072 bzw. 0,010…0,102 — das ist der Sockel aus der Einsortierung an
 * den Bin-Grenzen, nicht Farbe. Ein Bild aus einer anderen Farbwelt liegt
 * weit darüber: Streifenmuster 1,000, Farbtafel 0,86/0,86, stark entsättigt
 * 0,32/0,32. Dazwischen ist viel Luft, und 0,25 liegt bewusst näher am ruhigen
 * Ende: Typ B korrigiert nicht, sondern rät zum Tauschen — ein Fehlalarm
 * kostet hier mehr als ein übersehener Fall.
 *
 * Weicheres Einsortieren (trilinear auf die Bin-Zentren) wurde gemessen und
 * verworfen: es hebt den Sockel des homogenen Sets auf 0,022…0,128, statt ihn
 * zu senken, und drückt zugleich die echten Abstände. Der Sockel steckt nicht
 * in den Bin-Grenzen, sondern in den Zellen, die überhaupt belegt sind.
 *
 * Kein Tuning-Punkt aus THRESHOLDS: das ist eine andere Größe auf einer
 * anderen Skala und gehört nicht in die Befundmatrix.
 */
export const MIN_FARBABSTAND = 0.25;

/** Tabellenwert an einer Zwischenstelle — der Vertreter ist ein Mittelwert. */
function tab(lut: Float32Array, x: number): number {
  const i = Math.floor(x);
  if (i >= 255) return lut[255]!;
  if (i < 0) return lut[0]!;
  const f = x - i;
  return lut[i]! * (1 - f) + lut[i + 1]! * f;
}

/**
 * Die Farbverteilung des **korrigierten** Bildes, als Anteile über 16³ Zellen.
 *
 * Aus dem Farbgitter von Etappe 3c, nicht aus einem neuen Pixeldurchlauf: der
 * Vertreter jeder belegten Zelle geht durch dieselben Tabellen wie das Bild
 * (`sample(curve, i·g[c])`, in `buildLuts` bereits gefaltet) und wird danach
 * neu einsortiert.
 *
 * Ein eigener Normalisierungsschritt für Belichtung und Weißabgleich wäre
 * doppelt gemoppelt — die Korrektur selbst *ist* die Normalisierung. Genau
 * darin liegt die Trennung zu Typ A: was die Tabellen einfangen, ist hier
 * schon eingefangen, und was übrig bleibt, bleibt auch im Export übrig.
 */
function farbVerteilung(grid: ColorGrid, luts: Luts): Float64Array {
  const h = new Float64Array(GRID_BINS ** 3);
  const { counts, sums } = grid;
  let n = 0;

  for (let k = 0; k < counts.length; k++) {
    const c = counts[k]!;
    if (c === 0) continue;
    n += c;
    const r = tab(luts[0]!, sums[k * 3]! / c);
    const g = tab(luts[1]!, sums[k * 3 + 1]! / c);
    const b = tab(luts[2]!, sums[k * 3 + 2]! / c);
    const kr = Math.min(GRID_BINS - 1, Math.max(0, Math.floor(r) >> GRID_SHIFT));
    const kg = Math.min(GRID_BINS - 1, Math.max(0, Math.floor(g) >> GRID_SHIFT));
    const kb = Math.min(GRID_BINS - 1, Math.max(0, Math.floor(b) >> GRID_SHIFT));
    h[(kr << 8) | (kg << 4) | kb] += c;
  }

  if (n > 0) for (let i = 0; i < h.length; i++) h[i]! /= n;
  return h;
}

/**
 * Totaler Variationsabstand zweier Anteilsverteilungen, 0…1.
 *
 * Der halbe L1-Abstand, damit der Wert eine Bedeutung hat: er ist der Anteil
 * der Pixel, der in der einen Verteilung in Farbbereichen liegt, in denen die
 * andere nichts hat.
 */
function abstand(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / 2;
}

/**
 * Die Einstellung, unter der Typ B misst: volle Stärke, Weißabgleich und
 * Tonwertkurve an. Sättigung, Korn und Schärfe stehen hier nur der
 * Vollständigkeit halber — `buildLuts` liest sie nicht.
 */
const VOLLE_ANGLEICHUNG: Settings = {
  ...DEFAULT_SETTINGS,
  strength: 1,
  fixes: { ...DEFAULT_SETTINGS.fixes, tone: true, wb: true },
};

function textB(index: number): string {
  return (
    `Bild ${index + 1} passt farblich nicht zu den übrigen Bildern. Belichtung und ` +
    `Weißabgleich sind angeglichen — die Farben bleiben trotzdem andere, und daran ` +
    `ändert auch mehr Korrektur nichts. Überleg dir, das Bild zu tauschen.`
  );
}

/**
 * Typ B: farbliche Ausreißer über das Farbgitter.
 *
 * Der Weg: jedes Bild durch seine eigenen Tabellen schicken (also so, wie es
 * im Export aussieht), daraus eine Farbverteilung, davon binweise den Median
 * des Sets, und der Abstand jedes Bildes zu diesem Median ist die Größe, auf
 * die wieder der modifizierte z-Score geht.
 *
 * Der binweise Median ist selbst keine Verteilung — er summiert sich nicht auf
 * 1 —, also wird er normiert. Ohne das trüge jeder Abstand denselben Sockel,
 * und der z-Score misst zwar noch dasselbe, `MIN_FARBABSTAND` aber nicht mehr.
 *
 * Wie bei Typ A gilt die UND-Bedingung mit `MIN_FARBABSTAND`, und einseitig:
 * ein Bild, das der Farbwelt des Sets *näher* liegt als alle anderen, ist kein
 * Ausreißer.
 *
 * **Gemessen wird bei voller Stärke, nicht bei der eingestellten.** Typ B
 * beantwortet eine einzige Frage: bleibt dieses Bild farblich fremd, *auch
 * wenn* die Angleichung alles tut, was sie kann? Läuft die Rechnung mit einer
 * zurückgedrehten Stärke, misst der Abstand den Rest einer Korrektur, die der
 * Benutzer selbst weggeregelt hat — und meldet damit als „nicht
 * wegzukorrigieren", was mit einem Schieberegler zu beheben wäre. Am §13-Satz
 * ist das kein Randfall: Bild 03 (B × 1,35) kommt bei Stärke 0,7 als Typ B
 * durch und bei 1,0 nicht mehr. Deshalb steht `Settings` auch nicht in der
 * Signatur — es gäbe nichts daran einzustellen.
 *
 * Was das Maß nicht trennen kann, ist Farbe von **Bildausschnitt**: die
 * Verteilung zählt, welche Farbbereiche wie oft vorkommen, und ein anderer
 * Ausschnitt derselben Szene zeigt andere Anteile davon. Am §13-Satz gemessen,
 * je gegen den Median der übrigen vier Bilder und bei voller Stärke: allein der
 * Ausschnitt von Bild 05 kommt auf 0,731, allein die Weichzeichnung auf 0,110,
 * allein das Rauschen auf 0,134 — die Grundszene selbst liegt bei 0,102. Bild
 * 05 wird also gemeldet, und zwar wegen seines Ausschnitts. Für ein Carousel
 * ist das nicht einmal falsch (ein Bild, das einen ganz anderen Teil der Szene
 * zeigt, fällt auf), aber es ist nicht das, was Typ B verspricht. Der Fall ist
 * beziffert und offen, nicht stillschweigend repariert.
 */
export function typB(stats: Stats[], target: Stats): Ausreisser[] {
  if (stats.length < MIN_SET) return [];

  const verteilungen = stats.map((s) =>
    farbVerteilung(s.colorGrid, buildLuts(s, target, VOLLE_ANGLEICHUNG)),
  );

  const mitte = new Float64Array(GRID_BINS ** 3);
  let summe = 0;
  for (let i = 0; i < mitte.length; i++) {
    const m = medianOf(verteilungen.map((v) => v[i]!));
    mitte[i] = m;
    summe += m;
  }
  if (summe > 0) for (let i = 0; i < mitte.length; i++) mitte[i]! /= summe;

  const abstaende = verteilungen.map((v) => abstand(v, mitte));
  const { z, median } = robustZ(abstaende);

  const out: Ausreisser[] = [];
  for (let i = 0; i < stats.length; i++) {
    if (z[i]! <= Z_GRENZE) continue;
    if (abstaende[i]! < MIN_FARBABSTAND) continue;
    out.push({
      index: i,
      typ: 'B',
      criterion: null,
      z: z[i]!,
      value: abstaende[i]! - median,
      text: textB(i),
    });
  }
  return out.sort((a, b) => b.z - a.z);
}
