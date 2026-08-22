import { describe, expect, test } from 'vitest';
import type { Frame, Stats } from '../src/core/types.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { computeTarget } from '../src/core/target.ts';
import { THRESHOLDS } from '../src/core/deviation.ts';
import { MIN_SET, robustZ, typA } from '../src/core/outlier.ts';
import { addNoise, baseScene, scaleChannels, testSet } from './fixtures/generate.ts';

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

  test('ein Satz, der sich nur im Rauschen unterscheidet, meldet nichts auf noise', () => {
    // Rauschen allein ist kein Ausreißer: σ 0…13 spreizt die `noise`-Achse
    // zwar, aber der MAD eines so kleinen Sets ist winzig und der z-Score
    // entsprechend groß. Was hier prüft, ist die UND-Bedingung — gemeldet
    // werden darf auf dieser Achse nur, was auch die warn-Schwelle reißt.
    const base = baseScene();
    const set = [0, 4, 7, 10, 13].map((sigma, i) =>
      analyzeFull(sigma === 0 ? base : addNoise(base, sigma, 7 + i)),
    );
    const unterSchwelle = typA(set)
      .filter((a) => a.criterion === 'noise' && Math.abs(a.value) < THRESHOLDS.noise.warn)
      .map((a) => `${a.index} d=${a.value.toFixed(3)}`);
    expect(unterSchwelle).toEqual([]);
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
