import type { Frame } from './types.ts';

/** Luminanz nach §8.1: L = 0,2126·R + 0,7152·G + 0,0722·B */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createFrame(width: number, height: number): Frame {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function cloneFrame(f: Frame): Frame {
  return { data: new Uint8ClampedArray(f.data), width: f.width, height: f.height };
}

/** Luminanzkanal als Float32Array, ein Eintrag je Pixel. */
export function luminanceMap(f: Frame): Float32Array {
  const n = f.width * f.height;
  const out = new Float32Array(n);
  const d = f.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = luminance(d[p]!, d[p + 1]!, d[p + 2]!);
  }
  return out;
}

/**
 * Skaliert so, dass die längste Kante `edge` misst — per Flächenmittel, nicht
 * per Nächstem-Nachbarn. Das ist für §8.5 wesentlich: Punktabtastung würde
 * Rauschen unverändert stehen lassen und damit von der Ausgangsauflösung
 * abhängig machen, statt es vergleichbar zu machen.
 */
export function downscaleToEdge(src: Frame, edge: number): Frame {
  const longest = Math.max(src.width, src.height);
  if (longest <= edge) return cloneFrame(src);

  const scale = edge / longest;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const dst = createFrame(w, h);

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let p = (sy * src.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, p += 4) {
          r += src.data[p]!;
          g += src.data[p + 1]!;
          b += src.data[p + 2]!;
          a += src.data[p + 3]!;
          n++;
        }
      }
      const q = (y * w + x) * 4;
      dst.data[q] = r / n;
      dst.data[q + 1] = g / n;
      dst.data[q + 2] = b / n;
      dst.data[q + 3] = a / n;
    }
  }
  return dst;
}
