import type { Frame, Stats } from '../core/types.ts';
import { MAX_PIXELS, MEASURE_EDGE } from '../core/types.ts';
import { analyze } from '../core/stats.ts';

export type DecodeResult = { bitmap: ImageBitmap; stats: Stats; preview: Blob };

/**
 * Datei → volles Bitmap plus Messwerte.
 *
 * `imageOrientation: 'from-image'` erledigt F-03: die EXIF-Drehung muss vor
 * der Messung greifen, sonst stimmt schon das Seitenverhältnis nicht und ein
 * hochkant aufgenommenes Handyfoto gilt als Querformat-Ausreißer.
 *
 * Die 640-px-Kopie kommt aus einem zweiten `createImageBitmap` mit
 * `resizeWidth`/`resizeHeight` — der Browser skaliert dabei flächenmittelnd,
 * was §8.5 voraussetzt (Punktabtastung würde Rauschen unverändert stehen
 * lassen und von der Ausgangsauflösung abhängig machen).
 *
 * Aus derselben Kopie fällt die Vorschaudatei ab. Das ist kein Beiwerk: ein
 * <img> auf die Originaldatei zu setzen heißt, das volle 24-MP-JPEG auf dem
 * Hauptthread zu dekodieren — bei zehn Bildern hat das im Versuch den Renderer
 * für rund eine Sekunde blockiert und bei voller Ladung ganz einfrieren lassen.
 * Die Messung im Worker war nie das Problem, die Vorschau war es.
 */
export async function decodeAndAnalyze(file: File): Promise<DecodeResult> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    bitmap.close();
    throw new Error(
      `ist größer als 50 Megapixel (${Math.round((bitmap.width * bitmap.height) / 1e6)} MP) und wird übersprungen`,
    );
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, MEASURE_EDGE / longest);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const small = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'high',
  });

  const { frame, canvas } = toFrameWithCanvas(small);
  small.close();

  const preview = await previewBlob(canvas);
  const stats = analyze(frame);
  // Das Seitenverhältnis kommt aus dem Original: die Rundung beim Skalieren
  // würde es sonst um bis zu einen halben Prozentpunkt verschieben.
  stats.aspect = bitmap.width / bitmap.height;

  return { bitmap, stats, preview };
}

function toFrameWithCanvas(source: ImageBitmap): { frame: Frame; canvas: OffscreenCanvas } {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, source.width, source.height);
  return { frame: { data: img.data, width: img.width, height: img.height }, canvas };
}

export function toFrame(source: ImageBitmap): Frame {
  return toFrameWithCanvas(source).frame;
}

/** Die Vorschaudatei ist die Messkopie: 640 px lange Kante, mehr braucht kein <img>. */
function previewBlob(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}
