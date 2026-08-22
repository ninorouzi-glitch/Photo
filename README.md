# Lichttisch

Misst die Bilder eines Instagram-Posts gegeneinander und bringt sie auf einen
gemeinsamen Nenner. Alles clientseitig — die Bilder verlassen den Rechner nicht.

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # Messkern gegen die Testbilder aus §13 (A-01 … A-04)
npm run test:e2e     # Durchlauf, Randfälle und Leistungsbudget (A-05, §12, §13)
npm run build
```

## Aufbau

| Ordner | Inhalt |
|---|---|
| `src/core/` | Messung (§8) und Korrektur (§9) als reine Funktionen, ohne DOM |
| `src/pipeline/` | Dekodieren im Worker, Rendern, Export |
| `src/state/` | Zustand und Persistenz der Einstellungen |
| `src/ui/` | die vier Stufen |
| `test/` | Testbilder mit bekannter Abweichung, plus Abnahmen |
| `e2e/` | Playwright: Durchlauf, Randfälle, Budget |

Die Trennlinie ist `src/core/` gegen den Rest: der Kern nimmt und gibt ein
schlichtes `Frame` (`{ data, width, height }`) statt `ImageData`. Deshalb laufen
Messung und Korrektur in Node und lassen sich gegen synthetische Bilder mit
exakt bekannter Abweichung prüfen, statt nur plausibel auszusehen.

## Zielformat

Vier Knöpfe: `4:5`, `1:1`, `1,91:1` und `Eigenes`. Hinter `Eigenes` stehen zwei
Zahlenfelder für Breite und Höhe; geklemmt wird auf 1:4 bis 4:1. Das Format gilt
für das ganze Set und nicht je Bild — ein Post, der zwischendurch die Breite
wechselt, ruckelt im Carousel, und die App handelt davon, dass die Bilder
zusammen auftreten (P1).

Liegt das eigene Verhältnis außerhalb von 0,8 … 1,91, sagt der Hinweis unter den
Feldern, dass Instagram nachschneiden wird. Verboten wird es nicht: zugeschnitten
wird auf das, was dasteht.

Aus `RATIOS[settings.ratio]` ist dabei `aspectOf(settings)` geworden
(`src/core/crop.ts`) — die eine Stelle, an der aus der Einstellung eine Zahl
wird. `exportSize` und `previewSize` nehmen seitdem ein Verhältnis als Zahl,
keinen Schlüssel mehr.

## Ausgabe in voller Auflösung

Standard ist `Volle Auflösung`: der Export nimmt die Pixel des Zuschnitts so,
wie sie in der hochgeladenen Datei stehen. Ein 6000 × 4000er ergibt in 4:5 also
3200 × 4000 und nicht 1080 × 1350. Das Zeichnen ist dabei ein 1:1-Blit — keine
Neuabtastung, kein Filter. `1080 px` (F-22) bleibt als zweite Wahl im Regler
„Ausgabe" und ist bei einem heutigen Foto eine Verkleinerung um den Faktor zehn.

Drei weitere Stellen, an denen vorher Bildqualität liegen blieb:

- **Zweimal runden.** Die Tabellen in `src/core/lut.ts` hielten gerundete Bytes;
  nach der Sättigung wurde ein zweites Mal gerundet. Jetzt rechnen sie in
  Fließkomma und es wird genau einmal gerundet, beim Schreiben in den Frame.
- **Streifen im Verlauf.** Die Tonwertkurve staucht 256 Stufen auf weniger als
  256 — daran ändert kein genaueres Zwischenergebnis etwas, die Ausgabe ist
  8 bit. Ein halbes Bit geordnetes Rauschen (Bayer 4 × 4) vor dem Runden macht
  aus der Stufe wieder einen Verlauf. Geprüft in `test/quality.test.ts`.
- **Vorschau.** Die Vorschau rechnete in CSS-Pixeln und war auf einem
  Retina-Schirm sichtbar weicher als die Datei, die dabei herauskommt. Sie
  rechnet jetzt in Geräteauflösung; am Regler läuft die schnelle Fassung, und
  sobald die Hand still steht, wird scharf nachgezogen. Die Seite „Original"
  im Vergleich kommt nicht mehr aus der 640-px-Vorschaudatei, sondern aus
  demselben Bitmap wie das Ergebnis daneben.

## Zwei Abweichungen vom PRD, beide bewusst

**Belichtungsmaß.** §10 schreibt `log2((P50+4)/(Ziel+4))`. Der additive Offset
soll Division durch Null bei schwarzen Bildern verhindern, verkleinert aber jede
echte Abweichung: ein um exakt 1,2 EV abgedunkeltes Testbild misst damit −1,15
und reißt die Abnahme A-01 (±0,03). Umgesetzt ist `max(4, …)` — dieselbe
Absicherung, ohne den Normalfall zu verzerren. Gemessen: −1,208.
Siehe `src/core/deviation.ts`.

**Export-Zwischenstufe.** Wo die File System Access API fehlt, stand im Plan ein
ZIP. Umgesetzt sind einzelne Downloads: dasselbe Ergebnis ohne zusätzliche
Abhängigkeit. Die dritte Stufe (F-23, Bilder zum manuellen Sichern) ist
unverändert. Siehe `src/pipeline/exporter.ts`.

**Ausgabegröße.** F-22 schreibt 1080 px Breite fest. Das ist Instagrams Maß,
aber es wirft bei einem 24-MP-Foto rund 97 % der Pixel weg, bevor Instagram
überhaupt etwas davon sieht. Umgesetzt ist die volle Auflösung als Standard und
1080 px als Wahl. Siehe `src/pipeline/render.ts`.

## Offene Vorbehalte

**Sättigung wird gemessen, bevor der Weißabgleich läuft — teilweise behoben.**
Ein Farbstich liest sich in `(max−min)/max` als Sättigung: Testbild 03
(Blau × 1,35) misst 0,369 und ist kaum gesättigt. Der Weißabgleich nimmt den
Stich weg, aber der Sättigungsfaktor wurde gegen die 0,369 gebildet und dann auf
das entstichte Bild angewendet — es wurde ein zweites Mal entsättigt.

Behoben ist das über das Farbgitter: `Stats.colorGrid` trägt 16³ Zellen über
genau die Pixel, über die §8.3 mittelt. Der Vertreter jeder Zelle läuft durch
dieselben Tabellen wie das Bild, und die dort gemessene Verschiebung geht auf
die (exakt gemessenen) Summen der Zelle. So entsteht die Sättigung *nach* den
Tabellen, ohne das Bild ein zweites Mal anzufassen. Gegen die Zählung am Pixel
geprüft liegt die Schätzung über alle Fixtures höchstens 0,013 daneben
(`test/gitter.test.ts`).

Vollständig ist die Rekonstruktion nicht, und das ist der Grund für `w`:
innerhalb einer Zelle kann die Kanalreihenfolge kippen, sobald die Kanäle
unterschiedlich skaliert werden, und für diesen Teil der Pixel steht der
Vertreter nicht mehr. `w` ist dieser Anteil, sättigungsgewichtet und aus 4³
Stützstellen je Zelle geschätzt; gerechnet wird mit

    s_wirksam = (1−w)·s_nachLUT + w·s_vorLUT,   ā analog
    t_wirksam = (1−w)·Ziel(s_nachLUT) + w·Ziel(s_vorLUT)

Das Ziel wird mitgeblendet, sonst mischte der Median bei einem Set mit
unterschiedlichen `w` die beiden Domänen. Bei `w = 1` steht damit bitgleich das
Ergebnis von vor der Umstellung — die Umstellung kann kein Bild schlechter
stellen. Gemessen am §13-Satz (Stärke 1 / 0,7): `w` = 0,30 · 0,34 · 0,58 · 0,66
· 0,31, und die Spannweite der erreichten Sättigung über das Set fällt von 0,128
auf 0,095 (bei 0,7 von 0,115 auf 0,081).

Was bleibt: bei starkem Farbstich ist `w` gerade dort am größten, wo die
Korrektur am meisten brächte. Bild 03 misst vor den LUTs 0,369, danach
tatsächlich 0,120, geschätzt 0,124 — mit `w` = 0,58 wird daraus ein wirksames
0,267, also gut die Hälfte des Weges. Zusätzlich bindet in diesem Fall der
Deckel aus §9.5 (Verhältnis 0,65), sodass das Ergebnis sich kaum ändert. Deshalb
prüft A-02 die Sättigung weiter gegen einen Bruchteil der Ausgangsstreuung statt
gegen die Schranke der übrigen Kriterien. Festgehalten in `src/core/satgrid.ts`
und `src/core/target.ts`.

**Die Tonwertkurve trifft ihr Ziel nur näherungsweise**, auch bei Stärke 1.
Zwei bauliche Gründe: Sie wird aus der Luma-CDF gebaut, aber über dieselbe
Tabelle auf jeden Kanal angewendet — ein farbiges Bild landet damit nie exakt
auf dem Luma-Ziel. Und der Weißabgleich läuft vor ihr (§9.2) und verschiebt
genau die Verteilung, gegen die sie angepasst wurde. Die Achsen Belichtung,
Kontrast, p01 und p99 behalten deshalb einen systematischen Restwert; am
§13-Satz sind das im Mittel rund 0,8 Tonwerte auf p01 und 2,1 auf p99. Das ist
erwartet und kein Fehler. Sauber lösen ließe es sich nur mit Luma-Matching
unter Erhalt der Chroma, und das passt nicht mehr in eine Tabelle je Kanal —
also auch nicht mehr in die 150 ms am Regler. Festgehalten in `src/core/lut.ts`.

**Behoben: §8.3 und §9.5 sind verschiedene Größen.** Gemessen wird
`(max−min)/max`, angewendet `L + (c−L)·f` — und `f` ist der Parameter der
Operation, nicht das erreichte Verhältnis. Mit `a = L/max` je Pixel gilt nach
der Operation exakt `S′/S = f / (a + (1−a)·f)`, also `f = r·a / (1 − r + r·a)`
für ein gewünschtes Verhältnis `r`. Bis dahin stand dort schlicht `f = r`, was
nur bei `a = 0` richtig wäre: übrig blieb eine systematische Unterkorrektur von
rund 20 % der geforderten Änderung bei Stärke 1 und rund 43 % bei 0,7. `Stats`
führt das `a` jetzt als `satA` mit, gewichtet mit der Sättigung des jeweiligen
Pixels — ungewichtet bliebe drei Viertel des Fehlers stehen. Der Restfehler
liegt unter einem Prozent; geprüft in `test/saettigung.test.ts`. Der Deckel aus
§9.5 liegt seither auf dem Verhältnis statt auf `f`, weil ein Deckel auf `f` je
nach Bildinhalt zwischen 0,70 und 0,60 wanderte. Nach oben begrenzt zusätzlich
ein technischer Anschlag den Faktor — Gamut-Schutz, keine Vorgabe aus §9.5.

Zwei Präzisionsfehler an der Tonwertkurve waren ebenfalls behebbar und sind
behoben: Das Glättungsfenster der Kurve war an den Enden einseitig und zog
Schwarz- und Weißpunkt nach innen — in jedem Bild etwas zu wenig Kontrast. Und
die Inverse der Ziel-CDF wurde auf ganze Bins gerundet, mitten in einer Kette,
die sonst durchgehend in Fließkomma rechnet. An einem Testbild mit bekannter
Wahrheit fiel der mittlere Kurvenfehler dadurch von 0,105 auf 0,033 Tonwerte,
am Rand von 2,59 auf 0,30. Geprüft in `test/lut.test.ts`.

## Schwellen nachjustieren

Die Werte in `THRESHOLDS` (`src/core/deviation.ts`) stammen aus Messungen an
synthetischen Bildern. Sie stehen bewusst an einer Stelle und sollten nach den
ersten zwanzig echten Sets nachgezogen werden (§10).

Eine Zeile ist dabei vordringlich: `tint` ist neu in der Befundmatrix — bis
hierher wurde der Grün-Magenta-Stich gemessen und korrigiert, aber nirgends
angezeigt. Seine Schwellen (0,05 / 0,12) sind als einzige nicht an §13 gemessen,
sondern aus den `warmth`-Schwellen über die 2/3-Dämpfung in `channelGains`
hergeleitet. Sie sind ausdrücklich vorläufig.
