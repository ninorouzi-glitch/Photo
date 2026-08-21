import { CRITERIA } from '../core/deviation.ts';
import { ALL_CLEAR, CRITERION_LABEL, blurWarning, findings, formatValue, lesson } from '../core/copy.ts';
import type { Ctx } from './ctx.ts';
import { clear, el, sentenceWithBoldLead } from './dom.ts';

export function render(root: HTMLElement, ctx: Ctx): void {
  const state = ctx.store.get();
  clear(root);
  if (!state.target || state.items.length === 0) return;

  const items = state.items;
  const devs = items.map((i) => state.deviations[i.id]!);
  const referenceName =
    state.settings.reference === 'median'
      ? 'das Set'
      : `Bild ${items.findIndex((i) => i.id === state.settings.reference) + 1}`;

  root.append(
    el('h2', { text: 'Befund' }),
    el('p', {
      class: 'sub',
      text: `Sieben Kriterien, gemessen gegen ${referenceName}. Zeiger oder Tastaturfokus auf eine Zelle zeigt den Zahlenwert.`,
    }),
    matrix(items, devs),
    el('div', { class: 'legend' },
      swatch('ok', 'in Ordnung'),
      swatch('warn', 'fällt auf'),
      swatch('crit', 'deutlicher Ausreißer')),
  );

  // ── F-08 Klartext ──
  const found = findings(
    items.map((it, i) => ({ name: it.name, deviations: devs[i]! })),
    referenceName,
  );
  root.append(el('h2', { text: 'Im Klartext' }));
  if (found.length === 0) {
    root.append(el('ul', { class: 'findings' }, el('li', { text: ALL_CLEAR })));
  } else {
    const list = el('ul', { class: 'findings' });
    for (const f of found) {
      const worst = CRITERIA.reduce(
        (acc, c) => (devs[f.index]![c].status === 'crit' ? 'crit' : acc),
        'warn',
      );
      const li = el('li', { class: worst });
      li.appendChild(sentenceWithBoldLead(f.sentence));
      list.appendChild(li);
    }
    root.append(list);
  }

  // ── F-09 Nicht-reparierbares ──
  const warning = blurWarning(items.map((it, i) => ({ name: it.name, deviations: devs[i]! })));
  if (warning) {
    root.append(
      el('div', { class: 'callout' },
        el('strong', { text: 'Das lässt sich nicht korrigieren. ' }),
        warning),
    );
  }

  // ── F-10 Farbpaletten ──
  root.append(
    el('h2', { text: 'Farbpaletten' }),
    el('p', { class: 'sub', text: 'Die fünf häufigsten Farben je Bild, nebeneinander. Ein farblich abweichendes Bild fällt hier ohne jede Zahl auf.' }),
  );
  const palettes = el('div', { class: 'palettes' });
  items.forEach((item, i) => {
    palettes.append(
      el('div', { class: 'palette-row' },
        el('span', { class: 'who', text: `Bild ${i + 1}` , title: item.name }),
        el('div', { class: 'swatches' },
          ...item.stats.palette.map((c) => el('i', { style: `background:${c}`, title: c }))),
      ),
    );
  });
  root.append(palettes);

  // ── F-11 Lernzeile ──
  const l = lesson(devs);
  root.append(
    el('div', { class: 'callout lesson' },
      el('strong', { text: 'Fürs nächste Mal. ' }),
      l.text),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', type: 'button', text: 'Angleichen', onclick: () => ctx.go(3) }),
      el('button', { class: 'ghost', type: 'button', text: 'Zurück zu den Bildern', onclick: () => ctx.go(1) })),
  );
}

function swatch(status: string, label: string) {
  return el('span', {}, el('i', { class: `dot ${status}`, style: `background:var(--${status})` }), label);
}

/**
 * F-06: Kriterien als Zeilen, Bilder als Spalten. Die Kriterienspalte ist
 * `sticky` und die Matrix scrollt in ihrem eigenen Container — bei 20 Bildern
 * auf 1280 px bleiben die Zeilenbeschriftungen sichtbar und der Seitenkörper
 * scrollt nicht seitwärts.
 */
function matrix(
  items: { id: string; name: string }[],
  devs: import('../core/types.ts').Deviations[],
) {
  const head = el('tr', {}, el('th', { scope: 'col', text: '' }));
  items.forEach((item, i) => {
    head.appendChild(el('th', { scope: 'col', title: item.name, text: `Bild ${i + 1}` }));
  });

  const body = el('tbody');
  for (const c of CRITERIA) {
    const tr = el('tr', {}, el('th', { scope: 'row', text: CRITERION_LABEL[c] }));
    devs.forEach((d, i) => {
      const { value, status } = d[c];
      // F-07: als <button> erreichbar, damit Tastatur und Maus denselben Wert
      // ausgeben — nicht als title-Attribut, das die Tastatur nicht erreicht.
      tr.appendChild(
        el('td', {},
          el('button', {
            class: 'cell',
            type: 'button',
            'aria-label': `${CRITERION_LABEL[c]}, Bild ${i + 1}: ${formatValue(c, value)}`,
          },
            el('span', { class: `dot ${status}` }),
            el('span', { class: 'val', text: formatValue(c, value) }))),
      );
    });
    body.appendChild(tr);
  }

  return el('div', { class: 'matrix-scroll' },
    el('table', { class: 'matrix' }, el('thead', {}, head), body));
}
