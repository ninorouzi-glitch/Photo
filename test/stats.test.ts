import { describe, expect, test } from 'vitest';
import type { Frame } from '../src/core/types.ts';
import { MEASURE_AREA, MIN_CONTRAST } from '../src/core/types.ts';
import { analyzeFull, measureWindow, sampleStep } from '../src/core/stats.ts';
import { luminanceMap } from '../src/core/frame.ts';
import {
  baseScene,
  clippedRed,
  flatten,
  stripes,
  vignette,
  STRIPE_A,
  STRIPE_B,
  VIGNETTE_BASE,
} from './fixtures/generate.ts';

/**
 * Shades-of-Grey wie in stats.ts, nur mit Schalter: `ausschluss = false` ist der
 * alte Zustand, der allein über die Luminanz filtert. Bewusst hier nachgebaut —
 * der Punkt der Prüfung ist der Vergleich der beiden Varianten am selben Bild.
 */
function warmthRef(f: Frame, ausschluss: boolean): number {
  const lum = luminanceMap(f);
  const P = 6;
  let sr = 0, sb = 0, n = 0;
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const r = f.data[p]!, g = f.data[p + 1]!, b = f.data[p + 2]!;
    if (ausschluss && (Math.max(r, g, b) >= 250 || Math.min(r, g, b) <= 5)) continue;
    const L = lum[i]!;
    if (L <= 16 || L >= 244) continue;
    sr += (r / 255) ** P;
    sb += (b / 255) ** P;
    n++;
  }
  const wr = (sr / n) ** (1 / P) * 255;
  const wb = (sb / n) ** (1 / P) * 255;
  return Math.log2((wr + 1e-6) / (wb + 1e-6));
}

/** Median der Luminanz über den ganzen Frame, ohne Messfenster. */
function medianLuma(f: Frame): number {
  const l = Array.from(luminanceMap(f)).sort((a, b) => a - b);
  return l[l.length >> 1]!;
}

describe('Kanalweiser Clipping-Ausschluss', () => {
  const fixture = clippedRed();
  const fenster = measureWindow(fixture);

  test('Ein geclippter Rotkanal zieht den Weißabgleich, der Ausschluss hält ihn', () => {
    // Der Hintergrund ist exakt neutral, der wahre Illuminant also warmth = 0.
    const ohne = warmthRef(fenster, false);
    const mit = warmthRef(fenster, true);
    expect(Math.abs(ohne)).toBeGreaterThan(0.9); // weit jenseits crit (0,18)
    expect(Math.abs(mit)).toBeLessThan(0.01);
    expect(Math.abs(mit)).toBeLessThan(Math.abs(ohne));
  });

  test('analyzeFull misst den Wert mit Ausschluss', () => {
    expect(analyzeFull(fixture).warmth).toBeCloseTo(warmthRef(fenster, true), 6);
  });

  test('clippedRatio trifft den Anteil der verworfenen Pixel im Messfenster', () => {
    let verworfen = 0;
    const d = fenster.data;
    for (let p = 0; p < d.length; p += 4) {
      const r = d[p]!, g = d[p + 1]!, b = d[p + 2]!;
      if (Math.max(r, g, b) >= 250 || Math.min(r, g, b) <= 5) verworfen++;
    }
    const anteil = verworfen / (fenster.width * fenster.height);
    expect(analyzeFull(fixture).clippedRatio).toBeCloseTo(anteil, 6);
    // Das Band deckt drei Zehntel der Bildhöhe ab und liegt ganz im Fenster.
    expect(anteil).toBeGreaterThan(0.3);
    expect(anteil).toBeLessThan(0.37);
  });

  test('Ein Bild ohne Anschlag meldet clippedRatio 0', () => {
    expect(analyzeFull(baseScene()).clippedRatio).toBe(0);
  });
});

describe('Entphaste Palette-Stichprobe', () => {
  const fixture = stripes();
  const fenster = measureWindow(fixture);
  const farben = (step: number) => {
    const set = new Set<string>();
    const n = fenster.width * fenster.height;
    for (let i = 0; i < n; i += step) {
      const p = i * 4;
      set.add(`${fenster.data[p]},${fenster.data[p + 1]},${fenster.data[p + 2]}`);
    }
    return set;
  };

  test('Eine feste Schrittweite 4 trifft nur eine der beiden Spaltengruppen', () => {
    // Die Fensterbreite ist durch 4 teilbar — genau der Fall, in dem die alte
    // Schrittweite auf einer Spaltenphase festhängt.
    expect(fenster.width % 4).toBe(0);
    expect(farben(4).size).toBe(1);
  });

  test('sampleStep wählt eine Primzahl, die die Fensterbreite nicht teilt', () => {
    const step = sampleStep(fenster.width);
    expect(fenster.width % step).not.toBe(0);
    expect(farben(step).size).toBe(2);
  });

  test('Beide Farben des Musters stehen in der Palette', () => {
    const hex = ([r, g, b]: [number, number, number]) =>
      `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const palette = analyzeFull(fixture).palette;
    expect(palette).toContain(hex(STRIPE_A));
    expect(palette).toContain(hex(STRIPE_B));
  });
});

describe('Messfenster gegen Vignettierung', () => {
  const fixture = vignette();

  test('p50 liegt mit Messfenster näher an der unvignettierten Fläche', () => {
    const mitFenster = analyzeFull(fixture).p50;
    const ohneFenster = medianLuma(fixture);
    expect(Math.abs(mitFenster - VIGNETTE_BASE)).toBeLessThan(
      Math.abs(ohneFenster - VIGNETTE_BASE),
    );
    expect(mitFenster).toBeGreaterThan(ohneFenster);
  });

  test('Das Messfenster hält MEASURE_AREA der Fläche', () => {
    const fenster = measureWindow(fixture);
    const anteil = (fenster.width * fenster.height) / (fixture.width * fixture.height);
    expect(anteil).toBeCloseTo(MEASURE_AREA, 2);
  });

  test('Das Seitenverhältnis bleibt vom Messfenster unberührt', () => {
    expect(analyzeFull(fixture).aspect).toBeCloseTo(fixture.width / fixture.height, 10);
  });
});

describe('Kanalweise CDFs', () => {
  const s = analyzeFull(baseScene());

  test('Jede Kanal-CDF ist monoton und endet bei 1', () => {
    for (const cdf of [s.cdfR, s.cdfG, s.cdfB]) {
      expect(cdf.length).toBe(256);
      for (let i = 1; i < 256; i++) expect(cdf[i]!).toBeGreaterThanOrEqual(cdf[i - 1]!);
      expect(cdf[255]!).toBeCloseTo(1, 10);
    }
  });

  test('Auf einem Graubild sind die drei CDFs identisch', () => {
    const g = analyzeFull(vignette()); // R = G = B in jedem Pixel
    for (let i = 0; i < 256; i++) {
      expect(g.cdfG[i]!).toBe(g.cdfR[i]!);
      expect(g.cdfB[i]!).toBe(g.cdfR[i]!);
    }
  });
});

describe('Kontrastnormierung mit MIN_CONTRAST', () => {
  // Dieselbe Szene, einmal unter und einmal über der alten Normierungsgrenze 12.
  const flach = analyzeFull(flatten(baseScene(), 0.08, 1));
  const steil = analyzeFull(flatten(baseScene(), 0.16, 1));

  test('Die Voraussetzung stimmt: ein Bild unter 12, eines darüber', () => {
    expect(flach.contrast).toBeGreaterThan(MIN_CONTRAST);
    expect(flach.contrast).toBeLessThan(12);
    expect(steil.contrast).toBeGreaterThan(12);
  });

  test('Schärfe ist auch unter 12 auf den eigenen Kontrast normiert', () => {
    // Mit der alten Grenze fiele der flaue Wert um (contrast/12)² ≈ 0,56 zu
    // niedrig aus — das Verhältnis läge bei rund 0,6 statt bei 1.
    expect(flach.sharpness / steil.sharpness).toBeGreaterThan(0.85);
    expect(flach.sharpness / steil.sharpness).toBeLessThan(1.15);
  });

  test('Rauschen ist auch unter 12 auf den eigenen Kontrast normiert', () => {
    // Alte Grenze: Faktor contrast/12 ≈ 0,75 zu niedrig.
    expect(flach.noise / steil.noise).toBeGreaterThan(0.95);
    expect(flach.noise / steil.noise).toBeLessThan(1.05);
  });
});
