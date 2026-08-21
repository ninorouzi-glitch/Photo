import { describe, expect, test } from 'vitest';
import { testSet } from './fixtures/generate.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { computeTarget } from '../src/core/target.ts';
import { CRITERIA, deviations } from '../src/core/deviation.ts';
import {
  ALL_CLEAR,
  CRITERION_LABEL,
  artikel,
  blurWarning,
  findings,
  formatValue,
  lesson,
  mitArtikel,
} from '../src/core/copy.ts';
import { suggestOrder } from '../src/core/order.ts';

const set = testSet();
const stats = set.map((t) => analyzeFull(t.frame));
const target = computeTarget(stats);
const images = set.map((t, i) => ({ name: t.label, deviations: deviations(stats[i]!, target) }));

describe('F-07 Messwert auf Anforderung', () => {
  test('Vorzeichen, Einheit und Richtung', () => {
    expect(formatValue('exposure', -1.2)).toBe('−1,20 EV dunkler');
    expect(formatValue('warmth', 0.16)).toBe('+0,16 wärmer');
    expect(formatValue('contrast', -0.86)).toBe('−0,86 flacher');
    // Unter der Anzeigeauflösung keine Richtung behaupten
    expect(formatValue('sharpness', -0.0001)).toBe('±0,00');
    expect(formatValue('exposure', 0)).toBe('±0,00 EV');
  });
});

describe('F-08 Klartext-Zusammenfassung', () => {
  const f = findings(images, 'das Set');

  test('benennt die auffälligen Bilder, sortiert nach Schwere', () => {
    expect(f.length).toBeGreaterThan(0);
    for (let i = 1; i < f.length; i++) {
      expect(f[i - 1]!.severity).toBeGreaterThanOrEqual(f[i]!.severity);
    }
  });

  test('„dunkel & kühl" wird als dunkler und kühler benannt', () => {
    const s = f.find((x) => x.index === 2)!.sentence;
    expect(s).toContain('dunkler');
    expect(s).toContain('kühler');
    expect(s).toMatch(/^Bild 3 ist /);
    expect(s).toMatch(/als das Set\.$/);
  });

  test('ein einheitliches Set erzeugt keinen leeren Kasten', () => {
    const same = [0, 0, 0].map(() => ({ name: 'x', deviations: deviations(stats[0]!, stats[0]!) }));
    expect(findings(same, 'das Set')).toHaveLength(0);
    expect(ALL_CLEAR).toContain('bereits einheitlich');
  });
});

describe('F-09 Nicht-reparierbares benennen', () => {
  test('Hinweis erscheint nur bei negativer Schärfe im Ausreißer-Bereich', () => {
    expect(blurWarning(images.map((i) => ({ deviations: i.deviations })))).toBeNull();

    const soft = [{
      deviations: {
        ...images[0]!.deviations,
        sharpness: { value: -1.5, status: 'crit' as const },
      },
    }];
    const w = blurWarning(soft)!;
    expect(w).toContain('nicht');
    expect(w).toContain('aus dem Post nehmen');
  });
});

describe('Bestimmter Artikel je Kriterium', () => {
  // Alle acht einzeln, nicht stichprobenhaft: vier davon standen vor der
  // Einführung des Genus-Felds falsch im Satz („die Weißabgleich"), und ein
  // Fehler hier fällt nur beim Lesen auf, nie beim Rechnen.
  const NOMINATIV: Record<string, string> = {
    aspect: 'das Format',
    exposure: 'die Belichtung',
    warmth: 'der Weißabgleich',
    tint: 'der Grün-Magenta-Stich',
    contrast: 'der Kontrast',
    saturation: 'die Sättigung',
    sharpness: 'die Schärfe',
    noise: 'das Rauschen',
  };

  const AKKUSATIV: Record<string, string> = {
    aspect: 'das Format',
    exposure: 'die Belichtung',
    warmth: 'den Weißabgleich',
    tint: 'den Grün-Magenta-Stich',
    contrast: 'den Kontrast',
    saturation: 'die Sättigung',
    sharpness: 'die Schärfe',
    noise: 'das Rauschen',
  };

  test('Nominativ, alle acht Kriterien', () => {
    for (const c of CRITERIA) expect(mitArtikel(c)).toBe(NOMINATIV[c]);
  });

  test('Akkusativ, alle acht Kriterien', () => {
    for (const c of CRITERIA) expect(mitArtikel(c, 'akk')).toBe(AKKUSATIV[c]);
  });

  test('Nominativ ist die Vorgabe, wenn kein Fall genannt wird', () => {
    for (const c of CRITERIA) expect(mitArtikel(c)).toBe(mitArtikel(c, 'nom'));
  });

  test('der Artikel ist auch einzeln zu haben — Etappe 5 baut eigene Sätze', () => {
    expect(artikel('contrast')).toBe('der');
    expect(artikel('contrast', 'akk')).toBe('den');
    for (const c of CRITERIA) {
      expect(mitArtikel(c, 'akk')).toBe(`${artikel(c, 'akk')} ${CRITERION_LABEL[c]}`);
    }
  });

  test('jedes Kriterium hat ein Genus — kein stilles undefined', () => {
    for (const c of CRITERIA) expect(['der', 'die', 'das']).toContain(artikel(c));
  });
});

describe('F-11 Lernzeile', () => {
  test('nennt ein Kriterium und einen umsetzbaren Hinweis', () => {
    const l = lesson(images.map((i) => i.deviations));
    expect(l.text.length).toBeGreaterThan(60);
    expect(l.text).toContain('streut');
    // Der Artikel kommt aus dem Genus-Feld, nicht aus einem festen „die".
    expect(l.text).toContain(mitArtikel(l.criterion));
  });
});

describe('F-21 Reihenfolge-Vorschlag', () => {
  const items = set.map((t, i) => ({ id: t.id, stats: stats[i]! }));

  test('ist deterministisch', () => {
    expect(suggestOrder(items)).toEqual(suggestOrder(items));
  });

  test('enthält jedes Bild genau einmal', () => {
    const o = suggestOrder(items);
    expect([...o].sort()).toEqual(items.map((i) => i.id).sort());
  });
});
