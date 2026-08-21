import type { Frame } from '../../src/core/types.ts';
import { createFrame } from '../../src/core/frame.ts';

/** Deterministischer PRNG — die Testbilder müssen bei jedem Lauf identisch sein. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Eine Basisszene, aus der alle Varianten in §13 abgeleitet werden.
 *
 * Der Aufbau ist kein Zierrat: der Verlauf gibt dem Histogramm Breite, die
 * Farbflächen machen §8.3 überhaupt messbar, die Feinstruktur §8.4. Und alle
 * Werte bleiben im Band 20…200, damit die Kanalskalierung in Testbild 03
 * (B × 1,35) nicht in die Sättigung clippt und den Messwert verfälscht.
 */
export function baseScene(width = 800, height = 1000): Frame {
  const f = createFrame(width, height);
  const rand = rng(20260821);
  const d = f.data;

  for (let y = 0; y < height; y++) {
    // Verlauf von 40 nach 190 über die Höhe
    const base = 40 + (150 * y) / (height - 1);
    for (let x = 0; x < width; x++) {
      // Feinstruktur: gleichmäßige Textur für die Schärfemessung
      const tex =
        14 * Math.sin(x * 0.9) * Math.cos(y * 0.7) +
        8 * Math.sin((x + y) * 2.1) +
        4 * (rand() - 0.5);

      let r = base + tex;
      let g = base + tex;
      let b = base + tex;

      // Vier Farbflächen, je ein Quadrant der oberen Bildhälfte
      const qx = Math.floor((x / width) * 4);
      const inBand = y > height * 0.15 && y < height * 0.45;
      if (inBand) {
        if (qx === 0) { r *= 1.35; g *= 0.85; b *= 0.8; }
        else if (qx === 1) { r *= 0.8; g *= 1.25; b *= 0.85; }
        else if (qx === 2) { r *= 0.85; g *= 0.9; b *= 1.3; }
        else { r *= 1.2; g *= 1.1; b *= 0.75; }
      }

      const p = (y * width + x) * 4;
      d[p] = clamp(r);
      d[p + 1] = clamp(g);
      d[p + 2] = clamp(b);
      d[p + 3] = 255;
    }
  }
  return f;
}

const clamp = (v: number) => Math.max(0, Math.min(255, v));

/** Kanalweise Multiplikation — der Kern jeder Belichtungs- und Stich-Variante. */
export function scaleChannels(src: Frame, kr: number, kg: number, kb: number): Frame {
  const f = createFrame(src.width, src.height);
  for (let p = 0; p < src.data.length; p += 4) {
    f.data[p] = clamp(src.data[p]! * kr);
    f.data[p + 1] = clamp(src.data[p + 1]! * kg);
    f.data[p + 2] = clamp(src.data[p + 2]! * kb);
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

/** Kontrast um den Mittelwert 128, danach Sättigung um die Luminanz. */
export function flatten(src: Frame, contrast: number, sat: number): Frame {
  const f = createFrame(src.width, src.height);
  for (let p = 0; p < src.data.length; p += 4) {
    const r = 128 + (src.data[p]! - 128) * contrast;
    const g = 128 + (src.data[p + 1]! - 128) * contrast;
    const b = 128 + (src.data[p + 2]! - 128) * contrast;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    f.data[p] = clamp(L + (r - L) * sat);
    f.data[p + 1] = clamp(L + (g - L) * sat);
    f.data[p + 2] = clamp(L + (b - L) * sat);
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

export function crop(src: Frame, x0: number, y0: number, w: number, h: number): Frame {
  const f = createFrame(w, h);
  for (let y = 0; y < h; y++) {
    const s = ((y + y0) * src.width + x0) * 4;
    f.data.set(src.data.subarray(s, s + w * 4), y * w * 4);
  }
  return f;
}

export function addNoise(src: Frame, sigma: number, seed = 7): Frame {
  const f = createFrame(src.width, src.height);
  const rand = rng(seed);
  for (let p = 0; p < src.data.length; p += 4) {
    // Box-Muller, ein Wert für alle drei Kanäle (Luminanzrauschen)
    const u = Math.max(1e-9, rand());
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * sigma;
    f.data[p] = clamp(src.data[p]! + n);
    f.data[p + 1] = clamp(src.data[p + 1]! + n);
    f.data[p + 2] = clamp(src.data[p + 2]! + n);
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

/** Gaußscher Weichzeichner, separabel. */
export function blur(src: Frame, radius: number): Frame {
  const k = gaussKernel(radius);
  const half = (k.length - 1) / 2;
  const { width: w, height: h } = src;
  const tmp = createFrame(w, h);
  const out = createFrame(w, h);

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < k.length; i++) {
        const sx = Math.max(0, Math.min(w - 1, x + i - half));
        const p = (y * w + sx) * 4;
        r += src.data[p]! * k[i]!;
        g += src.data[p + 1]! * k[i]!;
        b += src.data[p + 2]! * k[i]!;
      }
      const q = (y * w + x) * 4;
      tmp.data[q] = r; tmp.data[q + 1] = g; tmp.data[q + 2] = b; tmp.data[q + 3] = 255;
    }

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < k.length; i++) {
        const sy = Math.max(0, Math.min(h - 1, y + i - half));
        const p = (sy * w + x) * 4;
        r += tmp.data[p]! * k[i]!;
        g += tmp.data[p + 1]! * k[i]!;
        b += tmp.data[p + 2]! * k[i]!;
      }
      const q = (y * w + x) * 4;
      out.data[q] = r; out.data[q + 1] = g; out.data[q + 2] = b; out.data[q + 3] = 255;
    }
  return out;
}

function gaussKernel(sigma: number): number[] {
  const half = Math.max(1, Math.ceil(sigma * 3));
  const k: number[] = [];
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return k.map((v) => v / sum);
}

/** Die fünf Testbilder aus §13. */
export function testSet(): { id: string; label: string; frame: Frame }[] {
  const base = baseScene();
  const dark = 2 ** -1.2;
  return [
    { id: '01', label: 'Referenz', frame: base },
    { id: '02', label: 'nah dran', frame: scaleChannels(base, 1.05, 1.05, 1.05) },
    { id: '03', label: 'dunkel & kühl', frame: scaleChannels(base, dark * 0.85, dark, dark * 1.35) },
    { id: '04', label: 'flau', frame: flatten(base, 0.55, 0.45) },
    { id: '05', label: 'quer & rauschig', frame: addNoise(blur(crop(base, 0, 250, 800, 450), 1.5), 10) },
  ];
}
