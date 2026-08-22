/**
 * Datenmodell nach PRD §11.
 *
 * `Frame` ist der Bindestrich zwischen Browser und Kern: strukturell identisch
 * zu `ImageData`, aber ein schlichtes Objekt — damit laufen alle Mess- und
 * Korrekturfunktionen in Node ohne Canvas und sind gegen §13 prüfbar.
 */
export type Frame = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

/**
 * Grobes RGB-Gitter über dieselben Pixel wie `saturation`, 16 Bins je Kanal.
 *
 * Wozu: `saturation` misst das Bild, wie es hereinkommt. Der Sättigungsfaktor
 * wird aber auf ein Bild angewendet, das Weißabgleich und Tonwertkurve schon
 * durchlaufen hat — und ein Farbstich liest sich in (max−min)/max als
 * Sättigung, die der Weißabgleich anschließend wegnimmt. Aus Randverteilungen
 * ist das nicht zu rekonstruieren, aus einer gemeinsamen schon: das Gitter
 * lässt sich durch dieselben Tabellen schicken, die `apply.ts` fährt.
 *
 * Ein verbreiteter Fehlschluss dazu: die Sättigung des Bildes kommt aus
 * `satSums` und ist damit **exakt** — jedes Bin trägt die Summe der echten
 * Pixelwerte, nicht eine aus dem Bin geschätzte Größe. Der Vertreter aus
 * `sums` dient allein dazu, die Wirkung der Tabellen abzuschätzen, und dafür
 * ist das Bin-**Mittel** richtig. (Für das Schätzen der Sättigung selbst wäre
 * das Bin-Zentrum besser — gemessen: −21 % gegen −61 % Fehler an einem flauen
 * Bild. Diese Messung betrifft eine andere Frage und gilt hier nicht.)
 *
 * Die Wirkung geht als **Verschiebung** auf die Summen der Zelle ein, nicht
 * als Verhältnis s′/s: ein Verhältnis wächst bei fast neutralem Vertreter über
 * jede Grenze (siehe `estimateAfterLuts`).
 *
 * Was das Gitter nicht kann: Innerhalb eines Bins wechselt für einen Teil der
 * Pixel die Kanalreihenfolge, sobald die Kanäle unterschiedlich skaliert
 * werden — welcher Kanal nach dem Weißabgleich der größte ist, hängt dann vom
 * einzelnen Pixel ab und nicht mehr vom Bin. Ein feineres Gitter hilft dagegen
 * nicht; 32³ ist an §13-Bild 03 nicht besser als 16³. Wie groß dieser Teil
 * ist, schätzt `w` — und `satModels` blendet damit auf die Vor-LUT-Größe
 * zurück, statt der Schätzung blind zu folgen.
 *
 * `counts` als Uint32, alles Übrige als Float32: das sind Aggregate für eine
 * Schätzung, keine Pixelwerte. Float64 verdoppelte nur den Strukturklon vom
 * Worker zum Hauptthread.
 */
export type ColorGrid = {
  counts: Uint32Array; // 16³ Zellen
  sums: Float32Array; // R, G, B je Zelle — der Vertreter
  satSums: Float32Array; // Σ (max−min)/max je Zelle
  satASums: Float32Array; // Σ a·(max−min)/max je Zelle, a = L/max
};

/**
 * Die Sättigungsgrößen, mit denen der Faktor aus §9.5 tatsächlich rechnet.
 *
 * `Stats.saturation` ist und bleibt die Vor-LUT-Messung (§8.3) — sie steht in
 * der Befundmatrix und im UI. Hier stehen die *wirksamen* Größen: aus dem
 * Farbgitter geschätzt für das Bild nach Weißabgleich und Tonwertkurve, mit
 * `w` gegen die Vor-LUT-Größe zurückgeblendet. `w` ist der Anteil, für den das
 * Gitter die Schätzung nicht tragen kann; bei w = 1 steht hier wieder genau
 * das, was vor dieser Umstellung dastand (Abweichung Nr. 3).
 *
 * `target` wird **mitgeblendet**, mit demselben w: sonst mischte der Median
 * bei einem Set mit unterschiedlichen w die beiden Domänen, und die Garantie
 * „nie schlechter als vorher" hielte nicht mehr.
 */
export type SatModel = {
  saturation: number; // wirksames S des Bildes
  satA: number; // wirksames ā
  target: number; // wirksames Ziel-S
  w: number; // 0…1, Anteil ohne verlässliche Schätzung
};

export type Stats = {
  aspect: number; // Breite / Höhe
  p01: number;
  p10: number;
  p50: number;
  p90: number;
  p99: number;
  contrast: number; // p90 − p10, min. MIN_CONTRAST
  cdf: Float64Array; // Luminanz, 256 Einträge, 0…1
  /**
   * Kanalweise kumulierte Histogramme, je 256 Einträge, 0…1.
   *
   * ACHTUNG, enger Zweck: Sie sind allein für die Abschätzung da, wie viel ein
   * geplanter Kanalfaktor in die Sättigung drückt — das entsteht kanalweise und
   * ist aus einer Luminanzverteilung nicht ablesbar.
   *
   * Ausdrücklich *nicht* für kanalweises Histogramm-Matching. Jeden Kanal auf
   * sein eigenes Ziel zu ziehen wäre selbst ein Weißabgleich und liefe gegen
   * `channelGains` — das Ergebnis wäre ein doppelt korrigierter und damit
   * neutralisierter Farbcharakter. Die Tonwertkurve kommt weiter aus `cdf`.
   */
  cdfR: Float64Array;
  cdfG: Float64Array;
  cdfB: Float64Array;
  warmth: number; // log2(R/B)
  tint: number; // log2(G/√(R·B))
  clippedRatio: number; // Anteil der Pixel mit geclipptem Kanal, 0…1
  saturation: number; // 0…1
  /**
   * Mittleres L/max über dieselben Pixel wie `saturation`, mit deren Sättigung
   * gewichtet. Kein Anzeigewert: der Umrechnungsfaktor zwischen dem Maß aus
   * §8.3 und der Operation aus §9.5 (Herleitung bei `saturationFactor`).
   */
  satA: number; // 0…1
  colorGrid: ColorGrid;
  sharpness: number; // kontrastnormiert
  noise: number; // kontrastnormiert
  palette: string[]; // 5 CSS-Farben
};

/**
 * Zielformat. Die drei Voreinstellungen sind Instagrams Ecken; `custom` steht
 * für ein selbst gesetztes Verhältnis in `Settings.customRatio`.
 *
 * Das Format gilt für das ganze Set, nicht je Bild — ein Post, der die Breite
 * wechselt, ist im Carousel ein Ruckeln, und die ganze App handelt davon, dass
 * die Bilder zusammen auftreten (P1).
 */
export type Ratio = '4:5' | '1:1' | '1.91:1' | 'custom';

export type CustomRatio = { w: number; h: number };

/** Grenzen für das eigene Format: von hochkant 1:4 bis quer 4:1. */
export const MIN_ASPECT = 0.25;
export const MAX_ASPECT = 4;

/** Was Instagram unbeschnitten stehen lässt — alles andere schneidet es nach. */
export const IG_MIN_ASPECT = 4 / 5;
export const IG_MAX_ASPECT = 1.91;

/**
 * Ausgabeauflösung.
 *
 * `original` behält die Pixel des Zuschnitts — der Export ist dann ein 1:1-Blit
 * ohne jede Neuabtastung. `1080` ist die Instagram-Größe aus F-22 und wirft bei
 * einem 24-MP-Foto rund 97 % der Pixel weg.
 */
export type Output = 'original' | '1080';

export type Fixes = {
  tone: boolean;
  wb: boolean;
  saturation: boolean;
  grain: boolean;
  sharpen: boolean;
};

export type Settings = {
  ratio: Ratio;
  customRatio: CustomRatio; // gilt nur bei ratio === 'custom'
  output: Output;
  strength: number; // 0…1, Standard 0,7
  reference: 'median' | string; // 'median' oder eine ImageItem-id
  fixes: Fixes;
};

/**
 * Die Kriterien der Befundmatrix (§10), in Anzeigereihenfolge.
 *
 * `tint` steht nicht in §10. Es wird seit jeher gemessen (§8.3) und in
 * `channelGains` auch korrigiert, hatte aber keine Schwelle und tauchte in
 * keiner Anzeige auf: ein Bild, das deutlich ins Grüne oder Magenta kippt,
 * meldete nichts. Es steht direkt neben `warmth`, weil beide aus derselben
 * Messung stammen und dieselbe Korrektur teilen.
 */
export type Criterion =
  | 'aspect'
  | 'exposure'
  | 'warmth'
  | 'tint'
  | 'contrast'
  | 'saturation'
  | 'sharpness'
  | 'noise';

export type Status = 'ok' | 'warn' | 'crit';

export type Deviation = {
  value: number; // vorzeichenbehaftet, Einheit je Kriterium
  status: Status;
};

export type Deviations = Record<Criterion, Deviation>;

export type ImageItem = {
  id: string;
  name: string; // Dateiname ohne Endung
  bitmap: ImageBitmap; // volle Auflösung, für Vorschau und Export
  objectUrl: string; // für <img>-Vorschauen
  stats: Stats;
  crop: { x: number; y: number }; // je −1…1, 0 = mittig
};

export type AppState = {
  items: ImageItem[];
  order: string[]; // ids in Post-Reihenfolge
  settings: Settings;
  target: Stats | null; // aus items + settings.reference berechnet
  deviations: Record<string, Deviations>; // je ImageItem-id
  satModel: Record<string, SatModel>; // je ImageItem-id, abgeleitet wie `target`
};

/** §15: Obergrenze auf Instagrams Carousel-Limit gesetzt. */
export const MIN_IMAGES = 2;
export const MAX_IMAGES = 20;

/** §8: alle Messungen auf einer Kopie mit dieser längsten Kante. */
export const MEASURE_EDGE = 640;

/**
 * Anteil der Fläche, auf dem die globalen Messungen laufen: die zentralen 80 %.
 *
 * Objektivvignettierung zieht die Ränder abhängig von Blende und Objektiv
 * unterschiedlich weit nach unten. Objektivprofile haben wir nicht, also messen
 * wir dort, wo der Abfall am kleinsten ist, statt ihn mitzumitteln. Das
 * Seitenverhältnis bleibt davon ausgenommen — es kommt weiter aus dem ganzen Bild.
 */
export const MEASURE_AREA = 0.8;

/** Randanteil je Seite, der dafür wegfällt: (1 − √0,8) / 2 ≈ 5,6 %. */
export const MEASURE_INSET = (1 - Math.sqrt(MEASURE_AREA)) / 2;

/**
 * Untergrenze für den Kontrast (p90 − p10).
 *
 * Derselbe Wert klemmt den Messwert selbst und normiert Schärfe und Rauschen
 * (§8.4, §8.5). Das muss dieselbe Zahl sein: würde die Normierung höher liegen,
 * teilte ein flaues Bild seine Gradienten durch einen Kontrast, den es gar nicht
 * hat, und gälte fälschlich als unscharf und rauschfrei.
 */
export const MIN_CONTRAST = 4;

/** §12: darüber Hinweis statt Absturz. */
export const MAX_PIXELS = 50_000_000;

/** F-22: die Instagram-Breite. Nur noch die Breite der Variante `1080`. */
export const IG_WIDTH = 1080;

/**
 * JPEG-Qualität je Ausgabegröße. Bei voller Auflösung höher: dort ist das Bild
 * das Endprodukt und nicht schon eine Verkleinerung, die Artefakte mitmittelt.
 */
export const JPEG_QUALITY: Record<Output, number> = { original: 0.95, '1080': 0.92 };

/** Die Voreinstellungen. `custom` steht bewusst nicht darin — es hat keinen festen Wert. */
export const RATIOS: Record<Exclude<Ratio, 'custom'>, number> = {
  '4:5': 4 / 5,
  '1:1': 1,
  '1.91:1': 1.91,
};

export const PRESET_RATIOS = Object.keys(RATIOS) as Exclude<Ratio, 'custom'>[];

export const DEFAULT_SETTINGS: Settings = {
  ratio: '4:5',
  customRatio: { w: 3, h: 2 },
  output: 'original',
  strength: 0.7,
  reference: 'median',
  fixes: { tone: true, wb: true, saturation: true, grain: true, sharpen: false },
};
