import type { AppState, ImageItem } from '../core/types.ts';
import { JPEG_QUALITY } from '../core/types.ts';
import { aspectOf } from '../core/crop.ts';
import { suggestOrder } from '../core/order.ts';
import { exportSize, previewScale, previewSize, renderTo } from '../pipeline/render.ts';
import { renderAll, saveFiles, type ExportedFile } from '../pipeline/exporter.ts';
import type { Ctx } from './ctx.ts';
import { clear, el } from './dom.ts';

let originalOrder: string[] | null = null;

export function render(root: HTMLElement, ctx: Ctx): void {
  const state = ctx.store.get();
  clear(root);
  if (!state.target || state.items.length === 0) return;

  const ordered = ctx.store.ordered();
  const size = previewSize(aspectOf(state.settings));

  // ── F-19 Carousel ──
  const carousel = el('div', { class: 'carousel', tabindex: '0', 'aria-label': 'Carousel-Vorschau' });
  ordered.forEach((item, i) => {
    carousel.append(
      el('figure', {},
        draw(item, ctx, size.width, size.height),
        el('figcaption', { text: `${String(i + 1).padStart(2, '0')} · ${item.name}` })),
    );
  });

  // ── F-20 Raster ──
  const grid = el('div', { class: 'grid3', 'aria-label': 'Rastervorschau' });
  for (const item of ordered) grid.append(draw(item, ctx, 220, 220));

  root.append(
    el('h2', { text: 'Die Reihe' }),
    el('p', {
      class: 'sub',
      text: outputLine(state),
    }),
    carousel,
    el('h2', { text: 'Im Profil' }),
    el('p', { class: 'sub', text: 'Dreispaltig, wie das Raster im Instagram-Profil.' }),
    grid,
  );

  // ── F-21 Reihenfolge ──
  const orderActions = el('div', { class: 'actions' },
    el('button', {
      class: 'ghost', type: 'button', text: 'Reihenfolge vorschlagen',
      onclick: () => {
        if (!originalOrder) originalOrder = [...ctx.store.get().order];
        ctx.store.setOrder(suggestOrder(ctx.store.ordered().map((i) => ({ id: i.id, stats: i.stats }))));
        ctx.live('Reihenfolge nach Ähnlichkeit sortiert.');
        ctx.rerender();
      },
    }),
    el('button', {
      class: 'ghost', type: 'button', text: 'Ursprüngliche Reihenfolge',
      disabled: !originalOrder,
      onclick: () => {
        if (!originalOrder) return;
        ctx.store.setOrder(originalOrder);
        originalOrder = null;
        ctx.rerender();
      },
    }),
    el('p', { class: 'note', text: 'Der Vorschlag stellt Bilder nebeneinander, die sich in Helligkeit, Weißabgleich und Sättigung am wenigsten unterscheiden.' }),
  );

  // ── F-22 / F-23 Export ──
  const status = el('p', { class: 'note' });
  const fallback = el('div', {});

  const exportBtn = el('button', {
    class: 'primary', type: 'button', text: `${ordered.length} Bilder exportieren`,
    onclick: async () => {
      exportBtn.disabled = true;
      status.textContent = 'Bilder werden gerechnet …';
      clear(fallback);
      try {
        const files = await renderAll(ctx.store.get());
        status.textContent = 'Speicherort wählen …';
        const outcome = await saveFiles(files);
        if (outcome === 'directory') {
          status.textContent = `${files.length} Bilder gespeichert.`;
        } else if (outcome === 'downloads') {
          status.textContent = `${files.length} Bilder in den Download-Ordner gelegt.`;
        } else {
          status.textContent =
            'Dieser Browser darf keine Dateien schreiben — hier sind die fertigen Bilder in voller Größe zum Sichern per Rechtsklick.';
          showManual(fallback, files);
        }
        ctx.live(status.textContent);
      } finally {
        exportBtn.disabled = false;
      }
    },
  });

  root.append(
    el('h2', { text: 'Reihenfolge und Export' }),
    orderActions,
    el('div', { class: 'actions' },
      exportBtn,
      el('button', { class: 'ghost', type: 'button', text: 'Zurück zum Angleichen', onclick: () => ctx.go(3) }),
      status),
    fallback,
  );
}

/**
 * Was am Ende herauskommt, in einem Satz.
 *
 * Bei voller Auflösung hat jedes Bild seine eigenen Maße — die stehen in der
 * hochgeladenen Datei und nicht in einer Einstellung. Genannt wird deshalb die
 * Spanne, damit die Zahl nicht mehr behauptet, als sie weiß.
 */
function outputLine(state: AppState): string {
  const quality = Math.round(JPEG_QUALITY[state.settings.output] * 100);
  const aspect = aspectOf(state.settings);
  const sizes = state.items.map((i) => exportSize(aspect, state.settings.output, i.bitmap));
  const px = (s: { width: number; height: number }) => `${s.width} × ${s.height} px`;
  const first = sizes[0]!;

  if (state.settings.output === '1080') {
    return `So läuft der Post durch. Ausgabe: ${px(first)}, JPEG in Qualität ${quality}.`;
  }

  const mp = (s: { width: number; height: number }) => s.width * s.height;
  const smallest = sizes.reduce((a, b) => (mp(b) < mp(a) ? b : a));
  const largest = sizes.reduce((a, b) => (mp(b) > mp(a) ? b : a));
  const range = mp(smallest) === mp(largest) ? px(first) : `${px(smallest)} bis ${px(largest)}`;
  return `So läuft der Post durch. Ausgabe in voller Auflösung, ${range} je Bild, ` +
    `JPEG in Qualität ${quality}. Der Zuschnitt wird nicht neu abgetastet.`;
}

function draw(item: ImageItem, ctx: Ctx, w: number, h: number): HTMLCanvasElement {
  const state = ctx.store.get();
  const canvas = el('canvas', {}) as HTMLCanvasElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', item.name);
  // Geräteauflösung, sonst ist die Vorschau auf einem Retina-Schirm weicher
  // als die Datei, die dabei herauskommt.
  const scale = previewScale();
  renderTo(canvas, item, state.target!, state.settings,
    Math.round(w * scale), Math.round(h * scale),
    { reuseGeometry: true, sat: state.satModel[item.id] });
  return canvas;
}

/** F-23: ohne Fehlermeldung, und kein Klick läuft ins Leere. */
function showManual(root: HTMLElement, files: ExportedFile[]): void {
  const list = el('div', { class: 'export-list' });
  for (const f of files) {
    list.append(
      el('figure', {},
        el('img', { src: f.url, alt: f.name }),
        el('figcaption', { text: f.name })),
    );
  }
  root.append(list);
}
