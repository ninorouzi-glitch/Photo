import type { AppState } from '../core/types.ts';
import { JPEG_QUALITY } from '../core/types.ts';
import { aspectOf } from '../core/crop.ts';
import { renderTo, exportSize } from './render.ts';

export type ExportedFile = { name: string; blob: Blob; url: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** F-22: Dateiname mit führender Positionsnummer. */
export function exportName(position: number, base: string): string {
  const safe = base.replace(/[^\p{L}\p{N}\-_. ]/gu, '').trim() || 'bild';
  return `${pad(position)}_${safe}.jpg`;
}

/**
 * Rendert alle Bilder in Post-Reihenfolge, sRGB.
 *
 * Die Größe steht je Bild fest, nicht je Set: bei `output: 'original'` ist es
 * der Zuschnitt in den Pixeln des Bildes, und die kommen aus der hochgeladenen
 * Datei. Ein 6000 × 4000er ergibt in 4:5 also 3200 × 4000 und nicht 1080 × 1350.
 * Dass die Dateien dann unterschiedlich groß sind, ist unproblematisch —
 * gleich ist, worauf es ankommt: das Seitenverhältnis.
 *
 * Ein eigenes Canvas je Bild, statt eines wiederverwendeten: bei voller
 * Auflösung schwanken die Maße von Bild zu Bild, und ein Canvas, dem man Breite
 * und Höhe neu zuweist, behält in Chrome den alten Speicher für die Dauer des
 * Exports.
 */
export async function renderAll(state: AppState): Promise<ExportedFile[]> {
  const quality = JPEG_QUALITY[state.settings.output];
  const aspect = aspectOf(state.settings);
  const out: ExportedFile[] = [];

  for (let i = 0; i < state.order.length; i++) {
    const item = state.items.find((x) => x.id === state.order[i]);
    if (!item || !state.target) continue;
    const { width, height } = exportSize(aspect, state.settings.output, item.bitmap);
    const canvas = document.createElement('canvas');
    renderTo(canvas, item, state.target, state.settings, width, height, { sat: state.satModel[item.id] });
    const blob = await toJpeg(canvas, quality);
    canvas.width = 0;
    canvas.height = 0;
    out.push({ name: exportName(i + 1, item.name), blob, url: URL.createObjectURL(blob) });
  }
  return out;
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas konnte kein JPEG erzeugen'))),
      'image/jpeg',
      quality,
    );
  });
}

export type SaveOutcome = 'directory' | 'downloads' | 'manual';

/**
 * Drei Stufen, jede eine Stufe ehrlicher über ihre Grenzen als die vorige:
 *
 *  1. Ordner wählen und direkt hineinschreiben (File System Access API)
 *  2. Einzelne Downloads — funktioniert überall, landet aber im Download-Ordner
 *  3. F-23: die fertigen Bilder in voller Größe zum manuellen Sichern anzeigen,
 *     ohne Fehlermeldung und ohne dass ein Klick ins Leere läuft
 */
export async function saveFiles(files: ExportedFile[]): Promise<SaveOutcome> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;

  if (picker) {
    try {
      const dir = await picker.call(window, { mode: 'readwrite' });
      for (const f of files) {
        const handle = await dir.getFileHandle(f.name, { create: true });
        const writable = await (handle as FileSystemFileHandle & {
          createWritable: () => Promise<FileSystemWritableFileStream>;
        }).createWritable();
        await writable.write(f.blob);
        await writable.close();
      }
      return 'directory';
    } catch (err) {
      // Abbruch durch den Nutzer ist kein Fehlerfall — dann bleibt Stufe 4 offen.
      if (err instanceof DOMException && err.name === 'AbortError') return 'manual';
    }
  }

  try {
    for (const f of files) {
      const a = document.createElement('a');
      a.href = f.url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 120));
    }
    return 'downloads';
  } catch {
    return 'manual';
  }
}
