import { describe, expect, test } from 'vitest';
import { baseScene, blur, crop, testSet } from './fixtures/generate.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { computeTarget } from '../src/core/target.ts';
import { deviationValues, deviations } from '../src/core/deviation.ts';
import { applyRecipe, buildRecipe } from '../src/core/apply.ts';
import { cropFrame, cropRect } from '../src/core/crop.ts';
import { DEFAULT_SETTINGS, RATIOS, type Settings } from '../src/core/types.ts';
import { cloneFrame } from '../src/core/frame.ts';

const set = testSet();
const stats = set.map((t) => analyzeFull(t.frame));
const byId = (id: string) => stats[set.findIndex((t) => t.id === id)]!;

const spread = (v: number[]) => Math.max(...v) - Math.min(...v);

/** Index des ersten Unterschieds, oder −1. Ein Tiefenvergleich über 640k
 *  Einträge dauert in vitest Sekunden; hier reicht eine Schleife. */
function firstDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over, fixes: { ...DEFAULT_SETTINGS.fixes, ...over.fixes } };
}

describe('A-01 Messgenauigkeit (§13)', () => {
  const ref = byId('01');

  test('02 „nah dran": ×1,05 Helligkeit ergibt ≈ +0,07 EV', () => {
    const d = deviationValues(byId('02'), ref);
    expect(d.exposure).toBeCloseTo(Math.log2(1.05), 2);
    expect(Math.abs(d.warmth)).toBeLessThan(0.03);
  });

  test('03 „dunkel & kühl": −1,20 EV und −0,67 Weißabgleich auf ±0,03', () => {
    const d = deviationValues(byId('03'), ref);
    expect(d.exposure).toBeGreaterThan(-1.23);
    expect(d.exposure).toBeLessThan(-1.17);
    expect(d.warmth).toBeGreaterThan(Math.log2(0.85 / 1.35) - 0.03);
    expect(d.warmth).toBeLessThan(Math.log2(0.85 / 1.35) + 0.03);
  });

  test('04 „flau": Kontrast und Sättigung sind Ausreißer', () => {
    const d = deviations(byId('04'), ref);
    expect(d.contrast.status).toBe('crit');
    expect(d.contrast.value).toBeLessThan(0);
    expect(d.saturation.status).toBe('crit');
    expect(d.saturation.value).toBeLessThan(0);
  });

  test('05 „quer & rauschig": Format Ausreißer, Rauschen und Schärfe auffällig', () => {
    const target = computeTarget(stats);
    const d = deviations(byId('05'), target);
    expect(d.aspect.status).toBe('crit');
    expect(d.noise.status).not.toBe('ok');
    expect(d.sharpness.status).not.toBe('ok');
  });

  test('Schärfe erkennt Weichzeichnung in der richtigen Richtung', () => {
    const sharp = analyzeFull(baseScene());
    const soft = analyzeFull(blur(baseScene(), 1.5));
    const d = deviationValues(soft, sharp);
    expect(d.sharpness).toBeLessThan(-1.1); // Ausreißer, negativ
  });

  test('Schärfemaß ist unabhängig von der Helligkeit (§8.4)', () => {
    // Dasselbe Motiv, nur 1,2 EV dunkler, ist pixelidentisch scharf.
    const d = deviationValues(byId('03'), byId('01'));
    expect(Math.abs(d.sharpness)).toBeLessThan(0.1);
  });

  test('Rauschmaß ist unabhängig von der Helligkeit (§8.5)', () => {
    const d = deviationValues(byId('03'), byId('01'));
    expect(Math.abs(d.noise)).toBeLessThan(0.5);
  });
});

describe('A-02 Konvergenz', () => {
  const s = 0.7;
  const cfg = settings({ strength: s });
  const target = computeTarget(stats);

  const corrected = set.map((t, i) => {
    const recipe = buildRecipe(stats[i]!, target, cfg);
    return analyzeFull(applyRecipe(cloneFrame(t.frame), recipe, i + 1));
  });

  test('Belichtung: Reststreuung ≤ (1−s)·Ausgang + 10 %', () => {
    const before = spread(stats.map((x) => x.p50));
    const after = spread(corrected.map((x) => x.p50));
    expect(after).toBeLessThanOrEqual((1 - s) * before * 1.1);
  });

  test('Weißabgleich: Reststreuung ≤ (1−s)·Ausgang + 10 %', () => {
    const before = spread(stats.map((x) => x.warmth));
    const after = spread(corrected.map((x) => x.warmth));
    expect(after).toBeLessThanOrEqual((1 - s) * before * 1.1);
  });

  test('Kontrast: Reststreuung sinkt deutlich', () => {
    const before = spread(stats.map((x) => x.contrast));
    const after = spread(corrected.map((x) => x.contrast));
    expect(after).toBeLessThan(before * 0.5);
  });

  test('Sättigung: Reststreuung sinkt (Maß ≠ Anwendung, weite Toleranz)', () => {
    // Gemessen wird (max−min)/max, angewendet L + (c−L)·f — nicht dasselbe Maß.
    // Deshalb hier nur die Richtung geprüft, nicht der exakte Faktor.
    const before = spread(stats.map((x) => x.saturation));
    const after = spread(corrected.map((x) => x.saturation));
    expect(after).toBeLessThan(before);
  });
});

describe('A-03 Nulldurchlauf', () => {
  test('Stärke 0 % ist pixelgleich zum zugeschnittenen Original', () => {
    const target = computeTarget(stats);
    const cfg = settings({ strength: 0 });
    for (let i = 0; i < set.length; i++) {
      const src = set[i]!.frame;
      const rect = cropRect(src.width, src.height, RATIOS['4:5']);
      const cropped = cropFrame(src, rect);
      const recipe = buildRecipe(stats[i]!, target, cfg);
      expect(recipe.neutral).toBe(true);
      const out = applyRecipe(cloneFrame(cropped), recipe, i + 1);
      expect(firstDiff(out.data, cropped.data)).toBe(-1);
    }
  });

  test('Alle Schalter aus ergibt dasselbe wie Stärke 0 % (F-15)', () => {
    const target = computeTarget(stats);
    const cfg = settings({
      strength: 1,
      fixes: { tone: false, wb: false, saturation: false, grain: false, sharpen: false },
    });
    const recipe = buildRecipe(stats[0]!, target, cfg);
    expect(recipe.neutral).toBe(true);
  });
});

describe('A-04 keine Verschlechterung', () => {
  const clipped = (f: { data: Uint8ClampedArray }) => {
    let n = 0;
    for (let p = 0; p < f.data.length; p += 4) {
      if (f.data[p] === 255 || f.data[p + 1] === 255 || f.data[p + 2] === 255) n++;
      else if (f.data[p] === 0 && f.data[p + 1] === 0 && f.data[p + 2] === 0) n++;
    }
    return (n / (f.data.length / 4)) * 100;
  };

  test('Anteil ausgefressener Pixel steigt um höchstens 0,5 Prozentpunkte', () => {
    const target = computeTarget(stats);
    const cfg = settings({ strength: 1 });
    for (let i = 0; i < set.length; i++) {
      const before = clipped(set[i]!.frame);
      const recipe = buildRecipe(stats[i]!, target, cfg);
      const after = clipped(applyRecipe(cloneFrame(set[i]!.frame), recipe, i + 1));
      expect(after - before).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('Zuschnitt (F-17, F-22)', () => {
  test('4:5 aus einem Querformat trifft das Verhältnis', () => {
    const src = crop(baseScene(), 0, 250, 800, 450);
    const r = cropRect(src.width, src.height, RATIOS['4:5']);
    expect(r.w / r.h).toBeCloseTo(0.8, 2);
    expect(r.x + r.w).toBeLessThanOrEqual(src.width);
    expect(r.y + r.h).toBeLessThanOrEqual(src.height);
  });

  test('Versatz kann nicht über den Bildrand hinausschieben', () => {
    const src = crop(baseScene(), 0, 250, 800, 450);
    for (const off of [-5, -1, 0, 1, 5]) {
      const r = cropRect(src.width, src.height, RATIOS['4:5'], { x: off, y: off });
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(src.width);
      expect(r.y + r.h).toBeLessThanOrEqual(src.height);
    }
  });
});
