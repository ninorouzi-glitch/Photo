import './style.css';
import { MIN_IMAGES } from './core/types.ts';
import { createStore } from './state/store.ts';
import type { Ctx } from './ui/ctx.ts';
import * as stage1 from './ui/stage01-images.ts';
import * as stage2 from './ui/stage02-report.ts';
import * as stage3 from './ui/stage03-align.ts';
import * as stage4 from './ui/stage04-series.ts';

const store = createStore();
const roots = [1, 2, 3, 4].map((n) => document.getElementById(`stage-${n}`) as HTMLElement);
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.stage-tab')];
const liveRegion = document.getElementById('live') as HTMLElement;

let current = 1;

const ctx: Ctx = {
  store,
  go(stage: number) {
    // §6: Stufe 02 bis 04 sind erst erreichbar, wenn mindestens zwei Bilder da sind.
    if (stage > 1 && store.get().items.length < MIN_IMAGES) return;
    current = stage;
    draw();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  rerender: draw,
  live(message: string) {
    liveRegion.textContent = message;
  },
};

function draw(): void {
  const ready = store.get().items.length >= MIN_IMAGES;
  if (!ready && current > 1) current = 1;

  tabs.forEach((tab, i) => {
    const stage = i + 1;
    tab.disabled = stage > 1 && !ready;
    tab.setAttribute('aria-current', String(stage === current));
    tab.title = tab.disabled
      ? `Erst ab ${MIN_IMAGES} Bildern — ein einzelnes Bild lässt sich mit nichts vergleichen.`
      : '';
  });

  roots.forEach((root, i) => { root.hidden = i + 1 !== current; });

  const render = [stage1.render, stage2.render, stage3.render, stage4.render][current - 1]!;
  render(roots[current - 1]!, ctx);
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => ctx.go(Number(tab.dataset.stage)));
});

// Ablegen irgendwo auf der Seite landet in Stufe 01 — der Browser würde die
// Datei sonst als Navigation öffnen und die Sitzung wegwerfen.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) {
    if (current !== 1) ctx.go(1);
    stage1.accept(e.dataTransfer.files, ctx);
  }
});

draw();
