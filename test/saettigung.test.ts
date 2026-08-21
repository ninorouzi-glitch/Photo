import { describe, expect, test } from 'vitest';
import { cloneFrame, createFrame } from '../src/core/frame.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { applyRecipe, buildRecipe } from '../src/core/apply.ts';
import { baseScene, chromaScaled, measurementSet } from './fixtures/generate.ts';
import type { Frame, Settings } from '../src/core/types.ts';

/**
 * Messmittel für die dokumentierte Abweichung Nr. 3: Sättigung wird als
 * (max−min)/max gemessen (§8.3), aber als L + (c−L)·f angewendet (§9.5).
 *
 * Absichtlich nicht in `generate.ts` — weder §13-Satz noch Messsatz. Die
 * Flächen sind keine Fotos, sondern ein Messmittel mit bekannter Wahrheit:
 * jedes Pixel trägt exakt die gesetzte Sättigung, der Sollwert der Messung
 * steht also vorher fest. Die fotografische Variante steht daneben, weil auf
 * den Flächen L/max fast konstant ist und der Restfehler dort kleiner ausfällt
 * als in einem Bild mit gemischten Farben.
 */

/** Nur Sättigung: keine Tonwertkurve, kein Weißabgleich, kein Korn, keine Schärfe. */
const nurSaettigung: Settings = {
  ratio: '4:5',
  customRatio: { w: 4, h: 5 },
  output: 'original',
  strength: 1,
  reference: 'median',
  fixes: { tone: false, wb: false, saturation: true, grain: false, sharpen: false },
};

/**
 * Fläche, in der jedes Pixel exakt die Sättigung S trägt.
 *
 * max (= V) streut über 70…235, damit die Fläche Tonwertbreite hat und
 * zugleich keinen Kanal an die Ausschlussgrenzen CLIP_LOW/CLIP_HIGH legt;
 * sechs Farbtöne und ein wandernder mittlerer Kanal, damit nicht eine einzige
 * Farbe gemessen wird.
 */
function bekannteSaettigung(S: number, w = 256, h = 256): Frame {
  const f = createFrame(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const V = 70 + ((x * 13 + y * 7) % 166);
      const min = V * (1 - S);
      const mid = min + (V - min) * (((x * 5 + y * 3) % 7) / 6);
      const [r, g, b] = [
        [V, mid, min], [mid, V, min], [min, V, mid],
        [min, mid, V], [mid, min, V], [V, min, mid],
      ][(x + y) % 6]!;
      const p = (y * w + x) * 4;
      f.data[p] = r!; f.data[p + 1] = g!; f.data[p + 2] = b!; f.data[p + 3] = 255;
    }
  }
  return f;
}

/**
 * Fotografische Variante: die Basisszene, Chroma um die Luma skaliert.
 *
 * Dieselbe Bildung wie das Paar 09/10 aus `measurementSet()` — dort als
 * Fixture-Paar mit festen Faktoren, hier mit freiem Faktor, damit mehrere
 * Ausgangslagen geprüft werden können.
 */
function szeneChroma(g: number): Frame {
  return chromaScaled(baseScene(400, 500), g);
}

/** Quelle an Ziel angleichen, Stärke 1, und die erreichte Sättigung messen. */
function angleichen(src: Frame, ziel: Frame) {
  const s = analyzeFull(src);
  const t = analyzeFull(ziel);
  const rezept = buildRecipe(s, t, nurSaettigung);
  const out = analyzeFull(applyRecipe(cloneFrame(src), rezept, 1));
  return { s, t, out, faktor: rezept.saturation };
}

describe('§8.3 Sättigung wird gemessen, wie sie konstruiert wurde', () => {
  for (const S of [0.1, 0.2, 0.3, 0.45]) {
    test(`Fläche mit S = ${S.toFixed(2)} misst sich als ${S.toFixed(2)}`, () => {
      expect(analyzeFull(bekannteSaettigung(S)).saturation).toBeCloseTo(S, 3);
    });
  }

  test('eine graue Fläche hat keine Sättigung', () => {
    expect(analyzeFull(bekannteSaettigung(0)).saturation).toBeLessThan(0.001);
  });
});

/**
 * Die Schranken hier sind Sollgrößen, keine Bestandsaufnahme mehr.
 *
 * `saturationFactor` rechnet das Maß aus §8.3 in den Parameter aus §9.5 um:
 * mit a = L/max je Pixel gilt S′/S = f / (a + (1−a)·f), also f = r·a / (1−r+r·a).
 * Vorher stand dort f = r, was eine systematische Unterkorrektur von rund einem
 * Fünftel der geforderten Änderung ergab (Stärke 1; bei 0,7 rund zwei Fünftel).
 * Übrig bleibt, dass ā ein Mittelwert über eine in a nichtlineare Beziehung ist
 * — daher unter einem Prozent statt null.
 *
 * Reißen diese Tests, ist etwas an der Umrechnung kaputt; sie sind nicht als
 * Toleranz für einen bekannten Fehler gedacht. Die gedeckelten Fälle stehen
 * getrennt darunter und haben ihre eigenen Schranken: dort begrenzt §9.5 die
 * Korrektur absichtlich, und dieser Rest ist der Deckel und nicht das Maß.
 */
describe('§9.5 Angleichung trifft das Ziel (Umrechnung nach §8.3)', () => {
  // Paare, in denen der Deckel 0,65…1,55 aus §9.5 nicht bindet — sonst misst
  // der Test den Deckel und nicht die Maß-Verwechslung.
  const paare: [number, number][] = [
    [0.4, 0.3], [0.3, 0.4], [0.2, 0.15], [0.15, 0.2], [0.1, 0.15],
  ];

  for (const [a, b] of paare) {
    describe(`Fläche ${a.toFixed(2)} → ${b.toFixed(2)}`, () => {
      const { s, t, out, faktor } = angleichen(bekannteSaettigung(a), bekannteSaettigung(b));

      test('der Deckel bindet hier nicht', () => {
        const r = (t.saturation / s.saturation);
        expect(Math.min(r, 1 / r)).toBeGreaterThan(0.65);
      });

      test('der Faktor ist der umgerechnete, nicht das Verhältnis', () => {
        // f = r·ā / (1 − r + r·ā); f = r wäre der alte, falsche Wert.
        const r = t.saturation / s.saturation;
        const erwartet = (r * s.satA) / (1 - r + r * s.satA);
        expect(faktor).toBeCloseTo(erwartet, 6);
        expect(Math.abs(faktor - r)).toBeGreaterThan(0.01);
      });

      test('der Restfehler bleibt unter 1 % des Zielwerts', () => {
        // Gemessen: 0,12 / 0,19 / 0,04 / 0,03 / 0,01 %. Vor der Umrechnung
        // waren es 5,4 / 4,7 / 2,6 / 2,4 / 2,4 %.
        expect(Math.abs(out.saturation - t.saturation) / t.saturation).toBeLessThan(0.01);
      });

      test('mindestens 98 % der geforderten Änderung werden erreicht', () => {
        // Gemessen: 99,7…100,8 %. Vor der Umrechnung: 81…93 %.
        const soll = t.saturation - s.saturation;
        const ist = out.saturation - s.saturation;
        expect(ist / soll).toBeGreaterThan(0.98);
        expect(ist / soll).toBeLessThan(1.02);
      });
    });
  }

  for (const [a, b] of [[1.0, 0.75], [0.75, 1.0], [1.3, 1.0], [1.0, 1.3]] as const) {
    describe(`Szene, Chroma ${a} → ${b}`, () => {
      const { s, t, out, faktor } = angleichen(szeneChroma(a), szeneChroma(b));

      test('der Deckel bindet hier nicht', () => {
        const r = t.saturation / s.saturation;
        expect(Math.min(r, 1 / r)).toBeGreaterThan(0.65);
        expect(faktor).toBeLessThan(2);
      });

      test('der Restfehler bleibt unter 1 % des Zielwerts', () => {
        // Gemessen: 0,08 / 0,07 / 0,08 / 0,09 %. Vor der Umrechnung: 4,0…4,6 %.
        // Auf der Szene hängt das ganz an der Gewichtung von ā: ungewichtet
        // blieben 2,9…3,3 % stehen (siehe `saturation` in stats.ts).
        expect(Math.abs(out.saturation - t.saturation) / t.saturation).toBeLessThan(0.01);
      });

      test('im Befundmaß bleiben weniger als 3 % der Abweichung stehen', () => {
        // log2-Verhältnis wie in `deviationValues`. Gemessen: unter 1 %,
        // vorher 18…21 %.
        const soll = Math.log2(s.saturation / t.saturation);
        const rest = Math.log2(out.saturation / t.saturation);
        expect(Math.abs(rest) / Math.abs(soll)).toBeLessThan(0.03);
      });
    });
  }

  test('der Deckel aus §9.5 liegt auf dem Verhältnis, nicht auf dem Faktor', () => {
    // 0,45 → 0,25 verlangt ein Verhältnis von 0,556; §9.5 lässt nur 0,65 zu.
    // Der Rest ist der Deckel und gehört nicht der Umrechnung angelastet.
    const src = bekannteSaettigung(0.45);
    const { out, s, t, faktor } = angleichen(src, bekannteSaettigung(0.25));
    const erwartet = (0.65 * s.satA) / (1 - 0.65 + 0.65 * s.satA);
    expect(faktor).toBeCloseTo(erwartet, 6);
    // Das erreichte Verhältnis ist der Deckel selbst — das ist der Sinn der
    // Verlagerung: die Grenze ist für jedes Bild dieselbe, unabhängig von ā.
    expect(out.saturation / s.saturation).toBeCloseTo(0.65, 2);
    expect(out.saturation / t.saturation).toBeGreaterThan(1.1);
  });

  test('nach oben begrenzt der Gamut-Anschlag den Faktor', () => {
    // Stark gesättigtes Bild, kleines ā: das Verhältnis 1,55 verlangt ein f
    // jenseits von 2, das L + (c−L)·f aus dem Wertebereich trüge.
    const { faktor } = angleichen(bekannteSaettigung(0.45), bekannteSaettigung(0.9));
    expect(faktor).toBeLessThanOrEqual(2);
  });

});

/**
 * Das Paar 09/10 aus `measurementSet()`: dieselbe Szene, nur die Chroma
 * unterscheidet sie. Es steht dort, weil sich an §13 keine reine
 * Sättigungsabweichung findet — Bild 03 trägt die höchste gemessene Sättigung
 * und zugleich einen Blaustich, der genau diese Messung aufbläht.
 */
describe('Fixture-Paar 09/10: reine Sättigungsabweichung', () => {
  const satt = measurementSet().find((m) => m.id === '09')!.frame;
  const flau = measurementSet().find((m) => m.id === '10')!.frame;
  const a = analyzeFull(satt);
  const b = analyzeFull(flau);

  test('die beiden unterscheiden sich nur in der Sättigung', () => {
    // Luminanz, Kontrast und Weißabgleich bleiben stehen; was übrig bleibt,
    // ist die eine Rundung ins Uint8ClampedArray.
    expect(b.p50).toBeCloseTo(a.p50, 0);
    expect(b.contrast).toBeCloseTo(a.contrast, 0);
    expect(Math.abs(b.warmth - a.warmth)).toBeLessThan(0.01);
    expect(Math.abs(b.tint - a.tint)).toBeLessThan(0.01);
    expect(b.saturation).toBeLessThan(a.saturation * 0.7);
  });

  test('die Angleichung trifft in beide Richtungen auf unter 1 %', () => {
    for (const [q, z] of [[satt, flau], [flau, satt]] as const) {
      const { t, out } = angleichen(q, z);
      expect(Math.abs(out.saturation - t.saturation) / t.saturation).toBeLessThan(0.01);
    }
  });
});
