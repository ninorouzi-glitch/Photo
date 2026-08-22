import { describe, expect, test } from 'vitest';
import type { ColorGrid, Frame, Settings, Stats } from '../src/core/types.ts';
import { MEASURE_EDGE } from '../src/core/types.ts';
import { cloneFrame, downscaleToEdge, luminanceMap } from '../src/core/frame.ts';
import { analyzeFull, channelsUsable, measureWindow } from '../src/core/stats.ts';
import { computeTarget, satModels } from '../src/core/target.ts';
import { buildLuts, type Luts } from '../src/core/lut.ts';
import { applyRecipe, buildRecipe } from '../src/core/apply.ts';
import { emptyGrid, estimateAfterLuts } from '../src/core/satgrid.ts';
import { baseScene, measurementSet, scaleChannels, testSet } from './fixtures/generate.ts';

/**
 * Das Farbgitter gegen die Zählung am Pixel (Abweichung Nr. 3, Etappe 3c).
 *
 * `estimateAfterLuts` schätzt aus 16³ Zellen, was von der Sättigung nach
 * Weißabgleich und Tonwertkurve übrig ist, und gibt mit `w` an, wie weit die
 * Schätzung trägt. Beides ist eine Schätzung — hier steht die Wahrheit
 * daneben: dieselben Größen, Pixel für Pixel gerechnet, auf derselben
 * Pixelauswahl wie `saturation` in stats.ts.
 *
 * Diese Referenz bleibt hier stehen, damit die Schätzung nicht still
 * abdriftet. Sie ist bewusst nicht in `core/`: sie kostet einen vollen
 * Durchlauf über das Bild je Reglerschritt und ist damit genau das, was das
 * Gitter vermeidet.
 */

function cfg(strength: number): Settings {
  return {
    ratio: '4:5', customRatio: { w: 4, h: 5 }, output: 'original', strength,
    reference: 'median',
    fixes: { tone: true, wb: true, saturation: true, grain: false, sharpen: false },
  };
}

/** Tabellenwert an einer Zwischenstelle — dieselbe Interpolation wie in satgrid.ts. */
function tab(lut: Float32Array, x: number): number {
  const i = Math.floor(x);
  if (i >= 255) return lut[255]!;
  if (i < 0) return lut[0]!;
  const f = x - i;
  return lut[i]! * (1 - f) + lut[i + 1]! * f;
}

const argmax = (a: number, b: number, c: number) => (a >= b ? (a >= c ? 0 : 2) : b >= c ? 1 : 2);
const argmin = (a: number, b: number, c: number) => (a <= b ? (a <= c ? 0 : 2) : b <= c ? 1 : 2);

/** Die Pixel, über die §8.3 mittelt — dieselbe Auswahl wie `saturation`. */
function messPixel(f: Frame): { m: Frame; lum: Float32Array } {
  const m = measureWindow(downscaleToEdge(f, MEASURE_EDGE));
  return { m, lum: luminanceMap(m) };
}

/**
 * Wahrheit am Pixel: Sättigung und ā nach den Tabellen, und der Anteil der
 * Pixel, deren Kanalreihenfolge nach den Tabellen von der ihres Vertreters
 * abweicht — sättigungsgewichtet, also dieselbe Größe, die `w` schätzt.
 */
function amPixel(f: Frame, grid: ColorGrid, luts: Luts) {
  const { m, lum } = messPixel(f);
  const d = m.data;
  let sum = 0, sumA = 0, n = 0, ab = 0, ges = 0;
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    if (lum[i]! <= 20) continue;
    const r0 = d[p]!, g0 = d[p + 1]!, b0 = d[p + 2]!;
    if (!channelsUsable(r0, g0, b0)) continue;
    const max0 = Math.max(r0, g0, b0);
    if (max0 <= 0) continue;
    n++;
    const s0 = (max0 - Math.min(r0, g0, b0)) / max0;
    ges += s0;

    const r = luts[0]![r0]!, g = luts[1]![g0]!, b = luts[2]![b0]!;
    const max = Math.max(r, g, b);
    if (max > 0) {
      const s = (max - Math.min(r, g, b)) / max;
      sum += s;
      sumA += ((0.2126 * r + 0.7152 * g + 0.0722 * b) / max) * s;
    }

    // Vertreter der Zelle, durch dieselben Tabellen geschickt
    const k = (r0 >> 4) * 256 + (g0 >> 4) * 16 + (b0 >> 4);
    const c = grid.counts[k]!;
    const vr = tab(luts[0]!, grid.sums[k * 3]! / c);
    const vg = tab(luts[1]!, grid.sums[k * 3 + 1]! / c);
    const vb = tab(luts[2]!, grid.sums[k * 3 + 2]! / c);
    if (argmax(r, g, b) !== argmax(vr, vg, vb) || argmin(r, g, b) !== argmin(vr, vg, vb)) ab += s0;
  }
  return {
    saturation: n === 0 ? 0 : sum / n,
    satA: sum <= 0 ? 1 : sumA / sum,
    w: ges > 0 ? ab / ges : 1,
  };
}

/**
 * Alle Fixtures, jeweils gegen das §13-Ziel gerechnet.
 *
 * Der Messsatz geht hier ausdrücklich *nicht* in `computeTarget` ein (er würde
 * Median und Ausgangsstreuung verschieben, siehe generate.ts) — er steht nur
 * als Quelle daneben. Gerade die harten Fälle (geclippter Kanal, Vignette,
 * Streifen) sind für die Schätzung die interessanten.
 */
const stats13 = testSet().map((m) => analyzeFull(m.frame));
const ziel13 = computeTarget(stats13);
const alle = [
  ...testSet().map((m, i) => ({ ...m, stats: stats13[i]! })),
  ...measurementSet().map((m) => ({ ...m, stats: analyzeFull(m.frame) })),
];

describe('Gitter-w gegen Pixel-w', () => {
  for (const strength of [1, 0.7]) {
    for (const it of alle) {
      test(`${it.id} ${it.label}, Stärke ${strength}`, () => {
        const luts = buildLuts(it.stats, ziel13, cfg(strength));
        const g = estimateAfterLuts(it.stats.colorGrid, luts);
        const p = amPixel(it.frame, it.stats.colorGrid, luts);

        // Die eine Bedingung: w darf die Unsicherheit nicht kleinrechnen.
        // Zu hoch ist unbedenklich — dann fällt die Blende auf die
        // Vor-LUT-Größe zurück, also auf den Stand vor dieser Etappe.
        // Gemessen (Stärke 1 / 0,7): 01 +0,30/+0,30 · 02 +0,34/+0,34 ·
        // 03 +0,035/+0,47 · 04 +0,25/+0,25 · 05 +0,30/+0,30 ·
        // 06 0/0 · 07 +0,25/0 · 08 0/0 · 09 +0,33/+0,33 · 10 +0,47/+0,47.
        expect(g.w - p.w).toBeGreaterThan(-0.10);

        // Und die Schätzung selbst trifft die Zählung am Pixel. Gemessen:
        // höchstens 0,013 daneben (Bild 08, eine Vignette ohne jede Farbe);
        // über den §13-Satz höchstens 0,010.
        expect(Math.abs(g.saturation - p.saturation)).toBeLessThan(0.02);
      });
    }
  }
});

/**
 * Die Garantie der Blende: bei w = 1 steht wieder genau das da, was vor
 * dieser Etappe dastand — Quellgröße *und* Ziel.
 *
 * w = 1 heißt „das Gitter kann zu diesem Bild nichts sagen"; im Code ist das
 * der leere Beitrag (`sVor <= 0`). Hier wird er hergestellt, indem das Bild
 * sein Gitter verliert — genau der Zustand, den `computeTarget` für den
 * Zielwert selbst erzeugt. Der Rest des Sets behält seines und zieht den
 * Median der Nach-LUT-Sättigung weit weg vom Median der Vor-LUT-Sättigung;
 * würde das Ziel nicht mitgeblendet, bekäme das Bild ohne Gitter ein Ziel aus
 * der falschen Domäne und ein anderes Ergebnis als vorher.
 */
describe('w = 1 gibt bitgleich den Stand vor der Umstellung', () => {
  // Ein Satz, in dem die beiden Domänen wirklich auseinanderliegen: drei
  // Bilder mit kräftigem Stich in verschiedene Richtungen, deren gemessene
  // Sättigung zum großen Teil der Stich ist und nach dem Weißabgleich
  // verschwindet. Am §13-Satz taugte das nicht — dort trägt nur ein Bild
  // einen Stich, und der Median steht robust dagegen.
  const basis = baseScene(400, 500);
  const set = [
    { id: 'k1', label: 'kühl', frame: scaleChannels(basis, 0.78, 1.0, 1.32) },
    { id: 'k2', label: 'warm', frame: scaleChannels(basis, 1.3, 1.0, 0.78) },
    { id: 'k3', label: 'grün', frame: scaleChannels(basis, 0.85, 1.28, 0.85) },
    { id: 'k4', label: 'magenta', frame: scaleChannels(basis, 1.22, 0.8, 1.22) },
  ];
  const ohneGitter = 3; // dieses Bild bekommt kein Gitter, also w = 1
  const stats = set.map((m, i) => {
    const st = analyzeFull(m.frame);
    return i === ohneGitter ? ({ ...st, colorGrid: emptyGrid() } as Stats) : st;
  });
  const ziel = computeTarget(stats);

  for (const strength of [1, 0.7]) {
    const models = satModels(stats, ziel, cfg(strength));

    test(`Stärke ${strength}: w = 1 genau für das Bild ohne Gitter`, () => {
      expect(models[ohneGitter]!.w).toBe(1);
      // Nicht leerlaufen lassen: der Rest des Sets muss die Schätzung
      // tatsächlich benutzen, sonst prüft der Test nichts.
      for (let i = 0; i < models.length; i++) {
        if (i === ohneGitter) continue;
        expect(models[i]!.w).toBeLessThan(0.7);
        expect(models[i]!.saturation).not.toBeCloseTo(stats[i]!.saturation, 4);
      }
    });

    test(`Stärke ${strength}: Quelle und Ziel sind die Vor-LUT-Größen`, () => {
      const m = models[ohneGitter]!;
      expect(m.saturation).toBe(stats[ohneGitter]!.saturation);
      expect(m.satA).toBe(stats[ohneGitter]!.satA);
      expect(m.target).toBe(ziel.saturation);
      // Und die beiden Domänen liegen in diesem Satz weit auseinander —
      // sonst wäre die Mitblendung des Ziels folgenlos und der Test blind.
      const nach = stats.map((st) => estimateAfterLuts(st.colorGrid, buildLuts(st, ziel, cfg(strength))).saturation);
      const sortiert = [...nach].sort((x, y) => x - y);
      const medianNach = (sortiert[1]! + sortiert[2]!) / 2;
      expect(Math.abs(medianNach - ziel.saturation)).toBeGreaterThan(0.05);
    });

    test(`Stärke ${strength}: dieselben Pixel wie ohne Modell`, () => {
      const s = stats[ohneGitter]!;
      const alt = buildRecipe(s, ziel, cfg(strength));
      const neu = buildRecipe(s, ziel, cfg(strength), models[ohneGitter]!);
      expect(neu.saturation).toBe(alt.saturation);

      const quelle = downscaleToEdge(set[ohneGitter]!.frame, MEASURE_EDGE);
      const a = applyRecipe(cloneFrame(quelle), alt, 1);
      const b = applyRecipe(cloneFrame(quelle), neu, 1);
      expect(Array.from(b.data)).toEqual(Array.from(a.data));
    });
  }
});
