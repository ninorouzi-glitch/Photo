import { MAX_IMAGES, MIN_IMAGES, type ImageItem } from '../core/types.ts';
import type { Ctx } from './ctx.ts';
import { clear, el } from './dom.ts';
import type { AnalyzeResponse } from '../pipeline/analyze.worker.ts';

/**
 * Ein Platz je ausgewählter Datei, in Auswahlreihenfolge. Der Worker liefert
 * die Messungen in der Reihenfolge, in der sie fertig werden — ohne diese
 * Liste stünde ein kleines Bild vor einem großen, egal wie ausgewählt wurde
 * (F-01 verlangt die Reihenfolge der Auswahl).
 */
type Slot = { id: string; name: string; url?: string; item?: ImageItem; done: boolean };

let worker: Worker | null = null;
let slots: Slot[] = [];
let skipped: string[] = [];

const pendingCount = () => slots.filter((s) => !s.done).length;

function syncStore(ctx: Ctx): void {
  ctx.store.setItems(
    slots.map((s) => s.item).filter((i): i is ImageItem => Boolean(i)),
  );
}

function getWorker(ctx: Ctx): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../pipeline/analyze.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => onResult(e.data, ctx);
  return worker;
}

function onResult(res: AnalyzeResponse, ctx: Ctx): void {
  const slot = slots.find((s) => s.id === res.id);
  if (!slot) return;
  slot.done = true;

  if (!res.ok) {
    skipped.push(`${slot.name} ${res.error}`);
    slots = slots.filter((s) => s.id !== res.id);
  } else {
    // Die Vorschau-URL zeigt auf die 640-px-Kopie aus dem Worker, nicht auf die
    // Originaldatei — sonst dekodiert der Hauptthread jedes 24-MP-JPEG erneut.
    slot.url = URL.createObjectURL(res.preview);
    slot.item = {
      id: res.id,
      name: slot.name,
      bitmap: res.bitmap,
      objectUrl: slot.url,
      stats: res.stats,
      crop: { x: 0, y: 0 },
    };
  }
  syncStore(ctx);
  ctx.rerender();
  if (pendingCount() === 0) {
    ctx.live(
      `${ctx.store.get().items.length} Bilder gemessen.` +
        (skipped.length ? ` ${skipped.length} übersprungen.` : ''),
    );
  }
}

/** F-01, F-02, F-05: Aufnahme, Grenzen, Messung beim Laden. */
export function accept(files: FileList | File[], ctx: Ctx): void {
  const list = [...files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
  const rejectedType = [...files].length - list.length;
  if (rejectedType > 0) {
    skipped.push(`${rejectedType} Datei(en) mit nicht unterstütztem Format`);
  }

  const free = MAX_IMAGES - slots.length;
  if (list.length > free) {
    skipped.push(`${list.length - free} Bild(er) über der Obergrenze von ${MAX_IMAGES}`);
  }

  for (const file of list.slice(0, Math.max(0, free))) {
    const id = crypto.randomUUID();
    slots.push({ id, name: file.name.replace(/\.[^.]+$/, ''), done: false });
    getWorker(ctx).postMessage({ id, file });
  }
  ctx.rerender();
}

export function render(root: HTMLElement, ctx: Ctx): void {
  const state = ctx.store.get();
  const count = state.items.length;
  const busy = pendingCount() > 0;
  clear(root);

  const input = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    multiple: true,
    hidden: true,
    onchange: (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (t.files) accept(t.files, ctx);
      t.value = '';
    },
  });

  const drop = el(
    'div',
    {
      class: 'drop',
      role: 'button',
      tabindex: '0',
      onclick: () => input.click(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      },
      ondragover: (e: DragEvent) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        drop.classList.remove('over');
        if (e.dataTransfer?.files) accept(e.dataTransfer.files, ctx);
      },
    },
    el('strong', { text: 'Bilder hierher ziehen oder klicken' }),
    el('span', { text: `JPEG, PNG oder WebP · ${MIN_IMAGES} bis ${MAX_IMAGES} Bilder` }),
  );

  root.append(
    el('h2', { text: 'Bilder des Posts' }),
    el('p', {
      class: 'sub',
      text:
        'Leg die exportierten Bilder ab, die zusammen in einen Post sollen. ' +
        'Gemessen wird sofort beim Laden — die Bilder verlassen dabei den Rechner nicht.',
    }),
    input,
    drop,
  );

  if (busy) {
    const total = slots.length;
    root.append(
      el('div', { class: 'progress' },
        el('i', { style: `width:${Math.round((count / Math.max(1, total)) * 100)}%` })),
      el('p', { class: 'note', text: `${count} von ${total} gemessen …` }),
    );
  }

  if (count > 0 || busy) {
    // Die Plätze werden gezeichnet, nicht die fertigen Bilder — so behält
    // jedes Bild von Anfang an seine Position, auch während der Messung.
    const thumbs = el('div', { class: 'thumbs' });
    slots.forEach((slot, i) => {
      thumbs.append(
        el('figure', { class: slot.item ? 'thumb' : 'thumb busy' },
          slot.url
            ? el('img', { src: slot.url, alt: slot.name, loading: 'lazy', decoding: 'async' })
            : el('div', { class: 'placeholder' }),
          slot.item &&
            el('button', {
              class: 'remove',
              type: 'button',
              title: `${slot.name} entfernen`,
              'aria-label': `${slot.name} entfernen`,
              text: '×',
              onclick: () => {
                ctx.store.removeItem(slot.id);
                slots = slots.filter((s) => s.id !== slot.id);
                ctx.rerender();
              },
            }),
          el('figcaption', {},
            el('span', { class: 'n', text: String(i + 1).padStart(2, '0') }),
            el('span', { class: 'name', text: slot.item ? slot.name : 'wird gemessen …' })),
        ),
      );
    });
    root.append(thumbs);
  }

  if (skipped.length > 0) {
    root.append(
      el('p', { class: 'note alert', text: `Übersprungen: ${skipped.join('; ')}.` }),
    );
  }

  // F-02: unterhalb von zwei Bildern bleibt der Knopf gesperrt — mit Begründung.
  const ready = count >= MIN_IMAGES && !busy;
  root.append(
    el('div', { class: 'actions' },
      el('button', {
        class: 'primary',
        type: 'button',
        disabled: !ready,
        text: 'Set analysieren',
        onclick: () => ctx.go(2),
      }),
      el('p', {
        class: 'note',
        text: busy
          ? 'Messung läuft.'
          : count < MIN_IMAGES
            ? `Ein einzelnes Bild lässt sich mit nichts vergleichen — es braucht mindestens ${MIN_IMAGES}.`
            : count >= MAX_IMAGES
              ? `Obergrenze erreicht: ${MAX_IMAGES} Bilder.`
              : `${count} Bilder geladen.`,
      })),
  );
}
