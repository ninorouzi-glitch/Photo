import { describe, expect, test } from 'vitest';
import { createFrame } from '../src/core/frame.ts';
import { applyRecipe, type Recipe } from '../src/core/apply.ts';
import { identityLuts, type Luts } from '../src/core/lut.ts';

/** Ein Rezept, das nur die Tabelle anwendet — Sättigung, Korn und Schärfe aus. */
function tableOnly(fill: (i: number) => number): Recipe {
  const luts = identityLuts();
  for (const l of luts) for (let i = 0; i < 256; i++) l[i] = fill(i);
  return { luts, saturation: 1, grainSigma: 0, sharpenAmount: 0, neutral: false };
}

function fillLevel(width: number, height: number, level: number) {
  const f = createFrame(width, height);
  for (let p = 0; p < f.data.length; p += 4) {
    f.data[p] = level; f.data[p + 1] = level; f.data[p + 2] = level; f.data[p + 3] = 255;
  }
  return f;
}

/** Ein Verlauf über die Breite: Spalte x hat genau den Tonwert x. */
function gradient(height: number) {
  const f = createFrame(256, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 256; x++) {
      const p = (y * 256 + x) * 4;
      f.data[p] = x; f.data[p + 1] = x; f.data[p + 2] = x; f.data[p + 3] = 255;
    }
  }
  return f;
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

function columnMeans(f: { data: Uint8ClampedArray; width: number; height: number }): number[] {
  const out: number[] = [];
  for (let x = 0; x < f.width; x++) {
    const col: number[] = [];
    for (let y = 0; y < f.height; y++) col.push(f.data[(y * f.width + x) * 4]!);
    out.push(mean(col));
  }
  return out;
}

describe('Tonwerte überstehen die Korrektur ohne Abrisse', () => {
  test('ein Zwischenwert bleibt im Mittel erhalten, statt weggerundet zu werden', () => {
    // Die Tabelle bildet alles auf 100,5 ab — auf halbem Weg zwischen zwei
    // Tonstufen. Einfaches Runden macht daraus eine glatte 100 und wirft den
    // halben Tonwert weg; über die Fläche verteilt bleibt er erhalten.
    const f = fillLevel(64, 64, 40);
    applyRecipe(f, tableOnly(() => 100.5));
    expect(mean([...f.data].filter((_, i) => i % 4 === 0))).toBeCloseTo(100.5, 1);
  });

  test('ein gestauchter Verlauf behält alle 256 Stufen, statt auf 141 zu verschmelzen', () => {
    // Faktor 0,55: 256 Eingangsstufen drängen sich auf 141 Ausgangsstufen.
    // Genau da entstehen die Streifen im Himmel — mehrere Eingangsstufen
    // landen auf derselben Ausgangsstufe und die Kante dazwischen wird sichtbar.
    const curve = (i: number) => 60 + i * 0.55;
    const naive = new Set([...Array(256).keys()].map((i) => Math.round(curve(i))));
    expect(naive.size).toBeLessThan(150);

    const f = gradient(64);
    applyRecipe(f, tableOnly(curve));
    const cols = columnMeans(f);

    // Jede Eingangsstufe ist im Flächenmittel noch von ihren Nachbarn zu
    // unterscheiden — der Verlauf ist wieder ein Verlauf.
    expect(new Set(cols.map((v) => v.toFixed(3))).size).toBe(256);
    for (let x = 1; x < 256; x++) expect(cols[x]!).toBeGreaterThan(cols[x - 1]!);
  });

  test('F-21: zweimal dasselbe Bild ergibt zweimal dieselben Pixel', () => {
    const recipe = tableOnly((i) => 60 + i * 0.55);
    const a = gradient(16);
    const b = gradient(16);
    applyRecipe(a, recipe);
    applyRecipe(b, recipe);
    expect([...a.data]).toEqual([...b.data]);
  });

  test('A-03: ein neutrales Rezept fasst kein einziges Pixel an', () => {
    const f = gradient(16);
    const before = new Uint8ClampedArray(f.data);
    applyRecipe(f, { ...tableOnly((i) => i), neutral: true });
    expect([...f.data]).toEqual([...before]);
  });
});

describe('Die Tabelle rundet nicht vor der Zeit', () => {
  test('sie hält Fließkommawerte, nicht schon Bytes', () => {
    const luts: Luts = identityLuts();
    luts[0][7] = 12.25;
    expect(luts[0][7]).toBeCloseTo(12.25, 5);
  });
});
