# DVhub Chart UX Design

**Status:** Validiert am 2026-03-09

**Ziel:** Der Leitstand und die History-Seite sollen Vergleichswerte schneller lesbar machen: der Zeitplan rueckt direkt unter den Boersenchart, alle History-Charts erhalten dieselbe Pointer-Interaktion, alle Diagramme bekommen X- und Y-Achsen, und Balkendiagramme bleiben auch auf kleinen Screens nebeneinander sichtbar.

## Anforderungen

- Im Leitstand soll der komplette `Zeitplan`-Block direkt unter dem `Boersenpreis`-Chart stehen.
- Auf der History-Seite soll fuer alle interaktiven Charts dieselbe Maus-/Pointer-Interaktion wie in der Gesamtansicht gelten.
- Alle Charts und Balkendiagramme sollen eine sichtbare X- und Y-Achse mit Vergleichswerten erhalten.
- Balkendiagramme duerfen auf kleinen Screens nicht untereinander umbrechen.
- Statt Scrollen sollen Balken und Abstaende auf kleinen Screens komprimiert werden.
- Die Balken sollen insgesamt schmaler werden, damit mehr Werte nebeneinander vergleichbar bleiben.

## Layout-Entscheidung

- Gewaehlt wurde die Variante `komprimierte Vergleichscharts`.
- Auf Desktop bleiben die Panels grosszuegig, auf Tablet und Telefon werden Balkenbreite, Gaps, Beschriftungen und Innenabstaende verdichtet.
- Die Reihenfolge der Balken bleibt immer erhalten, damit visuelle Vergleiche nicht durch Layoutspruenge zerstoert werden.

## Leitstand

- Der `Zeitplan`-Block wird im Dashboard direkt unter den `Day-Ahead-Preise`-Block verschoben.
- Die `Steuerzentrale` behaelt die manuellen Eingriffe und Default-Werte, verliert aber die Schedule-Tabelle.
- So liegen Chart-Selektion und anschliessende Zeitplanbearbeitung im selben visuellen Kontext.

## History-Charts

- Linien- und Balkencharts nutzen dieselbe Pointer-Logik:
  - Cursorposition wird ueber die X-Achse bestimmt.
  - Die naechste Datenposition wird hervorgehoben.
  - Ein Inspector zeigt die Werte des aktiven Slots oder Zeitraums.
- Auf Touch-Geraeten bleibt die letzte Pointer-Position sichtbar, damit die Interaktion nicht nur per Hover funktioniert.

## Achsenmodell

- Jeder Chart bekommt eine linke Y-Achse mit skalierten Tick-Werten und horizontalen Hilfslinien.
- Jeder Chart bekommt eine untere X-Achse mit Periodenlabels:
  - Tag: Uhrzeit
  - Woche/Monat: Tageslabel
  - Jahr: Monatskuerzel
- Balkencharts erhalten unter jedem Balken oder Balkenpaar eine feste X-Beschriftung.

## Responsive Verdichtung

- `history-bars` und kombinierte Balkenansichten bleiben stets in einer Rasterzeile je Periode.
- Auf kleineren Breakpoints werden folgende Werte reduziert:
  - `grid-template-columns`
  - `gap`
  - Balkenbreite
  - Karten-Padding
  - Label-Schriftgroesse
- Lange Labels duerfen gekuerzt werden, numerische Vergleichswerte bleiben sichtbar.

## Teststrategie

- DOM-Tests fuer die neue Reihenfolge im Leitstand.
- Seitentests fuer neue Achsen- und Inspector-Strukturen in der History.
- Responsive-Assertions fuer schmalere Balken und das Ausbleiben von `auto-fit`-Umbruechen.
- Regressionstest fuer bestehende Chart-Selection- und Schedule-Funktionen im Dashboard.
