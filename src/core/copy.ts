import type { Criterion, Deviations, Status } from './types.ts';
import { CRITERIA, THRESHOLDS, widestSpread } from './deviation.ts';

export const CRITERION_LABEL: Record<Criterion, string> = {
  aspect: 'Format',
  exposure: 'Belichtung',
  warmth: 'Weißabgleich',
  contrast: 'Kontrast',
  saturation: 'Sättigung',
  sharpness: 'Schärfe',
  noise: 'Rauschen',
};

/** Richtungswörter: [Wert > 0, Wert < 0]. */
const DIRECTION: Record<Criterion, [string, string]> = {
  aspect: ['breiter', 'höher'],
  exposure: ['heller', 'dunkler'],
  warmth: ['wärmer', 'kühler'],
  contrast: ['kräftiger', 'flacher'],
  saturation: ['farbiger', 'blasser'],
  sharpness: ['schärfer', 'weicher'],
  noise: ['rauschiger', 'sauberer'],
};

const num = (v: number, digits = 2) =>
  v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Vorzeichen als typografisches Minus, nicht als Bindestrich. */
const signed = (v: number, digits = 2) => (v >= 0 ? '+' : '−') + num(Math.abs(v), digits);

/**
 * F-07: Zahlenwert mit Vorzeichen und Einheit, wie er an der Zelle erscheint.
 * P3 verlangt, dass die Zahl da ist, wenn man sie sucht — aber erst dann.
 */
export function formatValue(c: Criterion, v: number): string {
  // Unter der angezeigten Auflösung gibt es keine Richtung mehr: „−0,00 weicher"
  // behauptet einen Unterschied, den die Zahl daneben schon verneint.
  if (Math.abs(v) < 0.005) return c === 'exposure' ? '±0,00 EV' : '±0,00';
  const dir = ' ' + DIRECTION[c][v > 0 ? 0 : 1];
  if (c === 'exposure') return `${signed(v)} EV${dir}`;
  return `${signed(v)}${dir}`;
}

const ADVERB: Record<Status, string> = { ok: 'leicht', warn: 'etwas', crit: 'deutlich' };

function phrase(c: Criterion, v: number, status: Status): string {
  const dir = DIRECTION[c][v > 0 ? 0 : 1];
  if (c === 'exposure') return `${num(Math.abs(v), 1)} EV ${dir}`;
  return `${ADVERB[status]} ${dir}`;
}

export type Finding = { index: number; name: string; sentence: string; severity: number };

/**
 * F-08: pro auffälligem Bild ein Satz, sortiert nach Schwere.
 * Beispiel: „Bild 3 ist 1,2 EV dunkler, deutlich kühler und deutlich flacher
 * als das Set."
 */
export function findings(
  images: { name: string; deviations: Deviations }[],
  reference: string,
): Finding[] {
  const out: Finding[] = [];
  images.forEach((img, i) => {
    const notable = CRITERIA.filter((c) => img.deviations[c].status !== 'ok')
      .sort((a, b) => severity(b, img.deviations[b]) - severity(a, img.deviations[a]));
    if (notable.length === 0) return;

    const parts = notable.map((c) => phrase(c, img.deviations[c].value, img.deviations[c].status));
    out.push({
      index: i,
      name: img.name,
      sentence: `Bild ${i + 1} ist ${join(parts)} als ${reference}.`,
      severity: Math.max(...notable.map((c) => severity(c, img.deviations[c]))),
    });
  });
  return out.sort((a, b) => b.severity - a.severity);
}

/**
 * Abweichung in Vielfachen der Warnschwelle.
 *
 * Der rohe Betrag taugt hier nicht: Rauschen wird in Einheiten um 8 gemessen,
 * Weißabgleich in Einheiten um 0,6. Nach Betrag sortiert stünde jede
 * Rauschabweichung vor jedem Farbstich, egal wie deutlich der ist. Erst die
 * Normierung auf die Schwelle macht die sieben Kriterien vergleichbar.
 */
function severity(c: Criterion, d: { value: number }): number {
  return Math.abs(d.value) / THRESHOLDS[c].warn;
}

function join(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  return parts.slice(0, -1).join(', ') + ' und ' + parts[parts.length - 1];
}

/** F-08: ein Set ohne Auffälligkeiten bekommt einen Satz, keinen leeren Kasten. */
export const ALL_CLEAR =
  'Das Set ist bereits einheitlich — kein Bild fällt bei einem der sieben Kriterien aus der Reihe.';

/**
 * F-09: P4 verlangt, Grenzen zu benennen statt sie zu überspielen. Unschärfe
 * lässt sich nicht zurückholen; der ehrliche Vorschlag ist, das Bild aus dem
 * Post zu nehmen.
 */
export function blurWarning(images: { deviations: Deviations }[]): string | null {
  const soft = images
    .map((img, i) => ({ i, d: img.deviations.sharpness }))
    .filter(({ d }) => d.status === 'crit' && d.value < 0);
  if (soft.length === 0) return null;

  const names = soft.map(({ i }) => `Bild ${i + 1}`);
  const subject = names.length === 1 ? `${names[0]} ist` : `${join(names)} sind`;
  return (
    `${subject} deutlich weicher als das Set. Unschärfe lässt sich nicht ` +
    `zurückholen — Nachschärfen macht daraus nur harte Kanten um weiche Details. ` +
    `Besser ${names.length === 1 ? 'dieses Bild' : 'diese Bilder'} aus dem Post nehmen.`
  );
}

const LESSON: Record<Criterion, string> = {
  aspect: 'Schneide schon beim Fotografieren auf ein Format zu, oder lass genug Rand für den späteren Beschnitt — dann bestimmt nicht der Zuschnitt, was im Bild bleibt.',
  exposure: 'Belichte die Bilder einer Serie gleich: fester Blendenwert und feste Belichtungszeit statt Automatik, oder gleiche die Belichtung in Affinity vor dem Export an.',
  warmth: 'Stell den Weißabgleich fest ein statt auf Automatik. Die Automatik reagiert auf jede Farbfläche im Bild und driftet dadurch von Aufnahme zu Aufnahme.',
  contrast: 'Zieh die Tonwertkurve nicht bei jedem Bild neu nach Gefühl. Leg sie einmal fest und wende sie auf die ganze Serie an.',
  saturation: 'Sättigung addiert sich schnell auf. Prüf die Bilder einer Serie nebeneinander statt einzeln — allein sieht kräftiger fast immer besser aus.',
  sharpness: 'Achte auf gleichmäßige Schärfe: dieselbe Blende, derselbe Fokuspunkt, und schärfe beim Export für alle Bilder gleich stark.',
  noise: 'Halte den ISO-Wert über die Serie konstant. Ein einzelnes rauschfreies Bild zwischen rauschigen fällt genauso auf wie umgekehrt.',
};

/**
 * F-11: das Kriterium mit der größten relativen Streuung, mit einem Hinweis
 * für Aufnahme oder Bearbeitung.
 *
 * Das ist die Zeile, an der Erfolgskriterium 4 hängt (§14): eine App, die
 * einen Anfänger dauerhaft von sich abhängig macht, hat versagt.
 */
export function lesson(all: Deviations[]): { criterion: Criterion; text: string } {
  const { criterion, spread } = widestSpread(all);
  const factor = spread / THRESHOLDS[criterion].warn;
  const lead =
    factor < 1
      ? `Am weitesten streut in diesem Set die ${CRITERION_LABEL[criterion]} — noch im grünen Bereich.`
      : `Am weitesten streut in diesem Set die ${CRITERION_LABEL[criterion]} (Spanne ${num(spread)}).`;
  return { criterion, text: `${lead} ${LESSON[criterion]}` };
}
