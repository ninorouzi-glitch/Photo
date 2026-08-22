import { describe, expect, test } from 'vitest';
import type { ColorGrid, Settings, Stats } from '../src/core/types.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import { analyzeFull } from '../src/core/stats.ts';
import { computeTarget, satModels } from '../src/core/target.ts';
import { buildLuts } from '../src/core/lut.ts';
import { farbraumBild, testSet } from './fixtures/generate.ts';

/**
 * Was `satModels()` je Reglerschritt kostet (Schritt 0, zweite Lücke).
 *
 * `derive()` in store.ts rechnet die Modelle bei **jeder** Änderung der
 * Einstellungen neu — sie hängen an den Tabellen und damit an der Stärke. Pro
 * Bild fällt dabei ein `buildLuts` an plus ein Gitterdurchlauf mit 4³
 * Stützstellen je belegter Zelle. Der Preis skaliert also mit der Belegung des
 * Farbgitters, und die §13-Bilder belegen mit 26…150 der 4096 Zellen sehr
 * wenig. Deshalb steht `farbraumBild()` mit 2744 belegten Zellen daneben: die
 * beiden Zahlen spannen auf, worin sich echte Sets bewegen.
 *
 * Hier wird nur gemessen, nicht optimiert. Die 150 ms aus §13 sind das Budget
 * für den ganzen Reglerschritt — Tabellen, Zuschnitt, Pixel, Zeichnen —, nicht
 * für diesen Teil. `BUDGET_ANTEIL` ist entsprechend die Schwelle, ab der
 * `satModels()` allein einen Anteil nähme, der dem Rest nicht mehr bliebe.
 */
const BUDGET_ANTEIL = 60; // ms, für satModels() allein bei 20 Bildern auf der Referenzmaschine

/**
 * Warum die Schranke nicht absolut bleiben kann.
 *
 * Dieselbe Messung ergibt 20 ms auf einem M-Mac und 95 ms in einem
 * Cloud-Container — Faktor fünf, ohne dass sich am Code etwas geändert hätte.
 * Eine feste Zahl prüft dort nicht mehr die Kosten von `satModels()`, sondern
 * die Maschine, auf der die Tests gerade laufen.
 *
 * Deshalb läuft vor der Messung ein kurzer Kalibrierlauf mit derselben Art
 * Arbeit (`buildLuts`, also Kurvenbau plus 3 × 256 Tabelleneinträge), und das
 * Budget wird mit dem Verhältnis zur Referenzmaschine gestreckt. Nur gestreckt:
 * auf einer schnelleren Maschine bleibt es bei den 60 ms, sonst zöge der Test
 * bei jedem Ausschlag der Uhr an.
 *
 * `KALIBRIER_REFERENZ` ist auf der Maschine gemessen, auf der auch die 60 ms
 * entstanden sind. Wer sie neu setzt, muss beide Zahlen zusammen neu messen —
 * einzeln ergeben sie keinen Maßstab.
 */
const KALIBRIER_LAEUFE = 1000;
const KALIBRIER_REFERENZ = 5.8; // ms für KALIBRIER_LAEUFE × buildLuts, Median über 5 Läufe

const cfg: Settings = { ...DEFAULT_SETTINGS, strength: 0.7 };

const belegteZellen = (g: ColorGrid) => {
  let n = 0;
  for (let i = 0; i < g.counts.length; i++) if (g.counts[i]! > 0) n++;
  return n;
};

/**
 * Median über mehrere Läufe nach einem Aufwärmlauf.
 *
 * Median und nicht Minimum: gesucht ist der Preis, den ein Reglerschritt
 * üblicherweise zahlt, nicht der bestmögliche. Der Aufwärmlauf hält die
 * JIT-Kompilierung aus der Messung heraus.
 */
function miss(fn: () => unknown, laeufe = 5): number {
  fn();
  const zeiten: number[] = [];
  for (let i = 0; i < laeufe; i++) {
    const t0 = performance.now();
    fn();
    zeiten.push(performance.now() - t0);
  }
  zeiten.sort((a, b) => a - b);
  return zeiten[zeiten.length >> 1]!;
}

/** Ein Set der gewünschten Länge, aus den vorhandenen Messwerten aufgefüllt.
 *  Für die Laufzeit zählt allein, wie oft und über welche Gitter gerechnet
 *  wird — ob zwei Bilder dieselben Messwerte tragen, ändert daran nichts. */
const auffuellen = (quelle: Stats[], n: number): Stats[] =>
  Array.from({ length: n }, (_, i) => quelle[i % quelle.length]!);

const dreizehn = testSet().map((t) => analyzeFull(t.frame));

/**
 * Wie langsam diese Maschine gegenüber der Referenz ist, als Faktor ≥ 1.
 * Läuft über dieselbe `miss`-Routine wie die eigentliche Messung, damit
 * Aufwärmlauf und Medianbildung für beide Zahlen gleich sind.
 */
function kalibrierFaktor(): number {
  const s = dreizehn[0]!;
  const t = computeTarget(dreizehn);
  const ms = miss(() => {
    for (let i = 0; i < KALIBRIER_LAEUFE; i++) buildLuts(s, t, cfg);
  });
  return Math.max(1, ms / KALIBRIER_REFERENZ);
}
const farbraum = [analyzeFull(farbraumBild())];

const BELEGUNGEN = [
  { name: '§13-Fixtures', stats: dreizehn },
  { name: 'breites Farbgitter', stats: farbraum },
];
const GROESSEN = [5, 10, 20];

describe('Kosten von satModels()', () => {
  test.each(BELEGUNGEN)('$name', ({ name, stats: quelle }) => {
    const zeilen: string[] = [];
    const zellen = quelle.map((s) => belegteZellen(s.colorGrid));
    const spanne =
      Math.min(...zellen) === Math.max(...zellen)
        ? `${zellen[0]}`
        : `${Math.min(...zellen)}…${Math.max(...zellen)}`;

    for (const n of GROESSEN) {
      const stats = auffuellen(quelle, n);
      const target = computeTarget(stats);
      const ms = miss(() => satModels(stats, target, cfg, -1));
      zeilen.push(
        `${name.padEnd(20)} ${String(n).padStart(2)} Bilder  ` +
          `${ms.toFixed(1).padStart(6)} ms  belegte Zellen ${spanne}`,
      );

      // Geprüft wird genau ein Fall: der teuerste. Alles andere wird
      // protokolliert, damit die Zahlen im Repo stehen, aber nicht bewertet —
      // eine Schranke auf einem billigen Fall wäre nur eine Fehlerquelle.
      if (name === 'breites Farbgitter' && n === 20) {
        const faktor = kalibrierFaktor();
        const budget = BUDGET_ANTEIL * faktor;
        zeilen.push(
          `Kalibrierung: Faktor ${faktor.toFixed(2)} gegenüber der Referenz, ` +
            `Budget ${budget.toFixed(0)} ms`,
        );
        expect(
          ms,
          `satModels() für 20 Bilder mit breitem Gitter: ${ms.toFixed(1)} ms ` +
            `bei einem Budget von ${budget.toFixed(0)} ms (Kalibrierfaktor ${faktor.toFixed(2)})`,
        ).toBeLessThanOrEqual(budget);
      }
    }
    console.log('\n' + zeilen.join('\n'));
  });
});
