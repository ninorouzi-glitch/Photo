import type { AppState, Deviations, ImageItem, SatModel, Settings } from '../core/types.ts';
import { computeTarget, satModels } from '../core/target.ts';
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
    satModel: {},
  });

  const listeners = new Set<Listener>();

  function derive(next: AppState): AppState {
    if (next.items.length === 0) return { ...next, target: null, deviations: {}, satModel: {} };

    const anchorIndex =
      next.settings.reference === 'median'
        ? -1
        : next.items.findIndex((i) => i.id === next.settings.reference);
    const anchor = anchorIndex >= 0 ? next.items[anchorIndex]!.stats : null;

    const stats = next.items.map((i) => i.stats);
    const target = computeTarget(stats, anchor);
    const devs: Record<string, Deviations> = {};
    for (const item of next.items) devs[item.id] = deviations(item.stats, target);

    // Die wirksamen Sättigungsgrößen sind abgeleitet wie `target` und
    // `deviations` — sie hängen an den Tabellen und damit an der Stärke, also
    // an jeder Änderung der Einstellungen (Abweichung Nr. 3).
    const models = satModels(stats, target, next.settings, anchorIndex);
    const satModel: Record<string, SatModel> = {};
    next.items.forEach((item, i) => { satModel[item.id] = models[i]!; });

    return { ...next, target, deviations: devs, satModel };
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
