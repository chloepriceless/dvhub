# Preisprognose für EOS (Preisschwanz) – ab DVhub 1.0.11

EOS plant den Akku Viertelstunde für Viertelstunde, solange Börsenpreise feststehen. Vormittags ist das bis
Mitternacht, ab etwa 13 Uhr bis Mitternacht des Folgetags. Dahinter braucht EOS trotzdem Preise: Im „Schwanz“
schätzt es, was die Restladung im Akku später noch wert ist. Ohne Preise dort bewertet EOS sie fast nur zum
Einspeisewert und speist mittags PV ein, statt sie für Nacht und Morgen zu speichern.

Bis 1.0.10 hat DVhub die Börsenpreise dafür aus dem eigenen Preisverlauf fortgeschrieben (Holt-Winters, ein
wiederholtes Wochen- und Tagesmuster). Ab 1.0.11 kommt der Schwanz aus der **Residuallast-Prognose von
dvhub.online**.

## Woher die Preise kommen

- Quelle: `GET https://dvhub.online/v1/residual-load/outlook`, öffentlich, ohne Schlüssel. DVhub schickt dabei nur
  Programmname und Version mit (`DVhub/1.0.11 (price-outlook)`), keine Daten der Anlage.
- Inhalt: Börsenpreis DE-LU je Stunde für die fünf Tage nach dem letzten bekannten Börsentag, als P10, P50 und P90
  in €/MWh. Gerechnet wird aus der Wettervorhersage (ECMWF): Wind, Sonne und Verbrauch ergeben die Residuallast,
  daraus und aus Gas-, CO2- und Ölpreis den Börsenpreis.
- Neue Läufe gibt es 4× täglich (08:15, 12:30, 15:00, 20:15 UTC). DVhub fragt 10 min danach, spätestens alle 3 h.
  Nach einem Fehlschlag fragt es frühestens 10 min später wieder.
- Rückblick über ein Jahr (Nov. 2025 – Nov. 2026): Fehler je Stunde 19–28 €/MWh gegenüber 26–39 €/MWh mit
  Holt-Winters. Teure Tage erkennt die Prognose zu 61–66 %, Holt-Winters zu 30–36 %.

## Regeln

- **Feste Börsenpreise haben immer Vorrang.** Der Schwanz beginnt am Ende der lückenlosen festen Preise. Stunden
  der Prognose, für die es schon feste Preise gibt, werden übersprungen.
- **P50 je Viertelstunde:** Bei 15-min-Preisen gilt der Stundenwert für alle vier Viertelstunden. Bei Stundenpreisen
  kommt der Schwanz stündlich, damit EOS keine gemischte Reihe sieht. Gerechnet wird in UTC-Stunden, deshalb
  brauchen die Umstellungstage (23 oder 25 Stunden) keine Sonderregel.
- **Dieselbe Umrechnung wie für feste Preise:** Bezugspreis (fest, dynamisch, Anbieterpreis mit Ausgleichsgerade,
  §14a-Zeitfenster) und Einspeisewert (Börse × Faktor, + Marktprämie bei nicht negativem Preis, oder fester Satz)
  entstehen für Prognose-Slots auf demselben Weg wie für feste. Eine zweite Preislogik gibt es nicht.
- **Lücken:** Fehlt der Prognose eine Stunde, endet der Schwanz davor. Beginnt die Prognose erst nach dem Ende der
  festen Preise, gibt es keinen Schwanz.
- **Nur hinter genug festen Preisen:** Reichen die festen Preise nicht mindestens 1 h 15 min voraus, hängt DVhub
  nichts an (wie bisher). Sonst lägen Prognosepreise im Steuerzeitraum.

## Rückfall

1. **Letzte gültige Prognose weiterverwenden.** DVhub speichert die letzte gültige Antwort in
   `price_outlook_cache.json` im Datenverzeichnis. Sie übersteht also einen Neustart. Kommt keine neue Prognose
   (offline, HTTP-Fehler, kaputte Antwort, Server meldet `stale`), nimmt DVhub die gespeicherte, solange ihre Stunden
   in der Zukunft liegen und sie **höchstens 48 h** alt ist (ab `issued_at`).
   - Warum 48 h: Nach 48 h braucht der Schwanz aus der alten Prognose die Vorlauftage 3–5. Deren Fehler
     (22,8 / 24,9 / 27,9 €/MWh) liegt noch unter dem, den Holt-Winters schon am ersten Tag hatte (26,4 €/MWh). Danach
     bliebe nur noch Vorlauf 5, das Gas-/CO2-Preisniveau der alten Prognose veraltet, und acht verpasste Läufe sind
     ein echter Ausfall.
   - Eine kaputte Antwort oder eine ältere Ausgabe ersetzt nie eine gültige neuere.
2. **Danach gibt es keinen Schwanz.** EOS plant nur über die festen Börsenpreise, wie vor dem 01.11.2026.
   - Der Steuerzeitraum bleibt dabei unverändert. Er hängt nur an den festen Preisen und an der Grenze
     „Prognosehorizont − 12 h“. Diese Regel („mindestens 12 h Schwanz“) rechnet mit dem eingestellten
     Prognosehorizont, nicht mit vorhandenen Preisen. Sie kürzt also nichts, wenn der Schwanz fehlt.
   - EOS kürzt nur seinen Schwanz auf das, was hinter dem Steuerzeitraum noch an festen Preisen liegt (wegen des
     15-min-Puffers mindestens eine Viertelstunde). Das bricht keinen Lauf ab: EOS rechnet mit
     `max(0, verfügbar − Steuerzeitraum)` und bewertet die Restladung über seinen Endwert.
   - Alte Schwanzwerte in EOS löscht DVhub bei jedem Push hinter dem Gesendeten. Der Lauf darf rechnen, weil der
     Steuerzeitraum ganz in festen Preisen liegt.
3. **Sichtbar:** Leitstand-Preiskurve („Preisprognose nicht verfügbar seit …“), EOS-Fahrplan im Leitstand (Zeile
   unter dem Diagramm, als Warnung) und die DV-EOS-Karte unter Integrationen („Preisprognose: nicht verfügbar seit …“).
   Das „seit“ wird ebenfalls gespeichert und übersteht einen Neustart.

## Wer keinen Schwanz bekommt

- **Andere Preiszonen als DE-LU** (DVhub lädt die Zonenliste von dvhub.online, z. B. AT oder NL): Die Prognose gibt
  es nur für DE-LU. Diese Anlagen hatten bis 1.0.10 einen fortgeschriebenen Schwanz und haben ab 1.0.11 **keinen
  Schwanz** mehr. EOS plant dort nur so weit, wie Börsenpreise feststehen. Hilfe und EOS-Karte sagen das.
- **Preisquelle „Öffentlich (Energy-Charts)“**: Diese Einstellung heißt ausdrücklich „ohne dvhub.online“. DVhub
  fragt dann keine Prognose ab, es gibt also ebenfalls keinen Schwanz. Ob das so bleiben soll, ist eine offene
  Entscheidung.
- **EOS nach eigenem Takt** (`optimizer.eosStartAfterPreviousRun`) oder EOS noch nicht als 0.4 erkannt: wie bisher
  kein Schwanz.

## Weiter vorausschauen

| Einstellung | Standard | Neu in 1.0.11 |
|---|---|---|
| EOS Prognosehorizont (`optimizer.eosPredictionHours`) | automatisch: Steuerzeitraum + 48 h, höchstens 72 h | wählbar 96 / 120 / 144 h |
| EOS Steuerzeitraum höchstens (`optimizer.eosControlHorizonMaxHours`) | ganzer bekannter Preiszeitraum | „Bis in die Preisprognose“ (`forecast`, höchstens 120 h) |

- **Prognosehorizont über 72 h:** DVhub fordert bei EOS den passenden Schwanz an
  (`optimization/genetic/tail_horizon_hours` = Prognosehorizont; EOS nimmt davon, was nach dem Steuerzeitraum
  bleibt). Die Lastprognose verlängert DVhub mit (Prognosehorizont + 1 h). Hinter dem ersten Tag ist sie das
  wiederholte Tagesprofil. Im automatischen Modus sendet DVhub den Schwanz nicht. Einmal je Start setzt es ihn auf den
  EOS-Standard 48 h zurück. Ein älteres EOS ohne diesen Schlüssel wird danach nicht weiter gefragt.
- **Bis in die Preisprognose:** EOS plant die nächsten Tage Slot für Slot, so weit Preise, PV und Last reichen
  (höchstens 120 h). Umgesetzt wird weiter nur, was auf festen Preisen liegt: Aus Slots mit Prognosepreisen setzt
  DVhub keine Akku-Regeln, wie bei der E-Auto-Frist. EOS rechnet alle 15 min neu. Ohne Prognose gilt wie der
  Standard der ganze bekannte Preiszeitraum.

### Was die Reichweite begrenzt

EOS schaut nur so weit, wie **alle** Reihen reichen: Preise, PV und Last. Die EOS-Karte im Leitstand zeigt
„EOS schaut voraus bis …“ und „begrenzt durch PV-Prognose / Verbrauchsprognose / Preisprognose“.

- **Preise:** fünf Tage nach dem letzten bekannten Börsentag, also je nach Uhrzeit etwa 120–150 h voraus.
- **Last:** Standard 72 h ab der vollen Stunde. Bei einem längeren Prognosehorizont reicht sie automatisch mit.
- **PV:** Das hängt vom Anbieter ab (im Code geprüft):
  - Solcast: 72 h;
  - Open-Meteo: 4 Kalendertage;
  - pvnode: je nach Tarif 2 bis 7 Tage;
  - forecast.solar und VRM: kürzer.

  Ein Prognosehorizont über 72–96 h bringt deshalb meist nur mit pvnode etwas.

### Rechenzeit (nativer Rust-Kern, gemessen am 12.11.2026)

Gemessen auf dem Mac, Median über 20 Pläne, 200 Generationen, 300 Individuen. Hochgerechnet auf den A55 mit
Faktor 19,5 (Jahresrechnung 2026) und auf den A7S mit Faktor ~18 (abgeleitet aus Prod 7–8 s bei 30 h; Annahme).
Nachrechnen mit `~/Projects/eos-bench/preisschwanz/` (`run_timing.sh`, `analyze.py`).

| Steuerzeitraum | Schwanz | Mac ohne / mit Auto | A7S geschätzt | A55 geschätzt |
|---|---|---|---|---|
| 30 h (heute) | 42–48 h | 0,40 / 0,55 s | 7–10 s | 8–11 s |
| 30 h | 120 h | 0,42–0,46 / 0,58 s | 8–11 s | 8–11 s |
| 48 h | 48 h | 0,60 / 0,98 s | 11–18 s | 12–19 s |
| 72 h | 48 h | 0,89 / 1,28 s | 16–23 s | 17–25 s |
| 96 h | 48 h | 1,23 / 1,79 s | 22–32 s | 24–35 s |
| 120 h | 48 h | 1,54 / 2,28 s | 28–41 s | 30–45 s |

- Ein längerer **Schwanz** kostet fast nichts (+3–9 % bei 48 → 120 h).
- Ein längerer **Steuerzeitraum** kostet fast linear: bei 72 / 96 / 120 h das 2,2- / 3,1- / 3,6- bis 4-Fache.

Mit dem Python-EOS wäre der Steuerzeitraum „bis in die Preisprognose“ auf kleinen Boards zu langsam (dort schon
24 h ≈ 30–40 min je Lauf).

### Warum die Standards bleiben

- **Prognosehorizont automatisch (72 h):** Eine Messung auf echten Daten (01.01.–02.11.2026, Rust-Kern, 10.11.2026)
  ergab für Schwanzlängen von 24 bis 96 h keinen messbaren Unterschied. Alle lagen innerhalb des Seed-Rauschens von
  σ 0,6 € im Jahr, sogar bei vollkommener PV- und Lastprognose. Last und die meisten PV-Anbieter reichen ohnehin
  nur ~72 h. Mit der besseren Preisprognose wird der Schwanz besser, nicht länger. Wer mehrere Tage voraus schauen
  will (pvnode), wählt 96–144 h. Das kostet kaum Rechenzeit.
- **Steuerzeitraum = ganzer bekannter Preiszeitraum:** Der Steuerzeitraum folgt den festen Preisen und wird nie
  gekürzt. „Bis in die Preisprognose“ ist eine Vorschau mit 2- bis 4-facher Rechenzeit. Umgesetzt wird davon nur
  der Teil mit festen Preisen. Deshalb bleibt sie eine freiwillige Einstellung.

## Nachvollziehbarkeit je Slot

- `GET /api/price/outlook`: Prognose-Stunden hinter den festen Preisen (P10/P50/P90 in ct/kWh), Zustand, Stand,
  „nicht verfügbar seit“, dazu der Preisschwanz des letzten EOS-Pushs.
- `GET /api/eos/plan`: `priceTail` (Quelle, Stand, ab wann, Vorausschau, Begrenzung). Plan-Zeilen ab dem ersten
  Prognose-Slot tragen `priceSource: 'residual_load'`.
- Log `eos_forecast_bridge`:
  - mit Schwanz: `estimatedPriceFrom`, `estimatedPriceSlots`, `estimatedPriceMethod: residual_load_p50`,
    `estimatedPriceIssuedAt`;
  - ohne Schwanz: `priceTailMissing` (Grund) und `priceOutlookStatus`.
- Abruffehler stehen unter `price_outlook_fetch_error` (nur bei neuer Meldung). Änderungen am angeforderten Schwanz
  stehen unter `eos_tail_horizon` bzw. `eos_tail_horizon_error`.

## Anzeige

- **Leitstand-Preiskurve:** Hinter den festen Börsenpreisen kommt bis jetzt + 36 h die Prognose als gestrichelte
  Linie, mit einem hellen Band P10–P90 und dem Bereich „Prognose“. Der Tooltip zeigt ganze Cent mit Spanne und
  „Börsenpreis noch nicht fest“. Prognose-Slots lassen sich nicht für Zeitpläne auswählen. Darunter steht, bis wann
  die Prognose reicht und von wann sie ist, oder seit wann sie fehlt.
- **EOS-Fahrplan:** Unter dem Diagramm stehen Vorausschau und Quelle bzw. die Warnung. Ein Plan, der in
  Prognosepreise reicht, ist als „Preisprognose“ hinterlegt. „Laut EOS-Plan“ nennt den Bereich ebenfalls
  „Preisprognose“.
- **Integrationen → DV-EOS:** Zeile „Preisprognose“ (aktuell, gespeichert, nicht verfügbar seit …, nur für DE-LU).

## Wertgrundlage des E-Autos („Max-Ladestand wenn günstig“)

Für „Max-Ladestand wenn günstig“ rechnet DVhub, was eine zusätzliche kWh im Auto an späteren Ladekosten spart
(`ev-targets.js`, `ev-minmax.js`). Dafür braucht es Bezugs- und Einspeisepreise ab dem Bewertungszeitpunkt E (Abfahrt
im Steuerzeitraum, sonst dessen Ende) bis zu 7 Tage weiter.

- **Preise:** die festen Börsenpreise, dahinter die Preisprognose, **so weit sie reicht**. Das gilt unabhängig davon,
  wie lang der EOS-Schwanz eingestellt ist und ob EOS gerade einen Schwanz bekommt. Bezug und Einspeisung entstehen wie
  für EOS. Dahinter endet die Reihe. Seit 1.0.11 schreibt DVhub keine Preise mehr fort (bis 1.0.10: Holt-Winters bis
  9,5 Tage voraus).
- **Fenster:** E bis E + 7 Tage, gekürzt auf das Ende der Preise. Fahrten und Ladegelegenheiten dahinter zählen nicht,
  Energie am Fensterende zählt nichts. Ein kürzeres Fenster heißt also vorsichtiger.
- **Unter einem Tag über E** (`MIN_VALUE_WINDOW_MS`, 24 h) gibt es keine Wertstufen. EOS lädt dann nur bis zum
  Mindestziel, der Max-Ladestand bleibt die Obergrenze. Die E-Auto-Details zeigen den Grund („Preise reichen nicht
  einen Tag über die Abfahrt hinaus — nur Mindestziel“).

| Lage | Preise reichen bis | Wertbestimmung |
|---|---|---|
| Prognose an (DE-LU) | ~5 Tage hinter dem letzten Börsentag | Fenster meist 3–5 Tage über E |
| Ohne Prognose (andere Zone, „aus“, Ausfall > 48 h), nach ~13 Uhr | Mitternacht des Folgetags | Abfahrt bis Mitternacht heute: Fenster bis zum Preisende; spätere Abfahrt: nur Mindestziel |
| Ohne Prognose, vormittags | Mitternacht | nur Mindestziel (kein E liegt einen Tag vor dem Preisende) |
| Steuerzeitraum „Bis in die Preisprognose“, Abfahrt erst in 5+ Tagen | Prognose-Ende | E liegt nahe am Preisende → nur Mindestziel |

Die PV-Seite ist davon unabhängig: Hinter dem Ende der PV-Prognose nimmt DVhub den Median-Überschuss je Viertelstunde
der Prognosetage; ohne PV-Prognose ist der Überschuss 0 (Laden nur aus dem Netz bewertet).
