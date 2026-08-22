import type { Frame } from '../../src/core/types.ts';
import { createFrame } from '../../src/core/frame.ts';

/** Deterministischer PRNG — die Testbilder müssen bei jedem Lauf identisch sein. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Eine Basisszene, aus der alle Varianten in §13 abgeleitet werden.
 *
 * Der Aufbau ist kein Zierrat: der Verlauf gibt dem Histogramm Breite, die
 * Farbflächen machen §8.3 überhaupt messbar, die Feinstruktur §8.4. Und alle
 * Werte bleiben im Band 20…200, damit die Kanalskalierung in Testbild 03
 * (B × 1,35) nicht in die Sättigung clippt und den Messwert verfälscht.
 */
export function baseScene(width = 800, height = 1000): Frame {
  const f = createFrame(width, height);
  const rand = rng(20260821);
  const d = f.data;

  for (let y = 0; y < height; y++) {
    // Verlauf von 40 nach 190 über die Höhe
    const base = 40 + (150 * y) / (height - 1);
    for (let x = 0; x < width; x++) {
      // Feinstruktur: gleichmäßige Textur für die Schärfemessung
      const tex =
        14 * Math.sin(x * 0.9) * Math.cos(y * 0.7) +
        8 * Math.sin((x + y) * 2.1) +
        4 * (rand() - 0.5);

      let r = base + tex;
      let g = base + tex;
      let b = base + tex;

      // Vier Farbflächen, je ein Quadrant der oberen Bildhälfte
      const qx = Math.floor((x / width) * 4);
      const inBand = y > height * 0.15 && y < height * 0.45;
      if (inBand) {
        if (qx === 0) { r *= 1.35; g *= 0.85; b *= 0.8; }
        else if (qx === 1) { r *= 0.8; g *= 1.25; b *= 0.85; }
        else if (qx === 2) { r *= 0.85; g *= 0.9; b *= 1.3; }
        else { r *= 1.2; g *= 1.1; b *= 0.75; }
      }

      const p = (y * width + x) * 4;
      d[p] = clamp(r);
      d[p + 1] = clamp(g);
      d[p + 2] = clamp(b);
      d[p + 3] = 255;
    }
  }
  return f;
}

const clamp = (v: number) => Math.max(0, Math.min(255, v));

/** Kanalweise Multiplikation — der Kern jeder Belichtungs- und Stich-Variante. */
export function scaleChannels(src: Frame, kr: number, kg: number, kb: number): Frame {
  const f = createFrame(src.width, src.height);
  for (let p = 0; p < src.data.length; p += 4) {
    f.data[p] = clamp(src.data[p]! * kr);
    f.data[p + 1] = clamp(src.data[p + 1]! * kg);
    f.data[p + 2] = clamp(src.data[p + 2]! * kb);
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

/**
 * Chroma um die Luminanz skaliert — die einzige Abweichung ist die Sättigung.
 *
 * L + (c−L)·g lässt die Luminanz jedes Pixels stehen, also auch Histogramm,
 * Kontrast und Weißabgleich (bis auf die eine Rundung ins
 * `Uint8ClampedArray`). Genau das unterscheidet dieses Paar von Bild 03 aus
 * §13: dessen R × 0,85 / B × 1,35 verschiebt Belichtung, warmth und tint mit
 * und liest sich obendrein als Sättigung.
 */
export function chromaScaled(src: Frame, g: number): Frame {
  const f = createFrame(src.width, src.height);
  for (let p = 0; p < src.data.length; p += 4) {
    const r = src.data[p]!, gr = src.data[p + 1]!, b = src.data[p + 2]!;
    const L = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    f.data[p] = clamp(L + (r - L) * g);
    f.data[p + 1] = clamp(L + (gr - L) * g);
    f.data[p + 2] = clamp(L + (b - L) * g);
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

/** Kontrast um den Mittelwert 128, danach Sättigung um die Luminanz. */
export function flatten(src: Frame, contrast: number, sat: number): Frame {
  const f = createFrame(src.width, src.height);
  for (let p = 0; p < src.data.length; p += 4) {
    const r = 128 + (src.data[p]! - 128) * contrast;
    const g = 128 + (src.data[p + 1]! - 128) * contrast;
    const b = 128 + (src.data[p + 2]! - 128) * contrast;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    f.data[p] = clamp(L + (r - L) * sat);
    f.data[p + 1] = clamp(L + (g - L) * sat);
    f.data[p + 2] = clamp(L + (b - L) * sat);
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

export function crop(src: Frame, x0: number, y0: number, w: number, h: number): Frame {
  const f = createFrame(w, h);
  for (let y = 0; y < h; y++) {
    const s = ((y + y0) * src.width + x0) * 4;
    f.data.set(src.data.subarray(s, s + w * 4), y * w * 4);
  }
  return f;
}

export function addNoise(src: Frame, sigma: number, seed = 7): Frame {
  const f = createFrame(src.width, src.height);
  const rand = rng(seed);
  for (let p = 0; p < src.data.length; p += 4) {
    // Box-Muller, ein Wert für alle drei Kanäle (Luminanzrauschen)
    const u = Math.max(1e-9, rand());
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * sigma;
    f.data[p] = clamp(src.data[p]! + n);
    f.data[p + 1] = clamp(src.data[p + 1]! + n);
    f.data[p + 2] = clamp(src.data[p + 2]! + n);
    f.data[p + 3] = src.data[p + 3]!;
  }
  return f;
}

/** Gaußscher Weichzeichner, separabel. */
export function blur(src: Frame, radius: number): Frame {
  const k = gaussKernel(radius);
  const half = (k.length - 1) / 2;
  const { width: w, height: h } = src;
  const tmp = createFrame(w, h);
  const out = createFrame(w, h);

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < k.length; i++) {
        const sx = Math.max(0, Math.min(w - 1, x + i - half));
        const p = (y * w + sx) * 4;
        r += src.data[p]! * k[i]!;
        g += src.data[p + 1]! * k[i]!;
        b += src.data[p + 2]! * k[i]!;
      }
      const q = (y * w + x) * 4;
      tmp.data[q] = r; tmp.data[q + 1] = g; tmp.data[q + 2] = b; tmp.data[q + 3] = 255;
    }

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < k.length; i++) {
        const sy = Math.max(0, Math.min(h - 1, y + i - half));
        const p = (sy * w + x) * 4;
        r += tmp.data[p]! * k[i]!;
        g += tmp.data[p + 1]! * k[i]!;
        b += tmp.data[p + 2]! * k[i]!;
      }
      const q = (y * w + x) * 4;
      out.data[q] = r; out.data[q + 1] = g; out.data[q + 2] = b; out.data[q + 3] = 255;
    }
  return out;
}

function gaussKernel(sigma: number): number[] {
  const half = Math.max(1, Math.ceil(sigma * 3));
  const k: number[] = [];
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return k.map((v) => v / sum);
}


/**
 * Große Fläche mit Rotkanal am Anschlag, bei mittlerem Luma.
 *
 * Der Hintergrund ist exakt neutral (R = G = B), der wahre Illuminant also
 * warmth = 0. Das Band in der Bildmitte steht mit R = 255 am Anschlag, hat aber
 * L ≈ 85 und käme durch einen reinen Luma-Filter glatt durch. Genau das soll der
 * kanalweise Ausschluss abfangen.
 *
 * 512 × 640 ist bewusst unter MEASURE_EDGE: so misst `analyzeFull` ohne
 * Verkleinerung, und der geclippte Anteil ist exakt abzählbar.
 */
export function clippedRed(width = 512, height = 640): Frame {
  const f = createFrame(width, height);
  const rand = rng(20260822);
  const d = f.data;

  for (let y = 0; y < height; y++) {
    const base = 60 + (80 * y) / (height - 1);
    const inBand = y >= height * 0.3 && y < height * 0.6;
    for (let x = 0; x < width; x++) {
      const v = base + 6 * Math.sin(x * 0.8) + 3 * (rand() - 0.5);
      const p = (y * width + x) * 4;
      if (inBand) {
        d[p] = 255; d[p + 1] = 40; d[p + 2] = 30;
      } else {
        d[p] = clamp(v); d[p + 1] = clamp(v); d[p + 2] = clamp(v);
      }
      d[p + 3] = 255;
    }
  }
  return f;
}

/**
 * Senkrechte Streifen mit Periode 4: je zwei Spalten Rot, zwei Spalten Blau.
 *
 * Der Fall, an dem eine feste, gerade Schrittweite in der Palette-Stichprobe
 * auffliegt — sie trifft dann nur eine der beiden Spaltengruppen. Bewusst ohne
 * Textur und ohne Verlauf: die Palette soll aus genau zwei Farbtöpfen bestehen,
 * damit fehlt oder da ist eindeutig ist. 640 × 640 bleibt unverkleinert.
 */
export const STRIPE_A: [number, number, number] = [190, 50, 50];
export const STRIPE_B: [number, number, number] = [50, 60, 190];

export function stripes(width = 640, height = 640): Frame {
  const f = createFrame(width, height);
  const d = f.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = (x >> 1) & 1 ? STRIPE_B : STRIPE_A;
      const p = (y * width + x) * 4;
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
    }
  }
  return f;
}

/** Der unvignettierte Sollwert von `vignette()`. */
export const VIGNETTE_BASE = 140;

/**
 * Gleichmäßige Fläche mit synthetischer Vignette.
 *
 * Der Abfall geht mit der vierten Potenz des normierten Radius — grob die Form
 * einer Objektivvignettierung: in der Mitte flach, zu den Ecken hin steil. Ohne
 * Messfenster zieht das den Median unter VIGNETTE_BASE.
 */
export function vignette(width = 512, height = 640): Frame {
  const f = createFrame(width, height);
  const rand = rng(20260823);
  const d = f.data;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const half = Math.hypot(cx, cy);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.hypot(x - cx, y - cy) / half;
      // Feinstruktur nur, damit der Median nicht auf einem einzigen Bin klebt.
      const v = (VIGNETTE_BASE + 2 * (rand() - 0.5)) * (1 - 0.6 * r ** 4);
      const p = (y * width + x) * 4;
      d[p] = clamp(v); d[p + 1] = clamp(v); d[p + 2] = clamp(v); d[p + 3] = 255;
    }
  }
  return f;
}

/**
 * Die fünf Testbilder aus §13.
 *
 * Zu Bild 03 „dunkel & kühl": die Skalierung R×0,85 / B×1,35 ist *keine* reine
 * Warm-Kalt-Verschiebung. Eine solche hielte R·B konstant; hier ist
 * R·B = 1,1475 gegen unverändertes G, und das ist ein echter leichter
 * Magentastich — tint = −log2(√1,1475) ≈ −0,099, also seit der Einführung der
 * tint-Achse sichtbar als warn. Das ist korrekt gemessen und kein Übersprechen
 * zwischen warmth und tint: die beiden Achsen stehen im Log-Raum senkrecht
 * aufeinander (warmth misst log R − log B, tint log G − (log R + log B)/2), und
 * eine reine Warm-Kalt-Verschiebung lässt tint nachweislich in Ruhe — geprüft
 * in `test/deviation.test.ts`.
 *
 * Das Fixture deshalb NICHT „geradeziehen". Jede Änderung an diesen Faktoren
 * verschiebt sämtliche Baselines der Abnahmen A-01…A-04.
 */
export function testSet(): { id: string; label: string; frame: Frame }[] {
  const base = baseScene();
  const dark = 2 ** -1.2;
  return [
    { id: '01', label: 'Referenz', frame: base },
    { id: '02', label: 'nah dran', frame: scaleChannels(base, 1.05, 1.05, 1.05) },
    { id: '03', label: 'dunkel & kühl', frame: scaleChannels(base, dark * 0.85, dark, dark * 1.35) },
    { id: '04', label: 'flau', frame: flatten(base, 0.55, 0.45) },
    { id: '05', label: 'quer & rauschig', frame: addNoise(blur(crop(base, 0, 250, 800, 450), 1.5), 10) },
  ];
}

/**
 * Messfälle ohne Spec-Bezug, geprüft in test/stats.test.ts und
 * test/saettigung.test.ts.
 *
 * Bewusst *neben* `testSet()` und nicht darin: A-02 und A-04 rechnen den
 * Zielwert als Median über das ganze Set. Ein geclipptes Band, ein hartes
 * Streifenmuster und eine Vignette sind keine Bilder desselben Posts — im Set
 * verschieben sie den Median und die Ausgangsstreuung so weit, dass die
 * Konvergenzschranken etwas anderes messen als gemeint.
 */
export function measurementSet(): { id: string; label: string; frame: Frame }[] {
  // 09/10 sind ein Paar und nur zusammen brauchbar: gleiche Basisszene, gleiche
  // Luminanz, gleicher Weißabgleich, allein die Chroma unterscheidet sie. Damit
  // lässt sich die Sättigungsachse isoliert prüfen — am §13-Satz geht das
  // nicht, weil dort Bild 03 mit seinem Blaustich zugleich die höchste gemessene
  // Sättigung trägt (0,369, davon fast nichts echte Sättigung) und eine Prüfung
  // an dieser Achse deshalb die WB-Wechselwirkung mitmisst statt der Konvergenz.
  const base = baseScene(400, 500);
  return [
    { id: '06', label: 'Rotkanal am Anschlag', frame: clippedRed() },
    { id: '07', label: 'Streifen Periode 4', frame: stripes() },
    { id: '08', label: 'Vignette', frame: vignette() },
    { id: '09', label: 'nur Sättigung, satt', frame: chromaScaled(base, 1.0) },
    { id: '10', label: 'nur Sättigung, flau', frame: chromaScaled(base, 0.6) },
  ];
}

/**
 * Ein Bild mit breit belegtem Farbgitter — kein Spec-Bezug, reines Messmittel.
 *
 * Die §13-Bilder belegen nur 26…164 der 4096 Zellen: eine Graustufenszene mit
 * vier Farbflächen. Was `satModels()` kostet, hängt aber an der Zahl der
 * belegten Zellen, denn je Zelle laufen 4³ Stützstellen durch die Tabellen
 * (`unsicherAnteil` in satgrid.ts). Am §13-Satz gemessen wäre der Preis also
 * systematisch zu niedrig. Dieses Bild legt die andere Seite fest.
 *
 * Aufbau: 14³ = 2744 Farben auf dem Gitterraster, jede als 8×8-Block, das
 * ganze Feld zentriert im Bild. Drei Größen sind aufeinander abgestimmt und
 * dürfen nicht einzeln geändert werden:
 *
 * - **512×640** ist genau `MEASURE_EDGE`, also wird nicht skaliert. Ein
 *   Downscale mittelte über Blockgrenzen und erzeugte Mischfarben, die im
 *   Gitter als zusätzliche Zellen erschienen — die Belegung wäre dann nicht
 *   mehr gesetzt, sondern zufällig.
 * - **Das 448×448-Feld** liegt vollständig im Messfenster (`MEASURE_INSET`,
 *   x 27…484, y 34…605), sonst zählte `MEASURE_AREA` einen Teil der Farben
 *   gar nicht mit.
 * - **Bins 1…14** statt 0…15: der Vertreterwert `bin·16 + 8` liegt damit in
 *   24…232 und jeder Kanal bleibt zwischen `CLIP_LOW` und `CLIP_HIGH`, so
 *   dass `channelsUsable` keinen einzigen Block verwirft.
 *
 * NICHT in `testSet()` aufnehmen — ein Farbtafelbild ist kein Foto desselben
 * Posts und verschöbe jeden Median (siehe `measurementSet()`).
 */
export function farbraumBild(): Frame {
  const width = 512;
  const height = 640;
  const BINS = 14; // Bins 1…14, die Ränder bleiben frei
  const BLOCK = 8;
  const SIDE = 56; // 56² = 3136 Blöcke für 2744 Farben
  const f = createFrame(width, height);
  const d = f.data;

  const feld = SIDE * BLOCK; // 448
  const ox = (width - feld) / 2;
  const oy = (height - feld) / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 128, g = 128, b = 128; // Rahmen: mittleres Grau, Zelle (8,8,8)

      const bx = Math.floor((x - ox) / BLOCK);
      const by = Math.floor((y - oy) / BLOCK);
      if (bx >= 0 && bx < SIDE && by >= 0 && by < SIDE) {
        // Blöcke reihenweise durchnummeriert, die Farbe zyklisch dazu: so ist
        // jede der 2744 Farben mindestens einmal vertreten und das Feld voll.
        const i = (by * SIDE + bx) % (BINS ** 3);
        r = (1 + Math.floor(i / (BINS * BINS))) * 16 + 8;
        g = (1 + (Math.floor(i / BINS) % BINS)) * 16 + 8;
        b = (1 + (i % BINS)) * 16 + 8;
      }

      const p = (y * width + x) * 4;
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = 255;
    }
  }
  return f;
}
