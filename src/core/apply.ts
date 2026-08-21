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
 * §9.5 Sättigung: Faktor (Ziel/Bild)^s, begrenzt auf 0,65…1,55.
 *
 * Vorbehalt, ausdrücklich festgehalten: gemessen wird Sättigung als
 * (max−min)/max (§8.3), angewendet wird sie als L + (c−L)·f. Das sind nicht
 * dieselben Maße — die Konvergenz für Sättigung ist deshalb nur näherungsweise.
 * Die Formel bleibt wie spezifiziert; die Abnahme A-02 trägt dafür eine
 * größere Toleranz, statt dass hier still etwas anderes gerechnet wird.
 */
function saturationFactor(s: Stats, t: Stats, strength: number): number {
  if (s.saturation <= 0.001 || t.saturation <= 0.001) return 1;
  const f = (t.saturation / s.saturation) ** strength;
  return Math.max(0.65, Math.min(1.55, f));
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
