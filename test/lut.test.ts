import { describe, expect, test } from 'vitest';
import { createFrame, cloneFrame } from '../src/core/frame.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { applyRecipe } from '../src/core/apply.ts';
import { identityLuts, toneCurve } from '../src/core/lut.ts';

/**
 * Ein Bild, das jeden der 256 Tonwerte gleich oft enthält, über die ganze
 * Fläche gestreut statt als Verlauf — sonst schnitte das Messfenster
 * (MEASURE_INSET) gerade die Randbins weg, auf die es hier ankommt.
 *
 * Absichtlich nicht in `generate.ts`: weder Teil des §13-Satzes noch des
 * Messsatzes. Es ist kein Foto, sondern ein Messmittel mit bekannter Wahrheit —
 * Quelle und Ziel unterscheiden sich um genau eine bekannte lineare Abbildung,
 * und die muss die Tonwertkurve zurückliefern.
 */
function vollerUmfang(map: (v: number) => number) {
  const f = createFrame(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const v = Math.max(0, Math.min(255, Math.round(map((x * 13 + y * 7) % 256))));
      const p = (y * 256 + x) * 4;
      f.data[p] = v; f.data[p + 1] = v; f.data[p + 2] = v; f.data[p + 3] = 255;
    }
  }
  return f;
}

/** Nur die Tabelle, kein Weißabgleich, keine Sättigung, kein Korn. */
function nurKurve(kurve: Float64Array) {
  const luts = identityLuts();
  for (const l of luts) for (let i = 0; i < 256; i++) l[i] = kurve[i]!;
  return { luts, saturation: 1, grainSigma: 0, sharpenAmount: 0, neutral: false };
}

describe('Tonwertkurve trifft die bekannte Ziel-CDF', () => {
  // Zwei Stauchungen, beide innerhalb des ±70-Deckels — sonst misst der Test
  // den Deckel und nicht die Kurve.
  for (const [name, off, k] of [['mild', 20, 0.86], ['kräftig', 60, 0.6]] as const) {
    describe(`Ziel v → ${off} + ${k}·v (${name})`, () => {
      const quelle = vollerUmfang((v) => v);
      const ziel = vollerUmfang((v) => off + k * v);
      const qs = analyzeFull(quelle);
      const zs = analyzeFull(ziel);
      const kurve = toneCurve(qs.cdf, zs.cdf, 1);

      test('die Kurve gibt die bekannte Abbildung wieder', () => {
        let summe = 0, max = 0;
        for (let i = 0; i < 256; i++) {
          const e = Math.abs(kurve[i]! - (off + k * i));
          summe += e;
          max = Math.max(max, e);
        }
        // Mit festem Glättungsfenster lagen diese Werte bei 0,105 / 2,586
        // (mild) bzw. 0,068 / 1,857 (kräftig) — der Fehler steckte fast
        // vollständig in den Randbins.
        expect(summe / 256).toBeLessThan(0.04);
        expect(max).toBeLessThan(0.35);
      });

      test('die Endpunkte werden nicht nach innen gezogen', () => {
        // Genau hier saß der systematische Fehler: das einseitige Fenster hob
        // den Schwarzpunkt an und senkte den Weißpunkt, in jedem Bild.
        expect(Math.abs(kurve[0]! - off)).toBeLessThan(0.35);
        expect(Math.abs(kurve[255]! - (off + k * 255))).toBeLessThan(0.35);
      });

      test('p01 und p99 landen nach der Korrektur auf dem Ziel', () => {
        const out = analyzeFull(applyRecipe(cloneFrame(quelle), nurKurve(kurve), 1));
        // Vorher: 1,217 / 2,000 (mild). Der Rest ist Dither und die eine
        // Rundung beim Schreiben in den Frame, nicht mehr die Kurve.
        expect(Math.abs(out.p01 - zs.p01)).toBeLessThan(0.35);
        expect(Math.abs(out.p99 - zs.p99)).toBeLessThan(0.35);
      });
    });
  }

  test('Stärke 0 lässt die Kurve die Identität', () => {
    const qs = analyzeFull(vollerUmfang((v) => v));
    const zs = analyzeFull(vollerUmfang((v) => 20 + 0.86 * v));
    const kurve = toneCurve(qs.cdf, zs.cdf, 0);
    for (let i = 0; i < 256; i++) expect(kurve[i]).toBeCloseTo(i, 10);
  });

  test('die Kurve bleibt monoton — keine Umsortierung von Tonwerten', () => {
    const qs = analyzeFull(vollerUmfang((v) => v));
    const zs = analyzeFull(vollerUmfang((v) => 60 + 0.6 * v));
    const kurve = toneCurve(qs.cdf, zs.cdf, 1);
    for (let i = 1; i < 256; i++) expect(kurve[i]!).toBeGreaterThanOrEqual(kurve[i - 1]!);
  });
});
