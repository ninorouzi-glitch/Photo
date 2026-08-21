import { describe, expect, test } from 'vitest';
import { computeTarget } from '../src/core/target.ts';
import { testSet } from './fixtures/generate.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { deviations } from '../src/core/deviation.ts';
import { exportName } from '../src/pipeline/exporter.ts';
import { exportSize } from '../src/pipeline/render.ts';
import { aspectOf, clampAspect, cropRect } from '../src/core/crop.ts';
import { DEFAULT_SETTINGS, MAX_ASPECT, MIN_ASPECT, RATIOS, type Settings } from '../src/core/types.ts';

const withRatio = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });

const stats = testSet().map((t) => analyzeFull(t.frame));

describe('F-14 Referenzwahl', () => {
  test('das Ankerbild zeigt in allen Kriterien null Abweichung', () => {
    const anchor = stats[1]!;
    const target = computeTarget(stats, anchor);
    const d = deviations(anchor, target);
    for (const key of Object.keys(d) as (keyof typeof d)[]) {
      expect(d[key].value).toBe(0);
      expect(d[key].status).toBe('ok');
    }
  });
});

describe('F-12 eigenes Zielformat', () => {
  test('die Voreinstellungen bleiben, was sie waren', () => {
    expect(aspectOf(withRatio({ ratio: '4:5' }))).toBeCloseTo(0.8, 10);
    expect(aspectOf(withRatio({ ratio: '1:1' }))).toBe(1);
    expect(aspectOf(withRatio({ ratio: '1.91:1' }))).toBeCloseTo(1.91, 10);
  });

  test('ein eigenes Verhältnis wird aus Breite und Höhe gerechnet', () => {
    expect(aspectOf(withRatio({ ratio: 'custom', customRatio: { w: 3, h: 2 } }))).toBeCloseTo(1.5, 10);
    expect(aspectOf(withRatio({ ratio: 'custom', customRatio: { w: 16, h: 9 } }))).toBeCloseTo(16 / 9, 10);
    expect(aspectOf(withRatio({ ratio: 'custom', customRatio: { w: 2, h: 3 } }))).toBeCloseTo(2 / 3, 10);
  });

  test('die Voreinstellung gewinnt, auch wenn ein eigenes Verhältnis danebensteht', () => {
    const s = withRatio({ ratio: '1:1', customRatio: { w: 16, h: 9 } });
    expect(aspectOf(s)).toBe(1);
  });

  test('Unsinn in den Feldern ergibt 1:1, keine Division durch null', () => {
    for (const bad of [0, -3, NaN, Infinity]) {
      expect(clampAspect(bad)).toBe(1);
      expect(aspectOf(withRatio({ ratio: 'custom', customRatio: { w: bad, h: 1 } }))).toBe(1);
    }
    // Eine leere Zahleneingabe kommt als NaN an, nicht als 0.
    expect(aspectOf(withRatio({ ratio: 'custom', customRatio: { w: 3, h: NaN } }))).toBe(1);
  });

  test('extreme Werte werden auf 1:4 … 4:1 geklemmt', () => {
    expect(aspectOf(withRatio({ ratio: 'custom', customRatio: { w: 100, h: 1 } }))).toBe(MAX_ASPECT);
    expect(aspectOf(withRatio({ ratio: 'custom', customRatio: { w: 1, h: 100 } }))).toBe(MIN_ASPECT);
  });

  test('ein eigenes Format trägt bis in den Zuschnitt und die Ausgabe', () => {
    const s = withRatio({ ratio: 'custom', customRatio: { w: 16, h: 9 } });
    const rect = cropRect(4000, 3000, aspectOf(s));
    expect(rect.w / rect.h).toBeCloseTo(16 / 9, 3);
    expect(rect.w).toBeLessThanOrEqual(4000);
    expect(rect.h).toBeLessThanOrEqual(3000);

    const size = exportSize(aspectOf(s), 'original', { width: 4000, height: 3000 });
    expect(size).toEqual({ width: rect.w, height: rect.h });
  });
});

describe('F-22 Export', () => {
  test('1080 px: 4:5 misst exakt 1080 × 1350 px', () => {
    expect(exportSize(RATIOS['4:5'], '1080')).toEqual({ width: 1080, height: 1350 });
    expect(exportSize(RATIOS['1:1'], '1080')).toEqual({ width: 1080, height: 1080 });
  });

  test('volle Auflösung: die Ausgabe ist der Zuschnitt in Bildpixeln', () => {
    // 6000 × 4000 in 4:5 ist an der Breite beschnitten, die Höhe bleibt ganz.
    expect(exportSize(RATIOS['4:5'], 'original', { width: 6000, height: 4000 }))
      .toEqual({ width: 3200, height: 4000 });
    // 1:1 aus demselben Bild: die kurze Kante gibt beide Maße vor.
    expect(exportSize(RATIOS['1:1'], 'original', { width: 6000, height: 4000 }))
      .toEqual({ width: 4000, height: 4000 });
  });

  test('volle Auflösung deckt sich mit dem Zuschnitt — kein Umrechnen dazwischen', () => {
    for (const [w, h] of [[6000, 4000], [4032, 3024], [1080, 1920], [900, 900]] as const) {
      for (const ratio of ['4:5', '1:1', '1.91:1'] as const) {
        const rect = cropRect(w, h, RATIOS[ratio]);
        const size = exportSize(RATIOS[ratio], 'original', { width: w, height: h });
        expect(size).toEqual({ width: rect.w, height: rect.h });
      }
    }
  });

  test('volle Auflösung vergrößert nie — die Ausgabe passt ins Bild', () => {
    const size = exportSize(RATIOS['1.91:1'], 'original', { width: 800, height: 1000 });
    expect(size.width).toBeLessThanOrEqual(800);
    expect(size.height).toBeLessThanOrEqual(1000);
  });

  test('Dateiname trägt die führende Positionsnummer', () => {
    expect(exportName(1, 'Strand')).toBe('01_Strand.jpg');
    expect(exportName(12, 'Boot/Hafen')).toBe('12_BootHafen.jpg');
    expect(exportName(3, '///')).toBe('03_bild.jpg');
  });
});
