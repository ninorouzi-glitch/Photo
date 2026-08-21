import type { Frame, ImageItem, Output, Settings, Stats } from '../core/types.ts';
import { IG_WIDTH } from '../core/types.ts';
import { aspectOf, cropRect, type Rect } from '../core/crop.ts';
import { applyRecipe, buildRecipe, type Recipe } from '../core/apply.ts';

/** Vorschauen rechnen auf dieser Kantenlänge in CSS-Pixeln — nicht in voller
 *  Auflösung. Sonst ist das 150-ms-Budget für das ganze Set nicht zu halten (§13). */
export const PREVIEW_EDGE = 540;

/**
 * Obergrenze für die Geräteauflösung der Vorschau.
 *
 * Ein Canvas mit 540 Pixeln Speicher, den das Layout auf 380 CSS-Pixel zieht,
 * ist auf einem Retina-Schirm 760 Gerätepixel breit und wird sichtbar weich —
 * das Ergebnis sah schlechter aus als die Datei, die dabei herauskommt. Bei 2
 * gedeckelt: darüber ist nichts mehr zu sehen, aber alles zu bezahlen.
 */
export const MAX_PREVIEW_DPR = 2;

export function previewScale(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.min(MAX_PREVIEW_DPR, Math.max(1, dpr));
}

/**
 * Ausgabegröße.
 *
 * `original` nimmt die Pixel des Zuschnitts, wie sie im Bild stehen — dann ist
 * das Zeichnen ein 1:1-Blit und es geht kein einziger Pixel verloren. `1080`
 * ist die Instagram-Breite aus F-22; bei einem 24-MP-Foto bleiben davon rund
 * 3 % der Pixel übrig.
 */
export function exportSize(
  aspect: number,
  output: Output = '1080',
  source?: { width: number; height: number },
): { width: number; height: number } {
  if (output === 'original' && source) {
    const r = cropRect(source.width, source.height, aspect);
    return { width: r.w, height: r.h };
  }
  return { width: IG_WIDTH, height: Math.round(IG_WIDTH / aspect) };
}

/** Stabiler Startwert je Bild, damit das Korn in der Vorschau nicht flimmert. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

/**
 * Zeichnet einen Ausschnitt auf die Zielgröße.
 *
 * Drei Fälle, und der erste ist der wichtigste: passt der Ausschnitt exakt,
 * wird nur kopiert — keine Neuabtastung, kein Filter, keine Interpolation.
 * Genau dafür gibt es die Ausgabe in voller Auflösung.
 *
 * Bei starker Verkleinerung wird stufenweise halbiert. `drawImage` tastet in
 * einem Schritt von 6000 auf 1080 auch mit `imageSmoothingQuality: 'high'`
 * zu grob ab: feine Struktur fällt zwischen die Abtastpunkte und kommt als
 * Griesel wieder. Halbieren mittelt jedes Mal über 2×2 Pixel und lässt nichts
 * aus.
 */
function drawScaled(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: ImageBitmap,
  rect: Rect,
  width: number,
  height: number,
): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (rect.w === width && rect.h === height) {
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height);
    return;
  }

  let src: ImageBitmap | OffscreenCanvas = source;
  let { x: sx, y: sy, w: sw, h: sh } = rect;

  while (sw >= width * 2 && sh >= height * 2) {
    const nw = Math.max(width, sw >> 1);
    const nh = Math.max(height, sh >> 1);
    const step = new OffscreenCanvas(nw, nh);
    const sctx = step.getContext('2d')!;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, sx, sy, sw, sh, 0, 0, nw, nh);
    src = step;
    sx = 0;
    sy = 0;
    sw = nw;
    sh = nh;
  }

  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, width, height);
}

export type RenderOptions = {
  recipe?: Recipe;
  /**
   * Den zugeschnittenen, skalierten Ausschnitt neben dem Ziel-Canvas aufheben
   * und wiederverwenden, solange sich Bild, Format, Zuschnitt und Größe nicht
   * ändern.
   *
   * Am Stärkeregler ändert sich nur das Rezept — die Geometrie ist bei jedem
   * Zwischenwert dieselbe. Sie trotzdem jedes Mal neu zu rechnen hieße, das
   * stufenweise Verkleinern (drei Zwischenstufen bei einem 24-MP-Bild) in die
   * Schleife zu legen, die das 150-ms-Budget einhalten muss. Für den Export
   * bleibt es aus: dort wird jedes Canvas genau einmal benutzt.
   */
  reuseGeometry?: boolean;
};

type Geometry = { key: string; canvas: OffscreenCanvas };

const geometryCache = new WeakMap<HTMLCanvasElement | OffscreenCanvas, Geometry>();

/**
 * Zuschnitt → Rezept → Pixel. Die Reihenfolge aus §9.2 steckt in genau dieser
 * Funktion; sie zu vertauschen ändert das Ergebnis.
 */
export function renderTo(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  item: ImageItem,
  target: Stats,
  settings: Settings,
  width: number,
  height: number,
  opts: RenderOptions = {},
): void {
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  const rect = cropRect(item.bitmap.width, item.bitmap.height, aspectOf(settings), item.crop);

  if (opts.reuseGeometry) {
    const key = `${item.id}|${rect.x},${rect.y},${rect.w},${rect.h}|${width}×${height}`;
    let geo = geometryCache.get(canvas);
    if (!geo || geo.key !== key) {
      const off = new OffscreenCanvas(width, height);
      drawScaled(off.getContext('2d')!, item.bitmap, rect, width, height);
      geo = { key, canvas: off };
      geometryCache.set(canvas, geo);
    }
    ctx.drawImage(geo.canvas, 0, 0); // gleiche Größe — reines Kopieren
  } else {
    drawScaled(ctx, item.bitmap, rect, width, height);
  }

  const r = opts.recipe ?? buildRecipe(item.stats, target, settings);
  if (r.neutral) return; // A-03: bei Stärke 0 läuft keine Pixeloperation

  const img = ctx.getImageData(0, 0, width, height);
  const frame: Frame = { data: img.data, width, height };
  applyRecipe(frame, r, seedOf(item.id));
  ctx.putImageData(img, 0, 0);
}

/**
 * Das Original, unbeschnitten und ohne Rezept — die linke Hälfte des A/B in
 * Stufe 03.
 *
 * Dafür stand dort ein `<img>` auf der 640-px-Vorschaudatei: ein JPEG in
 * Qualität 0,82, im Layout auf die doppelte Breite gezogen. Verglichen wurde
 * also nicht Original gegen Ergebnis, sondern eine Verkleinerung gegen eine
 * Rechnung auf dem vollen Bild. Hier kommen beide Seiten aus derselben Quelle.
 */
export function drawOriginalTo(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  edge: number,
): void {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  drawScaled(ctx, bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, width, height);
}

export function previewSize(aspect: number) {
  const a = aspect;
  return a >= 1
    ? { width: PREVIEW_EDGE, height: Math.round(PREVIEW_EDGE / a) }
    : { width: Math.round(PREVIEW_EDGE * a), height: PREVIEW_EDGE };
}
