# Messung: Ausreißererkennung an echtem Material

> Gemessen am 22. August 2026 gegen `d318b01` (Etappe 5, Rechenkern). Anlass war
> die Frage, wo `MIN_FARBABSTAND` liegen muss. Herausgekommen sind zwei
> widerlegte Annahmen und ein Fehler im bestehenden Werkzeug.
>
> Diese Datei bleibt im Repo, weil ohne sie in drei Wochen niemand mehr weiß,
> warum Typ B nicht existiert und warum es keine Satzaussage gibt.

## Das Material

Acht Sätze, 50 Bilder, alle von Nima ausgewählt und von ihm eingeordnet. Fünf
gelten ihm als stimmig, drei nicht. Drei der stimmigen sind fremde Posts eines
professionellen Instagram-Kontos, mitgemessen als Gegenprobe.

| Satz | n | Urteil | Beschreibung |
| --- | --- | --- | --- |
| Alm | 7 | stimmig | eine Terrasse, eine Stunde, gemischte Bildausschnitte |
| Ostsee | 4 | stimmig | ein Strandtag, goldene Stunde bis bedeckt |
| annonce | 3 | stimmig | ein Shooting, Bild 1 schwarzweiß, Bild 2+3 farbig |
| louisiana | 3 | stimmig | durchgehend schwarzweiß |
| summer | 3 | stimmig | Bild 1 schwarzweiß, Bild 2+3 farbig |
| Café | 12 | passt nicht | ein Ort, ein Nachmittag, zwölf ähnliche Aufnahmen |
| Galerie | 10 | passt nicht | Außenaufnahmen und Galerieinnenräume gemischt |
| gemischt | 8 | passt nicht | acht unzusammenhängende Bilder |

Gerechnet auf JPEGs mit 1280 px langer Kante, Stärke 1,0 sofern nicht anders
vermerkt. Für Streuungsmaße über globale Kennwerte ist die Vorskalierung ohne
Belang.

## Befund 1 — Typ B misst das Falsche

Typ B vergleicht die Farbverteilung eines Bildes mit dem binweisen Median des
Satzes und wertet den Abstand über einen MAD-z-Score. An echtem Material:

**Es meldet nichts.** Null Treffer in allen acht Sätzen, 50 Bilder.

**Und die Rangfolge ist gegenläufig.** Die Streuung der Farbabstände
(max/Median) liegt bei den stimmigen Sätzen zwischen 1,06 und 3,32, bei den
unstimmigen zwischen 1,18 und 1,26 — mitten dazwischen. Der Almsatz, der
zusammenpasst, streut stärker als jeder Satz, der es nicht tut.

**Der entscheidende Test war der Eindringling.** Zu den sieben Almbildern kam
jeweils ein Bild aus dem gemischten Satz — der Fall aus dem PRD, „ein
Innenraumbild zwischen neun Strandbildern":

| Eindringling | Abstand | ×Median | von Typ B gemeldet |
| --- | --- | --- | --- |
| Hütte innen | 0,803 | 1,12 | nein |
| Berliner Zimmer | 0,815 | 1,21 | nein |
| Blitzaufnahme Gesicht | 0,837 | 1,21 | nein |
| Rotschopf, dunkel | 0,846 | 1,20 | nein |
| Straße mit Bäumen | 0,866 | 1,24 | ja, zusammen mit einem Almbild |
| Zimmer, grüne Jacke | 0,791 | 1,14 | nein |
| Frau, sonnig | 0,685 | 1,03 | nein |
| Frau im Café | 0,786 | 1,16 | nein |

**Eins von acht.** Typ A fand im selben Test acht von acht. Und jeder
Eindringling liegt unter dem Almbild Nr. 6 (1,32× Median) — eine
Hütteninnenaufnahme ist nach diesem Maß weniger fremd als ein legitimes
Mitglied des Satzes.

Die Ursache: ein globales Farbhistogramm wird vom **Bildinhalt** beherrscht,
nicht von der Farbwelt. Es misst, wovon ein Bild handelt, nicht wie es aussieht.
Und weil gegen den Median des Satzes gemessen wird, ist der Fall „alle sind
verschieden" bauartbedingt unsichtbar: der Median wird zum Brei, von dem alles
gleich weit weg liegt, und ein robuster z-Score kann „alle" nicht melden.

Nebenbefunde aus derselben Messreihe, beide vor der Streichung noch behoben:

- Typ B baute seine Tabellen mit `settings.strength`. §13-Bild 03 maß bei 0,7
  einen Abstand von 0,607 und wurde gemeldet, bei 1,0 nur noch 0,202 und wurde
  nicht gemeldet. Ein technischer Ausreißer erschien also als farblicher, sobald
  der Nutzer den Regler zurückdrehte.
- §13-Bild 05 schlug an, obwohl es sich von der Grundszene nur durch Ausschnitt,
  Weichzeichnung und Rauschen unterscheidet. Zerlegt: Ausschnitt 0,731,
  Rauschen 0,134, Weichzeichnung 0,110, Grundszene selbst 0,102. Es treibt allein
  der Ausschnitt — Rauschen und Unschärfe sind unbedenklich.

**Konsequenz: Typ B wird gelöscht.** Das Farbgitter aus Etappe 3c bleibt, es
trägt weiter die Sättigungsschätzung; nur diese zweite Verwendung trägt nicht.

## Befund 2 — es gibt keine messbare Satzkohäsion

Nachdem Typ B fiel, lag die Vermutung nahe, die Zusammengehörigkeit stecke in
der Streuung der ohnehin gemessenen Achsen: ein Satz hängt zusammen, wenn das
Licht gleich bleibt, während die Komposition sich ändert.

Nach vier Sätzen sah das überzeugend aus (Faktor 11 auf `exposure`). Nach acht
überlappen die Bereiche vollständig:

| Satz | Urteil | MAD exposure | MAD saturation | Farbabst. max/med |
| --- | --- | --- | --- | --- |
| annonce | stimmig | 0,009 | 0,061 | 3,32 |
| Alm | stimmig | 0,015 | 0,031 | 1,32 |
| louisiana | stimmig | 0,046 | 0,415 | 1,42 |
| summer | stimmig | 0,052 | 0,203 | 1,47 |
| Ostsee | stimmig | 0,193 | 0,145 | 1,06 |
| Café | passt nicht | 0,170 | 0,085 | 1,18 |
| Galerie | passt nicht | 0,291 | 0,585 | 1,26 |
| gemischt | passt nicht | 0,360 | 0,245 | 1,25 |

Jeder „passt nicht"-Wert liegt innerhalb der Spanne der stimmigen Sätze, auf
allen drei Maßen. `warmth`, `tint`, `contrast` und `p01` trennen ebenfalls nicht.

Der Ostsee-Satz reicht von goldener Stunde bis zu bedecktem Himmel und gilt
trotzdem als Serie; der Café-Satz ist enger belichtet und gilt nicht als eine.
Das Urteil ist redaktionell — ein Ort, ein Tag, eine Erzählung, eine Auswahl —
und darüber weiß eine Messung globaler Kennwerte nichts.

**Konsequenz: keine Satzaussage.** Das Werkzeug beantwortet nicht, ob Bilder
zusammengehören. Es beantwortet, wie viel Arbeit die Angleichung leisten muss
und wo sie sichtbar etwas kostet — das Zweite ist der Clipping-Guard aus
Etappe 4. Die Entscheidung über die Zusammenstellung bleibt beim Nutzer, und der
Schalter „nicht in die Zielwerte einrechnen" ist die Stelle, an der er sie
eingibt.

## Befund 3 — monochrome Bilder werden beschädigt

Zwei der stimmigen Sätze mischen Schwarzweiß mit Farbe, einer ist durchgehend
schwarzweiß. Der §13-Satz besteht ausschließlich aus farbigen Bildern, deshalb
ist das nie aufgefallen.

**Ein Schwarzweißbild in einem Farbsatz** (summer, 1 sw + 2 farbig, Stärke 0,7):

```
#1   Sättigung 0,000 → 0,020     Sättigungsfaktor 1,557
```

Ein Schwarzweißbild hat per Konstruktion r = g = b und damit `warmth = tint = 0`.
Der Satzmedian liegt daneben, also legen die Kanalfaktoren einen Farbstich auf
ein Bild, das keinen hatte — und der Sättigungsfaktor verstärkt den frisch
entstandenen Stich anschließend um 56 %.

**Ein Farbbild in einem Schwarzweißsatz** (3 sw + 1 farbig, Stärke 0,7,
Zielsättigung 0,026):

```
#4   Sättigung 0,389 → 0,269     Sättigungsfaktor 0,622
```

31 % Entsättigung bei Stärke 0,7; bei 1,0 zöge es weiter Richtung Grau.

**Dazu ein numerischer Fehler.** Die Sättigungsachse geht als log2-Verhältnis in
`deviation.ts` ein. Bei einem Schwarzweißbild ist der Nenner 0 — der reine
Schwarzweißsatz misst deshalb einen `saturation`-MAD von 0,415, während seine
drei Bilder tatsächlich bei 0,030, 0,023 und 0,000 liegen. Die Befundmatrix
meldet bei einem solchen Satz heute Unsinn, und die Ausreißererkennung erbt den
Fehler.

**Konsequenz: neue Etappe, vor allem anderen.** Bilder unter einer kleinen
Sättigungsschwelle gelten als monochrom. Für sie entfallen Weißabgleich und
Sättigungsfaktor; Belichtung und Tonwertkurve laufen normal weiter, denn die
binden sie an den Satz. Auf `warmth`, `tint` und `saturation` gehen sie nicht in
die Zielwertbildung ein, sonst ziehen sie den Median.

Die Schwelle legt das Material nahe: die schwarzweißen Bilder messen 0,000 bis
0,030, die farbigen ab 0,32. Dazwischen liegt eine Größenordnung Luft.

**Nachtrag: die Sättigungshöhe allein trennt nicht.** Die Luft im Material ist
nicht die Luft in den Fixtures. §13-Bild 04 „flau" ist ein farbiges Bild — die
Basisszene mit 45 % Chroma — und misst 0,0297, liegt also mitten im Band der
schwarzweißen Bilder. Eine Schwelle, die 0,030 noch erfasst, erklärt Bild 04
zum Schwarzweißbild und verschiebt den §13-Satz (Ziel-`saturation` 0,1235 →
0,1430, Sättigungsfaktor von Bild 04 1,6075 → 1,000). p95 und p99 der
Pixelsättigung und der Anteil der Pixel über 0,1 trennen ebenfalls nicht: Bild
04 misst dort 0,102 / 0,116 / 5,6 %, ein Schwarzweißbild mit Chroma-Spur
0,107 / 0,157 / 6,1 %. Was trennt, ist die **Richtung** der Chroma, nicht ihre
Höhe: sättigungsgewichtet über das Farbgitter liegt die Richtungskonzentration
von §13-04 bei 0,280, die zweier getonter Schwarzweißbilder bei 0,954 und
0,996. Die Erkennung in Etappe 9 nimmt dieses zweite Merkmal deshalb dazu.

Gerechnet wird es je belegter Zelle aus dem Bin-Vertreter — `a = r − (g+b)/2`,
`b = (√3/2)·(g − b)`, `L = hypot(a, b)`, Gewicht `w = counts · sat(Zelle)` —, als
Länge des gewichteten Mittels der Einheitsrichtungen: `chromaR = hypot(Σw·a/L,
Σw·b/L) / Σw`, bei `Σw = 0` gleich 1. Das kostet keinen weiteren
Pixel-Durchlauf, das Gitter liegt aus 3c schon vor. Damit lautet die Regel
`sat ≤ EPS ∨ (sat ≤ BAND ∧ chromaR ≥ R_MIN)`; reines Grau hat ein beliebiges
`chromaR` und wird über den ersten Zweig erfasst. Zu messen, bevor die
Konstanten festgeschrieben werden: eine flaue Szene mit einheitlichem Farbstich
— Nebel, Schnee, weiße Wand im Abendlicht — fällt womöglich in dieselbe Ecke und
verliert dabei ihren Weißabgleich.

## Was aus der Messung an Material im Repo bleibt

Nichts von diesem Material darf ins Repo — es sind fremde und private Fotos. Was
bleibt, sind die Zahlen oben und die Tests, die aus ihnen entstanden sind:

- ein Satz, der sich nur im Rauschen unterscheidet, meldet keinen Typ B
  (bleibt als Prüfung erhalten, auch wenn Typ B fällt — dann als Prüfung an
  Typ A)
- `test/leistung-gitter.test.ts` mit dem breit belegten Farbgitter
- die kommenden Monochrom-Tests: ein rein schwarzweißer Satz bleibt nach der
  Angleichung neutral, ein Farbbild in einem solchen Satz bleibt farbig
