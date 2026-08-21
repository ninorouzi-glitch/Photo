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

## Ein offener Vorbehalt

Sättigung wird als `(max−min)/max` gemessen (§8.3), aber als `L + (c−L)·f`
angewendet (§9.5). Das sind nicht dieselben Maße, die Konvergenz für Sättigung
ist deshalb nur näherungsweise. Die Formeln bleiben wie spezifiziert; die
Abnahme A-02 prüft für Sättigung nur die Richtung. Festgehalten in
`src/core/apply.ts`.

## Schwellen nachjustieren

Die Werte in `THRESHOLDS` (`src/core/deviation.ts`) stammen aus Messungen an
synthetischen Bildern. Sie stehen bewusst an einer Stelle und sollten nach den
ersten zwanzig echten Sets nachgezogen werden (§10).
