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
 *
 * BEKANNTE GRENZE, kein Fehler: die Anpassung trifft ihr Ziel auch bei Stärke 1
 * nur näherungsweise. Zwei Gründe, beide baulich:
 *  - Die Kurve wird aus der *Luma*-CDF gebaut, aber über dieselbe Tabelle auf
 *    *jeden Kanal* angewendet. Ein farbiges Bild landet damit nie exakt auf dem
 *    Luma-Ziel, gegen das die Kurve angepasst wurde.
 *  - Der Weißabgleich läuft *vor* der Kurve (§9.2) und verschiebt genau die
 *    Verteilung, gegen die sie angepasst wurde — die Kurve sieht am Ende eine
 *    andere Eingabe als die, für die sie gebaut ist.
 * Deshalb behalten die Achsen exposure, contrast, p01 und p99 einen
 * systematischen Restwert. Zu beheben wäre das nur mit Luma-Matching unter
 * Erhalt der Chroma; das ließe sich nicht mehr in eine Tabelle je Kanal falten
 * und kostete das 150-ms-Budget. Siehe CLAUDE.md, Abweichung 4.
 */
export function toneCurve(srcCdf: Float64Array, dstCdf: Float64Array, strength: number): Float64Array {
  const mapped = new Float64Array(256);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    // Beide Seiten in derselben Konvention wie `percentile` in stats.ts: die
    // Masse eines Bins liegt gleichmäßig über [i−0,5 … i+0,5], also ist cdf[i]
    // die Masse bis zur *Oberkante* von Bin i. Für die Mitte von Bin i ist das
    // Quantil deshalb das Mittel aus cdf[i−1] und cdf[i].
    const q = ((i > 0 ? srcCdf[i - 1]! : 0) + srcCdf[i]!) / 2;
    while (j < 255 && dstCdf[j]! < q) j++;

    // Und dieselbe Konvention rückwärts: q liegt zwischen der Unterkante
    // (j−0,5, Masse dstCdf[j−1]) und der Oberkante (j+0,5, Masse dstCdf[j]).
    // Das ganzzahlige `j` von früher quantisierte die Inverse auf ±0,5 Stufen
    // — mitten in einer Kette, die sonst durchgehend in Fließkomma rechnet.
    //
    // Nur eine der beiden Seiten zu interpolieren ist schlechter als keine:
    // das alte `mapped[i] = j` paarte die Oberkante des Quellbins mit der
    // Mitte des Zielbins, zwei halbe Stufen, die einander weitgehend aufhoben.
    // Wird nur die Zielseite genau gerechnet, bleibt der halbe Schritt der
    // Quellseite als systematischer Versatz stehen — gemessen an einem
    // Testbild mit bekannter Wahrheit wurde die Kurve dadurch schlechter
    // statt besser. Deshalb beide Seiten oder keine.
    const lo = j > 0 ? dstCdf[j - 1]! : 0;
    const d = dstCdf[j]! - lo;
    mapped[i] = d > 0
      ? Math.max(0, Math.min(255, j - 0.5 + (q - lo) / d))
      : j;
  }

  // 1. Deckeln
  for (let i = 0; i < 256; i++) {
    mapped[i] = Math.max(i - 70, Math.min(i + 70, mapped[i]!));
  }

  // 2. Glätten, gleitendes Mittel über ±6 Bins, zum Rand hin verjüngt
  //
  // Ein festes Fenster ist an den Enden einseitig: bei i=0 mittelt es über die
  // Bins 0…6 und zieht damit genau den Endpunkt nach innen. Dort sitzen aber
  // p01 und p99, und der Fehler ist systematisch — p01 zu hoch, p99 zu
  // niedrig, also durchgehend etwas zu wenig Kontrast in jedem Bild. Ein
  // symmetrisch mitschrumpfendes Fenster (bei i=0 nur [0], bei i=1 [0…2], ab
  // i=6 das volle ±6) hält die Endpunkte exakt und glättet weiter dort, wo es
  // gebraucht wird.
  const smooth = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const R = Math.min(6, i, 255 - i);
    let sum = 0, n = 0;
    for (let k = -R; k <= R; k++) {
      sum += mapped[i + k]!;
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
