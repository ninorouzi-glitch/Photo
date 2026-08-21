import type { Frame, Stats } from './types.ts';
import { MEASURE_EDGE, MEASURE_INSET, MIN_CONTRAST } from './types.ts';
import { createFrame, downscaleToEdge, luminanceMap } from './frame.ts';

/**
 * Messung nach PRD §8. Erwartet einen bereits auf 640 px skalierten Frame —
 * `analyzeFull` nimmt jede Größe und skaliert selbst.
 */
export function analyze(f: Frame): Stats {
  // Alle globalen Messungen laufen auf dem Messfenster, nicht auf dem ganzen
  // Bild (MEASURE_INSET). Einzige Ausnahme: das Seitenverhältnis.
  const m = measureWindow(f);
  const lum = luminanceMap(m);
  const { cdf, hist, total } = histogram(lum);

  const p01 = percentile(cdf, hist, total, 0.01);
  const p10 = percentile(cdf, hist, total, 0.1);
  const p50 = percentile(cdf, hist, total, 0.5);
  const p90 = percentile(cdf, hist, total, 0.9);
  const p99 = percentile(cdf, hist, total, 0.99);
  const contrast = Math.max(MIN_CONTRAST, p90 - p10);

  const { warmth, tint, clippedRatio } = whiteBalance(m, lum);

  return {
    aspect: f.width / f.height,
    p01,
    p10,
    p50,
    p90,
    p99,
    contrast,
    cdf,
    ...channelCdfs(m),
    warmth,
    tint,
    clippedRatio,
    saturation: saturation(m, lum),
    sharpness: sharpness(lum, m.width, m.height, contrast),
    noise: noise(lum, m.width, m.height, contrast),
    palette: palette(m),
  };
}

/**
 * Der zentrale Ausschnitt, auf dem gemessen wird: MEASURE_AREA der Fläche,
 * je Seite MEASURE_INSET weniger.
 *
 * Objektivvignettierung dunkelt die Ränder ab, je nach Objektiv und Blende
 * unterschiedlich weit. Ohne Objektivprofile lässt sich das nicht herausrechnen,
 * also messen wir es gar nicht erst mit — sonst gilt dasselbe Motiv bei offener
 * Blende als dunkler als bei geschlossener.
 */
export function measureWindow(f: Frame): Frame {
  const x0 = Math.round(f.width * MEASURE_INSET);
  const y0 = Math.round(f.height * MEASURE_INSET);
  const w = Math.max(1, f.width - 2 * x0);
  const h = Math.max(1, f.height - 2 * y0);
  if (w === f.width && h === f.height) return f;

  const out = createFrame(w, h);
  for (let y = 0; y < h; y++) {
    const src = ((y + y0) * f.width + x0) * 4;
    out.data.set(f.data.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

export function analyzeFull(f: Frame): Stats {
  const small = downscaleToEdge(f, MEASURE_EDGE);
  const s = analyze(small);
  // Das Seitenverhältnis kommt aus dem Original — Rundung beim Skalieren
  // würde es sonst um bis zu einen halben Prozentpunkt verschieben.
  s.aspect = f.width / f.height;
  return s;
}

// ── §8.1 Histogramm und Tonwerte ──────────────────────────────────────────

function histogram(lum: Float32Array) {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) {
    hist[Math.max(0, Math.min(255, Math.round(lum[i]!)))]! += 1;
  }
  const total = lum.length;
  const cdf = new Float64Array(256);
  let run = 0;
  for (let i = 0; i < 256; i++) {
    run += hist[i]!;
    cdf[i] = run / total;
  }
  return { cdf, hist, total };
}

/**
 * Kumulierte Histogramme je Kanal, im selben Messdurchlauf wie alles andere.
 *
 * Zweck ist ausschließlich die Clipping-Abschätzung: ob ein Kanalfaktor Pixel
 * an den Anschlag drückt, hängt an der Verteilung dieses Kanals, nicht an der
 * Luminanz. Kein kanalweises Histogramm-Matching daraus bauen — die Begründung
 * steht bei `Stats.cdfR`.
 */
function channelCdfs(f: Frame) {
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const d = f.data;
  const n = f.width * f.height;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    hist[0]![d[p]!]! += 1;
    hist[1]![d[p + 1]!]! += 1;
    hist[2]![d[p + 2]!]! += 1;
  }
  const [cdfR, cdfG, cdfB] = hist.map((h) => {
    const cdf = new Float64Array(256);
    let run = 0;
    for (let i = 0; i < 256; i++) {
      run += h[i]!;
      cdf[i] = n === 0 ? 0 : run / n;
    }
    return cdf;
  });
  return { cdfR: cdfR!, cdfG: cdfG!, cdfB: cdfB! };
}

/**
 * Perzentil mit linearer Interpolation innerhalb des Bins. Die Masse eines
 * Bins gilt als gleichmäßig über [i−0,5 … i+0,5] verteilt. Ohne diese
 * Interpolation quantisiert der Median auf ganze Tonwerte und A-01 (±0,03)
 * ist bei dunklen Bildern nicht mehr sicher zu halten.
 */
export function percentile(
  cdf: Float64Array,
  hist: Float64Array,
  total: number,
  q: number,
): number {
  for (let i = 0; i < 256; i++) {
    if (cdf[i]! >= q) {
      const prev = i > 0 ? cdf[i - 1]! : 0;
      const share = hist[i]! / total;
      if (share <= 0) return i;
      return i - 0.5 + (q - prev) / share;
    }
  }
  return 255;
}

// ── §8.2 Weißabgleich ─────────────────────────────────────────────────────

/**
 * Shades-of-Grey mit Minkowski-Norm p = 6.
 *
 * Bewusst *nicht* Grauwelt über niedrig gesättigte Pixel: ein Bild mit
 * Farbstich hat seine echten Neutraltöne gerade nicht mehr bei niedriger
 * Sättigung — die Maske würde Pixel wählen, die durch den Stich neutral
 * geworden sind, und den Stich wegmessen (§8.2).
 */
/** Ober- und Untergrenze je Kanal: darüber bzw. darunter ist der Wert am Anschlag. */
const CLIP_HIGH = 250;
const CLIP_LOW = 5;

/**
 * Taugt das Pixel als Farbmesswert?
 *
 * Der Luma-Filter allein reicht nicht: ein sattes Rot mit R = 255, G = 40,
 * B = 30 hat L ≈ 95 und käme glatt durch, obwohl sein Rotkanal am Anschlag
 * steht und sein wahrer Wert unbekannt ist. Bei p = 6 wiegt gerade der hohe
 * Kanal am schwersten, so ein Pixel zieht den Weißabgleich also systematisch.
 *
 * Das ist ausdrücklich *keine* Sättigungsmaske — gesättigte Farben bleiben
 * drin, solange kein Kanal anschlägt. Die Begründung oben, warum Shades-of-Grey
 * und nicht Grauwelt mit Sättigungsmaske, bleibt davon unberührt.
 */
function channelsUsable(r: number, g: number, b: number): boolean {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  return max < CLIP_HIGH && min > CLIP_LOW;
}

function whiteBalance(f: Frame, lum: Float32Array) {
  const P = 6;
  let sr = 0, sg = 0, sb = 0, n = 0, clipped = 0;
  const d = f.data;
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const r = d[p]!, g = d[p + 1]!, b = d[p + 2]!;
    if (!channelsUsable(r, g, b)) {
      clipped++;
      continue;
    }
    const L = lum[i]!;
    if (L <= 16 || L >= 244) continue;
    sr += (r / 255) ** P;
    sg += (g / 255) ** P;
    sb += (b / 255) ** P;
    n++;
  }
  const clippedRatio = lum.length === 0 ? 0 : clipped / lum.length;
  if (n === 0) return { warmth: 0, tint: 0, clippedRatio };

  const wr = (sr / n) ** (1 / P) * 255;
  const wg = (sg / n) ** (1 / P) * 255;
  const wb = (sb / n) ** (1 / P) * 255;

  // Nur noch ein Schutz gegen Division durch null, kein Messeingriff mehr:
  // der frühere Offset von +1 stauchte das Verhältnis bei dunklen Bildern
  // spürbar — bei R̄ = B̄ = 20 um rund 5 %, gegen eine warn-Schwelle von 0,07.
  // Nötig ist der Schutz kaum: `channelsUsable` lässt nur Pixel mit allen
  // Kanälen > CLIP_LOW zu, jeder Minkowski-Mittelwert liegt also über CLIP_LOW,
  // und bei n === 0 ist die Funktion schon zurück.
  const EPS = 1e-6;
  return {
    warmth: Math.log2((wr + EPS) / (wb + EPS)),
    tint: Math.log2((wg + EPS) / Math.sqrt((wr + EPS) * (wb + EPS))),
    clippedRatio,
  };
}

// ── §8.3 Sättigung ────────────────────────────────────────────────────────

function saturation(f: Frame, lum: Float32Array): number {
  let sum = 0, n = 0;
  const d = f.data;
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    if (lum[i]! <= 20) continue;
    const r = d[p]!, g = d[p + 1]!, b = d[p + 2]!;
    // Gleicher Ausschluss wie beim Weißabgleich: an einem geclippten Kanal ist
    // (max − min) / max nicht die Sättigung des Motivs, sondern die des Sensors.
    if (!channelsUsable(r, g, b)) continue;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (max <= 0) continue;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    sum += (max - min) / max;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

// ── §8.4 Schärfe ──────────────────────────────────────────────────────────

/** 3×3-Boxfilter: unterdrückt Pixelrauschen, lässt Struktur stehen. */
function boxBlur3(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < w - 1 ? x + 1 : w - 1;
      const row = y * w;
      tmp[row + x] = (src[row + x0]! + src[row + x]! + src[row + x1]!) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = (tmp[y0 * w + x]! + tmp[y * w + x]! + tmp[y1 * w + x]!) / 3;
    }
  }
  return out;
}

/**
 * Varianz des Laplace-Operators, geteilt durch das Quadrat des Kontrasts.
 *
 * Die Normierung ist nicht optional: ohne sie misst ein um 1,2 EV dunkleres
 * Bild desselben Motivs kleinere Gradienten und gilt als unscharf, obwohl es
 * pixelidentisch scharf ist (§8.4).
 */
function sharpness(lum: Float32Array, w: number, h: number, contrast: number): number {
  if (w < 3 || h < 3) return 0;
  const s = boxBlur3(lum, w, h);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * s[i]! - s[i - 1]! - s[i + 1]! - s[i - w]! - s[i + w]!;
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  // `contrast` ist bereits auf MIN_CONTRAST geklemmt — hier keine zweite,
  // höhere Untergrenze, sonst normiert ein flaues Bild auf einen Kontrast,
  // den es nicht hat.
  return (variance / contrast ** 2) * 1e4;
}

// ── §8.5 Rauschen ─────────────────────────────────────────────────────────

/**
 * Schätzer nach Immerkaer: die Maske [[1,−2,1],[−2,4,−2],[1,−2,1]] löscht
 * Bildstruktur weitgehend aus und lässt Rauschen stehen. Ebenfalls auf den
 * Kontrast normiert, aus demselben Grund wie bei der Schärfe.
 */
function noise(lum: Float32Array, w: number, h: number, contrast: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        lum[i - w - 1]! - 2 * lum[i - w]! + lum[i - w + 1]! +
        -2 * lum[i - 1]! + 4 * lum[i]! - 2 * lum[i + 1]! +
        lum[i + w - 1]! - 2 * lum[i + w]! + lum[i + w + 1]!;
      sum += Math.abs(v);
      n++;
    }
  }
  const sigma = ((sum / n) * Math.sqrt(Math.PI / 2)) / 6;
  // Untergrenze wie bei der Schärfe: `contrast` bringt MIN_CONTRAST schon mit.
  return (sigma * 100) / contrast;
}

// ── §8.6 Farbpalette ──────────────────────────────────────────────────────

/**
 * Schrittweite der Stichprobe. Eine gerade Schrittweite trifft bei einer
 * geraden Bildbreite immer dieselben Spalten — bei 640 px und Schritt 4 die
 * Spalten 0, 4, 8, …, also ein senkrechtes Streifenraster statt einer
 * Stichprobe. Bei periodischem Bildinhalt (Zaun, Jalousie, Gewebe) aliast das.
 * Deshalb eine Primzahl, die die Breite nicht teilt: die Abtastpunkte wandern
 * dann Zeile für Zeile durch, ohne Zufall und damit determiniert (F-21).
 */
const SAMPLE_STEPS = [7, 11, 13, 17];

export function sampleStep(width: number): number {
  return SAMPLE_STEPS.find((p) => width % p !== 0) ?? 1;
}

function palette(f: Frame): string[] {
  const counts = new Int32Array(512);
  const sums = new Float64Array(512 * 3);
  const d = f.data;
  const n = f.width * f.height;
  const step = sampleStep(f.width);
  for (let i = 0; i < n; i += step) {
    const p = i * 4;
    const r = d[p]!, g = d[p + 1]!, b = d[p + 2]!;
    const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    counts[key]! += 1;
    sums[key * 3]! += r;
    sums[key * 3 + 1]! += g;
    sums[key * 3 + 2]! += b;
  }
  const order = [...counts.keys()]
    .filter((k) => counts[k]! > 0)
    .sort((a, b) => counts[b]! - counts[a]!)
    .slice(0, 5);

  return order.map((k) => {
    const c = counts[k]!;
    return hex(sums[k * 3]! / c, sums[k * 3 + 1]! / c, sums[k * 3 + 2]! / c);
  });
}

function hex(r: number, g: number, b: number): string {
  const two = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${two(r)}${two(g)}${two(b)}`;
}
