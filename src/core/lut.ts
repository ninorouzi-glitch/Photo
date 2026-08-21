import type { Settings, Stats } from './types.ts';

/**
 * Die Tabellen halten Fließkommawerte, nicht schon gerundete Bytes.
 *
 * Vorher war das ein `Uint8ClampedArray`: die Kurve wurde beim Bau der Tabelle
 * auf ganze Stufen gerundet und nach der Sättigung ein zweites Mal. Zweimal
 * runden heißt zweimal Quantisierungsfehler auf demselben Pixel — sichtbar als
 * Abrisse in glatten Verläufen. Jetzt läuft die ganze Rechnung in Fließkomma
 * und wird genau einmal gerundet, beim Schreiben in den Frame.
 */
export type Luts = [Float32Array, Float32Array, Float32Array];

const IDENTITY = (() => {
  const a = new Float32Array(256);
  for (let i = 0; i < 256; i++) a[i] = i;
  return a;
})();

export function identityLuts(): Luts {
  return [
    new Float32Array(IDENTITY),
    new Float32Array(IDENTITY),
    new Float32Array(IDENTITY),
  ];
}

export function isIdentity(luts: Luts): boolean {
  for (const l of luts) for (let i = 0; i < 256; i++) if (l[i] !== i) return false;
  return true;
}

/** §9.3: Weißabgleich als drei Kanalfaktoren. */
export function channelGains(s: Stats, t: Stats, strength: number) {
  const dW = (t.warmth - s.warmth) * strength;
  const dT = (t.tint - s.tint) * strength * (2 / 3);
  return {
    r: 2 ** (dW / 2 - dT / 2),
    g: 2 ** dT,
    b: 2 ** (-dW / 2 - dT / 2),
  };
}

/**
 * §9.4: Tonwertkurve aus Histogramm-Anpassung an die Ziel-CDF.
 *
 * Die drei Nachbearbeitungen machen aus einer mathematisch sauberen Abbildung
 * erst eine fotografisch brauchbare — keine davon ist Beiwerk:
 *  1. Deckeln, damit extreme Umsortierungen nicht das ganze Bild umwerfen
 *  2. Glätten, weil reine Histogramm-Anpassung sonst Abrisse in glatten
 *     Verläufen erzeugt (sichtbar als Streifen im Himmel)
 *  3. Blenden gegen die Identität mit der Stärke
 *
 * Diese eine Kurve erledigt Belichtung, Schwarz-/Weißpunkt und Kontrast
 * gemeinsam. Deshalb gibt es dafür nur einen Schalter und nicht drei: als
 * getrennte Schritte würden sie einander überschreiben.
 */
export function toneCurve(srcCdf: Float64Array, dstCdf: Float64Array, strength: number): Float64Array {
  const mapped = new Float64Array(256);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    const q = srcCdf[i]!;
    while (j < 255 && dstCdf[j]! < q) j++;
    mapped[i] = j;
  }

  // 1. Deckeln
  for (let i = 0; i < 256; i++) {
    mapped[i] = Math.max(i - 70, Math.min(i + 70, mapped[i]!));
  }

  // 2. Glätten, gleitendes Mittel über ±6 Bins
  const smooth = new Float64Array(256);
  const R = 6;
  for (let i = 0; i < 256; i++) {
    let sum = 0, n = 0;
    for (let k = -R; k <= R; k++) {
      const idx = i + k;
      if (idx < 0 || idx > 255) continue;
      sum += mapped[idx]!;
      n++;
    }
    smooth[i] = sum / n;
  }

  // 3. Blenden gegen die Identität
  const out = new Float64Array(256);
  for (let i = 0; i < 256; i++) out[i] = i + (smooth[i]! - i) * strength;
  return out;
}

/**
 * Faltet Weißabgleich und Tonwertkurve zu einer Tabelle je Kanal zusammen —
 * drei Zugriffe pro Pixel statt zwei Durchläufe. Das ist der Grund, warum das
 * 150-ms-Budget für die Vorschau des ganzen Sets überhaupt erreichbar ist.
 */
export function buildLuts(s: Stats, t: Stats, settings: Settings): Luts {
  const strength = settings.strength;
  const gains = settings.fixes.wb && strength > 0
    ? channelGains(s, t, strength)
    : { r: 1, g: 1, b: 1 };

  const curve = settings.fixes.tone && strength > 0
    ? toneCurve(s.cdf, t.cdf, strength)
    : null;

  const luts = identityLuts();
  const g = [gains.r, gains.g, gains.b];
  for (let c = 0; c < 3; c++) {
    const lut = luts[c]!;
    for (let i = 0; i < 256; i++) {
      const afterWb = Math.max(0, Math.min(255, i * g[c]!));
      lut[i] = curve ? sample(curve, afterWb) : afterWb;
    }
  }
  return luts;
}

/** Lineare Interpolation in der Kurve — der Weißabgleich liefert Zwischenwerte. */
function sample(curve: Float64Array, x: number): number {
  const i = Math.floor(x);
  if (i >= 255) return curve[255]!;
  const f = x - i;
  return curve[i]! * (1 - f) + curve[i + 1]! * f;
}
