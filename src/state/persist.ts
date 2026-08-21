import type { Settings } from '../core/types.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';

const KEY = 'lichttisch.settings.v1';

/**
 * §15: Format, Ausgabegröße, Stärke und Schalter überleben die Sitzung.
 *
 * Ausdrücklich *keine* Bilddaten und keine Referenzwahl — die gehört zu einem
 * konkreten Set und wäre beim nächsten Post eine tote id. Damit bleibt P5
 * unangetastet: die Bilder verlassen den Rechner nicht, und sie bleiben auch
 * nicht darauf zurück.
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ratio: saved.ratio ?? DEFAULT_SETTINGS.ratio,
      output: saved.output ?? DEFAULT_SETTINGS.output,
      customRatio: sane(saved.customRatio) ?? DEFAULT_SETTINGS.customRatio,
      strength:
        typeof saved.strength === 'number'
          ? Math.max(0, Math.min(1, saved.strength))
          : DEFAULT_SETTINGS.strength,
      fixes: { ...DEFAULT_SETTINGS.fixes, ...saved.fixes },
      reference: 'median',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Aus dem Speicher kommt, was beim letzten Mal in den Feldern stand — auch ein
 * halb getipptes `NaN`. Was hier nicht als Zahlenpaar durchgeht, fällt auf die
 * Voreinstellung zurück, statt als kaputtes Verhältnis in die Geometrie zu gehen.
 */
function sane(v: Settings['customRatio'] | undefined): Settings['customRatio'] | null {
  if (!v || typeof v !== 'object') return null;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return ok(v.w) && ok(v.h) ? { w: v.w, h: v.h } : null;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ratio: s.ratio,
        customRatio: s.customRatio,
        output: s.output,
        strength: s.strength,
        fixes: s.fixes,
      }),
    );
  } catch {
    // Privates Fenster oder gesperrter Speicher — die App funktioniert ohne.
  }
}
