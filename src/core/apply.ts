import type { Frame, Settings, Stats } from './types.ts';
import { luminance } from './frame.ts';
import { buildLuts, isIdentity, type Luts } from './lut.ts';

export type Recipe = {
  luts: Luts;
  saturation: number; // Faktor, 1 = unverändert
  grainSigma: number; // 0 = kein Korn
  sharpenAmount: number; // 0 = keine Schärfung
  neutral: boolean; // true = keine einzige Pixeloperation nötig
};

/**
 * Technischer Anschlag auf f — Gamut-Schutz, **nicht** der Deckel aus §9.5.
 *
 * L + (c−L)·f schiebt die Kanäle von der Luminanz weg und läuft nach oben aus
 * 0…255 heraus; nach unten kann das nicht passieren, deshalb nur eine Grenze.
 * Ohne Anschlag wächst f für stark gesättigte Bilder über jede Schranke: schon
 * bei ā = 0,5 verlangt das Verhältnis 1,55 ein f von 3,44, bei ā = 0,4 eines
 * von 8,86.
 *
 * Gemessen auf Flächen mit heller, gesättigter Farbe (max bis 235): bei f = 2,0
 * verlassen 2,4…5,9 % der Kanäle den Bereich (bis zu 78 Codewerte darüber), bei
 * 2,5 sind es 4,5…13,5 %, bei 3,0 dann 6,9…29,4 %. 2,0 deckt jedes Bild mit
 * ā ≥ 0,70 verlustfrei ab und schneidet erst darunter. Fotografisches Material
 * innerhalb 20…200 wandert bei 2,0 überhaupt nicht aus.
 *
 * Das ist eine grobe Grenze, weil sie den Bildinhalt nicht kennt. Die saubere
 * Behandlung ist der Clipping-Guard aus Etappe 4, der pro Bild abschätzt, wie
 * viel eine geplante Operation in die Schienen drückt — dort gehört dieser
 * Anschlag hineingeführt und dann ersetzt.
 */
const MAX_SAT_FACTOR = 2.0;

/**
 * §9.5 Sättigung: Verhältnis (Ziel/Bild)^s, begrenzt auf 0,65…1,55; der
 * Faktor f der Operation folgt daraus.
 *
 * Gemessen wird nach §8.3 als (max−min)/max, angewendet wird nach §9.5 als
 * L + (c−L)·f. Das sind verschiedene Größen, und f ist der Parameter der
 * Operation, nicht das erreichte Verhältnis. Mit a = L/max je Pixel gilt nach
 * der Operation exakt
 *
 *     S′/S = f / (a + (1−a)·f),
 *
 * also nach f aufgelöst für ein gewünschtes Verhältnis r
 *
 *     f = r·a / (1 − r + r·a).
 *
 * `f = r` wäre nur bei a = 0 richtig — bei realen Bildern (a ≈ 0,8) blieb davon
 * eine systematische Unterkorrektur von rund einem Fünftel der geforderten
 * Änderung bei Stärke 1 und rund zwei Fünfteln bei 0,7. Mit der Umrechnung
 * liegt der Restfehler unter einem Prozent (test/saettigung.test.ts).
 *
 * Der Deckel aus §9.5 liegt auf dem **Verhältnis**, nicht auf f: er begrenzt,
 * wie weit ein Bild in seiner Anmutung verschoben werden darf, und das ist die
 * sichtbare Sättigungsänderung. Ein Deckel auf f wanderte je nach Bildinhalt
 * zwischen 0,70 und 0,60 und wäre keine Grenze.
 *
 * `a` ist ein Mittelwert, die Beziehung in a ist nichtlinear — die Konvergenz
 * ist damit sehr genau, aber nicht exakt.
 */
function saturationFactor(s: Stats, t: Stats, strength: number): number {
  if (s.saturation <= 0.001 || t.saturation <= 0.001) return 1;
  const r = Math.max(0.65, Math.min(1.55, (t.saturation / s.saturation) ** strength));
  const a = s.satA;
  const nenner = 1 - r + r * a;
  // Nenner ≤ 0 heißt: dieses Verhältnis ist mit diesem Operator nicht
  // erreichbar (r ≥ 1/(1−a), bei a = 0,36 schon am Deckel 1,55). Dann gehört f
  // an den technischen Anschlag, nicht an das Ergebnis einer Division durch
  // fast null.
  if (nenner <= 0.02) return r >= 1 ? MAX_SAT_FACTOR : 0.65;
  return Math.min(MAX_SAT_FACTOR, (r * a) / nenner);
}

/**
 * §9.5 Korn: nur hinzufügen, nie entfernen. Ein sauberes Bild an ein rauschiges
 * Set anzugleichen ist ehrlich; der umgekehrte Weg — Entrauschen — ist es in
 * v1 nicht und bleibt draußen (§5).
 */
function grainSigma(s: Stats, t: Stats, strength: number): number {
  const delta = t.noise ** 2 - s.noise ** 2;
  if (delta <= 0) return 0;
  const sigma = Math.sqrt(delta) * strength * (t.contrast / 100) * 1.25;
  return Math.min(5, sigma);
}

/** §9.5 Schärfe: nur nach oben, nur für Bilder unterhalb des Ziels. */
function sharpenAmount(s: Stats, t: Stats, strength: number): number {
  if (s.sharpness <= 0 || t.sharpness <= 0 || s.sharpness >= t.sharpness) return 0;
  const amount = 0.5 * Math.log2(t.sharpness / s.sharpness) * strength * 0.9;
  return Math.max(0, Math.min(0.85, amount));
}

export function buildRecipe(s: Stats, t: Stats, settings: Settings): Recipe {
  const strength = settings.strength;
  const luts = buildLuts(s, t, settings);
  const sat = settings.fixes.saturation && strength > 0 ? saturationFactor(s, t, strength) : 1;
  const grain = settings.fixes.grain && strength > 0 ? grainSigma(s, t, strength) : 0;
  const sharpen = settings.fixes.sharpen && strength > 0 ? sharpenAmount(s, t, strength) : 0;

  return {
    luts,
    saturation: sat,
    grainSigma: grain,
    sharpenAmount: sharpen,
    neutral: isIdentity(luts) && sat === 1 && grain === 0 && sharpen === 0,
  };
}

/**
 * Geordnetes Rauschen (Bayer 4×4), −0,5 … +0,5 einer Tonstufe.
 *
 * Die Tonwertkurve bildet 256 Eingangsstufen auf 256 Ausgangsstufen ab und
 * staucht dabei Bereiche: mehrere Eingangsstufen landen auf derselben
 * Ausgangsstufe, und ein glatter Himmel bekommt Streifen. Kein noch so genaues
 * Zwischenergebnis behebt das — die Ausgabe ist nun einmal 8 bit. Ein halbes
 * Bit geordnetes Rauschen vor dem Runden verteilt den Rundungsfehler räumlich,
 * statt ihn an einer Kante zu sammeln: die Stufe wird zum Verlauf.
 *
 * Auf alle drei Kanäle derselbe Wert, aus demselben Grund wie beim Korn (§9.5)
 * — farbiges Rauschen sieht digital aus. Fest verdrahtet und ortsfest, damit
 * F-21 hält: dasselbe Bild ergibt dasselbe Ergebnis.
 */
const BAYER = (() => {
  const m = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  return Float32Array.from(m, (v) => (v + 0.5) / 16 - 0.5);
})();

/**
 * Wendet das Rezept auf einen bereits zugeschnittenen Frame an, in place.
 *
 * Die Reihenfolge ist die aus §9.2 und verbindlich — Weißabgleich und
 * Tonwertkurve stecken bereits in den LUTs, danach Sättigung, Korn, Schärfe.
 *
 * Tabellenwert, Sättigung und Rauschen laufen in Fließkomma; gerundet wird
 * genau einmal, nämlich beim Schreiben in das `Uint8ClampedArray`. Vorher waren
 * es zwei Rundungen (Tabelle, dann Sättigung) — die zweite arbeitete auf einem
 * bereits verfälschten Wert.
 *
 * `neutral` schließt kurz: bei Stärke 0 läuft keine einzige Pixeloperation.
 * Das ist der einzige Weg, A-03 (pixelgleich zum zugeschnittenen Original)
 * wirklich zu halten — eine Identitäts-LUT plus Rundung tut es nicht.
 */
export function applyRecipe(frame: Frame, recipe: Recipe, seed = 1): Frame {
  if (recipe.neutral) return frame;

  const d = frame.data;
  const { width: w, height: h } = frame;
  const [lr, lg, lb] = recipe.luts;
  const f = recipe.saturation;
  const applySat = f !== 1;

  let p = 0;
  for (let y = 0; y < h; y++) {
    const row = (y & 3) << 2;
    for (let x = 0; x < w; x++, p += 4) {
      const n = BAYER[row | (x & 3)]!;
      const r = lr[d[p]!]!;
      const g = lg[d[p + 1]!]!;
      const b = lb[d[p + 2]!]!;
      if (applySat) {
        const L = luminance(r, g, b);
        d[p] = L + (r - L) * f + n;
        d[p + 1] = L + (g - L) * f + n;
        d[p + 2] = L + (b - L) * f + n;
      } else {
        d[p] = r + n;
        d[p + 1] = g + n;
        d[p + 2] = b + n;
      }
    }
  }

  if (recipe.sharpenAmount > 0) unsharpMask(frame, recipe.sharpenAmount);
  if (recipe.grainSigma > 0) addGrain(frame, recipe.grainSigma, seed);
  return frame;
}

/**
 * Korn, deterministisch aus einem Startwert je Bild.
 *
 * Derselbe Wert wird auf alle drei Kanäle addiert: farbiges Rauschen sieht
 * digital aus, Luminanzrauschen sieht nach Film aus (§9.5). Der feste Startwert
 * hält die Vorschau ruhig — ohne ihn würde das Korn bei jedem Neuzeichnen
 * flimmern und A-04 wäre nicht reproduzierbar.
 */
function addGrain(frame: Frame, sigma: number, seed: number): void {
  const d = frame.data;
  let s = (seed * 2654435761) >>> 0;
  for (let p = 0; p < d.length; p += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const u = Math.max(1e-9, s / 4294967296);
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = s / 4294967296;
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
    d[p] = d[p]! + n;
    d[p + 1] = d[p + 1]! + n;
    d[p + 2] = d[p + 2]! + n;
  }
}

/** Unschärfemaske: Original + amount · (Original − Weichzeichnung). */
function unsharpMask(frame: Frame, amount: number): void {
  const { width: w, height: h, data: d } = frame;
  if (w < 3 || h < 3) return;
  const blurred = new Uint8ClampedArray(d.length);

  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < w - 1 ? x + 1 : w - 1;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const yy of [y0, y, y1]) for (const xx of [x0, x, x1]) sum += d[(yy * w + xx) * 4 + c]!;
        blurred[(y * w + x) * 4 + c] = sum / 9;
      }
    }
  }

  for (let p = 0; p < d.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[p + c]!;
      d[p + c] = v + amount * (v - blurred[p + c]!);
    }
  }
}
