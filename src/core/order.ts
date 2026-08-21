import type { Stats } from './types.ts';

/**
 * §9.6 Reihenfolge-Vorschlag: Start beim hellsten Bild, dann jeweils der
 * euklidisch nächste noch nicht platzierte Nachbar. Deterministisch, kein
 * Zufall — F-21 verlangt, dass dasselbe Set dieselbe Reihenfolge ergibt.
 */
export function suggestOrder(items: { id: string; stats: Stats }[]): string[] {
  if (items.length <= 2) return items.map((i) => i.id);

  const vec = (s: Stats) => [s.p50 / 255, s.warmth * 1.6, s.saturation * 1.2];
  const points = items.map((i) => ({ id: i.id, v: vec(i.stats), p50: i.stats.p50 }));

  const remaining = [...points];
  let idx = 0;
  for (let i = 1; i < remaining.length; i++) {
    if (remaining[i]!.p50 > remaining[idx]!.p50) idx = i;
  }
  const order: string[] = [];
  let current = remaining.splice(idx, 1)[0]!;
  order.push(current.id);

  while (remaining.length > 0) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(current.v, remaining[i]!.v);
      if (d < bestD) { bestD = d; best = i; }
    }
    current = remaining.splice(best, 1)[0]!;
    order.push(current.id);
  }
  return order;
}

function dist(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(sum);
}
