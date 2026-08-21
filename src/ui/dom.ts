type Props = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

/** Winziger Ersatz für ein Framework — mehr braucht diese App nicht. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in node && typeof v !== 'string') {
      (node as unknown as Props)[k] = v;
    } else {
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

/** Fett gesetzte Bildnummer im Klartext-Satz, ohne innerHTML. */
export function sentenceWithBoldLead(sentence: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const m = /^(Bild \d+)( .*)$/s.exec(sentence);
  if (!m) {
    frag.appendChild(document.createTextNode(sentence));
    return frag;
  }
  frag.appendChild(el('b', { text: m[1]! }));
  frag.appendChild(document.createTextNode(m[2]!));
  return frag;
}
