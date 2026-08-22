import { describe, expect, test } from 'vitest';
import { baseScene, monochromSet, testSet, toGray } from './fixtures/generate.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { computeTarget, satModels } from '../src/core/target.ts';
import { applyRecipe, buildRecipe } from '../src/core/apply.ts';
import { deviations } from '../src/core/deviation.ts';
import { cloneFrame, createFrame } from '../src/core/frame.ts';
import { DEFAULT_SETTINGS, type Frame, type Settings } from '../src/core/types.ts';

/**
 * Bestandsaufnahme vor Etappe 9: was die Angleichung heute mit monochromen
 * Bildern macht.
 *
 * Die Schranken hier sind ausdrücklich **keine Sollgrößen**. Sie halten den
 * gemessenen Schaden fest, damit er beziffert ist, bevor jemand ihn repariert
 * — und damit die Reparatur an denselben Zahlen nachweisbar wird. Wer Etappe 9
 * baut, dreht diese Erwartungen um; reißen sie vorher, hat sich unbemerkt
 * etwas am Rechenweg geändert.
 *
 * Gemessen am Produktivpfad (mit `SatModel`, wie `derive()` in store.ts),
 * Stärke 0,7 und 1,0. Die Zahlen stehen bei den einzelnen Tests.
 */

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over, fixes: { ...DEFAULT_SETTINGS.fixes, ...over.fixes } };
}

/**
 * Chroma-Spur, wie sie ein echtes Schwarzweißbild trägt.
 *
 * Ein synthetisch entsättigtes Bild misst exakt 0,000 und läuft damit in die
 * Nullschutz-Abfragen von `saturationFactor` (`von <= 0.001`). Aus einer
 * JPEG- oder Scanquelle kommt Schwarzweiß nie exakt neutral an: gemessen
 * 0,000 / 0,023 / 0,030 (`MESSUNG-ausreisser.md`, Befund 3). Genau dieser
 * Bereich rutscht am Nullschutz vorbei — deshalb steht er hier neben dem
 * exakten Fall, sonst misst die Bestandsaufnahme den geschützten Sonderfall
 * statt des Regelfalls.
 *
 * Gegenläufig auf R und B, mit festem Startwert: der Weißabgleich bleibt bei
 * warmth ≈ tint ≈ 0, allein die Sättigung steigt.
 */
function mitSpur(src: Frame, amplitude: number): Frame {
  const f = createFrame(src.width, src.height);
  let s = 987654321 >>> 0;
  for (let p = 0; p < src.data.length; p += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = (s / 4294967296 - 0.5) * 2 * amplitude;
    f.data[p] = src.data[p]! + n;
    f.data[p + 1] = src.data[p + 1]!;
    f.data[p + 2] = src.data[p + 2]! - n;
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

/** Der Produktivpfad: Ziel, wirksame Sättigungsgrößen, Rezept, Pixel. */
function angleichen(frames: { id: string; frame: Frame }[], cfg: Settings) {
  const stats = frames.map((m) => analyzeFull(m.frame));
  const ziel = computeTarget(stats);
  const modelle = satModels(stats, ziel, cfg, -1);
  return frames.map((m, i) => {
    const rezept = buildRecipe(stats[i]!, ziel, cfg, modelle[i]!);
    const out = applyRecipe(cloneFrame(m.frame), rezept, i + 1);
    return {
      id: m.id,
      vor: stats[i]!,
      nach: analyzeFull(out),
      dev: deviations(stats[i]!, ziel),
      faktor: rezept.saturation,
      abstand: maxAbstand(out),
    };
  });
}

/** Größte Kanalabweichung im Bild — 0 heißt exakt neutral. */
function maxAbstand(f: Frame): number {
  let max = 0;
  for (let p = 0; p < f.data.length; p += 4) {
    const r = f.data[p]!, g = f.data[p + 1]!, b = f.data[p + 2]!;
    const d1 = Math.abs(r - g), d2 = Math.abs(g - b);
    if (d1 > max) max = d1;
    if (d2 > max) max = d2;
  }
  return max;
}

type Zeile = ReturnType<typeof angleichen>[number];

function tabelle(zeilen: Zeile[]): void {
  for (const e of zeilen) {
    console.log(
      [
        e.id.padEnd(4),
        `sat ${e.vor.saturation.toFixed(3)} → ${e.nach.saturation.toFixed(3)}`,
        `warmth ${e.vor.warmth.toFixed(3)} → ${e.nach.warmth.toFixed(3)}`,
        `f ${e.faktor.toFixed(3)}`,
        `Δkanal ${e.abstand}`,
        `Befund Sättigung ${e.dev.saturation.value.toFixed(2)} ${e.dev.saturation.status}`,
      ].join('  '),
    );
  }
}

const satz = monochromSet();
const grau = toGray(baseScene());
const spur = mitSpur(grau, 4);
const farbsatz = testSet().map((t) => ({ id: t.id, frame: t.frame }));

describe('Das Fixture selbst', () => {
  const stats = satz.map((m) => analyzeFull(m.frame));

  test('die drei Graufassungen sind exakt neutral und messen 0,000', () => {
    for (let i = 0; i < 3; i++) {
      expect(maxAbstand(satz[i]!.frame)).toBe(0);
      expect(stats[i]!.saturation).toBe(0);
      expect(stats[i]!.warmth).toBe(0);
      expect(stats[i]!.tint).toBe(0);
    }
  });

  test('das vierte Bild ist farbig und unterscheidet sich um eine Größenordnung', () => {
    // Gemessen: 0,124. Weniger als das echte Material (ab 0,32), weil die
    // Basisszene überwiegend Graustufenverlauf ist — für die Trennung von der
    // Schwarzweißseite ist das der ungünstigere und damit richtige Fall.
    expect(stats[3]!.saturation).toBeCloseTo(0.124, 3);
  });

  test('die Chroma-Spur liegt im Band echter Schwarzweißbilder', () => {
    // 0,000…0,030 nach MESSUNG-ausreisser.md, Befund 3. Gemessen: 0,026.
    const s = analyzeFull(spur).saturation;
    expect(s).toBeGreaterThan(0.02);
    expect(s).toBeLessThanOrEqual(0.03);
    expect(Math.abs(analyzeFull(spur).warmth)).toBeLessThan(0.005);
  });
});

for (const strength of [0.7, 1]) {
  describe(`Bestandsaufnahme, Stärke ${strength}`, () => {
    const cfg = settings({ strength });

    describe('monochromer Satz mit einem Farbbild', () => {
      const ergebnis = angleichen(satz, cfg);
      const M4 = ergebnis[3]!;

      test('Tabelle', () => {
        tabelle(ergebnis);
        expect(ergebnis).toHaveLength(4);
      });

      test('die Graubilder bleiben neutral — aber nur, weil sie exakt 0 messen', () => {
        // Zielsättigung ist der Median über den ganzen Satz und damit 0; die
        // Nullschutz-Abfrage `ziel <= 0.001` in `saturationFactor` hält den
        // Faktor auf 1. Ein Satz aus echten Schwarzweißbildern (0,023 / 0,030)
        // käme dort nicht durch — siehe den Farbsatz unten.
        for (let i = 0; i < 3; i++) {
          expect(ergebnis[i]!.abstand).toBe(0);
          expect(ergebnis[i]!.faktor).toBe(1);
        }
      });

      test('das Farbbild behält seine Sättigung — aus demselben Grund', () => {
        // 0,124 → 0,124, Abweichung 0,5 % (Stärke 0,7) und 0,8 % (1,0); was
        // bleibt, ist die Tonwertkurve, die auch ohne Sättigungsfaktor an der
        // Sättigung rührt. Am echten Material, wo die Zielsättigung 0,026
        // statt 0,000 ist, sind es 0,389 → 0,269: 31 % Entsättigung.
        const rel = Math.abs(M4.nach.saturation - M4.vor.saturation) / M4.vor.saturation;
        expect(rel).toBeLessThan(0.02);
        expect(M4.faktor).toBe(1);
      });

      test('SCHADEN: die Befundmatrix meldet für das Farbbild Unsinn', () => {
        // `ratio(s.saturation, 0, 0.004)` = log2(0,124/0,004) = +4,95 gegen
        // eine crit-Schwelle von 0,40. Der Wert misst nicht die Abweichung des
        // Bildes, sondern den Abstand zum Klemmwert 0,004 — er ist der
        // eigentliche log2(s/0)-Fall im Baum, nur durch den Boden endlich
        // gemacht statt unendlich.
        expect(M4.dev.saturation.value).toBeCloseTo(4.95, 2);
        expect(M4.dev.saturation.status).toBe('crit');
      });
    });

    describe('Schwarzweißbild im §13-Farbsatz', () => {
      const ergebnis = angleichen([...farbsatz, { id: 'sw', frame: grau }, { id: 'swS', frame: spur }], cfg);
      const sw = ergebnis.find((e) => e.id === 'sw')!;
      const swS = ergebnis.find((e) => e.id === 'swS')!;

      test('Tabelle', () => {
        tabelle([sw, swS]);
        expect(ergebnis).toHaveLength(7);
      });

      test('SCHADEN: das Bild mit Chroma-Spur bekommt einen Sättigungsfaktor über 1,5', () => {
        // Gemessen: 1,571 — dasselbe Bild wie am echten Material (1,557).
        expect(swS.faktor).toBeGreaterThan(1.5);
      });

      test('SCHADEN: seine Sättigung steigt, statt zu bleiben', () => {
        // 0,026 → 0,041 bei beiden Stärken. Verstärkt wird dabei kein Motiv,
        // sondern die Chroma-Spur und der frisch aufgelegte Kanalversatz.
        expect(swS.nach.saturation).toBeGreaterThan(swS.vor.saturation * 1.5);
      });

      test('SCHADEN: der Kanalversatz wächst auf zweistellige Codewerte', () => {
        // Δkanal 15 bei Stärke 0,7 und 19 bei 1,0 — ein Bild, das mit
        // |r−g| = |g−b| ≤ 8 hereinkam, geht mit dem Doppelten hinaus.
        expect(swS.abstand).toBeGreaterThanOrEqual(15);
        expect(swS.abstand).toBeGreaterThan(maxAbstand(spur));
      });

      test('SCHADEN: die Befundmatrix meldet für das exakt neutrale Bild Unsinn', () => {
        // log2(0,004/0,124) = −4,95, wieder gegen den Klemmwert statt gegen
        // eine Messung. Für das Bild mit Spur sind es −2,24 — ebenfalls crit.
        expect(sw.dev.saturation.value).toBeCloseTo(-4.95, 2);
        expect(sw.dev.saturation.status).toBe('crit');
        expect(swS.dev.saturation.status).toBe('crit');
      });

      test('das exakt neutrale Bild bleibt nur wegen der Nullschutz-Abfrage heil', () => {
        // `von <= 0.001` fängt genau die synthetische Null. Übrig bleibt der
        // Kanalversatz aus den Kanalfaktoren: Δkanal 1 statt 0 — klein, aber
        // schon hier legt der Weißabgleich Farbe auf ein Bild ohne Farbe.
        expect(sw.faktor).toBe(1);
        expect(sw.abstand).toBe(1);
      });
    });
  });
}

/**
 * Die Zahl, an der die schwellwertbasierte Erkennung hängt.
 *
 * §13-Bild 04 „flau" ist ein farbiges Bild — `flatten(base, 0.55, 0.45)`, also
 * die Basisszene mit 45 % Chroma — und misst 0,0297. Echtes Schwarzweiß misst
 * 0,000…0,030 (MESSUNG-ausreisser.md, Befund 3). Die beiden Bänder stoßen
 * aneinander: eine Schwelle auf `Stats.saturation`, die echtes Schwarzweiß
 * vollständig erfasst, erklärt Bild 04 zum Schwarzweißbild und verschiebt
 * damit den §13-Satz.
 *
 * Dieser Test ist die Wache davor. Reißt er, weil sich 04 verschoben hat, ist
 * die Grundlage jeder gewählten Schwelle neu zu prüfen.
 */
test('§13-Bild 04 liegt im Sättigungsband echter Schwarzweißbilder', () => {
  const s04 = analyzeFull(testSet()[3]!.frame).saturation;
  expect(s04).toBeCloseTo(0.0297, 4);
  expect(s04).toBeLessThan(0.03);
});
