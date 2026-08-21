import type { Frame, Settings } from './types.ts';
import { MAX_ASPECT, MIN_ASPECT, RATIOS } from './types.ts';
import { createFrame } from './frame.ts';

/**
 * Das Seitenverhältnis, auf das zugeschnitten wird — die eine Stelle, an der
 * aus der Einstellung eine Zahl wird.
 *
 * Vorher stand überall `RATIOS[settings.ratio]`. Seit das Format auch selbst
 * gesetzt werden kann, ist das ein Griff ins Leere: `custom` hat keinen festen
 * Wert. Alles, was ein Verhältnis braucht, fragt hier.
 */
export function aspectOf(settings: Settings): number {
  if (settings.ratio !== 'custom') return RATIOS[settings.ratio];
  return clampAspect(settings.customRatio.w / settings.customRatio.h);
}

/**
 * Ein eigenes Format muss eine brauchbare Zahl ergeben. Leere Felder, Null und
 * Unsinn landen bei 1:1, statt eine Division durch Null in die Geometrie zu
 * tragen; darüber hinaus wird auf 1:4 … 4:1 geklemmt.
 */
export function clampAspect(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(MIN_ASPECT, Math.min(MAX_ASPECT, value));
}

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Zuschnitt-Geometrie für ein Zielverhältnis (Breite/Höhe).
 *
 * `offset` läuft je Achse von −1 bis 1 und bezeichnet den Anteil des
 * vorhandenen Spielraums, 0 ist mittig. Auf der Achse ohne Spielraum bleibt
 * der Versatz wirkungslos — das ist die Grundlage für F-17, wo das Ziehen nur
 * entlang der Achse mit Spielraum erlaubt ist.
 */
export function cropRect(
  width: number,
  height: number,
  targetAspect: number,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): Rect {
  const srcAspect = width / height;
  let w: number, h: number;
  if (srcAspect > targetAspect) {
    h = height;
    w = Math.round(height * targetAspect);
  } else {
    w = width;
    h = Math.round(width / targetAspect);
  }
  w = Math.min(w, width);
  h = Math.min(h, height);

  const slackX = width - w;
  const slackY = height - h;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    x: Math.round((slackX / 2) * (1 + clamp(offset.x))),
    y: Math.round((slackY / 2) * (1 + clamp(offset.y))),
    w,
    h,
  };
}

/** Auf welchen Achsen lässt sich überhaupt schieben? (F-17) */
export function cropSlack(width: number, height: number, targetAspect: number) {
  const r = cropRect(width, height, targetAspect);
  return { x: width - r.w, y: height - r.h };
}

export function cropFrame(src: Frame, rect: Rect): Frame {
  const out = createFrame(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const s = ((y + rect.y) * src.width + rect.x) * 4;
    out.data.set(src.data.subarray(s, s + rect.w * 4), y * rect.w * 4);
  }
  return out;
}
