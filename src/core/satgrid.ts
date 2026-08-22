import type { ColorGrid } from './types.ts';
import type { Luts } from './lut.ts';
import { luminance } from './frame.ts';

/**
 * Kantenlänge des Farbgitters: 16 Bins je Kanal, also 4096 Zellen.
 *
 * Gemessen an §13 und den Messfixtures: mit 16³ liegt die geschätzte
 * Nach-LUT-Sättigung bei vier von fünf Bildern unter 2 % neben der direkten
 * Messung am korrigierten Bild. 8³ reicht nicht (bis 40 %), 32³ bringt nichts
 * mehr (der Rest steckt nicht in der Auflösung, siehe `ColorGrid` in types.ts)
 * und kostet den 64-fachen Speicher.
 */
export const GRID_BINS = 16;
export const GRID_SHIFT = 4; // 256 / GRID_BINS
const BIN_WIDTH = 256 / GRID_BINS;

export function emptyGrid(): ColorGrid {
  const n = GRID_BINS ** 3;
  return {
    counts: new Uint32Array(n),
    sums: new Float32Array(n * 3),
    satSums: new Float32Array(n),
    satASums: new Float32Array(n),
  };
}

/**
 * Sättigung und ā, geschätzt für das Bild **nach** den Tabellen.
 *
 * Warum das gebraucht wird: `Stats.saturation` misst das Bild, wie es
 * hereinkommt, aber der Faktor aus §9.5 wirkt auf ein Bild, das Weißabgleich
 * und Tonwertkurve schon hinter sich hat (Abweichung Nr. 3). Ein Farbstich
 * liest sich in (max−min)/max als Sättigung, die der Weißabgleich anschließend
 * wegnimmt — der Faktor entsättigt dann ein zweites Mal.
 *
 * Wie: je Zelle den Vertreter (das Bin-Mittel) durch dieselben Tabellen
 * schicken, die `apply.ts` fährt, und die dort gemessene **Verschiebung** auf
 * die Summen der Zelle geben. Die Sättigung der Zelle selbst kommt aus
 * `satSums` und ist exakt; geschätzt wird allein die Wirkung der Tabellen.
 *
 * `w` ist das Gegenstück dazu: der sättigungsgewichtete Anteil der Pixel, für
 * die das Gitter die Kanalreihenfolge nach den Tabellen nicht festlegen kann
 * (siehe `unsicherAnteil`). Wer die Schätzung benutzt, blendet mit w gegen die
 * Vor-LUT-Größe zurück — bei w = 1 steht wieder genau das da, was ohne diese
 * Schätzung dastünde (`satModels` in target.ts).
 */
export type SatEstimate = {
  saturation: number; // §8.3, nach den Tabellen
  satA: number; // ā, nach den Tabellen
  w: number; // 0…1, Anteil der Pixel ohne verlässliche Schätzung
};

/**
 * Stützstellen je Kanal innerhalb einer Zelle: vier Gruppen zu je vier
 * Codewerten, jede durch ihre Mitte vertreten.
 */
const STUETZ = [1.5, 5.5, 9.5, 13.5];

const argmax = (a: number, b: number, c: number) => (a >= b ? (a >= c ? 0 : 2) : b >= c ? 1 : 2);
const argmin = (a: number, b: number, c: number) => (a <= b ? (a <= c ? 0 : 2) : b <= c ? 1 : 2);

/**
 * Anteil der Zelle, für den der Vertreter nicht mehr steht.
 *
 * Das ist die eine Sache, die das Gitter nicht kann: sobald die Kanäle
 * unterschiedlich skaliert werden, hängt es innerhalb einer Zelle vom
 * einzelnen Pixel ab, welcher Kanal nach den Tabellen der größte und welcher
 * der kleinste ist — und (max−min)/max des Vertreters steht dann für einen
 * Teil der Pixel nicht mehr. Ein feineres Gitter hilft dagegen nicht (32³ ist
 * an §13-Bild 03 nicht besser als 16³); was hilft, ist zu wissen, wie groß
 * dieser Teil ist.
 *
 * Geschätzt wird er auf 4³ Stützstellen über der Zelle, gleichverteilt: für
 * jede wird geprüft, ob sie nach den Tabellen dieselbe Kanalreihenfolge
 * bekommt wie der Vertreter. Gleichverteilung ist eine Annahme — die Pixel
 * einer Zelle liegen dichter beim Vertreter als an ihren Ecken —, deshalb
 * fällt die Schätzung eher zu hoch aus. Genau dafür steht die Zählung am
 * Pixel in `test/gitter.test.ts` daneben: sie misst denselben Anteil ohne
 * Annahme, und die Schätzung darf ihn nirgends nennenswert unterschreiten.
 */
function unsicherAnteil(lo: [number, number, number], luts: Luts, rMax: number, rMin: number): number {
  let ab = 0;
  for (const dr of STUETZ) {
    const r = tab(luts[0]!, lo[0]! + dr);
    for (const dg of STUETZ) {
      const g = tab(luts[1]!, lo[1]! + dg);
      for (const db of STUETZ) {
        const b = tab(luts[2]!, lo[2]! + db);
        if (argmax(r, g, b) !== rMax || argmin(r, g, b) !== rMin) ab++;
      }
    }
  }
  return ab / (STUETZ.length ** 3);
}

/** Tabellenwert an einer Zwischenstelle — der Vertreter ist ein Mittelwert. */
function tab(lut: Float32Array, x: number): number {
  const i = Math.floor(x);
  if (i >= 255) return lut[255]!;
  if (i < 0) return lut[0]!;
  const f = x - i;
  return lut[i]! * (1 - f) + lut[i + 1]! * f;
}

export function estimateAfterLuts(grid: ColorGrid, luts: Luts): SatEstimate {
  const { counts, sums, satSums, satASums } = grid;
  let n = 0; // Pixel im Gitter
  let sNach = 0; // Σ s′
  let saNach = 0; // Σ a′·s′
  let sVor = 0; // Σ s  (= Gewicht für w)
  let ungewiss = 0; // Σ s über den unsicheren Zellen

  for (let k = 0; k < counts.length; k++) {
    const c = counts[k]!;
    if (c === 0) continue;
    n += c;
    const s = satSums[k]!;
    sVor += s;

    const r = sums[k * 3]! / c, g = sums[k * 3 + 1]! / c, b = sums[k * 3 + 2]! / c;
    const max = Math.max(r, g, b);
    if (max <= 0) continue;
    const min = Math.min(r, g, b);
    const sRep = (max - min) / max;
    const aRep = luminance(r, g, b) / max;

    const r2 = tab(luts[0]!, r), g2 = tab(luts[1]!, g), b2 = tab(luts[2]!, b);
    const max2 = Math.max(r2, g2, b2);
    if (max2 <= 0) continue;
    const min2 = Math.min(r2, g2, b2);
    const sRep2 = (max2 - min2) / max2;
    const aRep2 = luminance(r2, g2, b2) / max2;

    const rb = k >> 8, gb = (k >> 4) & 15, bb = k & 15;
    ungewiss += s * unsicherAnteil(
      [rb * BIN_WIDTH, gb * BIN_WIDTH, bb * BIN_WIDTH],
      luts,
      argmax(r2, g2, b2),
      argmin(r2, g2, b2),
    );

    // Die Wirkung der Tabellen als **Verschiebung** je Pixel, nicht als
    // Verhältnis: die Zelle bringt ihre gemessene Sättigungssumme mit, und der
    // Vertreter sagt, um wie viel sie sich verschiebt. Ein Verhältnis
    // s′/s ist an dieser Stelle unbrauchbar — bei einem fast neutralen
    // Vertreter (sRep → 0) wächst es über jede Grenze, und ein Bild aus
    // Beinahe-Unentschieden bekam damit Sättigungen von 6,9 und 16,4
    // zugeschrieben. Gemessen gegen die Zählung am Pixel (test/gitter.test.ts):
    // Verschiebung höchstens 0,010 daneben, Verhältnis bis 0,038, der bloße
    // Vertreterbetrag c·s′ bis 0,018.
    const bs = Math.max(0, Math.min(c, s + c * (sRep2 - sRep)));
    sNach += bs;
    // ā genauso: die Zelle bringt ihre gemessene Summe Σ a·s mit, der
    // Vertreter die Verschiebung. Gegen ein flaches bs·ā′ gemessen ist das an
    // §13-Bild 03 0,001 statt 0,010 daneben, an Bild 04 0,015 statt 0,025.
    saNach += Math.max(0, satASums[k]! + c * (aRep2 * sRep2 - aRep * sRep));
  }

  if (n === 0 || sVor <= 0) return { saturation: 0, satA: 1, w: 1 };
  return {
    saturation: sNach / n,
    satA: sNach > 0 ? saNach / sNach : 1,
    w: ungewiss / sVor,
  };
}
