import { describe, expect, test } from 'vitest';
import { analyzeFull } from '../src/core/stats.ts';
import { deviations } from '../src/core/deviation.ts';
import { CRITERION_LABEL, findings, formatValue } from '../src/core/copy.ts';
import { baseScene, scaleChannels } from './fixtures/generate.ts';

/**
 * Die tint-Achse (§8.3 misst sie, §9.3 korrigiert sie) hatte bis hierher keine
 * Schwelle und keine Anzeige: ein Set mit einem Grün- oder Magentastich meldete
 * nichts. Geprüft wird deshalb genau das — dass die Achse anschlägt, in die
 * richtige Richtung zeigt und den Weißabgleich dabei nicht mitreißt.
 */
describe('Grün-Magenta-Stich wird bewertet', () => {
  const base = baseScene();
  const ref = analyzeFull(base);
  const dev = (kr: number, kg: number, kb: number) =>
    deviations(analyzeFull(scaleChannels(base, kr, kg, kb)), ref);

  test('dasselbe Bild weicht auf keiner der beiden Farbachsen ab', () => {
    const d = dev(1, 1, 1);
    expect(d.tint.value).toBeCloseTo(0, 3);
    expect(d.tint.status).toBe('ok');
  });

  test('Grün angehoben: positiver Wert, jenseits der Warnschwelle', () => {
    const d = dev(1, 1.06, 1);
    expect(d.tint.value).toBeGreaterThan(0);
    expect(d.tint.value).toBeCloseTo(Math.log2(1.06), 2);
    expect(d.tint.status).not.toBe('ok');
  });

  test('Grün abgesenkt: negativer Wert, deutlicher Ausreißer', () => {
    const d = dev(1, 0.9, 1);
    expect(d.tint.value).toBeLessThan(0);
    expect(d.tint.status).toBe('crit');
  });

  /**
   * warmth und tint stehen im Log-Raum senkrecht aufeinander: warmth misst
   * log(R)−log(B), tint log(G) − (log(R)+log(B))/2. Eine Verschiebung, die R
   * genauso weit hoch wie B hinunter zieht, darf deshalb nur die eine Achse
   * bewegen — sonst meldete jeder warme Ton nebenbei einen Farbstich.
   */
  test('eine reine Warm-Kalt-Verschiebung lässt die tint-Achse in Ruhe', () => {
    const d = dev(1.2, 1, 1 / 1.2);
    expect(d.warmth.value).toBeCloseTo(Math.log2(1.2 * 1.2), 2);
    expect(Math.abs(d.tint.value)).toBeLessThan(0.02);
    expect(d.tint.status).toBe('ok');
  });

  test('die Achse erscheint mit deutscher Beschriftung im Klartext', () => {
    expect(CRITERION_LABEL.tint).toBe('Grün-Magenta-Stich');
    expect(formatValue('tint', 0.14)).toBe('+0,14 grünstichiger');
    expect(formatValue('tint', -0.14)).toBe('−0,14 magentastichiger');

    const satz = findings([{ name: 'x', deviations: dev(1, 0.9, 1) }], 'das Set')[0]!.sentence;
    expect(satz).toContain('magentastichiger');
  });
});
