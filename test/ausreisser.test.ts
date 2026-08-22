import { describe, expect, test } from 'vitest';
import type { Frame, Settings, Stats } from '../src/core/types.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { computeTarget } from '../src/core/target.ts';
import { MIN_SET, robustZ, typA, typB } from '../src/core/outlier.ts';
import { baseScene, farbraumBild, scaleChannels, stripes, testSet } from './fixtures/generate.ts';

/**
 * Ausreißererkennung, Rechenkern (Etappe 5).
 *
 * Der wichtigste Fall steht zuerst und ist der langweiligste: ein Set, in dem
 * nichts aus der Reihe fällt, meldet nichts. Ein z-Score allein leistet das
 * nicht — in einem homogenen Set ist der MAD winzig, und jede Nuance bekommt
 * einen riesigen z-Score. Erst die UND-Bedingung mit den Warnschwellen aus
 * `THRESHOLDS` macht daraus eine brauchbare Meldung.
 */

const messe = (f: Frame) => analyzeFull(f);

/**
 * Fünf Aufnahmen derselben Szene mit den Abweichungen, die zwischen zwei
 * Auslösungen entstehen: ein paar Prozent Belichtung, ein Hauch Farbdrift.
 * Alles weit unter jeder Warnschwelle — und genau deshalb der harte Fall.
 */
function homogenesSet(): Stats[] {
  const base = baseScene();
  const faktoren: [number, number, number][] = [
    [1.0, 1.0, 1.0],
    [1.02, 1.02, 1.02],
    [0.985, 0.985, 0.985],
    [1.01, 1.005, 0.995],
    [0.995, 1.0, 1.008],
  ];
  return faktoren.map(([r, g, b]) => messe(scaleChannels(base, r, g, b)));
}

describe('Typ A — technische Ausreißer', () => {
  test('ein homogenes Set meldet nichts', () => {
    const gefunden = typA(homogenesSet());
    // Bei einem Treffer soll die Meldung sagen, welche Achse durchkam —
    // sonst ist der Fehlschlag nicht zu lesen.
    expect(gefunden.map((a) => `${a.criterion} z=${a.z.toFixed(1)} d=${a.value.toFixed(3)}`))
      .toEqual([]);
  });

  test('vier saubere Bilder plus 03 melden genau dieses eine Bild', () => {
    const set = [...homogenesSet().slice(0, 4), messe(testSet()[2]!.frame)];
    const gefunden = typA(set);

    expect(gefunden).toHaveLength(1);
    expect(gefunden[0]!.index).toBe(4);
    expect(gefunden[0]!.typ).toBe('A');
    // 03 ist um 1,2 EV abgedunkelt und zugleich kühl (R×0,85 / B×1,35) — beide
    // Achsen sind richtig, welche gewinnt, ist eine Frage des MAD im Set.
    expect(['exposure', 'warmth']).toContain(gefunden[0]!.criterion);
    expect(Math.abs(gefunden[0]!.z)).toBeGreaterThan(3.5);
  });

  test('der Klartext nennt keine Zahl und keine EV', () => {
    const set = [...homogenesSet().slice(0, 4), messe(testSet()[2]!.frame)];
    const text = typA(set)[0]!.text;

    expect(text).toMatch(/^Bild 5 ist /);
    expect(text).not.toMatch(/EV/);
    expect(text).not.toMatch(/\d[,.]\d/);
    // Artikel aus dem Helfer von Etappe 2A, nicht fest verdrahtet.
    expect(text).toMatch(/(der Weißabgleich|die Belichtung) fällt hier aus der Reihe/);
  });

  test('MAD = 0 wirft nicht und meldet nichts', () => {
    // Fünfmal exakt dasselbe Bild: jede Achse hat MAD 0 und mittlere absolute
    // Abweichung 0. Kein Ausreißer, keine Division durch Null.
    const eines = messe(baseScene());
    expect(() => typA([eines, eines, eines, eines, eines])).not.toThrow();
    expect(typA([eines, eines, eines, eines, eines])).toEqual([]);
  });

  test('MAD = 0 bei einem abweichenden Bild: die mittlere Abweichung springt ein', () => {
    // Vier gleiche Bilder plus 03: der MAD ist 0, weil die Mehrheit denselben
    // Wert trägt. Ohne Ersatzmaß wäre hier stillschweigend nichts zu melden.
    const gleich = messe(baseScene());
    const set = [gleich, gleich, gleich, gleich, messe(testSet()[2]!.frame)];
    const gefunden = typA(set);

    expect(gefunden).toHaveLength(1);
    expect(gefunden[0]!.index).toBe(4);
  });

  test('unter vier Bildern wird Typ A nicht ausgewertet', () => {
    const set = [...homogenesSet().slice(0, 2), messe(testSet()[2]!.frame)];
    expect(set).toHaveLength(MIN_SET - 1);
    expect(typA(set)).toEqual([]);
  });

  test('die Ankerwahl ändert am Ergebnis nichts', () => {
    // `typA` sieht `computeTarget` nicht und bildet seinen Median selbst. Der
    // Zielwert ist bei Ankerwahl das Messergebnis eines einzelnen Bildes und
    // damit kein Lagemaß der Messmenge — hinge die Erkennung daran, machte ein
    // Ankerbild am Rand des Sets das halbe Set zu Ausreißern.
    const set = [...homogenesSet().slice(0, 4), messe(testSet()[2]!.frame)];

    const median = computeTarget(set);
    const ankerAussen = computeTarget(set, set[4]);
    expect(ankerAussen.p50).not.toBeCloseTo(median.p50, 1);

    expect(typA(set)).toEqual(typA(set));
    expect(typA(set).map((a) => [a.index, a.criterion])).toEqual([[4, expect.anything()]]);
  });
});

describe('robustZ', () => {
  test('MAD > 0: der z-Score misst gegen den frischen Median', () => {
    const { z, median } = robustZ([10, 11, 9, 10, 20]);
    expect(median).toBe(10);
    expect(z[0]).toBe(0);
    expect(z[4]).toBeGreaterThan(3.5);
  });

  test('alle Werte gleich: lauter Nullen', () => {
    expect(robustZ([3, 3, 3, 3]).z).toEqual([0, 0, 0, 0]);
  });
});

/**
 * Typ B misst am **korrigierten** Bild: der Vertreter jeder belegten Zelle
 * geht durch dieselben Tabellen wie das Bild, danach wird neu einsortiert und
 * gegen das binweise Median-Histogramm des Sets gemessen. Ein eigener
 * Normalisierungsschritt für Belichtung und Weißabgleich entfällt deshalb —
 * die Korrektur selbst ist die Normalisierung.
 */
describe('Typ B — farbliche Ausreißer', () => {
  const cfg = (strength: number): Settings => ({ ...DEFAULT_SETTINGS, strength });
  const B = (set: Stats[], strength = 0.7) => typB(set, computeTarget(set), cfg(strength));

  test('ein homogenes Set meldet nichts', () => {
    const set = homogenesSet();
    expect(B(set, 0.7).map((a) => `${a.index} z=${a.z.toFixed(1)} d=${a.value.toFixed(3)}`))
      .toEqual([]);
    expect(B(set, 1).map((a) => a.index)).toEqual([]);
  });

  test('ein Bild aus einer anderen Farbwelt wird gemeldet', () => {
    // `stripes()` stammt aus `measurementSet()` und ist hier genau richtig: ein
    // hartes Rot-Blau-Muster ist kein Bild desselben Posts — das ist der Fall,
    // den Typ B erkennen soll. (In die Zielwertbildung einer Abnahme gehört es
    // weiterhin nicht, siehe `measurementSet()`.)
    const set = [...homogenesSet().slice(0, 4), analyzeFull(stripes())];
    const gefunden = B(set);

    expect(gefunden).toHaveLength(1);
    expect(gefunden[0]!.index).toBe(4);
    expect(gefunden[0]!.typ).toBe('B');
    expect(gefunden[0]!.criterion).toBeNull();
  });

  test('der Klartext rät zum Tauschen und nennt keine Zahl', () => {
    const set = [...homogenesSet().slice(0, 4), analyzeFull(stripes())];
    const text = B(set)[0]!.text;

    expect(text).toMatch(/^Bild 5 passt farblich nicht/);
    expect(text).toMatch(/tauschen/);
    expect(text).not.toMatch(/\d[,.]\d/);
  });

  test('unter vier Bildern wird Typ B nicht ausgewertet', () => {
    const set = [...homogenesSet().slice(0, 2), analyzeFull(stripes())];
    expect(set).toHaveLength(MIN_SET - 1);
    expect(B(set)).toEqual([]);
  });

  test('20 Bilder mit breit belegtem Gitter bleiben weit unter 30 ms', () => {
    // Der Preis hängt an der Zahl der belegten Zellen; `farbraumBild()` belegt
    // 2744 der 4096 und ist damit die teure Seite (§13 belegt 26…164).
    const eines = analyzeFull(farbraumBild());
    const set = Array.from({ length: 20 }, () => eines);
    B(set);

    const zeiten: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      B(set);
      zeiten.push(performance.now() - t0);
    }
    zeiten.sort((a, b) => a - b);
    expect(zeiten[2]!).toBeLessThan(30);
  });
});
