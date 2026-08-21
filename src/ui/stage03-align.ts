import type { Criterion, ImageItem, Output, Ratio, Settings } from '../core/types.ts';
import { IG_MAX_ASPECT, IG_MIN_ASPECT, PRESET_RATIOS } from '../core/types.ts';
import { CRITERION_LABEL, formatValue } from '../core/copy.ts';
import { aspectOf, cropRect, cropSlack } from '../core/crop.ts';
import { drawOriginalTo, previewScale, previewSize, renderTo } from '../pipeline/render.ts';
import type { Ctx } from './ctx.ts';
import { clear, el } from './dom.ts';

/** F-18: die tonalen Kriterien — das Format hängt am Zuschnitt, nicht an der Korrektur. */
const TONAL: Criterion[] = ['exposure', 'warmth', 'tint', 'contrast', 'saturation', 'sharpness', 'noise'];

const RATIO_LABEL: Record<Ratio, string> = {
  '4:5': '4:5',
  '1:1': '1:1',
  '1.91:1': '1,91:1',
  custom: 'Eigenes',
};

/** Was in der Überschrift des Ergebnisses steht — beim eigenen Format die Zahlen. */
function ratioLabel(s: Settings): string {
  return s.ratio === 'custom'
    ? `${s.customRatio.w}:${s.customRatio.h}`
    : RATIO_LABEL[s.ratio];
}

const OUTPUT_LABEL: Record<Output, string> = {
  original: 'Volle Auflösung',
  '1080': '1080 px',
};

/** Wie lange nach der letzten Reglerbewegung die scharfe Vorschau nachgezogen wird. */
const SHARPEN_DELAY = 140;

type Pane = {
  item: ImageItem;
  canvas: HTMLCanvasElement;
  head: HTMLElement;
  devs: HTMLElement;
  hint: HTMLElement;
};

type Refresh = (sharp?: boolean) => void;

export function render(root: HTMLElement, ctx: Ctx): void {
  const state = ctx.store.get();
  clear(root);
  if (!state.target || state.items.length === 0) return;

  const panes: Pane[] = [];
  const strengthOut = el('span', { class: 'strength-value' });

  /**
   * Der Regler zeichnet nur die Vorschauen neu, statt die Stufe neu aufzubauen.
   * Sonst verliert der Regler bei jedem Schritt den Fokus — und das
   * 150-ms-Budget für das ganze Set wäre bei jedem Zwischenwert fällig.
   *
   * Zwei Auflösungen, und der Grund ist genau dieses Budget: eine Vorschau in
   * Geräteauflösung kostet auf einem Retina-Schirm die vierfache Pixelzahl und
   * ist am Regler nicht zu halten. Während des Ziehens läuft deshalb die
   * schnelle Fassung, und sobald die Hand still steht, wird scharf nachgezogen.
   * Zu sehen ist immer die scharfe — die schnelle steht nur so lange, wie sich
   * ohnehin alles bewegt.
   */
  function refresh(sharp = true): void {
    const s = ctx.store.get();
    if (!s.target) return;
    strengthOut.textContent = `${Math.round(s.settings.strength * 100)} %`;
    const size = previewSize(aspectOf(s.settings));
    const scale = sharp ? previewScale() : 1;
    for (const pane of panes) {
      pane.head.textContent = `Ergebnis, ${ratioLabel(s.settings)}`;
      renderTo(
        pane.canvas, pane.item, s.target, s.settings,
        Math.round(size.width * scale), Math.round(size.height * scale),
        { reuseGeometry: true },
      );
      renderDevs(pane.devs, s.deviations[pane.item.id]!);
      updateCropHint(pane, aspectOf(s.settings));
    }
  }

  let sharpenTimer: ReturnType<typeof setTimeout> | undefined;

  /** Für alles, was fortlaufend feuert: Regler und Zuschnitt-Ziehen. */
  function refreshLive(): void {
    refresh(false);
    clearTimeout(sharpenTimer);
    sharpenTimer = setTimeout(() => refresh(true), SHARPEN_DELAY);
  }

  root.append(
    el('h2', { text: 'Angleichen' }),
    el('p', {
      class: 'sub',
      text:
        'Die Bilder werden auf den Median des Sets zubewegt, nicht auf einen fremden Idealwert. ' +
        'Der Regler bestimmt, wie weit.',
    }),
    controls(ctx, strengthOut, refresh, refreshLive),
  );

  const size = previewSize(aspectOf(state.settings));
  state.items.forEach((item, i) => {
    const canvas = el('canvas', { class: 'draggable' }) as HTMLCanvasElement;
    const devs = el('ul', { class: 'devlist' });
    const hint = el('p', { class: 'hint' });
    const head = el('h3', { text: `Ergebnis, ${ratioLabel(state.settings)}` });
    const pane: Pane = { item, canvas, head, devs, hint };
    panes.push(pane);

    enableCropDrag(pane, ctx, refreshLive);
    const scale = previewScale();
    renderTo(
      canvas, item, state.target!, state.settings,
      Math.round(size.width * scale), Math.round(size.height * scale),
      { reuseGeometry: true },
    );
    renderDevs(devs, state.deviations[item.id]!);
    updateCropHint(pane, aspectOf(state.settings));

    root.append(
      el('div', { class: 'pair' },
        el('p', { class: 'pair-title', text: `Bild ${i + 1} — ${item.name}` }),
        el('div', { class: 'pane' },
          el('h3', { text: 'Original, unbeschnitten' }),
          originalCanvas(item, size)),
        el('div', { class: 'pane' }, head, canvas, hint),
        el('div', { class: 'pane' },
          el('h3', { text: 'Abweichung' }),
          devs)),
    );
  });

  root.append(
    el('div', { class: 'actions' },
      el('button', { class: 'primary', type: 'button', text: 'Reihe ansehen', onclick: () => ctx.go(4) }),
      el('button', { class: 'ghost', type: 'button', text: 'Zurück zum Befund', onclick: () => ctx.go(2) })),
  );
}

/**
 * Beide Seiten des Vergleichs aus derselben Quelle: das Original kommt vom
 * vollen Bitmap, nicht von der 640-px-Vorschaudatei, und in derselben
 * Geräteauflösung wie das Ergebnis daneben. Sonst vergleicht man ein
 * verkleinertes JPEG mit einer Rechnung auf dem Original und hält das Ergebnis
 * für schlechter, als es ist.
 */
function originalCanvas(item: ImageItem, size: { width: number; height: number }): HTMLCanvasElement {
  const canvas = el('canvas', {}) as HTMLCanvasElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${item.name}, Original`);
  const edge = Math.max(size.width, size.height) * previewScale();
  drawOriginalTo(canvas, item.bitmap, edge);
  return canvas;
}

function controls(
  ctx: Ctx,
  strengthOut: HTMLElement,
  refresh: Refresh,
  refreshLive: () => void,
): HTMLElement {
  const state = ctx.store.get();

  // ── F-12 Zielformat ──
  //
  // Drei Voreinstellungen und ein eigenes Verhältnis. Die Zahlenfelder stehen
  // immer da, sind aber nur bei `Eigenes` bedienbar: sie verschwinden zu lassen
  // würde die Leiste bei jedem Klick umspringen lassen, und die Leiste klebt
  // oben am Rand.
  const customW = el('input', {
    type: 'number', min: '1', max: '999', step: '1', class: 'ratio-part',
    id: 'ratio-w', 'aria-label': 'Eigenes Format, Breite',
    value: String(state.settings.customRatio.w),
  }) as HTMLInputElement;

  const customH = el('input', {
    type: 'number', min: '1', max: '999', step: '1', class: 'ratio-part',
    id: 'ratio-h', 'aria-label': 'Eigenes Format, Höhe',
    value: String(state.settings.customRatio.h),
  }) as HTMLInputElement;

  const ratioNote = el('p', { class: 'hint ratio-note' });

  /**
   * Der Hinweis nennt das gerechnete Verhältnis und sagt, wenn Instagram es
   * nachschneiden würde. Nicht verbieten, nur sagen: die App schneidet auf das,
   * was gewünscht ist, und behauptet nicht, klüger zu sein als der Nutzer (P3).
   */
  function updateRatioNote(): void {
    const s = ctx.store.get().settings;
    if (s.ratio !== 'custom') { ratioNote.textContent = ''; return; }
    const a = aspectOf(s);
    const raw = s.customRatio.w / s.customRatio.h;
    const shown = a.toLocaleString('de-DE', { maximumFractionDigits: 2 });

    if (!Number.isFinite(raw) || raw <= 0) {
      ratioNote.textContent = 'Breite und Höhe brauchen beide eine Zahl über null — bis dahin gilt 1:1.';
    } else if (Math.abs(raw - a) > 1e-6) {
      ratioNote.textContent =
        `Geklemmt auf ${shown}:1 — weiter als 1:4 bis 4:1 wird nicht zugeschnitten.`;
    } else if (a < IG_MIN_ASPECT || a > IG_MAX_ASPECT) {
      ratioNote.textContent =
        `${shown}:1 — außerhalb dessen, was Instagram stehen lässt (0,8 bis 1,91). ` +
        'Der Post wird dort noch einmal beschnitten.';
    } else {
      ratioNote.textContent = `${shown}:1`;
    }
  }

  function applyCustom(): void {
    const w = Number(customW.value);
    const h = Number(customH.value);
    ctx.store.setSettings({ ratio: 'custom', customRatio: { w, h } });
    updateRatioNote();
    refresh();
  }

  const ratioButtons = ([...PRESET_RATIOS, 'custom'] as Ratio[]).map((r) =>
    el('button', {
      type: 'button',
      text: RATIO_LABEL[r],
      'aria-pressed': String(state.settings.ratio === r),
      onclick: (e: Event) => {
        ctx.store.setSettings({ ratio: r });
        const group = (e.currentTarget as HTMLElement).parentElement!;
        for (const b of group.children) {
          b.setAttribute('aria-pressed', String(b === e.currentTarget));
        }
        customW.disabled = r !== 'custom';
        customH.disabled = r !== 'custom';
        updateRatioNote();
        refresh();
      },
    }),
  );

  customW.disabled = state.settings.ratio !== 'custom';
  customH.disabled = state.settings.ratio !== 'custom';
  customW.addEventListener('input', applyCustom);
  customH.addEventListener('input', applyCustom);
  updateRatioNote();

  /**
   * Ausgabegröße. Standard ist die volle Auflösung: das Ergebnis soll so viele
   * Pixel behalten, wie die hochgeladene Datei hat. 1080 px bleibt als Wahl für
   * alle, die genau Instagrams Maß wollen (F-22) — es ist bei einem heutigen
   * Foto aber eine Verkleinerung um den Faktor zehn.
   */
  const outputButtons = (['original', '1080'] as Output[]).map((o) =>
    el('button', {
      type: 'button',
      text: OUTPUT_LABEL[o],
      'aria-pressed': String(state.settings.output === o),
      onclick: (e: Event) => {
        ctx.store.setSettings({ output: o });
        const group = (e.currentTarget as HTMLElement).parentElement!;
        for (const b of group.children) {
          b.setAttribute('aria-pressed', String(b === e.currentTarget));
        }
      },
    }),
  );

  // F-13 Stärkeregler
  const slider = el('input', {
    type: 'range', min: '0', max: '100', step: '1',
    value: String(Math.round(state.settings.strength * 100)),
    id: 'strength',
    oninput: (e: Event) => {
      ctx.store.setSettings({ strength: Number((e.target as HTMLInputElement).value) / 100 });
      refreshLive();
    },
  });
  strengthOut.textContent = `${Math.round(state.settings.strength * 100)} %`;

  // F-14 Referenzwahl
  const select = el('select', {
    id: 'reference',
    onchange: (e: Event) => {
      ctx.store.setSettings({ reference: (e.target as HTMLSelectElement).value });
      refresh();
    },
  },
    el('option', { value: 'median', text: 'Mittelwert des Sets', selected: state.settings.reference === 'median' }),
    ...state.items.map((item, i) =>
      el('option', {
        value: item.id,
        text: `Bild ${i + 1} als Anker — ${item.name}`,
        selected: state.settings.reference === item.id,
      })),
  );

  // F-15 einzelne Korrekturen abschalten
  const switches = el('div', { class: 'switches' },
    ...([
      ['tone', 'Belichtung & Kontrast'],
      ['wb', 'Weißabgleich'],
      ['saturation', 'Sättigung'],
      ['grain', 'Korn'],
      ['sharpen', 'Schärfe'],
    ] as const).map(([key, label]) =>
      el('label', {},
        el('input', {
          type: 'checkbox',
          checked: state.settings.fixes[key],
          onchange: (e: Event) => {
            ctx.store.setSettings({ fixes: { [key]: (e.target as HTMLInputElement).checked } as never });
            refresh();
          },
        }),
        label),
    ),
  );

  return el('div', { class: 'controls' },
    el('div', { class: 'control' },
      el('span', { class: 'label', text: 'Zielformat' }),
      el('div', { class: 'segmented' }, ...ratioButtons),
      el('div', { class: 'ratio-custom' }, customW, el('span', { text: ':' }), customH),
      ratioNote),
    el('div', { class: 'control' },
      el('span', { class: 'label', text: 'Ausgabe' }),
      el('div', { class: 'segmented' }, ...outputButtons)),
    el('div', { class: 'control' },
      el('label', { for: 'strength', text: 'Stärke' }),
      slider, strengthOut),
    el('div', { class: 'control' },
      el('label', { for: 'reference', text: 'Referenz' }),
      select),
    el('div', { class: 'control' },
      el('span', { class: 'label', text: 'Korrekturen' }),
      switches),
  );
}

function renderDevs(target: HTMLElement, devs: import('../core/types.ts').Deviations): void {
  clear(target);
  for (const c of TONAL) {
    const { value, status } = devs[c];
    target.append(
      el('li', {},
        el('span', { class: `dot ${status}` }),
        el('span', { class: 'k', text: CRITERION_LABEL[c] }),
        el('span', { class: 'v', text: formatValue(c, value) })),
    );
  }
}

function updateCropHint(pane: Pane, aspect: number): void {
  const slack = cropSlack(pane.item.bitmap.width, pane.item.bitmap.height, aspect);
  const movable = slack.x > 1 || slack.y > 1;
  pane.canvas.classList.toggle('draggable', movable);
  pane.hint.textContent = movable
    ? slack.x > 1
      ? 'Ausschnitt seitlich verschiebbar — ziehen.'
      : 'Ausschnitt vertikal verschiebbar — ziehen.'
    : 'Das Bild füllt das Format bereits aus — hier gibt es nichts zu verschieben.';
}

/**
 * F-17: Ziehen nur entlang der Achse mit Spielraum, geklemmt an den Bildrand.
 * Zeiger-Events decken Maus und Berührung gemeinsam ab.
 */
function enableCropDrag(pane: Pane, ctx: Ctx, refresh: () => void): void {
  let dragging = false;
  let startX = 0, startY = 0, startCropX = 0, startCropY = 0;

  pane.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const s = ctx.store.get();
    const slack = cropSlack(pane.item.bitmap.width, pane.item.bitmap.height, aspectOf(s.settings));
    if (slack.x <= 1 && slack.y <= 1) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startCropX = pane.item.crop.x; startCropY = pane.item.crop.y;
    pane.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  pane.canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    const s = ctx.store.get();
    const aspect = aspectOf(s.settings);
    const bm = pane.item.bitmap;
    const rect = cropRect(bm.width, bm.height, aspect);
    const slack = cropSlack(bm.width, bm.height, aspect);
    const box = pane.canvas.getBoundingClientRect();

    // Bildschirm-Pixel → Bitmap-Pixel → Anteil des Spielraums (−1…1).
    if (slack.x > 1) {
      const perBitmapPx = rect.w / box.width;
      pane.item.crop.x = clamp(startCropX - ((e.clientX - startX) * perBitmapPx * 2) / slack.x);
    }
    if (slack.y > 1) {
      const perBitmapPx = rect.h / box.height;
      pane.item.crop.y = clamp(startCropY - ((e.clientY - startY) * perBitmapPx * 2) / slack.y);
    }
    refresh();
  });

  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    pane.canvas.releasePointerCapture?.(e.pointerId);
  };
  pane.canvas.addEventListener('pointerup', end);
  pane.canvas.addEventListener('pointercancel', end);
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));
