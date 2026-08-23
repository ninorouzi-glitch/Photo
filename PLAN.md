# PLAN.md — Etappen

> Fahrplan für die Erweiterung. `CLAUDE.md` bleibt der verbindliche Vertrag über
> Architektur, Tuning-Punkte und Regeln; hier steht nur, was in welcher
> Reihenfolge gebaut wird und welche Entscheidungen dafür schon gefallen sind.
>
> Für Claude Code: diese Datei ersetzt jede Kontexterklärung im Chat. Der
> Einstieg ist immer „lies `CLAUDE.md` und `PLAN.md`, dann Etappe N".

## Das Ziel der Erweiterung

1. Die Faktoren ergänzen, die für die Harmonie eines Bild-Sets zählen:
   Weißabgleich, wahrgenommene Helligkeit, Schwarzpunkt, Kurvenform, Sättigung,
   Farbstich in den Tonwertzonen. Nicht Schärfe, nicht Rauschen.
2. Bilder erkennen, die nicht ins Set passen, in zwei Sorten:
   - **Typ A, technischer Ausreißer** — weicht auf einer gemessenen Achse so
     stark ab, dass die Angleichung ihn zwar korrigiert, aber mit sichtbaren
     Kosten. Konsequenz: „prüf das Ergebnis genau".
   - **Typ B, farblicher Ausreißer** — an echtem Material widerlegt und
     gestrichen, siehe `MESSUNG-ausreisser.md` und Etappe 5.

   Erkannte Ausreißer werden markiert. Pro Bild gibt es einen Schalter „Nicht in
   die Zielwerte einrechnen": das Bild fließt nicht in die Zielwertbildung ein,
   wird aber trotzdem korrigiert und bleibt im Export.

## Erledigt

- **Etappe 1 — Messung gehärtet.** Kanalweiser Clipping-Ausschluss für
  Weißabgleich und Sättigung, gemeinsamer `MIN_CONTRAST`, entphaste
  Palette-Stichprobe, Epsilon statt `+1` in `warmth`/`tint`, `MEASURE_INSET`
  (zentrale 80 % der Fläche), `clippedRatio` und kanalweise CDFs.
- **Etappe 2A — `tint` ist eine bewertete Achse.** Achtes Kriterium der
  Befundmatrix, dokumentierte Erweiterung gegenüber §10, mit Genus-Feld und
  Artikel-Helfer.
- **Etappe 2B — Tonwertkurve präzisiert.** Zum Rand hin verjüngtes
  Glättungsfenster, beidseitig interpolierte Inverse. Mittlerer Kurvenfehler
  0,105 → 0,033.
- **Etappe 3 — Sättigungsfaktor rechnet richtig um.** `f = r·ā / (1 − r + r·ā)`,
  Deckel auf dem erreichten Verhältnis statt auf `f`, `MAX_SAT_FACTOR = 2.0`.
  Restfehler unter 0,2 %.
- **Etappe 3c — Farbgitter gebaut und verdrahtet** (`src/core/satgrid.ts`,
  `satModels()` in `target.ts`, `derive()` in `store.ts`). 16³-Gitter,
  Schätzung der Sättigung nach den Tabellen, Verlässlichkeitsmaß `w`, Quelle
  **und** Ziel mit demselben `w` geblendet. Bei w = 1 bitgleich der Stand davor.

Stand: `tsc` sauber, 142 Unit-Tests grün, `vite build` läuft.

## Offen

### Etappe 9 — Monochrome Bilder (zuerst)

Der §13-Satz besteht ausschließlich aus farbigen Bildern, deshalb ist der Fall
nie aufgefallen. An echtem Material beschädigt die Angleichung schwarzweiße
Bilder in beide Richtungen (`MESSUNG-ausreisser.md`, Befund 3):

- Ein Schwarzweißbild hat per Konstruktion r = g = b, also `warmth = tint = 0`.
  Die Kanalfaktoren legen ihm einen Farbstich auf, den es nie hatte, und der
  Sättigungsfaktor verstärkt den frisch entstandenen Stich anschließend
  (gemessen: 0,000 → 0,020 bei Faktor 1,557, Stärke 0,7).
- Umgekehrt entsättigt ein Schwarzweißsatz das eine Farbbild darin um 31 %
  (0,389 → 0,269, Stärke 0,7); bei Stärke 1,0 zieht es weiter Richtung Grau.
- Dazu ein numerischer Fehler: die `saturation`-Achse geht als log2-Verhältnis
  in `deviation.ts` ein, und bei einem Schwarzweißbild ist der Nenner 0. Der
  rein schwarzweiße Satz misst so einen `saturation`-MAD von 0,415, während
  seine Bilder tatsächlich bei 0,030, 0,023 und 0,000 liegen. Die Befundmatrix
  meldet dort heute Unsinn, und die Ausreißererkennung erbt den Fehler.

Vorgehen: Bilder, die als **monochrom** gelten, verlieren Weißabgleich und
Sättigungsfaktor; Belichtung und Tonwertkurve laufen normal weiter, denn die
binden sie an den Satz. Auf `warmth`, `tint` und `saturation` gehen sie nicht in
die Zielwertbildung ein, sonst ziehen sie den Median.

**Eine Schwelle allein auf `Stats.saturation` reicht dafür nicht** — die
ursprüngliche Festlegung ist an §13-Bild 04 „flau" gescheitert. Es ist ein
farbiges Bild (die Basisszene mit 45 % Chroma) und misst 0,0297, liegt also im
Band echter Schwarzweißbilder (0,000…0,030). Eine Schwelle, die Schwarzweiß
vollständig erfasst, erklärt Bild 04 zum Schwarzweißbild und verschiebt damit
den §13-Satz. Auch p95/p99 der Pixelsättigung und der Anteil der Pixel über 0,1
trennen die beiden nicht.

Stattdessen kommt ein **zweites Merkmal** dazu: die sättigungsgewichtete
**Richtungskonzentration der Chroma** (`chromaR`), aus dem vorhandenen Farbgitter
(`Stats.colorGrid`) und damit ohne zusätzlichen Pixel-Durchlauf. Der Gedanke
dahinter ist der Unterschied, den die Sättigungshöhe nicht sieht: ein getontes
Schwarzweißbild hat *eine* Chroma-Richtung, ein flaues Farbbild trägt die
Farbtöne seiner Szene.

Je belegter Zelle, vom Bin-Vertreter:

```
a = r − (g+b)/2        b = (√3/2)·(g − b)        L = hypot(a, b)
w = counts · sat(Zelle)
X += w·a/L             Y += w·b/L                W += w

chromaR = hypot(X, Y) / W          (bei W = 0: 1)
```

An echtem Material gemessen liegt §13-04 bei `chromaR` = 0,280, getontes
Schwarzweiß bei 0,954 und 0,996 — bei praktisch gleicher Sättigung. Reines Grau
(`sat` = 0,000) hat ein beliebiges `chromaR`; dort entscheidet die Sättigung
allein.

Regel: **monochrom, wenn `sat ≤ EPS`, oder `sat ≤ BAND` und `chromaR ≥ R_MIN`.**

Offener Punkt, vor dem Festschreiben der Konstanten zu messen: eine flaue Szene
mit einheitlichem Farbstich — Nebel, Schnee — könnte in dieselbe Ecke fallen und
dabei ihren Weißabgleich verlieren.

Tests: ein rein schwarzweißer Satz bleibt nach der Angleichung neutral, ein
Farbbild in einem solchen Satz bleibt farbig.

### Schritt 0 — zwei Lücken aus 3c schließen (klein, vor Etappe 5)

- **A-01…A-04 laufen am Produktivpfad vorbei.** `test/acceptance.test.ts` ruft
  `buildRecipe` ohne `SatModel`; die App fährt seit 3c mit. Die Abnahmekriterien
  sind damit auf einem Pfad geprüft, den niemand mehr nimmt. Beide Pfade prüfen,
  nicht den alten ersetzen.
- **Kosten von `satModels()` je Slider-Tick sind unbeziffert.** `derive()` ruft
  pro Bild `buildLuts` plus einen Gitterdurchlauf mit 4³ Stützstellen je
  belegter Zelle. Die §13-Fixtures belegen nur 26…164 der 4096 Zellen, ein
  echtes Foto ein Vielfaches davon. 150 ms pro Tick in Stage 03 ist eine harte
  Grenze — also messen, bevor irgendetwas darauf aufbaut.

### Etappe 5 — Ausreißererkennung, Rechenkern (`src/core/outlier.ts`)

**Typ A** über den robusten modifizierten z-Score: `z = 0,6745·(x − median)/MAD`,
Ausreißer bei `|z| > 3,5`. Vier Fallstricke, alle zwingend:

- Der Median wird **frisch** berechnet, nicht aus `computeTarget` genommen — der
  Zielwert ist kein Element der Messmenge (Ankerwahl!).
- Pro Achse dasselbe Maß wie in `deviation.ts`: `warmth`, `tint` und `noise` als
  Differenz, alle übrigen als log2-Verhältnis.
- MAD kann 0 werden → Fallback auf die mittlere absolute Abweichung; ist auch die
  0, gibt es keinen Ausreißer.
- Bei sehr homogenen Sets erzeugen winzige Abweichungen riesige z-Scores.
  Deshalb zusätzlich als **UND**-Bedingung die warn-Schwelle aus `THRESHOLDS`.
- Unter 4 Bildern wird Typ A nicht ausgewertet.

**Typ B ist gestrichen.** Der farbliche Ausreißer wurde an echtem Material
widerlegt: acht Sätze, 50 Bilder, null Treffer, und im Eindringlingstest fand er
eins von acht Fremdbildern, wo Typ A acht von acht fand. Ein globales
Farbhistogramm misst den Bildinhalt, nicht die Farbwelt. Die Messung samt Zahlen
steht in `MESSUNG-ausreisser.md`; das Farbgitter aus 3c bleibt und trägt weiter
die Sättigungsschätzung.

Rückgabe pro Bild: Typ, Achse, z-Score, absolute Abweichung, fertig formulierter
deutscher Klartext. **Keine EV-Werte nennen** — die `exposure`-Achse misst log2
gammakodierter Mediane und ist gegenüber echten EV um rund Faktor 2,2 gestaucht.
Qualitativ formulieren: „deutlich dunkler als das Set", „spürbar wärmer als die
übrigen Bilder". Für die Grammatik den Artikel-Helfer aus Etappe 2A.

Wichtigster Test: ein sauberes homogenes Set meldet **nichts**.

### Etappe 4 — Clipping-Guard (bewusst nach 5, jetzt vor 6)

Zwei Mechanismen, beide ohne Pixel-Durchlauf abschätzbar. Erstens: die
Kanalfaktoren schieben Werte über den Rand, bevor die Kurve gefragt wird
(`sample(curve, i·g[c])`) — abschätzbar als `1 − CDF_c(255/g)` aus den
kanalweisen CDFs. Die Matching-Kurve selbst kann per Konstruktion nicht clippen.
Zweitens: eine Ziel-CDF mit viel Masse am Rand bildet einen ganzen
Eingangsbereich auf 0 ab. Gegenmittel unterschiedlich: bei Mechanismus 1 die
Gains dämpfen, bei Mechanismus 2 die Kurvenstärke. `MAX_SAT_FACTOR` aus Etappe 3
gehört hier hineingeführt.

### Etappe 6 — Ausreißer im UI, mit Ausschlussschalter

Markierung in der Bildliste, nach Typ unterschieden, Klartext direkt daneben
statt im Tooltip. `excludedFromTarget` ist Eingabezustand am Item, kein
abgeleiteter. Mindestens `MIN_IMAGES` (2) Bilder müssen eingerechnet bleiben,
sonst wird der Schalter deaktiviert — mit sichtbarer Begründung, nicht still.
Beachten: nimmt man den stärksten Ausreißer heraus, kann ein anderes Bild zum
Ausreißer werden. Statistisch korrekt, kann aber unruhig wirken.

Pro Bild wird nur der **stärkste** Befund gemeldet, nicht jedes gerissene
Kriterium. Im gemessenen Material meldet Typ A bis zu 4 von 7 Bildern eines
Satzes; ein Hinweis, der die Mehrheit trifft, trägt keine Information mehr.

### Etappe 7 — Hauttonmaske (optional)

Hautpixel aus der globalen Messung von `warmth`, `tint` und `saturation`
ausschließen, damit ein Porträt vor einer warmen Wand nicht kühl korrigiert wird.
Schwellwertbasiert im bestehenden gammakodierten sRGB, kein neuer Farbraum. Ab
40 % Maskenanteil wird die Maske ignoriert.

### Etappe 8 — Farbstich nach Tonwertbereichen (optional)

Als kanalweise Kurven in die bestehenden LUTs gefaltet, kein zusätzlicher
Pixel-Pass. Die Zonengrenzen gehören auf die **Ziel-CDF**, nicht auf `p10`/`p90`
des Originals — die Matching-Kurve verteilt die Tonwerte um.

## Wie gearbeitet wird

- **Erst messen, dann ändern.** Bevor eine als schwach dokumentierte Stelle
  repariert wird, wird beziffert, wie groß der Fehler tatsächlich ist. Dreimal
  hat sich dabei gezeigt, dass die naheliegende Korrektur falsch gewesen wäre.
- **Messmittel bleiben im Repo.** So sind `test/lut.test.ts`,
  `test/saettigung.test.ts` und `test/gitter.test.ts` entstanden. Sie prüfen
  gegen Material mit bekannter Wahrheit, nicht gegen den §13-Satz.
- **Der §13-Satz ist für Konvergenz da, nicht für Präzision.** Für Messfixtures
  gibt es `measurementSet()`, das nie in die Zielwertbildung gerät. Bild 03 trägt
  mehr Nebenwirkungen, als sein Name sagt.
- **Entscheidungen gehören als Wenn-dann in den Prompt.** Statt „miss und zeig
  mir" besser „miss; liegt X über Y, brich ab, sonst bau weiter". Nur echte
  Abbruchbedingungen kommen zurück. Berichtslänge vorgeben.
- **Vor jeder Etappe committen.** Dann ist `git diff` immer exakt der Umfang der
  laufenden Etappe.

## Verworfen, mit Begründung

- **Satzkohäsion — ob Bilder zusammengehören.** An acht Sätzen und 50 Bildern
  gemessen: kein trennendes Maß. Jeder „passt nicht"-Wert liegt innerhalb der
  Spanne der stimmigen Sätze, auf `exposure`, `saturation`, `warmth`, `tint`,
  `contrast`, `p01` und auf dem Farbabstand gleichermaßen. Das Urteil ist
  redaktionell — ein Ort, ein Tag, eine Erzählung — und darüber weiß eine
  Messung globaler Kennwerte nichts. Zahlen in `MESSUNG-ausreisser.md`,
  Befund 2. Das Werkzeug beantwortet nicht, ob Bilder zusammengehören, sondern
  wie viel Arbeit die Angleichung leistet und wo sie sichtbar etwas kostet.
- **Typ B, der farbliche Ausreißer.** Siehe Etappe 5 und
  `MESSUNG-ausreisser.md`, Befund 1.
