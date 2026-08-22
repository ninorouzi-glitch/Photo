/// <reference lib="webworker" />
import { decodeAndAnalyze } from './decode.ts';

export type AnalyzeRequest = { id: string; file: File };
export type AnalyzeResponse =
  | {
      id: string;
      ok: true;
      bitmap: ImageBitmap;
      stats: import('../core/types.ts').Stats;
      preview: Blob;
    }
  | { id: string; ok: false; error: string };

/**
 * Decode und Messung laufen hier statt im Hauptthread, damit F-05 hält: die
 * Oberfläche bleibt bedienbar, während zehn 24-MP-JPEGs gemessen werden.
 * Das Bitmap wird transferiert, nicht kopiert.
 */
self.onmessage = async (e: MessageEvent<AnalyzeRequest>) => {
  const { id, file } = e.data;
  try {
    const { bitmap, stats, preview } = await decodeAndAnalyze(file);
    const msg: AnalyzeResponse = { id, ok: true, bitmap, stats, preview };
    // Neben dem Bitmap wandern auch die Puffer des Farbgitters mit, statt
    // kopiert zu werden: 4096 Zellen ergeben rund 100 kB je Bild, bei 20
    // Bildern 2 MB, die der Strukturklon sonst doppelt anlegte. Der Worker
    // gibt `stats` aus der Hand und rührt es danach nicht mehr an.
    const g = stats.colorGrid;
    (self as unknown as Worker).postMessage(msg, [
      bitmap,
      g.counts.buffer,
      g.sums.buffer,
      g.satSums.buffer,
      g.satASums.buffer,
    ]);
  } catch (err) {
    const msg: AnalyzeResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : 'konnte nicht gelesen werden',
    };
    (self as unknown as Worker).postMessage(msg);
  }
};
