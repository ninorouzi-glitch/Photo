import type { AppState, Deviations, ImageItem, Settings } from '../core/types.ts';
import { computeTarget } from '../core/target.ts';
import { deviations } from '../core/deviation.ts';
import { loadSettings, saveSettings } from './persist.ts';

type Listener = (s: AppState) => void;

/**
 * Ein Objekt, ein `subscribe`, ein `set`.
 *
 * `target` und `deviations` sind abgeleitet und werden bei jeder Änderung neu
 * gerechnet, nie von Hand gepflegt (§11). Deshalb wirken Änderungen in Stufe 03
 * sofort auf Stufe 04 — es gibt keinen „Anwenden"-Schritt (§6).
 */
export function createStore() {
  let state: AppState = derive({
    items: [],
    order: [],
    settings: loadSettings(),
    target: null,
    deviations: {},
  });

  const listeners = new Set<Listener>();

  function derive(next: AppState): AppState {
    if (next.items.length === 0) return { ...next, target: null, deviations: {} };

    const anchor =
      next.settings.reference === 'median'
        ? null
        : (next.items.find((i) => i.id === next.settings.reference)?.stats ?? null);

    const target = computeTarget(next.items.map((i) => i.stats), anchor);
    const devs: Record<string, Deviations> = {};
    for (const item of next.items) devs[item.id] = deviations(item.stats, target);
    return { ...next, target, deviations: devs };
  }

  function emit() {
    for (const l of listeners) l(state);
  }

  return {
    get: () => state,

    set(patch: Partial<AppState>) {
      state = derive({ ...state, ...patch });
      emit();
    },

    setSettings(patch: Partial<Settings>) {
      const settings = { ...state.settings, ...patch, fixes: { ...state.settings.fixes, ...patch.fixes } };
      saveSettings(settings);
      state = derive({ ...state, settings });
      emit();
    },

    /**
     * Setzt die Liste vollständig. Stufe 01 hält die Auswahlreihenfolge selbst
     * vor und schreibt sie hierher — der Worker liefert die Messungen in der
     * Reihenfolge, in der sie fertig werden, nicht in der Reihenfolge der
     * Auswahl (F-01).
     */
    setItems(items: ImageItem[]) {
      // Die Reihenfolge kommt aus der übergebenen Liste, nicht aus der
      // bisherigen: Stufe 01 hält die Auswahlreihenfolge und ist hier die
      // Instanz, die sie kennt. Sie hier fortzuschreiben hieße, die
      // Reihenfolge zu übernehmen, in der die Messungen fertig werden.
      state = derive({ ...state, items, order: items.map((i) => i.id) });
      emit();
    },

    removeItem(id: string) {
      const item = state.items.find((i) => i.id === id);
      if (item) {
        URL.revokeObjectURL(item.objectUrl);
        item.bitmap.close();
      }
      const items = state.items.filter((i) => i.id !== id);
      // Der Anker darf nicht auf ein entferntes Bild zeigen (F-04, F-14).
      const settings =
        state.settings.reference === id
          ? { ...state.settings, reference: 'median' as const }
          : state.settings;
      state = derive({
        ...state,
        items,
        settings,
        order: state.order.filter((o) => o !== id),
      });
      emit();
    },

    setOrder(order: string[]) {
      state = { ...state, order };
      emit();
    },

    ordered(): ImageItem[] {
      return state.order
        .map((id) => state.items.find((i) => i.id === id))
        .filter((i): i is ImageItem => Boolean(i));
    },

    subscribe(fn: Listener) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
