# Changelog

Alle nennenswerten Änderungen an DVhub werden in dieser Datei dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/lang/de/).

CHANGELOG.md ist die Single Source of Truth für die Versionshistorie; der README
verweist hierher.

## [Unreleased]

### Neu

- **Oberfläche lädt nach einem Update selbst neu.** Eine offene Seite — besonders die Home-Screen-Webapp — erkennt
  eine neue DVhub-Version und lädt neu, statt bis zum Schließen den alten Stand zu zeigen (Anlass: nach einem Update
  fehlte in der offenen Webapp der E-Auto-Wochenplan). Der Server hängt an jede JSON-Antwort die Build-Kennung der
  Oberfläche (`X-DVhub-Build`, Hash aus Version und Inhalt von `public/`); die vorhandenen Status-Abfragen reichen,
  beim Zurückkehren in die Webapp prüft die Seite einmal `/health`. Wird nichts bearbeitet, lädt sie nach kurzem
  Hinweis neu; ist ein Dialog oder eine Seitenleiste offen, stehen ungespeicherte Einstellungen oder ein Entwurf der
  E-Auto-Kachel an oder wurde ohne Speichern etwas eingegeben, erscheint „Neue DVhub-Version installiert — neu laden“
  mit Knopf, und sie lädt nach dem Speichern bzw. Schließen von selbst. Kein Endlos-Neuladen: je Kennung höchstens
  einmal in 10 min, überhaupt höchstens einmal je Minute, sonst nur der Hinweis. Wirkt ab dem ersten Update nach
  dieser Version (eine schon offene ältere Seite kennt den Mechanismus noch nicht).

- **Sungrow SH Hybrid als Beta-Hersteller (nur Bleeding Edge).** Neues Herstellerprofil `sungrow` für SH3.0–10RS,
  SH5.0–10RT (inkl. -20/-V112/-V122), SH5T–SH25T und MG5/6RL über Modbus TCP (LAN-Port oder WiNet-S/S2, Port 502,
  Unit-ID 1), Register nach Sungrow-Protokoll V1.1.9. DVhub erkennt das Gerät am Typcode und schreibt nur an einen
  erkannten Hybrid-Wechselrichter (ein String-WR der SG-Serie wird gelesen, aber nicht gesteuert). Liest SoC,
  Akku-, PV-, Haus- und Netzleistung (Smart Meter 5601–5608, ältere Firmware: Einspeiseleistung 13010), dazu
  Seriennummer, SoH, Akkutemperatur und Tageswerte. Steuert den Akku über den Netz-Sollwert: nahe 0 W bleibt der
  Wechselrichter in Self-consumption, sonst Forced mode mit Laden/Entladen und Leistung (13050–13052), alle 10 s aus
  Netz- und Akku-Messung nachgeführt — ohne Bezugs-Wunsch nie Laden aus dem Netz, ohne Einspeise-Wunsch nie Entladen
  ins Netz; ohne frische Messwerte oder Sollwert zurück in Self-consumption. Abregelung (Direktvermarkter, §51) über
  die Einspeisebegrenzung am Netzpunkt (13088/13074/13087), vorher gesichert und bei Freigabe zurückgeschrieben.
  Jeder Write mit Rücklesen; Holding-Register werden nicht zyklisch gelesen (WiNet-S). Steuermodus einstellbar
  (Einstellungen → Anlage verbinden → „Sungrow-Akkusteuerung“, Beta): **External EMS** (Standard) mit Herzschlag 13080
  alle 10 s, Frist 30 s (20–300 s) — fällt DVhub aus, kehrt der Wechselrichter selbst in Self-consumption zurück;
  ohne das Register (alte Firmware) steuert DVhub den Akku nicht und meldet das. Alternativ **Forced mode** (ohne
  Rückfall). Ein Moduswechsel geht erst über Self-consumption. Not-Halt nimmt einen von DVhub gesetzten
  Zwangs-/EMS-Betrieb einmal zurück, danach auch kein Herzschlag. Ein fremdes EMS (Modus External/VPP) wird nicht übersteuert. Noch nicht an
  echter Hardware geprüft — Anleitung für den Test: `docs/SUNGROW-BETA.md`. Allgemein neu dafür: Profil-Punkte mit
  `notAvailableRaw` (Gerät meldet „kein Wert“ → leer statt Zahl), Zähler mit 4×int32 (`meter.readType: 'int32'`,
  Ersatzregister `meter.fallback`), Sequenzschritte mit `optional` (Register fehlt → Schritt übersprungen) und
  Steuerpunkte mit `verify` (Rücklesen nach jedem Write).

- **LUOX/Lumenaza als Datenquelle (Einstellungen → Strompreise → „LUOX / Lumenaza“).** Mit den eigenen Zugangsdaten
  des LUOX-Kundenportals (inoffizielle Portal-Schnittstelle, nur lesende Abrufe; Token 0600 im Datenverzeichnis,
  gebunden an E-Mail und Passwort, Refresh mit Rotation, sonst neue Anmeldung; abgelehnte Zugangsdaten sperren den
  Abruf 6 h): **Preisquelle „LUOX-Kundenportal“** holt die Day-Ahead-Viertelstundenpreise direkt bei LUOX statt über
  öffentliche Preisanbieter — fehlt ein Tag, füllt dvhub.online/Energy-Charts ihn auf, und DVhub fragt bis 20 Uhr
  weiter bei LUOX nach. **Anbieter „LUOX Dynamisch“** im Strompreis „Vom Stromanbieter“: als Energiepreis netto den
  Spot je Viertelstunde, als Endpreis (vorbereitet, ungeprüft bis zur ersten Abrechnung, eigener Schalter) (Spot + 3 %
  vom Betrag) × MwSt + Netzentgelt, Umlagen, Stromsteuer und Herkunftsnachweise laut Produktangaben im Portal.
  **Direktvermarktung täglich abgleichen**: Abrechnungsschein (Einspeisung × Day-Ahead → Vergütung, 15 min, XLSX ohne
  neue Abhängigkeit gelesen) und Tagessummen der Einspeisung des Erzeugervertrags in die Datenbank, Bericht neben
  DVhubs eigener Einspeisung × Day-Ahead — nur zum Abgleich, DVhub steuert nicht danach. **Lumenaza-Partner-API**
  (OAuth2 Client Credentials) vorbereitet und ab Werk aus; eingeschaltet mit Zugangsdaten geht sie bei Preisen und
  Einspeisung vor dem Portal.
- **EOS-Schwellen-Peak-Shaving: Akku deckt in gehaltenen Slots den Bezug über der Netzanschlussgrenze.** Liefert der
  EOS-Plan an seinen Akku-Instruktionen `peak_shaving_threshold_w` (unser EOS mit der Netzbezugs-Grenze, PR D; Vanilla
  v0.4.0rc3 kennt das Feld nicht), deckelt DVhub in Slots, in denen der Plan den Akku hält („Akku halten“) oder aus dem
  Netz lädt, den positiven Netz-Sollwert auf diese Schwelle (`ctx.batteryAssist`, Quelle `eos-threshold`): Victron und
  jedes Profil mit schreibbarem Netz-Sollwert holen den Bezug über der Schwelle aus dem Akku, der Rest bleibt gehalten.
  Freigegebene Slots, Slots ohne Schwelle und Anlagen ohne steuerbaren Akku bleiben unverändert; ohne das Feld verhält
  sich DVhub wie bisher. Deckt der Netzanschluss-Wächter dieselbe (oder eine strengere) Grenze schon, stellt die
  EOS-Schwelle keine zweite Anforderung. Strengstes Ziel gewinnt (§14a, Netzanschluss, Peak Shaving), im Not-Halt keine
  Akku-Hilfe, Victron-Register 2714/2715 bleiben unberührt. Solange eine Schwelle wirkt, sperrt die Einspeisung aus
  Akku 2 den Akku 1 nicht. Leitstand (Kachel „Netzanschluss“): „EOS: Akku deckt über X kW“. Wirkt nur mit
  eingeschaltetem „Akku halten“ (`optimizer.eosGridHoldEnabled`) und einem EOS, das PR D enthält.
- **E-Auto: Wochenplan mit Mindest- und Max-Ladestand.** Je Wochentag steht im Wochenplan jetzt, wie voll das Auto bei
  der Abfahrt **mindestens** sein muss und wie viel Ladestand die **Fahrt** danach etwa braucht — beides in %, nicht
  mehr in km. Dazu ein **Max-Ladestand, wenn günstig** (Standard 80 %, leer = aus): Ist Laden günstig (billige Nacht,
  PV-Überschuss), lädt EOS über das Mindestziel bis dorthin. Was eine zusätzliche kWh wert ist, schätzt DVhub aus Preisen
  und PV der nächsten 7 Tage (was sie später an Ladekosten spart, minus 1 ct Sicherheitsabschlag) und gibt es EOS als
  Wertstufen mit. Ist der Max-Ladestand erreicht, beendet DVhub das Laden an der Wallbox; eine Ladegrenze im Auto kann
  zusätzlich bestehen. Dafür zählt nur ein Ladestand, der nach dem zuletzt gesehenen Abstecken gelesen wurde — ein
  Wert von vor der Fahrt (TeslaMate, Fahrzeugtreiber) stoppt die Box nicht mehr (Fable R5 P3-2). „Sofort laden“ von Hand und der Not-Halt bleiben unberührt.
  - **Vorausschauend:** Das Mindestziel rechnet DVhub über die Fahrten der nächsten 8 Tage — reicht die Zeit zwischen
    zwei Fahrten nicht zum Nachladen (z. B. Samstag 09:00 und 13:00), steigt das Ziel der ersten Abfahrt.
  - **Einmal-Ziel:** „Morgen längere Strecke“ = einmal z. B. 75 % bis 08:00 (Leitstand-Kachel und Integrationen →
    evcc). Der Wochenplan bleibt, wie er ist; nach der Abfahrt ist das Ziel vorbei. Eine vorgezogene Einmal-Abfahrt
    lässt die ersetzte reguläre Abfahrt danach nicht wieder aufleben. Das Einmal-Ziel ersetzt höchstens die eine
    Abfahrt, zu der es gehört (dasselbe Fenster bzw. die nächste Abfahrt bis 24 h); Wochenplan-Abfahrten davor bleiben
    mit Mindestziel und Frist und kommen zuerst — auch bei einem Ziel in Wochen. Welche Abfahrt ersetzt ist, hängt
    nicht davon ab, wann man nachsieht.
    **Bedienung in der Kachel (11.11.2026):** statt dauerhafter Felder der Knopf **„Einmalige Abfahrt planen“** mit
    Dialog (Abfahrt als Datum + Uhrzeit, mindestens %, unter „Erweitert“ Verbrauch der Fahrt und einmal „zuhause ab“;
    am Handy als Blatt von unten). Solange es gilt, zeigt die Kachel **„Einmalig: Fr 14.11. 07:30 · mind. 80 %“**
    mit „Ändern“/„Beenden“ und was es bewirkt (ersetzte Wochenplan-Abfahrt, welche davor noch gilt, wann es endet).
    **Ende von selbst:** zur Abfahrt (10 min Vorlauf) bzw. beim Abstecken in der halben Stunde davor; danach räumt
    DVhub das Einmal-Ziel (und eine vergangene einmalige Ankunft) aus der Konfiguration, sobald es an der Planung
    nichts mehr ändert — ein vergangenes Ziel wirkt nie still weiter, und der Knopf erscheint wieder. Neue Termine in
    der Vergangenheit lehnt DVhub ab; Hinweise im Dialog, wenn die Abfahrt vor der erwarteten Ankunft liegt oder das
    Mindestziel über „Max, wenn günstig“. **Gleiche Bedienung überall:** Leitstand-Kachel, Family-Ansicht (E-Auto-Panel)
    und Integrationsseite (Einstellungen → E-Auto, statt der alten Dauerfelder) nutzen denselben Baustein; gespeichert
    wird sofort über `/api/ev` (Anmeldung + Pro, wie die übrige E-Auto-Planung). **Wirkt auch bei ausgeschaltetem
    Wochenplan:** dann ist das Einmal-Ziel die einzige Abfahrt (Frist und Ziel an EOS, Wertstufen, Vorplanung), der
    Wochenplan bleibt aus, nach der Abfahrt plant DVhub wieder keine.
  - **Zeile = Tag der Abfahrt, Bedienung neu (T-0427, Christin 11.11.2026):** Jede Zeile des Wochenplans ist jetzt der
    Tag, an dem man losfährt — „Dienstag 08:30 mit 80 %“ steht bei Dienstag; vorher war es der Tag der Ankunft, und
    man musste in die Montagszeile eine Ankunft erfinden. Statt eines Rasters aus Zeitfeldern: oben die
    **Standardwerte** (Wochenplan an/aus, „Standard: mindestens bei Abfahrt“, „Wenn günstig laden bis“), darunter je
    Tag eine **Karte in Klartext** („Di · 08:30 · mind. 80 %“) mit Schalter „fahre an diesem Tag“; Antippen öffnet ein
    **Blatt** wie beim Einmal-Ziel: Abfahrt, mindestens (Knöpfe 50–100 % oder frei), unter „Erweitert“ optional
    **„zuhause ab“** (am Vortag oder am selben Tag) und **„Verbrauch dieser Fahrt ≈ … %“** mit „→ bei Ankunft ≈ X %“
    (leer = 0, nicht mehr in jeder Zeile). Dazu **„Pendeln Mo–Fr einrichten“**, „Wie Montag“ und „Woche leeren“.
    Oben in Klartext, was DVhub daraus macht (nächste Abfahrt, ab wann geladen wird, Ladestand bei Ankunft); die
    Technik (EOS-Ziele, Wertstufen) eingeklappt unter „Details zur Ladeplanung“. Breit stehen die Tage als
    Wochenleiste nebeneinander. Gleich in Leitstand-Kachel, Family-Ansicht und Integrationsseite; das Einmal-Ziel
    steht als eigene Karte („Einmalig: Fr 13.11. 06:30 · mind. 85 %“) über der Woche und nutzt dieselben Begriffe.
    **Geplant wird genau wie vorher** (Äquivalenztest über Zufallspläne und zwei Wochen). **Alte Pläne werden beim
    Laden einmal umgerechnet:** Hilfs-Ankünfte (am Vormittag knapp nach der Abfahrtszeit, nur eingetragen, damit die
    Abfahrt auf den Folgetag rutscht) fallen weg, zwei Abfahrten an einem Tag bleiben beide; der Plan zeigt einmal
    „Wochenplan umgestellt — bitte prüfen“ mit der Liste der Änderungen, der alte Plan bleibt in der Konfiguration
    gesichert. **Rückweg auf 1.0.9:** der Plan wird zusätzlich im alten Format mitgeschrieben; ändert eine ältere
    Version ihn, gilt deren Stand nach dem nächsten Update. `/api/ev`: neues Feld `weeklyDepartures`, das alte
    `weeklyPlan` wird weiter angenommen.
  - **Ohne passendes EOS wie bisher:** Kennt EOS die Wertstufen nicht (Vanilla v0.4.0rc3), lädt EOS nur bis zum
    Mindestziel, Max-Ladestand und Wallbox-Grenze ruhen; das Mindestziel bleibt vorausschauend. Die Oberfläche sagt es.
  - **Einphasig laden,** wenn die Wallbox umschalten kann (evcc meldet es je Ladepunkt): kleine Leistungen 1,4–3,7 kW
    statt erst ab 4,1 kW dreiphasig. EOS bekommt nur noch Ladestufen, die die Wallbox wirklich fahren kann.
    **Einphasig höchstens 20 A** (4,6 kVA Schieflast nach VDE-AR-N 4100; evcc selbst deckelt einphasig nicht): bei
    einer 22-kW-Box mit Mindeststrom 10 A stellte DVhub sonst bis zu 30 A auf eine Phase. Zwischen 4,6 kW und der
    dreiphasigen Mindestleistung gibt es keine Stufe; liegt der Mindeststrom über 20 A, lädt DVhub nur dreiphasig.
    Gilt auch für Autos, die nur einphasig laden. Ein kleinerer Wert ist einstellbar
    (`optimizer.evOnePhaseMaxCurrentA`), ein größerer gilt nicht.
    Im Not-Halt und im Lese-Modus schaltet DVhub keine Phasen und stoppt nicht am Max-Ladestand — auch nicht, wenn
    der Not-Halt mitten in einem Befehl („erst Strom, dann Phasen“) oder während des Plan-Abrufs kommt.
    **Von Hand umgestellt bleibt umgestellt:** Stellt jemand die Phasen in evcc um (App, auch auf „automatisch“),
    erkennt DVhub das an der eingestellten Phasenzahl und schaltet die Phasen für diesen Ladevorgang nicht mehr — bis
    zum Abstecken; der Ladestrom passt sich der gewählten Phasenzahl an, der Netzanschluss-Wächter begrenzt weiter.
    Vorher galt der Befehl bei gleichem Strom als unverändert, und das Auto lud dreiphasig mit z. B. 8,3 kW statt
    2,75 kW. Damit kurz veraltete evcc-Meldungen nicht als Änderung gelten, zählen sie erst eine Minute nach DVhubs
    eigenem Befehl, nur aus Abfragen danach und erst in der zweiten Abfrage; evccs eigene Umschaltung (aktive Phasen)
    zählt nie. Status: `GET /api/integration/evcc/eos` → `phasesByCustomer`.
    **Danach wieder wie vorher:** Hat DVhub für sein eigenes Laden die Phasen umgestellt (z. B. evcc auf „automatisch“
    → einphasig), stellt es nach seiner Ladung den Wert von vorher wieder her — „automatisch“ bzw. fest 1 oder 3. Danach
    heißt: Plan ohne Ladung, Max-Ladestand erreicht, „Laden stoppen“, Abstecken; immer erst nach dem Stopp, damit
    „Sofort laden“ nicht kurz mit allen Phasen lädt. Abgesteckt stellt DVhub keine Phasen ein. Der Not-Halt nimmt die
    eigene Phasen-Vorgabe beim Aktivieren genau einmal zurück (nur wenn evcc noch auf DVhubs Phasen steht und DVhubs
    Ladung gestoppt ist), danach kein Befehl. Von außen umgestellt: nichts zurückstellen; Lese-Modus: nichts schreiben.
    Der Wert von vorher übersteht einen Neustart (`ev_owned.json`); Status `phasesRestoreTo`. Ob DVhub umschalten muss,
    entscheidet die in evcc eingestellte Phasenzahl (nicht die gerade aktiven Phasen, die nach einer Umschaltung bis zur
    nächsten Abfrage nachhängen) — sonst lud ein einphasiger Slot auf „automatisch“ kurz dreiphasig. Nach einem
    Phasenbefehl setzt eine ältere, später ankommende evcc-Antwort die Phasenzahl nicht zurück; überholte Antworten
    einer evcc-Abfrage gelten generell nicht mehr. Stellt jemand die
    Phasen kurz vor dem Not-Halt um, gilt das als Änderung von außen.
  - **Wertstufen frisch zum Lauf:** Vor jedem von DVhub angestoßenen EOS-Lauf gehen nach dem Prognose-Push auch die
    Wertstufen des Autos an EOS — vorher rechnete ein Lauf mit den Stufen des letzten Abgleichs (nach dem Start leer).
  - **Start-Ladestand des Autos an EOS abgerundet** statt gerundet — EOS plant nie mit mehr, als drin ist.
  - **Übernahme:** Bestehende Wochenpläne werden beim Start einmal umgerechnet — Ziel in kWh/km in %. Status unter
    `GET /api/ev` (`targets`: Mindestziel, Max, Wertstufen; `maxStop`). Kaputte alte Werte (z. B. ein leeres Ziel `[]`)
    gelten als „nicht gesetzt“ statt als Mindest-Ladestand 0 %.
  - **Der Heimweg zählt nicht mehr:** Geplant wird nur mit dem je Abfahrt eingetragenen Verbrauch der Fahrt in %
    („Fahrt %“). Ein alter Heimweg in km — allgemein oder je Tag — wird weder in Fahrten umgerechnet noch vom
    erwarteten Ladestand bei Ankunft abgezogen; der Heimweg ist jedes Mal anders, und DVhub weiß nicht, ob das Auto
    auf dem Heimweg ist oder noch woanders hinfährt. Der Wochenplan-Editor weist auf einen alten allgemeinen Heimweg
    hin.
- **§14a: Hausspeicher deckt zuerst (Schnittstelle).** Verlangt der Netzbetreiber eine Reduzierung, berechnet DVhub
  die benötigte Akku-Hilfe (Bedarf der steuerbaren Verbraucher über der Grenze plus Haushalt ohne Speicher) und fordert
  sie über eine schmale Schnittstelle bei der Akku-Steuerung an (`ctx.batteryAssist.request({ source: 'p14a', coverW,
  untilMs })`). Gekürzt wird weiter nach dem gemessenen Netzbezug am Anschlusspunkt — liefert der Speicher, steigen
  die Anteile, sonst bleibt es bei der Kürzung. Angefordert wird nur mit gültigem, frischem Zählerwert (höchstens
  30 s alt); Anfragen gehen nacheinander raus, eine Freigabe wird wiederholt, bis die Akku-Steuerung sie bestätigt.
  Solange er hilft, lädt der Speicher nicht aus dem Netz; im Not-Halt keine Akku-Hilfe. Einstellung „Hausspeicher deckt zuerst (Akku-Hilfe)“ (System → §14a, ab Werk an). Wirksam erst
  mit der Akku-Steuerung, die die Anforderung umsetzt (eigener Zweig); bis dahin ändert sich nichts.
- **Bleeding Edge auch für Paket-Installationen.** Native Boxen mit signierten Paketen können wieder auf Bleeding Edge
  wechseln, sobald ein Bleeding-Edge-Paket veröffentlicht ist (signierter Index `channels/index-dev.json`). Gibt es
  keins, bleibt die Box auf Stabil und die Oberfläche sagt: „Für Paket-Installationen ist derzeit kein
  Bleeding-Edge-Paket veröffentlicht.“ Rückschritt-Prüfung und Kanal-Rückfall bei einem gescheiterten Wechsel gelten
  wie bisher; ein älteres stabiles Paket erscheint nicht mehr als „Update“. Die Bleeding-Edge-Pakete werden vorerst
  von Hand aus `main` gebaut, nur aus Commits, die auf `origin/main` liegen (`docs/release-pakete.md`).
- **Version 1.0.10 auf main.** Bleeding-Edge-Pakete aus `main` heißen `1.0.10-dev.…` und sortieren damit nach 1.0.9.
- **Lizenz-Umzug wird gemeldet.** Bindet eine andere Box die Lizenz an sich, schaltete die bisherige Box die
  Pro-Funktionen bisher still ab. Jetzt kommt einmal je Umzug eine Benachrichtigung über die eingerichteten Kanäle
  (auch im Betrieb mit getrenntem Runtime-Prozess), und der Leitstand zeigt „Deine Lizenz ist jetzt auf einer anderen
  Box …“ mit dem Weg zurück (Einstellungen → Lizenz → „An diese Box binden“).
- **Netzspannung und Netzfrequenz zentral.** Der Poller liest L1–L3-Spannung und Netzfrequenz des Netzzählers mit
  und legt sie in den Live-Zustand (`/api/status`: `victron.gridVoltage` roh, `gridVoltage` mit Frische-Prüfung).
  Der Leitstand zeigt sie in der neuen Kachel „Netz · Zähler“: L1–L3 in V (eine Nachkommastelle), Frequenz in Hz
  (zwei Nachkommastellen), „–“ ohne Werte, „veraltet“ bei Werten älter als 2 min; gelb markiert, wenn eine Phase
  außerhalb 207–253 V oder die Frequenz außerhalb 49,8–50,2 Hz liegt. Quellen: Victron per Modbus (alle 30 s, nur
  lesend), Victron per MQTT (Grid-Topics) und der SPiNE EnergyLink (aus derselben Abfrage wie die Netzleistung).
  Andere Profile definieren keine Spannungsfelder, dort bleibt der Wert leer.
- **Netzzähler-Unit wird gesucht (GH #33).** Victron per Modbus fragt zuerst die konfigurierte bzw. System-Unit
  (Standard 100; ein Zähler mit DeviceInstance 0, etwa am VE.Can, liegt dort). Antwortet sie mit einer
  Modbus-Ausnahme (z. B. 10) oder ohne Spannung, sucht DVhub einmalig die Unit des Netzzählers
  (`com.victronenergy.grid`, erst 30–49, dann 1–247; z. B. 40 beim VM-3P75CT per Ethernet oder 31 beim EM540),
  merkt sie und nennt sie im Log (`victron_grid_meter_found`). Eine Zeitüberschreitung löst keine Suche aus.
- **Datenspende: Netzspannung je Phase.** Liefert die Anlage Spannungen, spendet DVhub sie als `voltage`-Messwert
  (V) — je Phase ein eigener Zähler „Netzspannung L1/L2/L3“, wie ein Spannungs-Sensor in der Home-Assistant-
  Integration. Jede Messung (alle 30 s, über MQTT/SPiNE häufiger) geht einmal hinaus, nur frische Werte. Neue Quelle
  „Netzspannung (L1–L3)“ in der Datenspende-Kachel, **ab Werk aus und nur mit eigener Zustimmung**: Wer bisher
  spendet, hat nur Leistungswerten zugestimmt — die Spannung geht erst hinaus, wenn man das Kästchen anhakt und die
  Nachfrage bestätigt (auch bei neuen Verknüpfungen; über den Support-Tunnel nicht einschaltbar). Bestehende Zähler
  und Spenden bleiben unverändert; die drei Zähler werden erst nach der Zustimmung beim ersten Wert registriert
  (Fable-Prüfung R3, P2-3).
- **EOS-Steuerzeitraum „automatisch“.** Neue Auswahl unter Einstellungen → EOS-Optimierung → „EOS Steuerzeitraum
  höchstens“: mindestens 6 h und bis zur Abfahrt des E-Autos (solange es bei EOS angemeldet ist) bzw. bis zum
  Fensterende eines planbaren Geräts, das heute noch nicht gelaufen ist (ohne Fensterende: frühester Start plus
  Laufzeit), höchstens so weit, wie Börsenpreise bekannt sind. Dahinter bewertet EOS die Restladung wie bisher über
  den Prognose-Schwanz. Gemessen auf 305 Tagen echter Daten gleichauf mit dem ganzen Preiszeitraum, bei etwa einem
  Viertel der Rechenzeit (mit 100 Generationen). Der bisherige Standard (ganzer bekannter Preiszeitraum) bleibt
  Standard. Das Protokoll `eos_control_horizon` nennt jetzt Modus, Grund und Frist.
- **EOS-Generationen als Auswahl.** „EOS Generationen“ bietet jetzt „200 (Standard)“, „100 (schwache Hardware,
  z. B. A55-Boards)“ und „Eigener Wert (50–1000)“. Der Leitstand zeigt am EOS-Fahrplan die mittlere Laufzeit der
  letzten acht Läufe; dauern sie im Mittel länger als 10 Minuten, schlägt er 100 Generationen und den Steuerzeitraum
  „automatisch“ vor. Umgestellt wird nichts von selbst.
- **E-Auto-Ziel erst zur Abfahrt, nicht schon um Mitternacht.** Steckte das Auto vormittags an (Börsenpreise für
  morgen noch nicht da) und lag die Abfahrt am nächsten Morgen, endete der EOS-Steuerzeitraum um Mitternacht — und
  EOS verlangte das Ladeziel schon dort, lud also am Abend teuer statt nachts. Jetzt reicht der Steuerzeitraum in
  genau diesem Fall bis zur Abfahrt; hinter den echten Preisen rechnet EOS mit den geschätzten. Sobald die echten
  Preise kommen, rechnet EOS neu. Der Leitstand kennzeichnet das am EOS-Fahrplan („Preise geschätzt“, mit Abfahrt)
  und unter „Laut EOS-Plan“. Aus Slots mit geschätzten Preisen setzt DVhub keine Akku-Regeln um; für den Hausakku
  allein bleibt es dabei, dass im Steuerzeitraum nur echte Preise liegen. Eine feste Grenze (6/12/24 h) bleibt fest.
  Mit „EOS rechnet nach eigenem Takt“ (dort schickt DVhub keine Schätzwerte) schneidet DVhub die Akku-Regeln nicht
  mehr an der alten Mitternacht ab, sobald seit über drei Stunden keine Schätzwerte mehr in EOS liegen — vorher
  fielen zwischen etwa 13 und 16 Uhr die Regeln für die Nacht weg, obwohl die Preise für morgen da waren. Nach einem
  Neustart von DVhub bleibt es bis zu drei Stunden beim vorsichtigen Schnitt (Fable-Prüfung R3, P3-2).
- **Netzanschluss: DVhub hält die Bezugsgrenze des Hausanschlusses ein.** Neue Einstellung „Netzanschluss maximal
  (kW)“ unter Netz & Recht, stabil (kein Beta), ab Werk leer = aus. Anlass: EOS plante 34,4 kW Netzbezug (Akku 27 kW +
  E-Auto 11 kW + Haus) an einem 29-kW-Anschluss. Der Wächter läuft bei jeder Zählerabfrage (Prod alle 2 s):
  - Jeder positive Netz-Sollwert (EOS, Kleine Börsenautomatik, Zeitplan, Handeingabe, Netzladen, §14a, „Akku halten“)
    wird auf Grenze − Sicherheitsabstand gedeckelt (Victron). Die Akku-Ladung aus dem Netz gibt damit immer zuerst nach.
  - Reicht das nicht, nimmt DVhub die steuerbaren Lasten zurück, Reihenfolge einstellbar (Standard Wallbox → Heizstab
    → EEBUS-Geräte). Die Wallbox regelt erst den Ladestrom bis zum Mindeststrom herunter und pausiert dann.
  - Die Pause ist hart: evcc geht auf „aus“, eine direkte Wallbox bekommt stop(), egal welcher Stopp-Modus
    eingestellt ist. Das gilt auch für „Sofort laden“ und für die §14a-Pause. Bisher lud evcc bei „minpv“ weiter.
    Senkt der Wechselrichter seine Akku-Ladung nicht binnen 10 s, kürzt DVhub die Geräte trotzdem.
  - Wieder frei gibt DVhub erst mit Rückschalt-Abstand: 30 s Luft, frühestens 60 s nach dem Eingriff, ein Gerät je
    Schritt. Optional gilt eine Grenze je Phase (A), weil Sicherungen je Phase auslösen.
  - Fail-safe: Ist der Zähler gestört oder sein Wert älter als 90 s, gibt DVhub keine neue Last frei. Der Akku-Sollwert
    sinkt dann auf Grenze − Abstand − geschätzte Grundlast − laufende Geräte.
  - Die Wallbox überwacht der Wächter IMMER, solange eine Grenze gilt (Christin 07.11.2026): mit oder ohne
    EOS-Weitergabe, bei „Sofort laden“, wenn evcc im eigenen Modus (pv/minpv/now) lädt und bei Handstart — und jeden
    ladenden evcc-Ladepunkt, nicht nur den eingestellten. Ein evcc-Ladepunkt, den DVhub nicht selbst steuert, wird nur
    über maxcurrent begrenzt (Modus bleibt); unter dem Mindeststrom geht er auf „aus“ und kehrt in seinen Modus zurück,
    sobald der Deckel den Mindeststrom wieder erlaubt; ohne Deckel bekommt er seinen Ursprungsstrom zurück. Zieht ein
    Gerät trotz Deckel deutlich mehr (z. B. von Hand wieder gestartet), sendet DVhub den Deckel erzwungen neu, höchstens
    alle 30 s. Eine Box, die beim Deckeln nichts zog (z. B. Fail-safe), gibt DVhub ganz frei statt sie per Ladebefehl
    zu starten.
  - Leitstand-Kachel „Netzanschluss“ und Protokoll-Ereignisse, z. B. „Netzanschluss: begrenzt Akku-Ladung auf 28,0 kW“.
  - Peak Shaving, §14a und Netzanschluss nutzen denselben Kern (`services/import-limit/core.js`): Sollwert-Deckel und
    „kleinste gilt“ je Gerät.
  - Grenze der Physik: Nicht steuerbare Verbraucher wie Herd oder Durchlauferhitzer kann DVhub nicht abschalten. Es
    nimmt alle steuerbaren schnell zurück und meldet, wenn nichts mehr übrig ist.
- **Netzanschluss: Akku zuerst auch ohne Victron.** Bisher galt der Akku nur bei Victron als Hebel (der Multi deckt
  über seiner AC-Eingangsgrenze selbst aus dem Akku); andere Anlagen drosselten sofort Wallbox & Co. Jetzt regelt
  DVhub „Akku zuerst“ selbst, je nachdem, was das Herstellerprofil schreiben kann — nicht nach dem Herstellernamen,
  eigene Profile zählen genauso:
  - **Netz-Sollwert** (z. B. Universal MQTT-Bridge, Universal HA/Loxone): dieselbe Sollwert-Decke wie bei Victron —
    auch „Akku halten“ von EOS wird auf Grenze − Abstand gedeckelt, der Speicher deckt den Rest aus dem Akku.
  - **Entladegrenze**: Hält sie den Akku fest (z. B. 0 = „Entladung sperren“) oder deckelt sie ihn zu tief, hebt DVhub
    sie um den Überschuss + 200 W Regelabstand an, höchstens bis zur Entladeleistung des Akkus bzw. der
    Wechselrichter-Nennleistung, nur mit frischem Ladestand über der Untergrenze (Sicherheit bzw. Mindest-Ladestand
    im Wechselrichter). Je Phase gerechnet, wenn der Zähler Phasenwerte liefert.
  - Der Akku bekommt 10 s, um zu folgen; erst dann (oder wenn er leer bzw. an seiner Leistungsgrenze ist) drosselt
    DVhub die Lasten wie bisher — und nur um den Rest, den der Akku nicht schafft.
  - Zurück in Stufen: Reicht weniger, sinkt die Entladegrenze nach 30 s mit Rückschalt-Abstand; liegt der Bezug auch
    ohne Hilfe mit Abstand unter dem Ziel, schreibt DVhub nach 30 s (frühestens 60 s nach dem letzten Anheben) die
    Entladegrenze davor zurück. Setzt eine andere Quelle (Handeingabe, MQTT) währenddessen eine kleinere
    Entladegrenze, hält DVhub die Hilfe und schreibt danach diesen jüngsten Wunsch zurück; eine größere gilt sofort.
  - Zähler gestört: die Hilfe bleibt stehen (kein Anheben, kein Zurücknehmen), außer der Akku ist leer. Ein Merker
    (`grid_connection_assist.json`) sorgt dafür, dass nach einem Neustart die Entladegrenze davor zurückkommt.
  - Not-Halt: DVhub nimmt die eigene Anhebung einmal zurück und greift danach nicht mehr ein. Victron unverändert.
  - Profile ohne Netz-Sollwert und ohne Entladegrenze (Fronius GEN24, Deye LV) zeigen „Akku nicht steuerbar — DVhub
    drosselt direkt die Lasten“; dort regelt der Wechselrichter seinen Eigenverbrauch selbst.
  - Leitstand-Kachel „Netzanschluss“: neue Zeilen „Akku“ (Hebel) und „Akku-Hilfe“ (was der Akku gerade zusätzlich
    abgibt, mit Entladegrenze vorher/jetzt); Zustand „Akku hilft“, solange nur der Akku eingreift.
  - **Mehrere Quellen, auch §14a:** Derselbe Regelkreis nimmt Anforderungen anderer Dienste an (`ctx.batteryAssist`).
    §14a fragt je Takt `request({ source: 'p14a', coverW, untilMs })` an: `coverW` ist die gesamte Abgabe des Akkus,
    `untilMs` der Ablauf der Vorgabe, `coverW: 0` gibt frei (auch im Not-Halt); Antwort `{ ok, acceptedW }`, zugesagt
    höchstens die Entladeleistung. Daneben `request({ source, maxImportW })`, `release(source)` und `status(source)`
    (gemessene Entladung in W) — gedacht auch für das EOS-Schwellen-Peak-Shaving (`eos-threshold`). Das strengste Ziel
    gewinnt, mit oder ohne eingetragene Netzanschluss-Grenze; bei Victron wirkt es als Decke des positiven
    Netz-Sollwerts. Die Hilfe wird aus Messwerten gerechnet (Bezug + Entladung − Ladung), nie aus dem angefragten
    Sollwert. Im Not-Halt und bei Profilen ohne steuerbaren Akku wird eine Anforderung abgelehnt; ohne `untilMs`
    verfällt sie nach 2 min ohne Erneuerung. Die Leitstand-Kachel „Netzanschluss“ erscheint auch ohne Grenze, solange
    §14a Akku-Hilfe anfordert („keine eingetragen“, „Akku hilft … · für §14a“).
- **EOS plant mit der Bezugsgrenze.** Kennt das EOS den Schlüssel `max_grid_import_power_w` am Wechselrichter (unser
  EOS), bekommt es Grenze − Abstand und kürzt selbst. Ist die Grenze in DVhub entfernt, schickt DVhub 1 GW statt null,
  weil ein null per PUT den Wert in EOS nicht zurücksetzt. Vanilla v0.4.0rc3 kennt den Schlüssel nicht. Dort plant EOS
  als Behelf höchstens Grenze − Abstand − Grundlast − E-Auto (falls EOS es plant) als Ladeleistung aus dem Netz, über
  `max_ac_charge_power_w`. Die Entladegrenze und das PV-Laden bleiben dabei unberührt.
- **Zweite Victron-Anlage: Einspeisen aus Akku 2, wenn Akku 1 leer ist (Beta).** Neuer Schalter unter der zweiten
  Victron-Anlage (ab Werk aus). Steht der Akku der Hauptanlage am harten Boden, sperrt DVhub sein Entladen (ESS „max.
  Entladeleistung“ 0, alter Wert wird gesichert und übersteht einen Neustart) und lässt die geplante Einspeisung aus
  Akku 2 laufen, statt sie ganz zu streichen. Der alte Wert kommt zurück, sobald Akku 1 drei Punkte über dem Boden
  liegt; fällt Akku 2 aus, bleibt Akku 1 gesperrt und das Haus bezieht aus dem Netz. Gilt für geplante Einspeisung ab
  1 kW (Zeitplan, EOS, Handvorgabe; keine dauerhafte Handvorgabe unter ihrer Mindest-Ladung), nicht für den
  DC-PV-Export. Steht die max. Entladeleistung an der GX schon auf 0, bleibt alles wie bisher. Dafür liest das
  Victron-Profil Register 2704 jetzt mit (Hashes neu); über Modbus prüft DVhub Sperre und Werkseinstellung „unbegrenzt“
  (2704 zeigt beide als 0) zusätzlich mit Register 2720 — ohne 2720 (Venus vor 3.50) bleibt der Schalter wirkungslos.
  Gesichert wird nur ein Messwert von nach dem letzten Schreiben der Entladegrenze. Zusammenspiel: im Not-Halt nimmt DVhub die Sperre einmal zurück, sobald der Ladestand über dem
  harten Boden liegt, und schreibt danach nichts mehr; braucht der Netzanschluss den Akku (Lasten gekürzt, §14a fordert
  Akku-Hilfe an), sperrt DVhub nicht bzw. gibt Akku 1 schon über dem harten Boden wieder frei; nicht, solange Peak
  Shaving eine Sperre aufgehoben hat; nur bei Victron.

### Geändert

- **EOS: DVhub-EOS statt Vanilla v0.4.0rc3** (T-0415, Christin 11.11.2026). DVhub liefert nativ und im Docker-Image das
  DVhub-EOS aus: Akkudoktor-EOS `main` plus die offenen PRs, die DVhub braucht (Netzbezugsgrenze und
  Schwellen-Peak-Shaving #1531, E-Auto-Ladestart und Wertstufen #1532, bitgleiche Pläne #1518, optionaler Rust-Kern
  #1520), je Release im Fork `chloepriceless/EOS` neu gebaut, bis alles upstream ist. Pin
  `dvhub-eos-0.3.0.dev2611110839161148-dvhub.2` (`eos-version.env`), Image
  `bikinibottomcapital/dvhub-eos:0.3.0.dev2611110839161148-dvhub.2` (`EOS_IMAGE_TAG` in `docker/.env.example`;
  Git-Tag ohne Präfix, weil Docker-Tags kein `+` kennen). **Immer mit aktivem Rust-Kern** (Christin 11.11.2026):
  `akkudoktoreos-native` 0.2.0 rechnet die GENETIC-Optimierung bitgleich zu Python, aber rund 25-mal schneller (echte Prod-Tage, 1 Worker: 0,4–0,6 s statt 11–16 s), und ist
  für genau diesen Stand zertifiziert. Die Wheels liegen als Release-Assets am Fork-Tag; `eos-version.env` pinnt
  Dateiname und sha256 je Architektur (x86_64, aarch64, armv7l). Nativ holt `eos-provision.sh` das zur Box passende
  Wheel (Auswahl über die Plattform-Tags des EOS-venv, also auch Raspberry Pi OS 32 Bit mit 64-Bit-Kernel richtig),
  prüft die Prüfsumme, setzt `EOS_OPTIMIZATION__GENETIC__BACKEND=native` in `eos.service` und lässt
  `scripts/eos-native-smoke.py` einen kurzen Lauf rechnen; gilt nur „GENETIC native run“ ohne Rückfall. Scheitert
  das, läuft EOS zwar (in Python), aber die Installation endet mit Fehler, der Marker `.eos-native` sagt `failed`, und
  `post-update.sh` zieht beim nächsten Start nur den Kern nach (ohne git/venv). Plattformen ohne Wheel (z. B. armv6l:
  Raspberry Pi 1/Zero) rechnen ausdrücklich in Python, mit Warnung. Docker: die CI baut `dvhub-eos` mit
  `docker/eos-native` (Wheel aus denselben Pins, Backend `native`, nativer Probelauf als Bau-Stufe — für amd64 und
  arm64, sonst roter Job); `dvhub-eos-slim` setzt das Backend neu und prüft ebenfalls nativ. Notfall:
  `EOS_OPTIMIZATION__GENETIC__BACKEND=python` in `/etc/dvhub/eos.env` bzw. der Container-Umgebung. **Update von 1.0.9:** nativ zieht `post-update.sh` den neuen
  Stand (anderes Repo, anderer Tag) entkoppelt nach, sichert vorher die EOS-Daten und baut das venv neu; im Docker
  gleicht der Installer `EOS_REPO`, `EOS_TAG` und neu `EOS_IMAGE_TAG` mit der Vorgabe ab (eigene Stände weiter mit
  `DVHUB_PIN_VERSIONS=1`) und behält dabei die Rechte 600 der `.env`. Die Versionsnummer von `main` (`0.3.0.dev…`) ist
  der Zahl nach kleiner als `0.4.0rc3` — DVhub vergleicht EOS-Stände deshalb nur auf Gleichheit und erkennt EOS an
  seiner Konfiguration. Die CI baut das Image für amd64 und arm64 aus dem Fork-Tag; das schlanke `dvhub-eos-slim`
  trägt denselben Docker-Tag und prüft den neuen Namen des Healthcheck-Moduls (`containerhealthcheck`).
- **EOS-Fernbetrieb (DVhub-Rechendienst) entfällt** (Christin 11.11.2026): Mit dem Rust-Kern rechnet DVhub-EOS auch
  auf schwacher Hardware schnell genug lokal. „Wo rechnet EOS?“ und die Rechendienst-Felder sind aus den
  Einstellungen verschwunden; eine gespeicherte Betriebsart `remote` wird beim Laden zu `local` (EOS unter
  `optimizer.eosProxy.url`), mit Hinweis im Protokoll (`[config]`) und in der Warnungszahl der Einstellungen —
  übernommen wird sie mit dem nächsten Speichern; Adresse und Token des Dienstes bleiben stehen. Der Code
  (`services/optimizer/eos-remote.js`) ruht statt gelöscht zu werden: `eosRemoteActive()` ist immer `false`,
  `resolveEosProxy()` kennt nur noch `local`.
- **Not-Halt „als ob DVhub aus ist“** (Christin 06./07./10.11.2026). Der Not-Halt nimmt jede eigene Vorgabe von
  DVhub genau einmal zurück — nur, wo DVhub gerade selbst vorgibt; im Zweifel sendet er nichts — und schreibt danach
  nichts mehr an die Anlage, ohne Wiederholung. Messwerte, Protokoll und Status laufen weiter. Neu ausgesetzt sind
  auch die **§51-Abregelung bei negativen Preisen, die Abregelung durch den Direktvermarkter (inkl. Teilvorgabe auf
  2706), die Einspeisegrenze der Steuerbox, die feste Einspeisegrenze als Regelschleife und die Sicherheits-Nullung
  am SoC-Boden**: Eine von DVhub gesetzte PV-Sperre wird einmal aufgehoben, danach ist der Betreiber selbst
  verantwortlich. Der Leitstand nennt im Not-Halt-Banner, was ausgesetzt ist. Jede dieser Klassen lässt sich in
  `services/emergency-stop/policy.js` einzeln wieder einschalten.
  - **Netz-Sollwert bleibt unverändert** (Christin 10.11.2026: „Netz-Sollwert – das was in Victron drinsteht – nichts
    ändern.“). Der Eintritt schreibt den Netz-Sollwert nicht mehr — bisher einmal 0 W auf Victron 2716 (bzw. 2700),
    die MQTT-Brücke und jedes andere Profil mit schreibbarem Netz-Sollwert. Es bleibt, was im Gerät steht, wie bei
    ausgeschaltetem DVhub: der flüchtige Victron-2716 wird nicht nachgeführt und läuft nach der Venus-Frist ab, ein
    persistenter 2700 behält den zuletzt geschriebenen Wert. Auch die frühere Quelle `emergency_stop` kommt im
    Not-Halt nicht mehr durch das Tor. Leitstand-Knopf, Rückfrage und Meldung versprechen keinen „Sollwert 0“ mehr;
    `POST /api/control/stop` meldet `neutralize: { skipped: true, reason: "setpoint_unchanged" }`. Beim Fortsetzen
    schreibt DVhub den geplanten Sollwert im nächsten Takt neu, auch wenn er sich nicht geändert hat (im Gerät kann
    inzwischen etwas anderes stehen); alte Schreibfehler der zweiten GX lassen sie im Not-Halt nicht mehr flattern.
  - **§14a im Not-Halt ausgesetzt:** Die von DVhub gesetzten EEBUS-Grenzen gehen einmal auf „frei“, danach kein
    Herzschlag, kein Auffrischen, kein Wiederanlauf-„frei“ und keine Verdichter-Planung mehr. Die Geräte gehen nach
    ihrer Frist in ihren eigenen Failsafe, genau wie bei ausgeschaltetem DVhub. Die Vorgabe des Netzbetreibers wird
    weiter angezeigt und protokolliert; Leitstand und §14a-Ansicht zeigen „§14a im Not-Halt ausgesetzt“. Beim
    Aufheben nimmt DVhub jedes verbundene Gerät wie beim Anmelden wieder auf. Neuer Befehl `device_heartbeat` für
    dvhub-eebus (Go und C); ein Hilfsprozess ohne den Befehl wird neu gestartet.
  - **Zweite GX:** kein Sollwert-Write, auch keine 0 W, nur Lesen (vorher alle 5 s 0 W); auch das Abschalten der
    zweiten Anlage im Not-Halt schreibt nichts. Ohne Nachführen läuft ihr 2716 wie bei ausgeschaltetem DVhub ab
    (laut Code-Kommentar nach etwa 10 s Passthru). Die Einspeisung aus Akku 2 schreibt die gesicherte
    Entladegrenze nur beim Eintritt zurück, wenn der SoC-Boden es dann zulässt; sonst erst nach dem Not-Halt.
  - **Still im Not-Halt:** die Lebenszeichen von Salia, Nexblue, Schneider und openWB (die Box geht in ihren eigenen
    Failsafe), das Nachprüfen der Einspeisegrenze 2706, Wallbox-Modus und Relais über Familie oder MQTT (Antwort
    409 `emergency_stop_active`) sowie die 0 W an einen Heizstab, der im Not-Halt aus der Konfiguration entfernt wird.
    Peak Shaving, Netzanschluss und die Einspeisung aus Akku 2 haben je höchstens eine Rücknahme pro Not-Halt.
  - **Kaputte `control_state.json` → Start im Not-Halt.** Ist die Datei da, aber unlesbar, startet DVhub im Not-Halt.
    Der Leitstand und das Protokoll warnen deutlich, bis der Betreiber den Not-Halt bewusst aufhebt; die kaputte Datei
    bleibt als `.broken-<Zeit>` liegen. Vorher startete DVhub dann normal. Fehlt die Datei (Erstinstallation), startet
    DVhub wie bisher normal.

- **§14a: Aufteilung nach Bedarf statt nach Nennleistung.** Während einer Dimmung bekam jedes Gerät bisher Leistung
  bis zu seiner Nennleistung (Vorrang) bzw. nach Nennleistung (anteilig). Eine Wärmepumpe mit 5,5 kW Nennleistung, die
  1,5 kW zog, hielt so 5,5 kW fest, während der Wallbox Leistung fehlte. Jetzt bekommt jedes Gerät zuerst seinen
  aktuellen Bedarf (Messwert plus Reserve zum Hochfahren: max(500 W, 10 %), auf 100 W aufgerundet; Wallbox mindestens
  die Ladestufe 6 A, ohne Auto nichts; stehende Wärmepumpe/Klima eine Anlaufreserve von max(1 kW, 30 %); Speicher der
  Netzbezug, den der Plan gerade will), der Rest geht zuerst an Geräte, die
  an ihrer Grenze laufen, dann nach der eingestellten Reihenfolge bis zur Nennleistung — es verfällt nichts. Steigt
  der Bedarf, gibt es den Anteil im nächsten Takt (5 s) zurück; sinkender Bedarf zählt erst nach 60 s. Geräte ohne
  Messwert bekommen wie bisher ihre volle Leistung. Neue Einstellung „Zuerst nach aktuellem Bedarf verteilen“
  (System → §14a, ab Werk an, auch für bestehende Konfigurationen); Vorrang-Reihenfolgen und „anteilig“ bleiben
  wählbar. Integrationen → §14a zeigt je Gerät Bedarf und Messwert. Anlass: Praxistest im pv magazine (09.11.2026);
  die BNetzA (BK6-22-300, Ziffer 4.5.2) lässt die Aufteilung ausdrücklich dem Betreiber.
- **Hinweis zum VRM-Feld** (Issue #32): Bei mehreren Anlagen im VRM-Konto ist die Site-ID der sichere Weg; mit der
  Portal-ID sucht DVhub die passende Anlage selbst (Integrationen → VRM-Cloud und Einstellungen → Historie-Import).
- **Kopierter Lizenzzustand bindet nicht mehr von selbst.** Startet eine Box mit dem Lizenzzustand einer anderen Box
  (z. B. ein Test-Aufbau mit kopierter `license_state.json`), nimmt sie der anderen Box die Lizenz nicht mehr
  automatisch weg. Sie zeigt „Lizenz von anderer Box übernommen – an diese Box binden?“; gebunden wird erst über
  „An diese Box binden“ oder einen hier neu eingegebenen Schlüssel. Erkannt wird das am Machine-File einer anderen
  Box und, ab diesem Stand, an der Herkunft, die DVhub im Lizenzzustand vermerkt. Normale Boxen merken davon nichts:
  ihr Zustand gilt beim ersten Start weiter als eigener, ein neu eingegebener Schlüssel bindet wie bisher sofort.
- **Ortsnetz-Auslastung nutzt die zentralen Netzwerte (GH #33).** Die eigene Modbus-Leseverbindung (fest Unit 100)
  ist entfernt; gesendet wird, was der Poller liest, und nur, wenn die Werte höchstens 2 min alt sind. Damit läuft
  die Teilnahme auch auf Anlagen mit dem Netzzähler an einer anderen Unit (bisher „modbus exception 10“), über
  Victron MQTT und mit dem SPiNE EnergyLink. Ohne Spannungswerte meldet die Karte „Keine Spannungswerte“, bei alten
  Werten „veraltet“. Die Gültigkeitsregeln (150–300 V, 45–55 Hz) bleiben.
- **Datenspende: Schlüssel aus dem Datenportal als empfohlener Weg (GH #31).** Erste Option der Einrichtung: im
  COMSYS-Datenportal Haushalt und Schlüssel (Typ „Victron Energy“) anlegen, in DVhub nur den Schlüssel eintragen.
  DVhub prüft ihn mit `GET /clients` und meldet danach nur noch die Zähler an — kein Konto, kein Haushalt. Mit Link
  und Schritt-für-Schritt-Hilfe; das Schlüsselformat ist nicht mehr auf `A–Z a–z 0–9 _ -` beschränkt (geprüft wird
  beim Projekt).
- **Datenspende: Hilfetexte.** E-Mail ist freiwillig, je E-Mail gibt es nur ein Konto (verständliche Meldung bei
  `taken_email`); mehrere Anlagen gehören in EIN Konto („Vorhandenes Konto verwenden“ legt je Anlage einen Haushalt
  an); scheitert die Einrichtung nach dem Haushalt, weist DVhub auf den möglicherweise leeren Haushalt hin, der sich
  im Datenportal löschen lässt.
- **EOS-Standard 200 statt 400 Generationen.** Ohne eigenen Wert rechnete EOS bisher mit 400 Generationen; gemessen
  bringt das gegenüber 200 praktisch nichts, kostet aber die doppelte Rechenzeit. Wer ausdrücklich einen Wert
  eingetragen hat, behält ihn.
- **Historie: eigene Messwerte zuerst, der VRM-Import füllt nur auf.** Liegen für eine Viertelstunde eigene,
  lokal gemessene Werte und ein VRM-Import vor, gilt jetzt je Reihe der eigene Wert. Den VRM-Import nimmt DVhub
  nur, wenn eigene Werte fehlen oder die Viertelstunde nicht vollständig abdecken (z. B. Neustart von DVhub
  mitten in der Viertelstunde). Beide Quellen werden nie gemittelt oder gemischt. Bis 1.0.9 hatte der VRM-Import
  immer Vorrang, und der Rohdaten-Ausweichpfad konnte beide Werte mitteln. Gilt für Historie, Historie-Diagramme
  und den Bestandsnachversand der Datenspende.
  - *Vollständig* heißt: die gespeicherten Live-Proben decken die Viertelstunde bis auf höchstens 15 s
    (bzw. anderthalb Probenabstände) ab. Proben aus einer fehlgeschlagenen oder veralteten Abfrage (alte Werte,
    eingefrorene Live-Werte) zählen nicht, und eine Pause von über 90 s zwischen zwei Proben macht die Viertelstunde
    unvollständig. DVhub merkt sich die Abdeckung dafür ab 1.0.10 je Viertelstunde und Reihe.
  - Der Probenabstand wird in ganzen Sekunden gespeichert; den Rundungsrest nimmt DVhub in die nächste Probe mit,
    sodass die Summe der echten Zeit folgt. Ohne das galt bei Abfragezyklen ab etwa 5 s (z. B. 5,3 s → 5 s) keine
    Viertelstunde je als vollständig, und die Energie lag dort einige Prozent zu niedrig (bzw. bei 5,6 s → 6 s zu
    hoch, was Lücken verdecken konnte). Fable-Prüfung R3, P2-1.
  - **Bereits gespeicherte Viertelstunden ändern sich nicht:** Für Viertelstunden von vor dem Update ist die
    Abdeckung unbekannt, dort bleibt es bei VRM vor eigenen Werten. Die neue Regel gilt für alle Viertelstunden ab
    dem Update. Die Jahres-/Gesamtansicht rechnet einmal neu (gleiches Ergebnis für die alten Daten).
- **Einfrier-Wächter und Schreib-Verifikation sind keine Beta-Funktionen mehr.** Beide stehen jetzt auch im
  Kanal Stabil in den Einstellungen (bei den selten gebrauchten Feineinstellungen) und wirken dort, wenn sie
  eingeschaltet sind. Ab Werk sind beide aus; wer sie schon eingeschaltet hatte, behält die Einstellung — bisher
  wirkte sie nur im Kanal Bleeding Edge, jetzt in jedem Kanal.
  - Solange der Einfrier-Wächter aus ist, erkennt DVhub eingefrorene Live-Werte trotzdem und bucht dann nichts vom
    Netzstrom im Akku ab (nur ein Protokolleintrag, kein Alarm, kein Eingriff in die Regelung). In 1.0.9 war das so
    gedacht, lief mit der Standardeinstellung aber nie. Ist der Wächter an, meldet nur er — kein zweiter Hinweis.
- **E-Auto-Wochenplan ohne Beta-Kennzeichen.** Die Übersicht zu 1.0.9 führte ihn als Beta, gesperrt war er nie.
- **Not-Halt hört mit allen DVhub-Steuerungen auf (Christin 06.11.2026).** Beim Aktivieren bekommen Wallbox und
  Heizstab EINMAL „aus“ bzw. 0 W — aber nur, wo DVhub den aktuellen Zustand selbst gesetzt hat (eigener Ladebefehl
  und evcc noch im DVhub-Modus, eigene Heizstab-Vorgabe über 0). Eine von Hand gestartete Ladung oder ein von selbst
  laufender Heizstab bleibt unberührt. Danach schreibt DVhub nichts mehr an Wallbox, Heizstab oder Geräte, auch
  „Laden stoppen“ hält nicht mehr gegen eine Handladung. Der Netzanschluss-Wächter greift im Not-Halt nicht ein.
  Fehlschläge werden geloggt und nicht wiederholt. Nach dem Aufheben übernimmt die normale Steuerung. Verschiebbare
  Geräte (Geschirrspüler) bleiben unberührt.
- **„Sofort laden“-Ende bei Not-Halt oder Leistungsgrenze.** Endet „Sofort laden“ (evcc, EOS-Weitergabe aus), kehrt
  evcc sofort in den Modus von vorher zurück; den Strom begrenzt danach der Wächter über maxcurrent (kein Warten auf
  Luft für die volle Leistung). Nur im Not-Halt oder unter einem Deckel unter dem Mindeststrom bleibt evcc aus bzw.
  unverändert; zurückgestellt wird nach dem Aufheben bzw. sobald der Deckel den Mindeststrom erlaubt — aber nur, wenn
  evcc frisch abgefragt noch auf DVhubs „aus“ steht (sonst hat man selbst umgestellt). Der E-Auto-Status zeigt, was
  aussteht. Ist eine Grenze aktiv, heißt ein Stopp immer „aus“. Scheitert der harte Stopp beim Ende, bleibt die Wallbox als
  „Laden stoppen“ aus, bis man ihn beendet oder absteckt. Die Wallbox-Brücke führt je Gerät genau einen Datensatz
  (Geräte-Identität, letzter Befehl, quittiert ja/nein, Grenz-Vorgabe, ausstehende Rückkehr) in `ev_owned.json`.
- **Not-Halt und direkt angebundene Wallboxen:** DVhub stoppt eine direkte Box nur, wenn sie frisch gelesen noch in
  DVhubs Zustand steht (go-e/Wattpilot, OpenEVSE, Victron-EVCS, openWB). Boxen, deren Zustand sich nicht lesen lässt,
  bekommen im Not-Halt keinen Befehl („im Zweifel nicht senden“). Ist inzwischen ein anderes Gerät eingetragen
  (Adresse, Connector), fasst DVhub es nicht an.
- **Netzanschluss-Grenze aus dem Victron-GX.** Mit dem Victron-Profil liest DVhub zusätzlich die Begrenzung des
  AC-Bezugs aus dem GX (Unit 100, Reg. 2714 /Settings/CGwacs/AcInputLimit, A je Phase; MQTT
  settings/0/Settings/CGwacs/AcInputLimit), nur lesend und alle 60 s. Ein Wert über 0 gilt als Grenze je Phase und
  als Gesamtgrenze (A × Summe der gemessenen Phasenspannungen, frisch; sonst 230 V je Phase). Steht in DVhub
  zusätzlich ein Wert, gilt der strengere. Stammt die Grenze aus Victron, regelt DVhub ohne Sicherheitsabstand genau
  auf sie (der GX hat schon einen Puffer); gewinnt die DVhub-Einstellung, bleibt deren Abstand. Je Phase gilt der
  Strom: Grenze = A × Spannung dieser Phase. -1/0 oder nicht lesbar → nur die DVhub-Werte (nicht lesbar: Log und
  Hinweis, kein Fail-safe). Die Leitstand-Kachel zeigt, woher die geltende Grenze kommt, und „kein Abstand
  (Victron-Grenze)“; EOS bekommt den wirksamen Wert. Andere Hersteller-Profile unverändert.
- **§14a im Not-Halt:** Die Vorgabe des Netzbetreibers (EEBUS-LPC, Steuerbox) gilt auch im Not-Halt weiter — sie ist
  keine DVhub-Steuerung, sondern eine gesetzliche Vorgabe.
- **Lizenz-Link zeigt auf dvhub.de.** „Noch keine Lizenz? Jetzt bestellen.“ in den Einstellungen führt jetzt auf
  https://dvhub.de/#preise statt auf den abgeschalteten Test-Shop shop.dvhub.de. Das README nennt dieselbe Adresse und
  führt die Wallbox-Steuerung (Ladeplan nach EOS, „Sofort laden“) als Pro-Funktion, wie sie im Code schon gesperrt ist.

### Behoben

- **Grenze an direkt angebundenen Wallboxen nur als Obergrenze, nicht als Ladebefehl.** Begrenzt §14a oder der
  Netzanschluss-Wächter eine Wallbox, die DVhub gerade nicht selbst steuert, setzte DVhub bisher einen Ladebefehl
  (go-e/Wattpilot `frc=2`, OpenEVSE-Auftrag „aktiv“): eine von Hand gestoppte Box lud los, und der nächste
  Grenz-Schritt startete sie wieder. Jetzt setzt DVhub bei go-e und Wattpilot nur den Strom (`amp`), bei OpenEVSE
  einen eigenen Auftrag nur mit `max_current` — ob geladen wird, entscheidet weiter die Box. Ist die Grenze weg,
  stellt DVhub den Strom von vorher wieder her (übersteht einen Neustart); der Not-Halt nimmt die eigene Obergrenze
  einmal zurück, wenn sie frisch gelesen noch steht. Unter dem Mindeststrom stoppt DVhub wie bisher. Boxen ohne reine
  Strom-Obergrenze (u. a. Victron-EVCS, KEBA, OCPP) bekommen die Grenze weiter als Ladebefehl (Log
  `paragraph14a_wallbox_capped`, `mode: charge`). (Fable R1 P2-5)
- **E-Auto-Wochenplan: einzelnen Tag am Handy leeren.** Am iPhone öffnet ein Tipp ins Zeitfeld sofort den
  Zeit-Picker, und Safari schreibt dabei schon die aktuelle Uhrzeit ins leere Feld. „Zurücksetzen“ im Picker leert
  nur dieses eine Feld: Der Picker bleibt offen und zeigt weiter eine Zeit, und Safari zeigt auch im geleerten Feld
  eine Schein-Uhrzeit an. Ankunft, Mind. % und Fahrt % bleiben stehen, und eine Ankunft ohne Abfahrt lässt sich nicht
  speichern. Ein Tag ließ sich so nicht leeren. Jetzt hat jede Tageszeile einen Knopf „✕ Leeren“ (auf Touch und in
  schmalen Spalten mindestens 44 px), der Ankunft, Abfahrt, Mindest-Ladestand und Fahrt auf „nicht gesetzt“ stellt,
  ohne dass man ein Feld antippt. Danach steht in der Zeile „kein Termin“, und leere Zeitfelder zeigen keine
  Schein-Uhrzeit mehr. Dasselbe gibt es fürs Einmal-Ziel und für „Nur nächste Ankunft“, auf der Leitstand-Kachel, im
  Family-Panel und auf der Integrationsseite. Gespeichert wird der Tag als nicht gesetzt (leere Zeit, `null` %), nicht
  als 00:00 oder 0 %, und er erzeugt keine Abfahrt. Der Knopf für alle Tage heißt jetzt „Alle Tage leeren“. In
  schmalen Spalten, etwa auf der Leitstand-Kachel am Desktop, ist die Zeile jetzt zweizeilig (Container-Abfrage).
  Tests: `dvhub/test/ev-tag-leeren.test.js` sowie Playwright `tests/visual-parity/ev-wochenplan-leeren-{iphone,desktop}.spec.mjs`
  (WebKit mit iPhone 15 und Chromium).
- **Geheimnis-Prüfung vor dem Push findet wieder private Schlüssel.** In `scripts/check-secrets.sh` ging das Muster
  `-----BEGIN … PRIVATE KEY-----` ohne `-e` an `git grep` und wurde als Option gelesen; der Fehler wurde verschluckt,
  die Prüfung meldete nie etwas. Jetzt mit `-e`, und ein scheiterndes `git grep` sperrt, statt als „sauber“ zu gelten.
  Probe im Wegwerf-Repo (`test/check-secrets.test.js`). Paritätsvergleich mit dem Rust-Neubau.
- **Kaputte config.json wird nicht mehr still überschrieben.** War die config.json kein gültiges JSON (oder kein
  Objekt), lief DVhub mit Vorgaben, und das nächste Speichern – Einstellungen, Setup-Assistent oder eine Automatik –
  ersetzte die Datei; die echte Konfiguration war weg, sobald die Sicherung aus der Aufbewahrung fiel. Jetzt sichert
  DVhub den kaputten Stand als `config.json.broken-<Zeit>` (je Inhalt einmal, Modus 0600, wird nie gelöscht).
  Gespeichert wird darüber nur nach ausdrücklicher Bestätigung: Einstellungen, Setup-Seite und Einrichtungsassistent
  zeigen eine deutliche Warnung mit dem Namen der Sicherung und fragen vor dem Ersetzen nach (HTTP 409
  `config_broken`, Bestätigung `confirmOverwriteBrokenConfig`). Automatische Speichervorgänge schreiben in dieser Lage
  nicht. Paritätsvergleich mit dem Rust-Neubau.
- **Falscher Typ für `schedule` bringt DVhub nicht mehr zum Absturz.** `"schedule": 5` (oder ein Text, `true`, eine
  Liste) ließ das Laden der Config mit „Cannot create property 'rules'“ werfen – DVhub startete nicht. Jetzt gibt es
  eine Warnung (`schedule: must be an object …`), und es gelten die Vorgaben für diesen Abschnitt. Die
  Config-Migrationen werfen auch bei einer Wurzel `null` nicht mehr. Paritätsvergleich mit dem Rust-Neubau.
- **Alte Preis-Adresse `api.dvhub.de` wird ohne Fehlwarnung umgestellt.** Die Umstellung auf `https://dvhub.online`
  griff nie, weil die Feldprüfung den alten Wert vorher als „invalid option“ verwarf (Ergebnis gleich, aber mit
  Warnung bei jedem Laden). Paritätsvergleich mit dem Rust-Neubau.
- **Modbus: eine Zeitüberschreitung lässt nicht mehr den Rest des Poll-Takts scheitern.** Nach einer
  Zeitüberschreitung baute DVhub die Verbindung neu auf, aber das Schließen des alten Sockets brach danach die neue
  Verbindung ab: alle weiteren Anfragen des Takts scheiterten mit „connection closed“. Jetzt gilt jedes
  Socket-Ereignis nur für seinen eigenen Socket; nur die betroffene Anfrage scheitert. Paritätsvergleich mit dem
  Rust-Neubau (A4).
- **Not-Halt: schon eingereihte Modbus-Writes gehen nicht mehr raus.** Ein Sollwert, der vor dem Not-Halt in der
  Warteschlange einer Modbus-Verbindung stand, wurde danach noch gesendet. Jetzt setzt der Not-Halt beim Eintritt eine
  Schreib-Sperre: alles, was vorher eingereiht war, wird unmittelbar vor dem Senden verworfen; die eine Rücknahme
  danach geht raus. Gilt für alle Modbus-Verbindungen (Haupt-GX, zweite GX, Register-Scan, Heizstab).
  Paritätsvergleich mit dem Rust-Neubau (A7).
- **Modbus: Lese-Anfragen können nicht mehr schreiben, übergroße Rahmen und volle Warteschlangen sind Fehler.** Eine
  Lese-Anfrage mit Schreib-Funktionscode (z. B. FC 6 aus einem Messpunkt oder dem Register-Scan) wäre ein gültiger
  Write gewesen – die Menge als Wert. Jetzt nimmt die Lese-Anfrage nur FC 1–4. Ein Rahmen mit Längenfeld über 254
  (mehr als 260 Byte) gilt sofort als ungültig, statt auf bis zu 64 KiB zu warten; die Warteschlange je Verbindung
  ist auf 256 Anfragen begrenzt. Paritätsvergleich mit dem Rust-Neubau (A6, A8).
- **Modbus: zu kurze Antworten sind ein Lesefehler statt 0 W.** Lieferte ein Gerät weniger Register als angefragt,
  wurden die fehlenden Wörter zu 0 und der Netzzähler galt als „ok“ mit 0 W – Netzanschluss-Wächter und
  §14a-Budget rechneten damit. Jetzt meldet DVhub `modbus short response (x von y Registern)`, der Wert gilt als
  ungültig und der Zähler als gestört (`meter.ok=false`). Paritätsvergleich mit dem Rust-Neubau (A5).
- **Preis-Abruf und Kuma-Push prüfen Adressen in Ziffern auch beim Verbinden.** Für `epex.priceApiUrl` und den
  Uptime-Kuma-Push löst DVhub Namen beim Verbinden auf und prüft jede Adresse. Adressen in Ziffern
  (`127.0.0.1`, `[::ffff:127.0.0.1]`, `2130706433`, `127.1`) prüfte nur das Speichern; eine von Hand geänderte Config
  verband trotzdem dorthin. Jetzt gilt beim Verbinden dieselbe Regel wie beim Speichern: nur Adressen im Internet.
  Fable-Prüfung R3, P3-1.

- **Paket-Veröffentlichung: Vorgänger bleibt im Kanal-Index, Index und Signatur gehen gemeinsam hoch.** Scheiterte in
  `scripts/release/publish-release.sh` der Abruf des bisherigen Index aus einem anderen Grund als „gibt es nicht“
  (Netz, Anmeldung), baute das Skript ohne Vorgänger — im stabilen Index hätte nur die neue Version gestanden, der
  Rückweg auf die vorige gefehlt. Jetzt bricht es ab, bevor etwas hochgeladen wird. Index und Signatur gehen unter
  Zwischennamen hoch und werden dann umbenannt (erst Signatur, dann Index); scheitert das Hochladen, bleibt der alte,
  gültige Stand stehen. Fable-Prüfung R3, P3-6.

- **§14a: Budget nur mit gültigem, frischem Zählerwert (Fable R2 P1-1).** Beim Start (Zähler noch nicht gelesen,
  `grid_total_w` = 0) oder mit eingefrorenem Zählerwert rechnete DVhub die laufende Leistung der Geräte als
  „PV-Überschuss“ — nachgestellt: 4,2 kW Vorgabe, 21,2 kW verteilt. Jetzt zählt der Überschuss nur mit gültigem Wert
  (höchstens 30 s alt), sonst gilt die Vorgabe ohne Zuschlag. Ebenso an die Steuerbox (MGCP): nur frische Werte.
- **§14a: Gerät von Hand „über DVhub (EMS)“ ist belegt (P2-1).** Es zählte für Pmin,14a und hob die Relais-Grenze,
  bekam aber keinen Anteil und war nicht belegt — die ganze Vorgabe ging an die steuerbaren Geräte, das Gerät zog
  dazu (10,5 kW Vorgabe → 16,5 kW). Jetzt ist seine Nennleistung belegt (BK6-22-300 Ziffer 4.5.2: die Vorgabe gilt
  für alle SteuVE hinter dem EMS); Hinweis in Integrationen → §14a.
- **§14a: veraltete Gerätemesswerte blähen das Budget nicht mehr auf (P2-5).** evcc-Stand nur ohne Abfragefehler
  und höchstens 60 s (bzw. drei Abfragen) alt, EEBUS-Leistung nur aus der laufenden Verbindung und höchstens 5 min
  alt; sonst unbekannt (strenger).
- **§14a: Neustart während einer Dimmung (P2-4).** Eine gespeicherte, noch gültige EEBUS-Grenze gilt gleich beim
  Start (vorher bis zu 120 s keine Grenze). Der Relais-Zustand wird gespeichert und gilt nach dem Neustart weiter,
  bis das Relais neu meldet (vorher: keine Dimmung bis zum nächsten Schalten) — eine gespeicherte Dimmung höchstens
  24 h nach der letzten Meldung, danach frei mit Warnung `paragraph14a_relay_restored_expired` (Fable R5 P3-1:
  Boxen, die nur bei einem Wechsel senden, hielten Wallbox und Wärmepumpe sonst tagelang auf 4,2 kW).
- **EEBUS: Wiederanlauf auch ohne Steuerbox (P2-3).** Hat DVhub einem Gerät je eine Vorgabe geschrieben
  (Netzanschluss-Deckel, von Hand), nimmt es das Gerät nach einem Neustart oder dem Ende des Not-Halts wieder auf
  („frei“ beendet dessen Failsafe); gespeichert in `eebus/controlled.json`. Eine noch gültige eigene Vorgabe
  (Wallbox-Stopp, Grenze von Hand) wird dabei neu geschrieben statt freigegeben.
- **Lese-Modus: EEBUS startet nicht, evcc und OCPP schalten nichts (P2-2, P2-9, P3-17).** Vorher plante die
  Lese-Instanz Verdichterläufe, quittierte Steuerbox-Vorgaben und schickte Herzschlag/Messwerte; der Familien-Knopf
  schaltete den evcc-Modus um; OCPP-Boxen bekamen beim Anmelden ihre Mess-Konfiguration. Jetzt: EEBUS-Status
  „Lese-Modus“, evcc `setMode`/`setMaxCurrent` und OCPP-Befehle (außer Abfragen) gesperrt.
- **Not-Halt: Neustart und Beenden schreiben nichts (P2-7, P2-8, P3-17).** Der Not-Halt wird geladen, bevor der
  erste Dienst startet (vorher schrieb der Einspeisebegrenzer 2706 einmal). Beim Beenden bekommt ein Heizstab 0 W
  nur, wenn DVhub ihm gerade Leistung vorgibt — nie im Not-Halt oder Lese-Modus. OCPP-Boxen bekommen im Not-Halt
  keine Mess-Konfiguration.
- **Not-Halt: Stopp und Aufheben nacheinander (P3-2), Speicherfehler sichtbar (P3-7).** Ein Aufheben während der
  laufenden Neutralisierung wartet, bis sie fertig ist (vorher gab die Stopp-Schleife danach noch Grenzen frei).
  Lässt sich `control_state.json` nicht speichern, meldet DVhub das als Systemwarnung.
- **Not-Halt: Hinweis zu EEBUS-Geräten (P2-6, so gewollt).** Der Leitstand sagt, dass EEBUS-Geräte nach kurzer Zeit
  in ihren eigenen Rückfallbetrieb gehen — wie bei ausgeschaltetem DVhub. Heizstab-Messwerte laufen im Not-Halt
  weiter (P3-8); scheitert „Herzschlag aus“, startet der EEBUS-Hilfsprozess neu (P3-11).
- **EEBUS: Failsafe-Vorgabe folgt der Geräteliste (P3-5),** keine Fehlalarme aus Rückmeldungen der vorigen Verbindung (P3-4), nicht erreichbare EEBUS-Hauptwallbox
  ist belegt statt „ohne Grenze“ (P3-3).
- **Netzanschluss: Wallbox wird nicht mehr unnötig gekürzt, wenn der Akku aus dem Netz lädt (Fable-Prüfung R1).**
  Das Einregeln des Multi um den Sollwert (bis 300 W) gilt nicht mehr als „Akku hängt“, auch über der harten Grenze
  nicht; größere Abweichungen zählen erst nach 10 s über der harten Grenze bzw. 30 s im Sicherheitsabstand. „Hängt“
  endet, sobald eine gekürzte Last nachweislich in den Akku floss (bisher: 15 min eingerastet, die Wallbox wurde
  Schritt für Schritt bis zur Pause gekürzt, während der Akku weiter aus dem Netz lud). Die Sollwert-Decke für die
  Akku-Ladung hält dafür die Einregel-Toleranz (300 W) unter der harten Grenze, wenn der Abstand kleiner ist (Victron-
  Grenze ohne Abstand) — die Lasten dürfen weiter bis zur Victron-Grenze. Ein Gerät ohne Leistungsmeldung (Wallbox aus
  oder ohne Zähler, evcc nicht erreichbar) zählt nicht mehr mit angenommenen 22 kW als Puffer: Die nächste Last wird im
  selben Takt gekürzt (bisher bis zu Minuten über der Grenze). Im Fail-safe (Zähler gestört) stoppt DVhub eine Wallbox
  ohne Leistungsmeldung nicht mehr, sondern lässt ihre Grenze stehen. Ein Heizstab, der von selbst läuft (DVhub gibt
  ihm 0 W vor), zählt nicht als steuerbar. Merker des Wächters gehen beim Zurücksetzen mit.
- **Not-Halt „als ob aus“ auch für DVhubs Wallbox-Begrenzungen (Fable-Prüfung R1).** Hat DVhub eine von Hand
  gestartete Ladung nur begrenzt (Netzanschluss, §14a), hebt der Not-Halt die eigene Begrenzung einmal auf statt die
  Ladung zu stoppen: direkte Box `release()` (openWB: voller Strom), evcc den ursprünglichen Ladestrom (maxcurrent) und
  — falls DVhub „aus“ gesetzt hat und evcc noch darauf steht — den Modus davor. Danach schreibt DVhub nichts mehr.
  Von DVhub gestartete Ladungen („Sofort laden“, EOS-Plan) stoppt der Not-Halt wie bisher.
- **Not-Halt nach Neustart: angehobene Entladegrenze geht zurück (Fable-Prüfung R1).** Startet DVhub mit
  angehobener Entladegrenze (Akku-Hilfe, Nicht-Victron) direkt im Not-Halt, ließ das Tor die eine Rücknahme nicht
  durch, weil der eigene letzte Write fehlte. Beleg ist jetzt auch der Merker der Akku-Hilfe oder eine frische
  Rücklesung.
- **Netzanschluss: Victron-Grenze fail-safe und stabil (Fable-Prüfung R1).** Ein einzelner Lesefehler von Reg. 2714
  hebt die Victron-Grenze nicht mehr auf: Der zuletzt gelesene Wert gilt bis 5 min nach der letzten erfolgreichen
  Lesung weiter, danach die DVhub-Einstellung — Deckel und Sollwert-Decke bleiben stehen (bisher: alle Deckel sofort
  weg, Ziel sprang z. B. von 27,6 auf 33,5 kW). Liegt die Victron-Grenze knapp unter der DVhub-Grenze, gilt das
  strengere Ziel aus „Victron ohne Abzug“ und „DVhub minus Abstand“ (29 kW mit 1 kW Abstand und 42 A: 28 000 W statt
  28 980 W), je Phase genauso. Die aus Ampere und gemessener Spannung gerechnete Grenze ist auf 100 W abgerundet und
  folgt der Spannung nach unten sofort, nach oben erst ab 200 W — keine neuen Sollwert-Writes und keine
  EOS-Wechselrichter-PUTs mehr bei jeder Spannungsschwankung (auch Fable R3 P2-2). Victron-Werte unter 6 A meldet
  DVhub statt sie still zu verwerfen; die Kachel sagt bei nicht lesbarer Victron-Grenze ohne DVhub-Wert „nicht lesbar“
  statt „Grenze ungültig“; der Hilfetext zur Phasengrenze nennt die gemessene Spannung.
- **EOS-Behelf (Vanilla rc3) zieht die Auto-Ladeleistung nur ab, wenn das Auto bei EOS angemeldet ist (Fable R3
  P3-3).** Bisher immer mit „E-Auto mitoptimieren“ — bei 3 × 16 A und 11-kW-Wallbox blieb dem Akku dauerhaft 0 W
  Netzladen im Plan.
- **Lese-Modus gilt auch für EEBUS-Geräte.** Mit `DVHUB_READ_ONLY=1` schrieb DVhub §14a-Anteile weiter als
  Verbrauchsgrenze an gekoppelte EEBUS-Geräte (Wärmepumpe, Wallbox). Jetzt blockiert der Lese-Modus auch diese
  Vorgaben (Eintrag `[READ-ONLY]` im Konsolen-Log).
- **§14a: Wiederanlauf der EEBUS-Geräte und deutliche Warnung bei Störung.** Nach einem Neustart von DVhub oder des
  EEBUS-Hilfsprozesses (Update, Stromausfall) schrieb DVhub einem Gerät ohne laufende Begrenzung nichts — der
  Herzschlag zum Gerät startete nicht, das Gerät fiel nach 120 s in seinen Failsafe und blieb dort bis zur nächsten
  Vorgabe (mindestens 2 h). Jetzt nimmt DVhub die Kopplung beim Anmelden jedes Geräts selbst wieder auf (laufende
  Grenze sofort neu, sonst „frei“; das beendet den Failsafe), sofern es nach § 14a steuert (Steuerbox oder Relais).
  Ist ein gesteuertes Gerät länger als 60 s nicht erreichbar, meldet das Gerät eine andere Grenze als die Vorgabe
  (DVhub schreibt sie dann erneut), zieht es 60 s deutlich mehr als erlaubt oder lehnt es die Vorgabe ab, zeigt der
  Leitstand „§14a gestört“ mit Gerät und Uhrzeit, Integrationen → §14a ebenso, dazu ein Protokolleintrag
  (`paragraph14a_device_issue`, Warnung) und eine Benachrichtigung über die eingerichteten Kanäle. Bewertet wird nur,
  was das Gerät meldet — ohne Rückmeldung keine „hat nicht reagiert“-Meldung. Eine Freigabe der Wallbox-Steuerung
  bleibt überwacht, bis das Gerät sie umsetzt; befristete Vorgaben (auch von Hand) nur bis zu ihrem Ende. Ein nicht erreichbares Gerät zählt
  weiter für die Mindestleistung; sein eigener Failsafe-Wert (ohne Angabe die Nennleistung) gilt während einer
  Begrenzung als belegt, damit die übrigen Geräte die Grenze nicht allein ausschöpfen.
- **§14a: EEBUS-Wallbox zählt richtig.** Eine EEBUS-Wallbox lief in der §14a-Geräteliste als Wärmepumpe (falsche
  Fallgruppe für Vorrang und Mindestleistung); war sie als Hauptwallbox eingetragen, zählte sie zusätzlich als
  „Wallbox“ — zwei SteuVE statt einer, also eine zu hohe Mindestleistung Pmin,14a (Relais-Grenze, automatischer
  Failsafe-Wert) und doppelt verteiltes Budget. Jetzt ist eine EEBUS-Box mit Auto-Meldung oder als Hauptwallbox ein
  Ladepunkt und zählt einmal (mit ihrer Nennleistung laut Gerät); ihr Anteil geht zusätzlich direkt als Watt-Grenze
  (LPC) an die Box. Ohne gestecktes Auto hat sie keinen Bedarf.
- **§14a: Summe der Anteile nie über der Vorgabe.** Die Glättung (Änderungen unter 300 W werden nicht
  weitergegeben) konnte die Summe der Geräte-Anteile über die Grenze des Netzbetreibers heben, wenn mehrere Anteile
  gleichzeitig leicht sanken (z. B. 7500 W bei 7200 W Vorgabe). Jetzt gilt in dem Fall der neue Anteil.
- **Kanalwechsel nach langem Stromausfall.** Fiel bei einem Kanalwechsel auf einer Paket-Box der Strom nach dem
  Umschalten länger als 90 Minuten aus, setzte DVhub den Kanal zurück, bevor die Box den Auftrag nach dem Neustart
  abschließen konnte. Jetzt gilt ein stiller Auftrag nur vor dem Umschalten als abgebrochen; danach entscheidet die
  Fortsetzung nach dem Neustart.
- **Relay: Sperrliste entkoppelter Handys.** Mit Anfragen aus wenigen IPv6-/48-Netzen ließ sich die Liste der
  entkoppelten Handys über die Gesamtgrenze treiben und damit leeren — ein entkoppeltes Handy kam dann wieder herein,
  solange die Box offline war. Jetzt verdrängt die Gesamtgrenze den ältesten Eintrag des /48 mit den meisten Einträgen.
- **Preis-API und Uptime-Kuma prüfen Namen beim Verbinden.** Wie schon beim ntfy-Kanal löst DVhub den Namen der
  eingestellten Preis-Adresse (`epex.priceApiUrl`, auch Nachimport und Marktwerte) und der Uptime-Kuma-Push-Adresse
  beim Verbinden auf und verbindet nicht, wenn er auf die Box selbst, eine Link-local- oder 0-Adresse zeigt. Vorher
  wurde beim Speichern nur eine Adresse in Ziffern geprüft. Umleitungen folgen diese Abrufe nicht mehr.
- **Datenspende-Einrichtung scheiterte an „Client anlegen“ (GH #31).** DVhub meldete sich mit dem Client-Typ
  `dvhub` an, den der COMSYS-Server nicht kennt (`400 bad_request: Invalid input format: null`). Standard ist jetzt
  `victron`, der Typ, den das Datenportal selbst für Victron-Anlagen anlegt; ein gespeichertes `dvhub` wird beim
  Laden gehoben. Schon verknüpfte Spenden bleiben unberührt (der Typ zählt nur beim Anlegen).

## [1.0.9] - 2026-11-04

Release nach knapp zwei Wochen. Überblick nach Themen — die Einzelheiten stehen in den Einträgen darunter:

- **Updates:** native Installationen im Kanal Stabil bekommen Updates künftig als fertige, signierte Pakete statt
  per git; die Umstellung läuft beim ersten Update auf 1.0.9 von selbst, mit Rückweg. Bleeding Edge bleibt git.
- **EOS:** Preise über den Day-Ahead hinaus fortgeschrieben, Steuerzeitraum über den ganzen bekannten Preiszeitraum
  (einstellbar), Prognosehorizont einstellbar, Speicherkosten ohne doppelten Verlustaufschlag, „Laut EOS-Plan“ im
  Leitstand, EOS im Fernbetrieb (Beta).
- **Strompreise:** Bezugspreis vom Stromanbieter (Tibber, LichtBlick) mit Protokoll und Auswertung, Hinweis vor dem
  Ende des Preiszeitraums.
- **Netzladen und Direktvermarktung:** Netzstrom im Akku wird mitgezählt; solange mehr als 0,1 kWh darin stecken,
  speist der Akku nicht ins Netz ein (bis auf den Regelpuffer von höchstens 100 W).
- **Neu (Beta):** Peak Shaving für Gewerbeanschlüsse, zweite Victron-Anlage am selben Anschluss, Handy-App.
- **Neu:** E-Auto-Wochenplan.
- **Leitstand:** Energiebilanz mit dem echten Akku, klarere Beschriftungen; Entlade-Wächter ohne Fehlalarme.
- **VRM und Datenspende:** VRM-Portal-ID oder Site-ID im selben Feld (Nachimport scheiterte mit Portal-ID an
  „HTTP 404“), verständliche Fehlermeldungen bei der Datenspende-Einrichtung.
- **Sicherheit:** zahlreiche Härtungen nach einer Sicherheitsprüfung (Abschnitt „Sicherheit“).

### Neu

- **Netzstrom im Akku wird gezählt, Akku-Einspeisung gesperrt, solange welcher darin steckt**: Lädt der Akku an einer
  PV-Anlage in der Direktvermarktung aus dem Netz (dynamischer Tarif, §14a Modul 3, „Netzladen auch ohne
  Pauschal-/Abgrenzungsoption“), darf dieser Strom nie mit Marktprämie verkauft werden. DVhub führt einen
  rechnerischen Zähler: Netz → Akku erhöht den Netzstrom-Anteil (höchstens der gemessene Netzbezug), Entladung und
  Verluste senken ihn anteilig. Gezählt wird jede tatsächliche Netzladung — gleich, ob EOS, eine Handeingabe, ein
  Zeitplan oder eine fremde Steuerung sie auslöst und ob Netzladen oder eine MiSpeL-Option freigegeben ist.
  Regelpendeln und kurze Regelvorgänge zählen nicht: Netzladung gilt, wenn innerhalb von 30 s im Mittel mindestens
  150 W und mindestens 10 s lang 150 W oder mehr fließen — dann zählt die ganze Ladung, auch wenn sie kurz stockt;
  das Tagesprotokoll weist Verworfenes aus. Über 0,1 kWh Netzstrom ist die Einspeisung aus dem Akku gesperrt (frei erst wieder
  unter 0,05 kWh; ein Regelpuffer von höchstens 100 W bleibt) — PV-Überschuss geht weiter hinaus, gemessen an PV- und
  Lastwerten, die höchstens 90 s alt sind (auch über MQTT; ältere zählen nicht, dann nur der Puffer); EOS plant dann
  keinen Akku-Verkauf. Leitstand „davon Netzstrom X kWh (Y %)“, Historie mit Verlauf
  und Tagesprotokoll (CSV), `/api/battery/grid-share`. Der Zähler übersteht Neustart und Update; ein ausdrückliches
  Zurücksetzen wird protokolliert. Bei unsicheren Akkuwerten (Lesefehler, veraltet, eingefroren) wird nichts
  abgebucht; das Tagesprotokoll nennt die Minuten. Abgebucht wird nur mit eingetragener Akkukapazität
  (Einstellungen → Meine Anlage → Akku-Grenzen bzw. Ausbaustufen) — ohne sie rechnet DVhub mit keiner Ersatzzahl,
  die Sperre bleibt, und Leitstand und Historie melden „Akkukapazität fehlt“. Der Zähler läuft ab der ersten Abfrage
  nach dem Start, nicht erst, wenn die Datenbank bereit ist.

- **Signierte Update-Pakete für native Installationen**: Statt eines git-Checkouts mit `npm install` auf der Box
  holt `dvhub-release` je Version und Architektur (arm64, armhf, amd64) ein fertiges Paket von GitHub, prüft
  Prüfsumme und Ed25519-Signatur (Vertrauensanker `/etc/dvhub-release/allowed_signers`), entpackt es nach
  `/opt/dvhub/releases/<version>`, schaltet um und prüft die Gesundheit — sonst geht es automatisch zurück.
  Im Update-Bereich der Einstellungen zeigt die Oberfläche den Fortschritt; „Vorige Version wiederherstellen“ geht
  ohne Download.
  git-Installationen im Kanal Stabil stellen sich beim ersten Update auf 1.0.9 nach etwa zwei Minuten selbst um (der
  alte Checkout bleibt bis zum nächsten Update als Rückweg liegen); eigene Forks und lokal geänderte Dateien bleiben
  auf git. Pakete gibt es nur für den Kanal Stabil: Boxen auf Bleeding Edge bleiben git-Installationen und holen
  `main` wie bisher — ohne Umstellungsversuch. Eine Paket-Installation kann nicht auf Bleeding Edge wechseln; die
  Oberfläche meldet „Bleeding Edge gibt es nur für git-Installationen. Paket-Installationen bleiben auf Stabil.“
  Scheitert ein Kanalwechsel auf einer Paket-Box (Index, Download, Signatur, Gesundheit, Rücknahme) oder startet
  der Auftrag gar nicht, setzt DVhub den Kanal selbst auf den alten Wert zurück (Protokoll
  `update_channel_reverted`). Docker-Images ändern sich nicht. Einzelheiten: `docs/release-pakete.md`.

- **EOS bekommt Preise über die bekannten hinaus**: Vormittags enden die Day-Ahead-Preise um Mitternacht. EOS
  kürzte dann seinen Prognose-Schwanz auf eine halbe Stunde („Tail forecast shortened … effective 0.5 h“) und bewertete
  die Restladung im Akku fast nur zum Einspeisewert — mittags wurde PV für ~28 ct eingespeist statt für Nacht und
  Morgen gespeichert. DVhub schreibt die Börsenpreise jetzt bis zum Ende der PV-/Lastprognose (höchstens 72 h) fort,
  nach der Methode von EOS' eigenen Preisquellen: exponentielle Glättung mit Wochenmuster aus der gespeicherten
  Day-Ahead-Historie (ab zwei Wochen, sonst Tagesmuster ab zwei Tagen; weniger Historie → keine Schätzung). Bezugspreis
  und Einspeisewert entstehen daraus wie bei echten Preisen (fester Preis, Börse + Bestandteile, Anbieterpreis über die
  Ausgleichsgerade, Börse + Marktprämie). Echte Preise haben Vorrang und ersetzen die Schätzung beim nächsten Push; der
  Steuerzeitraum richtet sich weiter nur nach echten Preisen. Anzahl und Beginn der geschätzten Slots stehen im Log
  (`eos_forecast_bridge`) und unter `state.optimizer.lastEosPush.priceEstimate`. Schätzwerte liegen nie im
  Steuerzeitraum: Vor jedem Lauf schickt DVhub die Prognose frisch und löscht in EOS alles dahinter. Fehlen nach einem
  Neustart die Preise, weil der Abruf gestört ist, nimmt DVhub die gespeicherten echten Preise. Der Lauf fällt aus
  (Log `eos_run_skipped`, mit Grund), wenn der Preis-Import scheitert, Preise, PV oder Last jetzt nicht abdecken, der
  Steuerzeitraum sich nicht setzen lässt oder nicht ganz in echten Preisen liegt — in diesen Fällen brach EOS früher
  meist ohnehin ab. Mit „EOS rechnet nach eigenem Takt“ (Einstellungen → Betriebsart → EOS-Optimierung) oder solange
  kein EOS 0.4 erkannt ist, wird nicht geschätzt.

- **Bezugspreis vom Stromanbieter (Tibber, LichtBlick)**: neue Preislogik „Vom Stromanbieter“ unter Einstellungen →
  Strompreise, auch je Zeitraum (z. B. ab Lieferbeginn). DVhub holt mit den eigenen Zugangsdaten des Kunden die
  Viertelstundenpreise des eigenen Vertrags — Tibber über die offizielle Schnittstelle (persönlicher
  Zugangsschlüssel), LichtBlick „ÖkoStrom Dynamic“ über das Backend der LichtBlick-App (inoffiziell, nach
  github.com/chloepriceless/Lichtblick-Lokal-Preis). Live-Kosten, Preisvergleich, Historie, interner Optimierer und
  EOS rechnen dann mit dem Preis, den der Kunde bezahlt. Abruf stündlich und ab Veröffentlichung der Preise für morgen
  (Tibber ~13 Uhr, LichtBlick ~15:20 Uhr) alle 15 min; kommen sie an, plant EOS sofort neu. Die Preise liegen in der
  Datenbank (`tariff_import_ct_kwh`) und sind nach einem Neustart wieder da. Fehlt ein Slot, schätzt DVhub aus einer
  Ausgleichsgeraden Anbieterpreis ↔ Börsenpreis der letzten sieben Tage. Wahlweise ist der Anbieterpreis der Endpreis
  oder nur der Energiepreis (dann kommen Netzentgelt, Umlagen, MwSt und §14a Modul 3 wie beim dynamischen Tarif
  dazu). Zugangsdaten gehen nie zurück und stehen in keinem Log; abgelehnte Zugangsdaten sperren den Abruf 6 h,
  damit der Anbieter das Konto nicht sperrt. Ungeprüft bis zum ersten LichtBlick-Liefertag: Schrittweite und ob der
  App-Preis brutto mit Netzentgelt ist.

- **Anbieterpreise mitloggen und auswerten**: Die Preise vom Stromanbieter (Tibber, LichtBlick) bleiben je
  Viertelstunde dauerhaft in der Datenbank, neben dem Day-Ahead-Preis — mit Abrufzeit, Lesart und bei einer Änderung
  dem vorigen Preis. Ein wiederholter Abruf schreibt nur neue oder geänderte Preise. Unter Einstellungen →
  Strompreise → „Vom Stromanbieter“ zeigt eine kleine Auswertung (7, 30, 90 oder 365 Tage) den mittleren
  Anbieterpreis, den mittleren Day-Ahead-Preis, die Formel netto ≈ a + b × Börsenpreis und die mittlere Abweichung
  davon — bei LichtBlick (IDA1 × Risikofaktor + Umlagen) wird so der Faktor sichtbar. Schnittstelle:
  `GET /api/tariff-provider/stats?days=30`. Aufbewahrung wie die Börsenpreise (weder Log-Verdichtung noch Platz-Wache
  entfernen sie; ~35 000 Zeilen je Jahr).

- **Peak Shaving – Bezugsgrenze für Gewerbeanschlüsse (Beta, #28)**: Bei Leistungsmessung (RLM) richtet sich der
  Leistungspreis nach der höchsten Viertelstunden-Bezugsleistung im Jahr. Mit eingetragener Grenze deckelt DVhub
  eigene Netz-Sollwerte (Netzladen, EOS-„Akku halten“, manuelle Werte) auf Grenze minus Sicherheitsabstand, sodass der
  Akku Spitzen abdeckt; ist die Entladung gesperrt (Max Entladung = 0), gibt DVhub sie bei Bezug über der Grenze um den
  Überschuss frei und setzt die Sperre mit Rückschalt-Abstand wieder. Not-Halt, §14a, Netzlade-Verbot und
  Mindest-Ladestand haben Vorrang. Den Akku zieht der Deckel nur bei frischem Ladestand über dem Boden heran; sonst
  deckelt er höchstens bis zur gemessenen Netto-Last (kein Entladen), ist auch die Last unbekannt, gar nicht. Ohne
  frischen Zähler oder Ladestand hebt DVhub keine Sperre auf und setzt eine selbst aufgehobene wieder — sobald die
  Rücklesung von 2704 bestätigt, dass dort noch DVhubs Freigabe steht; wurde sie am GX geändert, bleibt sie. Der
  Leitstand zeigt Grenze, Eingriff und die höchste Viertelstunde im Monat und im Jahr. Bisher nur Victron; andere Hersteller nur Anzeige.
  Einstellungen → Netz & Recht → Erweitert; nur im Bleeding-Edge-Kanal. EOS kennt keine Bezugsgrenze und plant ohne sie.

- **E-Auto: Wochenplan mit Ankunft und Abfahrt**: je Wochentag Ankunft, Abfahrt, eigenes Ziel und Heimweg statt
  einer Abfahrtszeit für ausgewählte Tage (bestehende Einstellungen werden übernommen, die Anlage rechnet wie bisher).
  DVhub schätzt den Ladestand bei Ankunft — live vom Auto oder aus dem letzten Wert minus Heimweg — und meldet das
  Auto bei EOS schon vor der Ankunft an, wenn EOS den Ladestart kennt. Ladestand von jeder Marke: neben TeslaMate,
  Wallbox, evcc und MQTT jetzt auch per HTTP-Abruf (JSON-Pfad, optional Token) und Home Assistant; http nur im eigenen
  Netz, Tokens geschwärzt. Der Editor in Kachel und Wallbox-Schublade zeigt, welche Abfahrt DVhub daraus macht
  („Ankunft Mi 20:00 → Abfahrt Do 05:00“) und was an EOS geht; Vorschau beim Bearbeiten über `POST /api/ev/preview`.

- **„Laut EOS-Plan“ im Leitstand (#27)**: unter dem Day-Ahead-Chart für heute ab jetzt und morgen, was EOS plant —
  Einspeisung und Netzbezug in kWh, Stunden, höchster Leistung, dem niedrigsten Einspeisewert der geplanten
  Einspeise-Slots (mit Grundlage, z. B. „Börse + Marktprämie“) und dem höchsten Bezugspreis der geplanten Bezugs-Slots —
  beides keine Schwellen, die Erklärung steht am Info-Zeichen und an den Zeilen; mit Bezugsgrenze die Slots darüber.
  Der EOS-Fahrplan zeigt zusätzlich geplante Last und Netzbezug.

- **Hinweis, wenn der Strompreis-Zeitraum ohne Nachfolger endet**: 14 Tage vor dem Ende des heute gültigen Zeitraums
  erscheint oben im Leitstand eine gelbe Warnung, wenn am Folgetag kein anderer beginnt — sonst rechnet DVhub danach
  still mit dem Grundtarif (z. B. bei neuen Netzentgelten zum Jahreswechsel). Ein neu gespeicherter Zeitraum nimmt
  den Hinweis sofort weg.

- **EOS im Fernbetrieb (Beta, Client-Modus)**: „Wo rechnet EOS?“ = „Im DVhub-Rechendienst“
  (`optimizer.eosProxy.mode` = `remote`, bei eingeschaltetem EOS) lässt den EOS-Plan von einem Rechendienst rechnen,
  für Boxen mit schwacher Hardware (Pro-Lizenz). DVhub startet dafür eine EOS-Fassade auf 127.0.0.1, das
  Regelverhalten bleibt gleich; fällt der Dienst aus, bleibt der letzte Plan, optional rechnet das lokale EOS. Ab Werk
  `local` (unverändert). Einstellungen → Betriebsart → EOS; nur im Bleeding-Edge-Kanal.

- **Zweite Victron-Anlage am selben Hausanschluss (Beta)**: eine zweite GX-Anlage ohne PV und ohne eigenen Zähler,
  z. B. die der anderen Haushälfte. Die Anlage mit Zähler regelt den Anschluss wie bisher; die zweite übernimmt träge
  einen Teil der Akkuleistung, verteilt nach nutzbarer Energie, sodass sich die Ladestände angleichen. EOS plant beide
  Akkus als einen (Kapazität und Leistung addiert, Ladestand gewichtet). Not-Halt setzt die zweite Anlage sofort auf 0,
  bei Abregelung oder negativem Preis speist sie nicht ins Hausnetz; ist sie nicht erreichbar, rechnet EOS ohne sie.
  Einstellungen → Meine Anlage → Erweitert; nur im Bleeding-Edge-Kanal.
  Die Historie zeigt den Akku der zweiten Anlage getrennt („Akku 2“): eigene Zeilen in der Energiebilanz, eigene
  Segmente in den Tagesflüssen, eigener Knoten im Sankey, eigene Spalten in Tabelle und CSV, seine Einspeisung mit
  eigenem Börsenerlös — PV, Verbrauch und Einspeisung gehen damit wieder auf.
- **Handy-App koppeln (Beta)**: Einstellungen → Freigaben → Handy-App. Ein QR-Code koppelt die DVhub-App mit der
  Anlage; erst nach „Freigeben“ in der Oberfläche ist das Handy eingetragen, wahlweise nur zum Anzeigen oder auch zum
  Steuern (Not-Halt, Auto, Regeln). Die Verbindung ist Ende zu Ende verschlüsselt — die Schlüssel tauschen Anlage und
  Handy nur über den QR-Code aus. Im Heimnetz spricht das Handy direkt mit der Anlage, unterwegs über ein Relay, das nur
  verschlüsselte Daten weiterleitet und nichts auf der Platte speichert. Voreingestellt ist `relay.dvhub.de`, ein
  eigenes Relay lässt sich eintragen (`relay/README.md`, Docker-Compose mit TLS). Ab Werk aus; Entkoppeln trennt
  sofort. Protokoll: `docs/HANDY-APP-PROTOKOLL.md`.

- **Entlade-Wächter in den Einstellungen, für alle Hersteller**: Einstellungen → Meine Anlage → „Entlade-Wächter“
  (Standard an) schaltet die Meldung „Speicher entlädt nicht“ ein und aus; unter „Erweitert“ stehen Dauer bis zur
  Meldung (Minuten), Mindest-Netzbezug und Mindest-Abweichung vom Sollwert (W). Der Wächter meldet nur (Protokoll,
  Notifications, Remote-Überwachung) und steuert nichts. Die Einstellung liegt jetzt herstellerneutral unter
  `monitoring.setpointWatchdog`; ein vorhandenes `victron.setpointWatchdog` zieht beim Laden dorthin um — vorher kam
  es unter einem aktiven Herstellerprofil gar nicht an. Er arbeitet bei Victron und Universal MQTT (Bridge und
  DVhub-Schema); Profile ohne Netz-Sollwert (Fronius, Deye) bleiben still. Victron-Register (aktive SoC-Grenze 2903,
  Entladegrenze 2720) liest er nur am Victron; meldet eine MQTT-Quelle keinen Mindest-Ladestand, gilt DVhubs
  „Untergrenze Sicherheit“.

### Geändert

- **EOS-Steuerzeitraum = ganzer bekannter Preiszeitraum, einstellbar**: Der Steuerzeitraum war fest auf 24 h gekappt;
  nachmittags (Preise bis Mitternacht des Folgetags) plante EOS den nächsten Abend deshalb nicht Slot für Slot. Jetzt
  reicht er standardmäßig so weit wie echte Preise (gut 30 h, höchstens 48 h). Neu unter Einstellungen → EOS-Optimierung:
  „EOS Steuerzeitraum höchstens“ (ganzer Preiszeitraum, 6, 12 oder 24 h — für schwache Boards; die Rechenzeit wächst
  mit dem Steuerzeitraum) und „EOS Prognosehorizont“ (`prediction.hours`, bisher fest 48 h; automatisch
  Steuerzeitraum + 48 h Schwanz, höchstens 72 h, oder fest 48/60/72 h). Die Preis-Fortschreibung endet am
  Prognosehorizont; hinter dem Steuerzeitraum bleiben immer mindestens 12 h Schwanz, sonst wird der Steuerzeitraum
  gekürzt. DVhub sendet beide Werte bei jedem Prognose-Push (beim Senken erst den Steuerzeitraum); nach dem Speichern
  rechnet EOS erst neu, wenn der Abgleich durch ist. Im Fernbetrieb nimmt der Rechendienst den Prognosehorizont noch
  nicht an und rechnet mit 48 h; DVhub plant dort mit 48 h und höchstens 36 h Steuerzeitraum, damit der Schwanz
  bleibt.

- **Leitstand, Kachel „Überschuss / Defizit“**: Die Hauptzahl ist jetzt der Rest heute (erwartete PV ab jetzt bis
  Mitternacht minus erwarteter Verbrauch im selben Zeitraum), darunter klein der ganze Tag; „Verfügbar“ = Rest heute +
  nutzbarer Akku. Akkugröße, Ladestand und Untergrenze kommen neu aus `/api/status` (`energyBalance.battery`, so wie
  EOS den Akku sieht, mit zweiter GX-Anlage beide) — bisher griffen Ersatzwerte 43 kWh / 5 %, auf einer 77-kWh-Anlage
  zeigte 43 % Ladestand dann 18,5 statt 33,1 kWh. „Rest heute“ zählt nur noch Slots ab jetzt (den laufenden anteilig).

- **EOS bekommt den Akku-Basispreis ohne Verlustaufschlag**: Als Speicherkosten (`levelized_cost_of_storage`) geht
  nur noch „Akku-Basispreis“ an EOS, nicht mehr Basispreis × (1 + Verlustaufschlag). EOS rechnet Lade- und
  Entladeverluste über den Akku-Wirkungsgrad selbst; mit dem Aufschlag zählten sie doppelt. DVhubs Preisvergleich und
  Historie rechnen weiter mit Aufschlag; die Hilfetexte sagen das.

### Behoben

- **Entlade-Wächter ohne Fehlalarme bei „Akku halten“, an der SoC-Grenze und bei Laststößen.** Die Meldung
  „Speicher entlädt nicht“ kam, obwohl alles richtig lief: während EOS „Akku halten“ (z. B. beim E-Auto-Laden), wenn
  der Akku an der aktiven SoC-Grenze des Victron stand (BatteryLife, Register 2903 — DVhub kannte nur die
  Mindestgrenze 2901) und wenn kurze Laststöße (Wallbox schaltet) sich zu „zehn Minuten“ summierten. Der Wächter
  liest jetzt die aktive SoC-Grenze mit, wertet ein Halten durch DVhub und eine Entlade-Sperre als gewollt und
  meldet nur, wenn die Störung ein ganzes Zehn-Minuten-Fenster prägt (mindestens 80 % der Messpunkte, auch im
  Mittel Netzbezug über dem Sollwert) und gerade anliegt. Bei Verdacht liest er die Entlade-Sperre selbst nach
  (Register 2720, auf älteren GX 2704), auch nach einem Neustart. Eine Sperre, die ein Poll-Punkt aus Register 2720
  liest, gilt als gewollt, auch wenn DVhub sie nicht selbst gesetzt hat. Während eines gewollten Haltens gibt es keine falsche Entwarnung mehr; „entlädt
  wieder“ meldet er nur, wenn der Akku wirklich entladen hat; lädt der Akku während des Haltens bei kaum Netzbezug,
  kommt „wieder unauffällig“, statt dass der Alarm stundenlang stehen bleibt. Das Protokoll nennt Anteil und
  Mittelwerte. Neuer Schalter `monitoring.setpointWatchdog.minSuspectShare` (Standard 0,8). Der Uptime-Kuma-Puls
  bleibt während eines Alarms auf „down“ — auch bei „Live-Daten eingefroren“ und „Anlagendaten widersprüchlich“, nicht
  nur beim Entlade-Wächter.

- **Peak Shaving sperrt den Akku nicht mehr versehentlich.** Victron zeigt die Werkseinstellung „Entladung
  unbegrenzt“ (−1 W) im Register 2704 als 0 an — genau wie eine Sperre. Peak Shaving hätte deshalb eine Sperre
  angenommen, bei einer Bezugsspitze „freigegeben“ (und damit den Akku auf wenige kW gedeckelt) und danach 0
  zurückgeschrieben — dann war der Akku wirklich gesperrt. Peak Shaving liest die Entladegrenze jetzt wie der
  Entlade-Wächter aus Register 2720 (eindeutig, Venus ≥ 3.50); eine 0 aus 2704 zählt nur noch, wenn DVhub selbst
  zuletzt 0 geschrieben hat.

- **VRM-Nachimport mit Portal-ID scheiterte mit „HTTP 404“ (#32).** Die VRM-Schnittstelle erwartet die numerische
  Site-ID, DVhub setzte aber den Inhalt des Feldes unverändert ein — und Oberfläche und Hilfetext verlangten genau
  die Hex-Portal-ID, die numerische Site-ID ließ sich gar nicht speichern. Jetzt heißt das Feld „VRM-Portal-ID oder
  Site-ID“ und nimmt beides: eine Zahl wird wie bisher direkt genutzt (bestehende Einrichtungen ändern sich nicht),
  eine Portal-ID löst DVhub mit dem Token über das VRM-Konto in die Site-ID auf und merkt sie sich. Gilt für Historie,
  VRM-Prognose und PV-Strings. Steht die Portal-ID nicht im Konto, sagt die Meldung das (mit Anzahl der Anlagen im
  Konto); ein 404 nennt die Site-ID. „Historie importieren“ meldet Fehler jetzt mit Grund statt „internal server
  error“, der Import mitgelieferter Zeilen wird wieder abgewartet, und die VRM-Prognose schreibt einen
  abgelehnten Abruf ins Log statt ihn still zu übergehen. VRM-Abrufe der Historie warten bei Netz- oder
  Serverfehlern jetzt wirklich zwischen den Versuchen (die Pausen waren wirkungslos) und haben ein Zeitlimit;
  scheitert der automatische Nachimport beim Start (z. B. Internet noch nicht da), steht das im Log
  (`history_auto_backfill_error`) und DVhub versucht es nach 5, 15 und 60 Minuten erneut — auch wenn schon die
  Lückensuche scheitert (Datenbank noch nicht bereit). Eine gespeicherte
  Portal-/Site-ID oder ein neues Token gilt für Historien-Import und Nachimport sofort, nicht erst nach einem
  Neustart.

- **Datenspende-Einrichtung: Fehler ohne erkennbaren Schritt (#31).** Scheiterte die Einrichtung (z. B. mit
  „400 bad_request: Invalid input format: null“), stand weder im Log noch in der Oberfläche, ob Konto, Haushalt,
  Client oder API-Key betroffen war. Jetzt nennen Log (`datenspende_link_failed`) und Meldung den Schritt, den
  HTTP-Status und die Meldung des Projekt-Servers, bei Verbindungsfehlern den Grund (z. B. `ETIMEDOUT`,
  `ENOTFOUND`); Passwort, Anmelde-Schlüssel und API-Key werden herausgefiltert. Jede ID wird direkt nach ihrem
  Schritt geprüft — fehlt sie, bricht die Einrichtung dort ab und protokolliert nur die Namen der Felder der Antwort,
  statt im nächsten Schritt einen leeren Wert zu schicken. IDs werden zusätzlich aus einer Antwort der Form
  `{household: {id}}`, `{client: {id}}` bzw. `{apiKey: {key}}` gelesen. Das Feld „Anmelde-Schlüssel“ hat eine
  Kurzhilfe und erscheint nur noch beim Anlegen eines neuen Kontos.

### Sicherheit

Nach einer Sicherheitsprüfung gehärtet; Einzelheiten zu den Befunden veröffentlichen wir nicht. Spürbar sind:

- **Support-Tunnel:** Der Fern-Support kann über den Tunnel weiter alles, was zur Reparatur nötig ist — auch
  API-Token, Kopplungen (Handy-App, EEBUS, Installateurs-Portal), VPN und Sicherheitseinstellungen. Er läuft über
  einen eigenen Zugang und gilt wie ein Gerät im Heimnetz. Einwilligungen erteilt nur der Kunde selbst: Datenspende
  und Ortsnetz-Daten einschalten, den Tunnel öffnen oder verlängern, den Support-Login einschalten und dem
  Installateurs-Portal Zugang geben geht über den Fern-Support nicht, auch nicht über eine eingespielte Sicherung;
  Datenspende, Ortsnetz und Portal-Zugang ausschalten und den Tunnel schließen geht. **Jede Änderung über den
  Fern-Support wird protokolliert** (mit Kennzeichen „Fern-Support“, Aufruf und geänderten Feldern, ohne Werte); der
  Kunde sieht sie unter Einstellungen → Fern-Support und im Tunnel-Hinweis, bei Token-, Kopplungs- und
  Sicherheitsänderungen kommt zusätzlich eine Benachrichtigung (sofern eingerichtet). Ein Sicherungs-Import ohne
  API-Token lässt das Token der Box stehen; das Token übernimmt ein Import nur ausdrücklich oder beim Geräte-Tausch.
- **Geräte-Tausch:** Der Import einer Sicherung auf eine neue Box verlangt das API-Token der Box.
- **Zugangsdaten folgen der Adresse:** Ändert sich die Adresse eines Dienstes (z. B. Benachrichtigungen, E-Auto,
  Wallbox) auf einen anderen Rechner, muss das Passwort bzw. Token neu eingegeben werden.
- **Lizenz:** Pro-Lizenzen werden an die jeweilige Box gebunden; Schlüssel ohne Signatur gelten nur bis 14 Tage nach
  der letzten erfolgreichen Online-Prüfung. Lizenz-Einstellungen lassen sich nicht mehr über die Konfiguration ändern;
  EOS im Fernbetrieb schickt seinen Lizenznachweis nur an dvhub.de.
- **Zugangsdaten folgen auch dem Port:** Ein anderer Port gilt wie eine andere Adresse.
- **Updates:** Ein Kanalwechsel, der auf eine ältere Fassung zurückstufen würde, fragt nach; Installations- und
  Update-Skripte folgen im Konfigurationsordner keinen Verweisen mehr und führen beim Installieren keine
  Paket-Skripte aus. Eigene Zertifikate unter `tls/` dürfen weiter Verweise sein (z. B. `cert.pem` und `key.pem`
  auf certbot unter `/etc/letsencrypt/live/…`); sie bleiben bei jedem Start erhalten, ein selbstsigniertes
  Zertifikat entsteht nur, wenn dort gar keins liegt. Der Dienstbenutzer braucht Leserecht auf die Ziele (bei
  certbot z. B. per deploy-hook); fehlt es, warnt das Start-Protokoll. Lässt sich bei Paket-Installationen die
  installierte Version nicht feststellen, installiert ein Update nicht. Die Update-Anzeige erkennt den laufenden
  Auftrag auch, wenn die Uhren von Browser und Box abweichen.
- **Benachrichtigungen (ntfy):** Adressen werden beim Senden aufgelöst und geprüft; Namen, die auf die Box selbst
  zeigen, gehen nicht.
- **Protokoll „Netzstrom im Akku“:** Der CSV-Download nutzt das API-Token.
- **Weitere Härtungen** an der Adressprüfung ausgehender Verbindungen (auch IPv6), an statischen Dateien, an
  Telemetrie-Abfragen, an der EOS-Oberfläche, am Installateurs-Portal und am Handy-App-Relay (Speicher- und
  Verbindungsgrenzen; ein volles Relay weist neue Boxen und Handys nicht mehr pauschal ab).

## [1.0.8] - 2026-10-21

Release nach knapp zwei Wochen, 110 Commits seit 1.0.7. Überblick nach Themen — die Einzelheiten
stehen in den Einträgen darunter:

- **Wallboxen:** rund 20 neue Typen direkt angebunden (u. a. KEBA, ABL, Heidelberg/Amperfied, Elli,
  Mennekes/Bender, Phoenix Contact, Hardy Barth, openWB, Victron EVCS, Nexblue, Peblar, NRGkick, SmartEVSE,
  Schneider EVlink, DaheimLaden, EM2GO, TinkerForge WARP, EEBUS-Wallboxen), OCPP-1.6J-Zentrale, Ladestand
  vom Auto über evccs Fahrzeug-Treiber, eine Hauptwallbox für alles.
- **EEBUS in Go:** `dvhub-eebus` auf Basis von eebus-go, nativ und im Container, mit E-Auto an der Wallbox;
  Geräte am Victron GX (Venus OS 3.80) werden angezeigt.
- **EOS:** das offizielle Akkudoktor-EOS unverändert (v0.4.0rc3), DVhub stößt jeden Lauf selbst an;
  EOS-Wache und „EOS neu starten“ auch im Docker-Betrieb; Planung mit der echten Wechselrichterleistung
  und dem Mindest-Ladestand.
- **Netz und Recht:** Einspeisegrenze der Anlage (60 %, 70 %, eigener Wert), MiSpeL-Option und
  -Übersicht, Netzladen ohne Option, Grenzen des Netzbetreibers per MQTT, Plexlog nach der offiziellen
  LUOX/Lumenaza-Tabelle, amtlicher Marktwert Solar von dvhub.online.
- **Fern-Support:** aus dem Installateurs-Portal öffnen, auch im Container, überlebt einen Neustart;
  Datenfluss-Übersicht.
- **Datenbank:** TimescaleDB auf Ubuntu (#24), Nachrüstung Apache → Community repariert bestehende
  Datenbanken, Kompression danach eingeschaltet.
- **Sicherheit:** Node.js 22.23.4 (Sicherheits-Release vom Oktober 2026), Schutz gegen Befehle fremder
  Webseiten, VPN-Hooks, Import-Rechenaufwand, Modbus-Schreibbestätigung, Geräteschlüssel im Portal.

### Neu

- **Schneider EVlink Pro AC als Wallbox** (Modbus TCP nach dem „EVlink Pro AC Modbus Connectivity Guide“
  GEX1969300–06): Ladestrom 6–32 A, Stopp über Vorgabe 0, Lebenszeichen (Lifebit) — ohne DVhub gilt der in eSetup
  eingestellte Ersatzstrom; Zustand, Leistung, Strom, Zählerstand. Je nach Firmware Holding- oder Input-Register.

- **DaheimLaden als Wallbox** (Smart V1+V2, Touch, Smart/Touch/Business PRO; Modbus TCP nach der
  „DaheimLader Modbus/TCP-Spezifikation“ vom 28.07.2026): gleiche Belegung wie EM2GO, Unit-ID 255. Smart und Touch
  fallen ohne DVhub nach 10 min auf 6 A zurück; die PRO-Modelle kennen keinen Rückfall, DVhub lädt dort ohne.

- **EEBUS nativ in Go.** Native Installationen (Debian/Raspberry Pi OS) bauen dvhub-eebus jetzt wie das
  Container-Image aus der Go-Fassung (eebus-go) und kennen damit auch das E-Auto an der EEBUS-Wallbox. Der nächste
  Neustart ersetzt eine vorhandene C-Fassung; Zertifikat und Kopplungen bleiben. Die Go-Werkzeugkette kommt von
  go.dev mit fest eingetragener Prüfsumme und liegt nur während des Baus auf dem Gerät. Zurück zur C-Fassung mit
  `/var/lib/dvhub/.eebus-impl-c`.

- **Phoenix Contact EV Charge Control als Wallbox** (Wallbe, Compleo Pro, E3/DC Easy Connect, ESL Walli; Modbus TCP
  nach Phoenix-Handbuch 108191_de_04): Ladestrom über Holding 528, Freigabe über Coil 400 (DIP 10 an), Zustand,
  Leistung, Strom, Energie. Dafür kann der Modbus-Transport jetzt Coils schreiben (FC5).

- **EM2GO (EM011/EM022 OCPP/ONC, Pro Power) als Wallbox** (Modbus TCP nach EM2GO-Leitfaden V5): Strombegrenzung,
  Rückfall 6 A nach 10 min, Start/Stopp über Ladebefehl; Zustand, Leistung, Strom, Zählerstand.

- **SmartEVSE v3 als Wallbox** (REST nach SmartEVSE-3-Doku und -Quellcode, MIT): Strom über `override_current`
  in NORMAL, Stopp über OFF, „Automatisch“ stellt den vorherigen Modus wieder her; Leistung, Strom, Energie und
  (mit Modem) SoC.

- **Nexblue (Edge 2, Edge Max, Point 2, Delta) als Wallbox** (Modbus TCP nach Nexblue-Doku, 32-Bit-Werte DCBA):
  Strom 1000 als Lebenszeichen alle 15 s, Rückfall 6 A nach 5 min; Zustand, Leistung, Energie.

- **EVSE-WiFi / smartWB als Wallbox** (HTTP-API nach Doku vom 27.05.2022): `setCurrent`, `setStatus`; im Modus Always
  Active Stopp über Strom 0. Kein Watchdog.

- **ABL eM4 Single/Twin als Wallbox** (Modbus TCP nach ABL-Beschreibung R01, 12/2023): EMS-Vorgabe Icmax (0,1 A, 0 = aus,
  höchstens Idefault), Status, Leistung, Energie, Ströme; Twin: Ladepunkt links/rechts. Kein Watchdog dokumentiert.

- **NRGkick Gen2 als Wallbox** (lokale JSON-API, SmartModule ≥ 4.0): `current_set`, `charge_pause`, Status/Leistung/Energie
  aus `/values`; BasicAuth optional (geschwärzt). Kein Watchdog.

- **Peblar Home / Home Plus als Wallbox** (Modbus TCP nach Peblars offiziellem Client): Ladestrom 40000 (mA, 0 =
  Pause), Leistung, Energie, Ströme, CP-Zustand. Kein dokumentierter Watchdog.
- **Mennekes AMTRON 4You 500 / 4Business 700** als Variante des Bender-Treibers (Strom über Register 2000).

- **Hardy Barth Salia (cPH2/cPμ2) als Wallbox** (Modbus TCP nach docs.echarge.de, MapVersion 2.1.0): Modus MANUAL,
  Strom 201, Start/Stopp 202, Failsafe 203/205 (5 min, 6 A) mit Lebenszeichen 207 bei jeder Abfrage; Leistung und
  Energie als Float32.

- **Bender-Laderegler als Wallbox** — ein Treiber für Mennekes AMTRON Professional/AMEDIO, SMA EV Charger Business,
  Webasto Live, Optec, Ebee, CUBOS, Ensto (Modbus TCP, Registersatz OMCCI nach bender.de): HEMS-Stromgrenze 1000
  (0 = Pause), Rückfall 131/132, Zustand 122, Leistung/Energie/Ströme 212–221.

- **Amperfied/Heidelberg connect und Elli Gen 2 (VW ID. Charger 2, Cupra/Škoda Charger 2) als Wallbox** — gleiches
  Modbus-TCP-Layout (Amperfied 04/2025, Elli v1.0 vom 15.10.2025): Strom 261 in 0,1 A (0 = Stopp), Watchdog 257,
  Rückfallstrom 262; Zustand, Ströme, Leistung, Energie aus den Input-Registern.

- **KEBA KeContact P30/P40 als Wallbox** (Modbus TCP nach KEBA-Guide V1.07): Strom 5004, Freigabe 5014 (P40: Stopp
  über Strom 0), Failsafe 6 A nach 5 min ohne Verbindung; schreibt nur bei Änderung (KEBA: höchstens alle 5 s).

- **OCPP-1.6J-Zentrale und OCPP-Wallbox.** DVhub kann selbst OCPP-Zentrale sein (ab Werk aus, Port 8889 — 8887 nutzt evcc, nur
  Heimnetz, optional Passwort nach Sicherheitsprofil 1). Wallboxen mit OCPP (z. B. Alfen, ABL, Wallbox, Zaptec,
  Bender-basierte) verbinden sich mit `ws://<DVhub>:8889/<Ladepunkt-ID>`. Steuerung über Ladeprofile in Ampere
  (`SetChargingProfile`), Stopp = 0 A, „Automatisch“ löscht das Profil; Fernstart, wenn das Auto steckt und kein
  Vorgang läuft. Messwerte (Leistung, Energie, Strom) und Status aus `MeterValues`/`StatusNotification`.
  An/aus und Port wirken ohne Neustart. `GET /api/ocpp/status`.

- **Phoenix Contact CHARX als Wallbox** (auch Veton, LadeFoxx): Modbus TCP nach Handbuch 109999_en_04 (Anhang B 3),
  Ladestrom x301, Freigabe x300, Status x299, Leistung/Energie; Watchdog — meldet sich DVhub 5 min nicht, fällt die
  Box auf 6 A zurück.
- **TinkerForge WARP als Wallbox**: HTTP-API (docs.warp-charger.com) über den Ladeslot „Externe Steuerung“
  (`evse/external_current` in mA), Status aus `evse/state`, Leistung aus `meter/values`.

- **EEBUS-Wallbox (Elli / VW ID. Charger, Cupra, Audi, Škoda, Porsche, Kontron/Steca/ghostONE).** Unter
  Integrationen → EEBUS koppeln, dann als Wallbox wählen. DVhub steuert die Box über ihre Verbrauchsgrenze (LPC):
  Laden = Strom × 230 V × Phasen, Stopp = 0 W, Automatisch = Grenze aufheben. Die Vorgabe gilt zusammen mit einem
  §14a-Anteil — der kleinere. Ob ein Auto steckt, erkennt DVhub nur, solange es lädt. Ungeprüft an einer echten Box.

- **openWB als Wallbox.** Zwei Wege: openWB Pro / series2 Satellit direkt über deren HTTP-Schnittstelle
  (`connect.php`: Ladestrom, Stopp, Messwerte, Ladestand), oder openWB series2/Duo im Modus „Nur Ladepunkt“ —
  DVhub steuert dann wie eine übergeordnete openWB per MQTT (Port 1883); bleibt DVhubs Lebenszeichen 80 s aus,
  stoppt die Box selbst. Steuerung wie bei allen Wallboxen nur mit Pro-Lizenz (EOS-Weitergabe, Lademodus).
- **Eine Liste der Wallbox-Typen** (`services/wallbox/types.js`) statt fünf Stellen — neue Wallboxen müssen nur
  noch dort und im Adapter eingetragen werden.
- **EEBUS-Knoten in Go (enbility eebus-go) mit E-Auto an der Wallbox.** `dvhub-eebus` gibt es neu in Go
  (`dvhub/eebus/go/`, eebus-go/ship-go/spine-go, MIT); das Container-Image nutzt diese Fassung, nativ bleibt
  vorerst die C-Bridge auf openeebus. Gleiches Protokoll mit DVhub, gleiche Zertifikate und SKI (Kopplungen
  bleiben), gleiche Rollen (CS LPC/LPP zur Steuerbox, EG LPC/LPP, MA MPC, CEM OHPCF, GCP MGCP). Neu als CEM:
  Auto an/ab und Fahrzeugdaten (EVCC), Strom/Leistung/Energie je Phase (EVCEM), Ladestand (EVSOC, falls das
  Auto ihn sendet), Ladestrom je Phase setzen (OPEV/OSCEV, `setEvCurrentLimits`), Ladeplan lesen (CEVC); Stand
  je Wallbox unter `device.ev`. Gegenüberstellung und Abweichungen: `dvhub/eebus/go/PROTOKOLL.md`. Gegen die
  openeebus-Referenzprogramme 27/27 Prüfungen wie die C-Bridge; mit echter Steuerbox, Wärmepumpe oder
  Wallbox noch ungeprüft. Rückweg im Image: `--build-arg EEBUS_IMPL=c`.
  Die EEBUS-Wallbox (Wallbox-Typ „EEBUS“) nutzt das: steckt ein Auto und meldet die Box OPEV, gibt DVhub den
  Ladestrom je Phase direkt vor (Stopp = 0 A) und zeigt Ladestand, Leistung und Strom vom Auto; sonst wie bisher
  über die Verbrauchsgrenze (LPC).

- **Ladestand vom Auto über evccs Fahrzeug-Treiber.** Integrationen → Wallbox → „Ladestand vom Auto“: Marke
  wählen (46 Vorlagen aus evcc 0.317.2, z. B. VW, Kia, Hyundai, Renault, Mercedes, Škoda, Tesla mit Tokens),
  Zugangsdaten der Hersteller-App eintragen. DVhub lädt das offizielle evcc-Programm erst beim Einschalten
  (gepinnte Version und SHA-256, nicht im Image) und fragt damit nur das Auto ab (`evcc vehicle`), alle 15 min
  solange es steckt, sonst stündlich. Neue Ladestand-Quelle „Fahrzeug über evcc-Treiber“. Zugangsdaten werden
  nie zurückgegeben und in Fehlermeldungen geschwärzt. Nicht dabei: Marken mit Browser-Anmeldung (BMW, Ford,
  Porsche, Volvo) und Tronity (evcc-Sponsor-Pflicht). evcc: MIT, Hinweis in THIRD-PARTY-LICENSES.md.

- **Einspeisegrenze der Anlage (60 %, 70 %, eigener Wert oder keine).** Neu unter Einstellungen → Netz & Recht.
  Ab Werk ist nichts gesetzt: bis der Betreiber gewählt hat (auch „keine Grenze“), zeigt DVhub einen Hinweis.
  Victron: DVhub setzt die Grenze im GX (Reg. 2706, gilt auch ohne DVhub) und prüft sie alle 10 min nach;
  Direktvermarkter und Steuerbox können nur tiefer begrenzen, danach gilt wieder diese Grenze. Fronius/SunSpec:
  DVhub regelt den Wechselrichter im 5-s-Takt so, dass die Einspeisung knapp unter der Grenze bleibt (die Grenze
  muss zusätzlich im Wechselrichter stehen). Liegt die Einspeisung länger als 60 s darüber, meldet DVhub das.
  `GET /api/feed-in-cap/status`.
- **Victron EV Charging Station als Wallbox.** Über den Modbus-TCP-Server des GX: Laden (Modus Manuell, Strom,
  Start), Stopp, „Automatisch“ gibt an Victrons Automatik zurück. Die Unit-ID sucht DVhub selbst.
- **Geräte am Victron GX.** Seit Venus OS 3.80 koppelt der GX EEBUS-Wärmepumpen und -Wallboxen selbst. DVhub
  findet sie (dazu Victron-Wallbox und AC-Lasten) über den Modbus des GX und zeigt sie im EEBUS-Fenster —
  nur lesend. `GET /api/victron/devices`, `POST /api/victron/devices/scan`.
- **Warnung bei unbekannten Befehlen des Direktvermarkters.** Schickt der Direktvermarkter etwas, das nicht zum
  gewählten Profil passt (z. B. einen Zwischenwert im Plexlog-Profil), meldet DVhub das im Protokoll
  (`dv_unknown_command`) und als Systemwarnung, statt es still zu ignorieren.

### Geändert (Direktvermarkter)

- **Plexlog-Profil liest nach der offiziellen LUOX/Lumenaza-Tabelle (02.06.2026).** Input-Register FC4: Einspeisung
  (volles i32, auch über 32,7 kW richtig), Produktion, Netzbetreiber-Vorgabe 100 %, Referenzleistung. Steuern
  bleibt wie bisher. Bei „Positiv bedeutet Netzbezug“ gilt jetzt das offizielle Vorzeichen (+ = Einspeisung).
  Freigabe über Adresse 0 = 255, 255 (so schaltet LUOX tatsächlich frei) wirkt jetzt auch.

- **EOS-Wache auch im Docker-Betrieb.** Hängt ein EOS-Lauf (Standard: länger als 90 min) oder drückt man „EOS neu
  starten“, startet DVhub jetzt auch den EOS-Container neu. Dafür läuft im EOS-Container ein kleiner Wächter
  (`docker/compose.yml`, `configs: dvhub-eos-watch`), der DVhub jede Minute über `127.0.0.1` fragt und EOS bei einer
  Anforderung beendet; Docker startet den Container dann neu. Mit einer älteren `compose.yml` ohne Wächter bleibt es
  beim Hinweis, den Container von Hand neu zu starten. Startet EOS 10 min nach der Anforderung nicht neu, meldet
  DVhub den Neustart als gescheitert.
- **MiSpeL-Übersicht in der Historie, Rumpfjahre in den Einstellungen.** Ist eine MiSpeL-Option gewählt, rechnet
  DVhub aus den eigenen Messwerten nach der Festlegung der BNetzA (Beschluss 618-25-02 vom 01.10.2026) mit:
  Pauschaloption je Kalender- bzw. Rumpfjahr (förderfähige Menge P1, Erstattungsschwelle P4, Einspeisung P7,
  saldierte Menge P10, voll belasteter Netzbezug P11, förderfähige Einspeisung P15), bei der Abgrenzungsoption
  zusätzlich Formelsatz A1 je Monat. Die Historie zeigt das als Karte für das gewählte Jahr
  (`GET /api/history/mispel?year=`). In den Einstellungen (Netz → Rechtliche Schalter) erscheinen mit der Option:
  „MiSpeL-Option gilt seit“ (im ersten Jahr ein Rumpfjahr ab diesem Tag), PV-Leistung und installierte
  Speicherkapazität für MiSpeL und die Liste der Rumpfjahre — jede Änderung an Speicher, Solaranlage, Ladepunkt,
  Messkonzept oder Zuordnung teilt das Jahr; Akku-Ausbaustufen werden als Rumpfjahr vorgeschlagen. Die Werte sind
  eine Auswertung der Anlage, keine Abrechnung; den Speicherzähler nähert DVhub aus der Akku-Leistung.
- **Feld für die MiSpeL-Option (Pauschal- oder Abgrenzungsoption).** Unter Rechtliche Schalter lässt sich jetzt
  wählen, ob für den Speicher die Pauschal- oder die Abgrenzungsoption gilt (`optimizer.mispel.mode`). Vorher ging
  das nur per Handeintrag in der `config.json`. Die Wahl einer Option gibt Netzladen mit PV-Anlage frei und muss
  deshalb bestätigt werden wie die anderen rechtlichen Schalter.

- **EOS hängt nicht mehr still — Wache und Knopf „EOS neu starten“.** Feldfall: EOS antwortete, rechnete aber
  seit dem Vorabend nicht mehr (ein Rechenprozess hing, jeder weitere Lauf wartete bis zum Timeout von 3 h); die
  Oberfläche zeigte „online“ und den alten Plan, ein Neustart von DVhub half nicht. Jetzt startet DVhub EOS selbst
  neu, wenn ein Lauf länger als 90 min rechnet (`optimizer.eosStallRestartMin`, 0 = aus; höchstens alle 2 h). Unter
  Prognose → EOS weist die Karte auf einen veralteten Plan (> 2 h) oder hängenden Lauf hin und bietet „EOS neu
  starten“ an (`POST /api/eos/restart`). Neue sudoers-Regel nur für `systemctl restart eos.service` (ohne Wildcard,
  auch mit sudo-rs gültig); sie kommt mit dem nächsten Update automatisch auf die Box. Gilt für das EOS auf derselben
  Box, nicht im Container und nicht für ein entferntes EOS.
- **Datenfluss-Übersicht: was kommt rein, was geht raus.** Unter Integrationen → „Datenfluss“ (und aus den
  Bereichen Loxone und Home Assistant) zeigt DVhub, welche Werte gerade ankommen (Feld/Topic, Wert, Alter, frisch
  oder veraltet), wie DVhub sie versteht (Netz, PV, Akku, Ladestand, Hausverbrauch) und welche Sollwerte über
  welchen Kanal hinausgehen (Loxone-HTTP mit Größe und Position der Sollwerte, Home Assistant, MQTT,
  Direktvermarkter-Modbus mit letzter Abfrage). Prüfhinweise melden typische Zuordnungsfehler: PV über 120 % der
  eingetragenen kWp, Ladestand außerhalb 0–100 %, Akku-Leistung weit über der Grenze, Energiebilanz geht nicht auf
  (Vorzeichen, doppelt gezählte Werte), veraltete oder fehlende Pflichtwerte. `GET /api/integrations/dataflow`.
- **Netzladen auch ohne Pauschal-/Abgrenzungsoption.** Neuer rechtlicher Schalter: Wer den Speicher bewusst mit
  Netzstrom laden will (z. B. im Winter mit dynamischem Tarif oder §14a Modul 3), kann die MiSpeL-Sperre aufheben,
  solange die Optionen noch nicht verfügbar sind. Bestätigung wie bei den anderen rechtlichen Schaltern; wirkt nur
  zusammen mit „Netzladen erlaubt“. Hinweis auf das EEG-Risiko für eingespeiste Mischmengen im Hilfetext.
- **Fern-Support über das Portal öffnen.** Im Installateurs-Portal öffnet „Fern-Support öffnen" den
  Tunnel zur Anlage — ohne Schlüsselaustausch per Chat, ohne Terminal beim Kunden und ohne Handarbeit
  am Relay. Die Anlage meldet ihren öffentlichen Relay-Schlüssel ans Portal; beim ersten Öffnen trägt
  ein Dienst auf dem Relay-Server sie ein und vergibt die Ports. Der Kunde erlaubt das einmal mit
  einem Haken im Kopplungsdialog, wird bei jeder Öffnung benachrichtigt und kann jederzeit schließen.
  Hinein kommt weiterhin nur der hinterlegte Support-Schlüssel.
- **Fern-Support auch im Docker-Container.** Das Image enthält jetzt ssh, autossh und einen sshd. Der
  sshd läuft nur, solange ein Tunnel offen ist, nur auf 127.0.0.1 und lässt nur den Support-Schlüssel
  herein (Benutzer `dvhub`); hat der Kunde den Support-Login abgeschaltet, geht nur die Weboberfläche
  durch den Tunnel. Schlüssel, gepinnter Relay-Hostschlüssel und `relay.json` legt der Entrypoint im
  Daten-Volume an. Der Tunnel leitet die Weboberfläche auf den eingestellten `httpPort` statt fest auf
  Port 80.
- **Container oder Betriebssystem neben der Version.** DVhub zeigt unter Einstellungen → System und
  im Portal an, ob es als Docker-Container läuft (Update = neues Image) oder nativ, und auf welchem
  Betriebssystem.

- **Eine Hauptwallbox für alles.** Unter Integrationen → Wallbox steht die Wahl jetzt ganz oben:
  über evcc, OpenEVSE, go-e Charger oder Fronius Wattpilot. Diese Wallbox gilt überall —
  Leitstand und Familien-Dashboard (Zustand und Lademodus), MQTT/Home Assistant (`ev/mode`),
  Ladestand und Steckzustand für EOS, Datenspende, §14a und der Auto-Vorrang des Heizstabs.
  Vorher fragten einige Stellen evcc, obwohl eine Box direkt angebunden war, und die Auswahl
  versteckte sich im EOS-Abschnitt. Ist eine Box direkt gewählt, wird evcc nicht mehr ersatzweise
  gefragt; die evcc-Felder erscheinen nur noch bei „über evcc". Eine direkte Box hat drei
  Lademodi: Aus, Automatisch (die Box bzw. der EOS-Plan entscheidet) und Schnell.
- **Fronius Wattpilot als Wallbox.** Neben OpenEVSE und go-e lässt sich jetzt ein Fronius
  Wattpilot direkt ansteuern (Integrationen → evcc → „Steuern über: Fronius Wattpilot direkt",
  Adresse und das Passwort aus der Wattpilot-App). DVhub spricht die Box über dieselbe lokale
  WebSocket-Schnittstelle wie die App an — Anmeldung und signierte Befehle wie im erprobten
  Ohmpilot-Übersetzer — und kann damit den EOS-Ladeplan, „Sofort laden", §14a und den Steckzustand
  genauso nutzen wie bei den anderen Boxen. Der Ladestrom bleibt unter der Grenze der Box.
- **my-PV-Heizstab direkt (AC THOR / ELWA 2).** Planbare Verbraucher kennen den Endpunkt
  „my-PV direkt": DVhub schreibt die Heizleistung per Modbus TCP (Register 1000) und liest
  Leistung, Temperatur, Status und Steuerungsart zurück. Ein eigener schneller Regler (alle 5 s
  statt 30 s) übernimmt die Regel aus dem Ohmpilot-Übersetzer: Überschuss am Netzanschlusspunkt
  minus Mindest-Einspeisung, langsam hoch, zügig herunter, bei Netzbezug sofort, nie aus dem Akku
  oder dem Netz; mit Einschaltschwelle, Mindest-Akkustand und Auto-Vorrang (wartet ein
  angestecktes Auto auf den Ladestart, bleibt der Stab aus; lädt es, bekommt er nach einer
  Wartezeit den Rest). Bei go-e und Wattpilot unterscheidet DVhub dafür jetzt „wartet" und
  „fertig". Der Verbrauch fließt in die Last-Vorhaltung für EOS ein.
- **CI-Ergebnis wird nach jedem Push geprüft.** `scripts/ci-check.py` fragt den Stand der GitHub-CI
  für einen Commit ab und wartet auf Wunsch darauf; Git-Hooks (`scripts/git-hooks/`) prüfen vor
  Commit und Push Secret-Scan und ESLint, und Claude-Code-Sitzungen warten nach einem Push auf
  das Ergebnis (`scripts/ci-hook.py`). Anlass: die CI war Anfang Oktober eine Woche unbemerkt rot.
- **Vorab-Image `dev` in der Registry.** Nach jedem Push auf `main` mit grüner CI baut GitHub
  `bikinibottomcapital/dvhub:dev` (auch `ghcr.io/chloepriceless/dvhub:dev`) für amd64 und arm64.
  `latest` bleibt das letzte Release. Hebt `main` den EOS-Stand an, wird das passende EOS-Image
  mitgebaut. Das Image trägt seinen Commit: die Versionsanzeige nennt ihn (z. B. `v1.0.7+4c066da`).
- **Leitstand: Ansicht „Einfach" oder „Erweitert".** Der Leitstand zeigt alles, was DVhub weiß und
  stellen kann — für Einsteiger zu viel auf einmal. Ein Umschalter oben rechts wechselt zwischen
  beiden Ansichten. „Einfach" lässt Energiefluss, PV, Akku, Kosten, Börsenpreis, E-Auto, die
  Tagesprognose und den Not-Halt stehen und blendet Sollwerte, Direktvermarkter-Signale, §14a-Karte,
  VPN, Zeitplan, Kleine Börsenautomatik, Prognose-Diagramme und das Systemprotokoll aus. Die Wahl
  gilt je Browser. Ohne eigene Wahl startet ein neuer Browser einfach; wer DVhub schon nutzt,
  behält die erweiterte Ansicht.
- **Grenzen des Netzbetreibers per MQTT.** Die Bezugsgrenze nach §14a (EEBUS-Steuerbox oder
  Dimm-Eingang) und die Einspeisegrenze wirkten bisher nur auf Speicher, Wallbox und
  Einspeisebegrenzer und waren sonst nur über die API lesbar. DVhub veröffentlicht sie jetzt
  unter `dvhub/control/grid_limit/*` (aktiv, Quelle, Bezugsgrenze, Einspeisegrenze, Sperre, dazu
  die Aufteilung je Gerät als JSON), mit Home-Assistant-Erkennung und als
  `dvhub_control_grid_limit_*`-Zeilen für Loxone. Damit kann auch ein Gerät ohne EEBUS — etwa
  eine Wärmepumpe über Home Assistant — der Grenze folgen.

### Geändert

- **Node.js 22.23.4.** Das Container-Image baut auf Node 22.23.4 (Sicherheits-Release vom Oktober 2026); native
  Installationen bekommen es mit dem nächsten DVhub-Update aus NodeSource.

- **EOS ist jetzt das offizielle Akkudoktor-EOS, unverändert.** Der eigene Fork (DV-EOS) wird nicht
  mehr gebraucht: Wirkungsgradkurve, parallele Bewertung, Fertig-Meldung und die Laufzeit- und
  RAM-Verbesserungen sind dort aufgenommen. Ausgeliefert wird `v0.4.0rc2` aus
  `github.com/Akkudoktor-EOS/EOS` (nativ und als Image `bikinibottomcapital/dvhub-eos:v0.4.0rc2`).
  Boxen mit dem Fork wechseln beim nächsten Update von selbst; EOS übernimmt seine Konfiguration.
- **EOS-Image: das offizielle, sobald es eines gibt.** Die Pipeline entscheidet anhand von
  `docker/.env.example` (`scripts/eos-image-plan.sh`): Zeigt der Pin auf ein offizielles Image
  (`akkudoktor/eos:<Version>`, neu `EOS_IMAGE` und `EOS_IMAGE_TAG`), baut sie kein EOS-Image mehr.
  Nur für Vorab-Stände, die Akkudoktor nicht als Image veröffentlicht (wie `v0.4.0rc2`), baut sie
  weiter `dvhub-eos`. Gibt es zum Pin ein offizielles Image, das noch nicht eingetragen ist, weist
  der Lauf auf `main` darauf hin und ein Release bricht ab.
- **DVhub stößt jeden EOS-Lauf selbst an.** Was bisher nur der Fork konnte, macht DVhub jetzt über
  die offizielle Schnittstelle (`POST /v1/optimize`): Der Lauf startet zur vollen Viertelstunde, der
  Ladestand von Akku und Auto reist im Aufruf mit, und ändert sich der Steuerzeitraum, passt DVhub
  die Startlösung selbst an, damit EOS nicht bei null beginnt. EOS' eigene Läufe sind dafür aus
  (`ems.mode = DISABLED`). Fehlt nach einem EOS-Neustart der Plan, rechnet EOS sofort statt erst
  zur nächsten Viertelstunde. „EOS rechnet nach eigenem Takt" in den Einstellungen stellt auf das
  alte Verhalten zurück.

### Behoben

- **„Auf Karte wählen“ übernahm den Standort nicht.** Seit der Suche in den Einstellungen trägt auch die Zeile
  eines Feldes dessen Pfad; der Karten-Picker traf die Zeile statt des Eingabefelds, „Übernehmen“ wirkte nicht,
  und die Karte öffnete immer in Deutschland-Mitte. Jetzt landen die Koordinaten in Breiten- und Längengrad, die
  Speichern-Leiste erscheint, und die Karte öffnet am eingetragenen Standort. Steht dort noch nichts (oder 0/0),
  zeigt sie Deutschland im Überblick, und „Übernehmen“ geht erst nach einem Klick auf das Haus. Feldfall: Standort
  0/0 ergab einen abendlichen PV-Peak in der Prognose.

- **TimescaleDB nach der Nachrüstung Apache → Community.** Auf nativen Boxen, deren Erweiterung noch auf der alten
  Apache-Version stand, fehlte nach dem Paketwechsel die passende Bibliothek: jede Datenbank-Sitzung scheiterte
  an der ersten Anweisung, spätere Schreibvorgänge landeten unsichtbar in der Elterntabelle. Die Nachrüstung hebt
  die Erweiterung jetzt als erste Anweisung an, holt solche Zeilen in die Hypertable zurück, protokolliert nach
  `timescale-provision.log` im Datenverzeichnis und meldet Fehler in Einstellungen → System, statt still „aktuell“
  zu zeigen. Danach schaltet DVhub die Kompression ein, die unter Apache nicht eingerichtet werden konnte (sonst
  wuchs die Datenbank ungebremst); ist die Tabelle gerade belegt, beim nächsten Start.

- **Historie: versteckte Rechenzeilen blieben sichtbar.** „Förderverlängerung (§51a)“ stand mit „-“ da, obwohl
  sie ausgeblendet sein sollte.

- **Marktwert Solar amtlich und deutschlandweit**: DVhub holte die Monatsmarktwerte nur von Energy-Charts, das der
  amtlichen Veröffentlichung hinterherhinkt (im Oktober fehlte der September, für Mai 2026 stand 3,163 statt
  3,296 ct/kWh). Jetzt kommen Monatswerte, Jahresmarktwert und der laufende Jahresmarktwert zentral von dvhub.online
  (amtliche Werte der Übertragungsnetzbetreiber von netztransparenz.de), zusammen mit den Börsenpreisen. Der laufende
  Jahresmarktwert ist der deutschlandweite (gewichtet mit der bundesweiten Solarerzeugung), nicht mehr nach der
  eigenen Einspeisung gewichtet. Ist dvhub.online nicht erreichbar oder die Börsenpreise kommen von der öffentlichen
  Quelle, holt DVhub die amtlichen Monatswerte direkt. Bereits gespeicherte Werte werden einmal amtlich nachgeholt.
- **TimescaleDB auf Ubuntu** ([#24](https://github.com/chloepriceless/dvhub/issues/24)): Der Installer trug auch auf
  Ubuntu die Debian-Paketquelle von Timescale ein; auf Ubuntu 26.04 gibt es die nicht, jedes `apt update` meldete
  einen Fehler und DVhub nahm die Apache-Fassung ohne Kompression. Jetzt die passende Quelle (auch für Ableger wie
  Mint); eine falsche wird beim nächsten Update ersetzt, eine Quelle ohne Pakete wieder entfernt.
- **Auswahllisten im Dark Theme** ([#23](https://github.com/chloepriceless/dvhub/issues/23)): Die aufgeklappte
  Liste war weiß mit weißer Schrift (z. B. Integrationen → Victron Wechselrichter). Jetzt dunkel im Dark Theme,
  hell im Light Theme.
- **Wallbox-Adapter behalten ihren Zustand:** DVhub baute für jeden Befehl und jede Statusabfrage einen neuen
  Adapter — Nexblue verlor das Lebenszeichen, EM2GO/SmartEVSE den gemerkten Modus, die EEBUS-Wallbox ihre
  LPC-Grenze, die Schreib-Entprellung (KEBA, Heidelberg, …) griff nie. Jetzt ein Adapter je Typ und Einstellung.
- **EEBUS-Wallbox:** OPEV nur mit lesbaren, änderbaren Grenzen; Stopp per OPEV nur, wenn der Standardwert der Box
  0 A ist (sonst LPC 0 W); Box ohne LPC, aber mit OPEV-Auto gilt als eingerichtet. Go-Bridge: Entitäten-Abgleich
  ohne gleichzeitigen Map-Zugriff. SmartEVSE: „Automatisch“ lässt SMART/SOLAR stehen. EM2GO: kein Startbefehl
  alle 15 s, wenn das Laden beendet ist (Auto voll).
- **Modbus-Wallboxen bei MQTT-angebundener Anlage:** KEBA, Heidelberg, Bender & Co. bekamen dort den MQTT-Transport
  und meldeten nur „Modbus nicht verfügbar“; sie nutzen jetzt eine eigene Modbus-Verbindung.
- **Unvollständige Datenbank-Migrationen werden angezeigt.** Eine gescheiterte Migration stand bisher nur im
  Journal, der Status meldete trotzdem „ok“. Jetzt erscheint unter System-Gesundheit „Datenbank-Stand“ mit den
  betroffenen Dateien, `/health` meldet `telemetry.migrationsOk`, und das Log bekommt einen Warneintrag.
- **Release nur mit grünen Tests desselben Commits.** Der Container-Release ruft jetzt die volle Testsuite für
  genau den Tag-Commit auf, bevor gebaut wird.

- **Benachrichtigungen fielen bei eingeschalteter Schreib-Rücklesung aus.** Der Timer der Rücklesung
  (`schedule.controlWriteVerify`) lag im gemeinsamen Zustand; solange eine Rücklesung anstand, scheiterte jede
  Benachrichtigungsprüfung mit „Converting circular structure to JSON“ (eHive: rund 1 600-mal je Stunde). Der
  Timer liegt jetzt außerhalb des Zustands.

- **VPN-Profile: Hooks in jeder Schreibweise blockiert, Prüfung auch beim Geräte-Tausch und vor jedem Start.**
  WireGuard-Hooks (`PreUp`, `PostUp`, …) wurden nur in genau dieser Schreibweise abgelehnt; `wg-quick` führt sie
  auch als `preup` aus. Ein Geräte-Tausch-Paket konnte VPN-Profile ohne Inhaltsprüfung einspielen. Jetzt prüft
  DVhub Upload, Import und jeden Start gleich; ein Paket mit gefährlichem Profil wird ganz abgelehnt, bevor etwas
  gespeichert ist. Bestehende Profile (auch OpenVPN mit DVhubs `script-security 0`) laufen unverändert weiter.
- **Import von Sicherungen: Rechenaufwand begrenzt.** Ein präpariertes Paket konnte über die Schlüsselableitung den
  ganzen Dienst (auch die Steuerung) minutenlang blockieren. Werte außerhalb 100 000–1 000 000 Iterationen werden
  sofort abgelehnt; alle echten Exporte nutzen 210 000.
- **Modbus: Schreibbestätigung wird mit dem Auftrag verglichen.** Bestätigt ein Gerät eine andere Adresse oder
  Registeranzahl, gilt der Schreibvorgang als fehlgeschlagen. Ein abweichender zurückgemeldeter Wert wird nur
  protokolliert, damit Geräte, die Bits maskieren, weiter funktionieren.

- **IPsec-VPN auf Ubuntu 26.04 (sudo-rs).** sudo-rs lehnt Platzhalter mitten im Argument ab und übersprang deshalb
  die vier sudoers-Regeln, mit denen DVhub die IPsec-Profile nach `/etc/ipsec.d` verlinkt — IPsec ging auf solchen
  Boxen nicht, und die Warnung landete in fremden Fehlermeldungen. Das übernimmt jetzt das root-eigene Hilfsskript
  `/usr/local/libexec/dvhub-ipsec-link` (prüft Profilnamen und lehnt `leftupdown`/`include` ab). Die sudoers-Datei
  wird vor dem Einspielen mit `visudo -c` geprüft; schlägt das fehl, bleiben die bisherigen Regeln aktiv. Kommt mit
  dem nächsten Update von selbst auf die Box. Mit sudo-rs 0.2.13 auf Ubuntu 26.04 geprüft.
- **MQTT-Kachel „Instabil“ mit tausenden Fehlern, obwohl MQTT aus ist.** Der MQTT-Publisher zählte bei
  ausgeschaltetem MQTT jeden 5-s-Takt als Fehler (Feldfall: 17 242 in 24 h bei reinem HTTP-Push). Jetzt keine
  Gesundheitsprobe, wenn MQTT aus ist; die Kachel zeigt „Inaktiv“.
- **Steuer-Log nennt die HTTP-Abholung.** Ohne Broker (Loxone holt die Sollwerte per HTTP ab) stand im Steuer-Log
  `writeType: mqtt`; jetzt `http_pickup` („HTTP-Abholung“).
- **Netzladen-Schalter sagt, wenn er nicht wirkt.** Mit PV-Anlage braucht Netzladen zusätzlich eine MiSpeL-Option
  oder „Netzladen auch ohne Pauschal-/Abgrenzungsoption“; der Schalter stand sonst auf „an“ ohne Wirkung. Ein
  Hinweis am Schalter nennt jetzt den Grund (und umgekehrt an den Freigaben, wenn der Hauptschalter fehlt).
- **Dachflächen lassen sich wieder eintragen.** Die Eingabe der PV-Dachflächen erschien nur bei
  `forecast.pv.configLevel = detailed`, für das es kein Feld gab. Sie steht jetzt immer unter Meine Anlage und
  weist darauf hin, dass ohne Fläche alle Prognosen mit 35° nach Süden rechnen; wer eine Fläche anlegt, schaltet
  die Prognose damit auf die Flächen um.
- **Strompreis: welcher Satz gilt heute?** Der Standard-Tarif hieß „immer gültig“, obwohl ein Preis-Zeitraum ihn
  vollständig ersetzt. Die Überschrift sagt jetzt „gilt an Tagen ohne eigenen Zeitraum“, und ein Hinweis nennt den
  heute gültigen Zeitraum bzw. den nächsten.
- **Anlagenadresse bei Universal (HA/Loxone) ausgeblendet.** Das Profil hat keine Geräteverbindung; das Feld war
  wirkungslos und lud zu Tippfehlern ein.
- **MiSpeL-Wirtschaftlichkeit folgt der Option ohne Neustart.** Die Umstellung der Option wirkte im Planer erst
  nach einem Neustart.

- **Loxone: Sollwerte stehen jetzt oben in der Antwort.** `GET /api/integration/loxone` gibt Zeitstempel und
  `dvhub_control_*` zuerst aus, JSON-Blöcke am Ende. Vorher stand allein `userEnergyPricing` mit über 40 KB vor den
  Sollwerten — Loxone liest große Antworten womöglich nicht bis dorthin. Alle Schlüssel bleiben erhalten.
- **EOS plante mit 10 kW Wechselrichterleistung, egal wie groß die Anlage ist.** Für die
  Wechselrichter-Nennleistung gab es kein Eingabefeld; eine Änderung direkt in EOS überschrieb DVhub
  beim nächsten Abgleich wieder. Jetzt gibt es unter „Akku-Grenzen“ das Feld
  „Wechselrichter-Nennleistung (W)“, leer gelten 10.000 W. Der Wert gilt überall gleich: in EOS, in
  der EOS-Vorschau, beim Begrenzen der Einspeisung im Zeitplan und bei der Null-Einspeisung. Vorher
  rechneten einige Stellen ohne Eintrag mit 29 kW, andere mit 10 oder 24 kW. Die kWp aus der
  MiSpeL-Pauschaloption verstellen die EOS-Planung nicht mehr. Die Null-Einspeisung rechnete
  außerdem immer mit 10 kW statt mit dem eingetragenen Wert.
- **Installateurs-Portal: Karteileichen und „verbunden“ ohne Verbindung.** Die Karte zeigte jede
  gekoppelte Anlage als „verbunden“, auch wenn sie sich seit Wochen nicht meldete. Jetzt steht dort
  „offline · zuletzt vor …“ nach 5 Minuten ohne Meldung und „verwaist“ nach 30 Tagen. Trennt der
  Kunde, während das Portal nicht erreichbar ist, holt die Anlage die Abmeldung nach, statt einen
  Eintrag zurückzulassen. Eine eigene Anlage, die ihre Kopplung verloren hat, lässt sich neu koppeln,
  ohne Name, Kunde und Ertragsverlauf zu verlieren. Doppelte Kommandos (Doppelklick auf „Tunnel
  schließen“) werden zusammengefasst, und Schließen verwirft ein noch nicht abgeholtes Öffnen.
- **Fern-Support ließ sich ohne aktive Lizenz nicht aus dem Portal schließen.** Lief die Lizenz bei
  offenem Tunnel ab, lehnte die Anlage auch „Tunnel schließen“ ab. Schließen geht jetzt immer, wie
  der Knopf auf der Box. Außerdem meldete die Anlage nach dem Schließen die Info-Zeile des Tunnels
  („Tunnel: Relay …, Ports …“) als Fehler ans Portal; das tut sie nicht mehr.
- **VPN-Bereich zeigte nie, ob der Direktvermarkter abfragt.** Das Feld für die letzte
  Modbus-Aktivität blieb immer leer, ein funktionierender Zugang sah tot aus. Der VPN-Status in den
  Einstellungen und in der VPN-Diagnose zeigt jetzt „Letzte Modbus-Abfrage: vor … von …“. Lauscht
  DVhub nicht auf Port 502, weist er darauf hin, dass Direktvermarkter wie LUOX meist 502 abfragen.
- **Open-Meteo-PV-Prognose lag auf manchen Boxen 2 Stunden zu spät.** DVhub holte die Wetterdaten
  in Ortszeit ohne Zeitzonen-Angabe. Läuft die Datenbank in UTC (z. B. Ubuntu-Server oder
  Container), wurden sie um die Zeitverschiebung zu spät gespeichert, die Prognose sagte die
  Erzeugung bis nach Sonnenuntergang voraus und zog die Mischprognose mit. Jetzt holt DVhub
  eindeutige UTC-Zeitpunkte. Künftige Stunden korrigiert der nächste Abruf, ältere Werte bleiben
  verschoben.
- **EOS durfte den Akku bis 0 % planen, wenn das Gerät keinen Mindest-Ladestand meldet.** Profile
  ohne Live-Mindest-SoC (z. B. die Universal-MQTT-Anbindung) liefern keinen Wert; DVhub schickte EOS
  dann 0 % statt der eingestellten „Untergrenze Sicherheit“, und der Plan entlud bis 3 %. Jetzt
  bekommt EOS den höheren aus Live-Wert und Untergrenze, ohne beide 5 %. Gilt auch für „Mit
  DVhub-Werten synchronisieren“. Die Hilfetexte zu Entladeleistung und Wechselrichter-Nennleistung
  erklären, wie EOS die volle Nennleistung einspeist.
- **Kurze Messfehler-Sprünge lösten die Lizenz-Prüfung aus.** Für den Abgleich mit dem Tarif nahm
  DVhub das rohe Tagesmaximum der PV-Leistung. Springt der PV-Wert für einige Sekunden um 20 kW (so
  bei einer Loxone-Anbindung), lag die Anlage gemessen weit über ihrem Tarif. Jetzt zählt je
  5-Minuten-Fenster das 75-%-Perzentil: Sprünge bis gut eine Minute fallen heraus, eine dauerhaft
  größere Anlage zählt weiter voll. Auf einer Anlage ohne Messfehler liegt der Wert etwa 7 % unter
  dem bisherigen.
- **Lizenz-Hinweis bei falsch zugeordneter PV-Messung irreführend.** Misst DVhub deutlich mehr
  PV-Leistung, als eingetragen ist (über das 1,3-Fache der kWp), nennt der Hinweis in der
  Lizenz-Sektion jetzt beide möglichen Ursachen: die PV-Messung ist falsch zugeordnet (meist), oder
  die eingetragene Leistung ist zu niedrig. Vorher stand dort nur „mehr als Ihr Tarif abdeckt“. Die
  Kulanzfrist läuft unverändert, denn eine zu niedrig eingetragene Anlage sieht in den Messwerten
  genauso aus.
- **Lastprognose im Kaltstart war nicht zu erkennen.** Solange weniger als 7 Stunden mit gemessenem
  Hausverbrauch vorliegen, rechnet die Prognose mit einer Konstanten (Standard 800 W), in EOS also
  200 Wh je Viertelstunde. Die Kachel „Erwarteter Verbrauch“ im Leitstand zeigt jetzt „Lernt noch –
  vorläufig konstant 800 W“ und wie viele Stunden schon gemessen sind. Bleibt das länger als einen
  Tag so, kommt kein Verbrauchswert an, und die Kachel sagt das. Der alte Hinweis „Flat 800W“
  verschwand, sobald die Nachtkorrektur einzelne Werte änderte.
- **EOS-„Akku halten“ fiel jede Viertelstunde für einige Minuten aus.** Die Plan-Regeln von EOS
  standen in der Konfiguration. Beim Speichern zur Viertelstunde gingen ihre Kennzeichen verloren
  (`optimizer`, `closedLoopHold` u. a.), die Bereinigung hielt sie dann für verbotenes Netzladen und
  löschte sie bis zum nächsten Plan. Jetzt leben Plan-Regeln nur im Speicher; für einen Neustart
  liegen sie vollständig in `optimizer-rules.json` im Datenverzeichnis und werden beim Start sofort
  wieder eingesetzt, bis der nächste Lauf neu plant. In der Konfiguration stehen nur noch Regeln,
  die jemand selbst eingestellt hat. Nebenbei entfällt das Speichern der Konfiguration zu jeder
  Viertelstunde samt Sicherungskopie.
- **Support-Tunnel überlebt einen Neustart von DVhub.** Er läuft jetzt als eigener Dienst
  (`dvhub-support-tunnel.service`) statt als Kindprozess von DVhub; vorher riss jeder
  `systemctl restart dvhub` die Verbindung des Supports ab. Im Docker-Container bleibt es beim
  Kindprozess.
- **Portal: Geräteschlüssel besser geschützt.** Das Portal speichert die Schlüssel der Anlagen nur
  noch als Prüfwert, vergleicht sie in konstanter Zeit und legt seine Dateien nur für sich lesbar ab
  (0600). Hinter dem Proxy zählt die Begrenzung der Kopplungsversuche je Absender statt für alle
  gemeinsam. Auf der Anlage ist die Kopplungsdatei mit dem Schlüssel ebenfalls nur für DVhub lesbar.
- **Support-Bundle ohne Token im Heimnetz.** Der Knopf unter Tools antwortete mit „unauthorized",
  weil das Bundle als eine von drei Stellen immer den API-Token verlangte — den hat im Browser kein
  Kunde. Support-Bundle, Datenbank-Wiederherstellung und TimescaleDB-Upgrade folgen jetzt der
  normalen Heimnetz-Regel: im Heimnetz ohne Token, von außen und in den strengeren Stufen mit.
- **Heimnetz auch über IPv6.** Wer DVhub über IPv6 erreichte (z. B. per Namen hinter einer
  Fritzbox), galt als „nicht im Heimnetz" und bekam überall „unauthorized". Als Heimnetz zählen
  jetzt auch die lokalen IPv6-Adressen (`fe80::`, `fd00::`) und das Präfix, das der Router der
  Anlage zugeteilt hat. Mit eigenen Netzen unter „Als Heimnetz zählende Netze" gilt weiter nur die
  Liste.
- **Dateiname des Support-Bundles** trägt wieder die Versionsnummer statt „objectObject".
- **Fremde Webseiten können der Anlage nichts befehlen.** Da im Heimnetz kein Token nötig ist, prüft
  DVhub bei schreibenden Aufrufen aus dem Browser, ob sie von der eigenen Oberfläche kommen. Eine
  fremde Seite, die jemand zu Hause öffnet, wird abgewiesen. Vorher griff das nur mit gefüllter
  Liste „corsAllowedOrigins". Für die Bedienung ändert sich nichts; Skripte und Home Assistant
  sind nicht betroffen.
- **EOS antwortet zwischen den Läufen wieder.** DVhub schrieb den Ladestand jede Minute in EOS'
  Messwertspeicher. EOS kürzt diesen Speicher nie und verarbeitet bei jedem Schreiben die ganze
  Reihe — nach einigen Tagen war der EOS-Prozess damit dauerhaft ausgelastet, Plan und Status
  kamen nur noch mit Zeitüberschreitung (eHive, 11.10.2026). Der Ladestand wird nicht mehr als
  Messwert geschrieben; nur der Zähler planbarer Geräte bleibt, alle 15 Minuten.
- **Prognosedaten zeigen den EOS-Fahrplan auch, während EOS rechnet.** Die Seite Einstellungen →
  Prognosedaten fragte EOS bei jedem Aufruf selbst — alle 30 Sekunden schickte sie sämtliche
  Prognosen hin und holte Plan und Lösung mit 5 Sekunden Frist. Rechnete EOS gerade oder war es
  ausgelastet, blieb der Fahrplan leer, obwohl DVhub ihn längst übernommen hatte, und die Abrufe
  bremsten EOS zusätzlich. Jetzt liest die Seite aus DVhubs zentraler Ablage: den zuletzt
  übernommenen Plan, die zuletzt abgeholte Lösung und das Ergebnis der letzten echten
  Übertragung, jeweils mit Uhrzeit. An EOS geht dafür kein Aufruf mehr.
- **EOS: Wirkungsgradkurve bei fast leerem Akku (DV-EOS rc1.19).** Kann der Akku in einem
  Zeitschritt weniger liefern als angefragt — fast leer oder an der Leistungsgrenze —, rechnete
  EOS die Umwandlung in Wechselstrom mit dem Wirkungsgrad der angefragten, höheren Last. Bei einer
  hinterlegten Wechselrichter-Kurve kam so etwas mehr Strom heraus, als der Wechselrichter bei der
  kleinen Last wirklich liefert. Jetzt gilt der Wirkungsgrad bei der tatsächlich gelieferten
  Leistung. Ohne Kurve und in allen Schritten mit voller Lieferung ändert sich nichts. Derselbe
  Fix liegt upstream in Akkudoktor-EOS #1375.
- **Nach jedem Update blieb eine lokale Änderung zurück.** `package-lock.json` nannte für DVhub
  noch Node ≥ 18, `package.json` verlangt ≥ 22. `npm install` schrieb die Datei deshalb auf der
  Anlage um; der nächste Update-Lauf musste sie erst beiseitelegen. Beide stimmen jetzt überein.

## [1.0.7] - 2026-10-08

Sammel-Release nach fünf Wochen, 220 Commits seit 1.0.6. Überblick nach Themen — die Einzelheiten
stehen in den Einträgen darunter:

- **E-Auto und Wallbox:** Wallbox nach EOS-Plan steuern über evcc, OpenEVSE oder go-e; Abfahrtszeit
  und Ladeziel; „Sofort laden“; Anstecken direkt an der Wallbox erkannt; Ladestand aus TeslaMate,
  evcc oder einem MQTT-Topic; §14a begrenzt die Wallbox; Heizstab und planbare Verbraucher.
- **EOS 0.4:** nur noch EOS 0.4 (DV-EOS `dvhub-v0.4.0rc1.18`), Läufe in fünf Schritten deutlich
  schneller bei identischem Ergebnis (Raspberry Pi 4: 136 s statt 333 s), zwei Kerne, Start zur
  Viertelstunde, sofortige Neuberechnung bei geänderter Grundlage, gemessener
  Wechselrichter-Wirkungsgrad, Netzladen, Betriebsart „Nur Netzspeicher“, Kleine Börsenautomatik
  als Rückfallebene.
- **MQTT, Home Assistant, Loxone:** Sollwerte und EOS-Plan nach außen, Profil „Universal“ für
  Messwerte aus Home Assistant/Loxone (MQTT oder HTTP-Push), MQTT-Hub steuern und debuggen,
  MQTT-Explorer hört nur bei Bedarf mit.
- **Netz und Direktvermarktung:** EEBUS-Steuerbox nach §14a (wirkt auf Speicher, Wallbox und
  Einspeisebegrenzer; Weitergabe an EEBUS-Geräte nur gegen Referenzprogramme geprüft), §14a nach BNetzA-Festlegung,
  Direktvermarkter-Schnittstelle Plexlog oder LUOX/Lumenaza, Börsenerlös je Einspeisequelle.
- **Geschwindigkeit und kleine Geräte:** Historie Jahr/Alle aus Monatsständen, weniger
  Arbeitsspeicher (jemalloc), Schonung von SD-Karte und eMMC, gestufte Log-Aufbewahrung.
- **Docker:** offizielle Images für amd64 und arm64 (`bikinibottomcapital/dvhub`,
  `bikinibottomcapital/dvhub-eos`), Container-Suite mit TimescaleDB und EOS in ≤ 704 MB.
- **Oberfläche:** Einstellungen nach Aufgabe gegliedert, Integrationen mit Liste und Mittelteil,
  Historie mit Tag/Monat/Jahr, Leitstand und Familien-Dashboard überarbeitet, eine Zeitzone für alles.
- **Betrieb:** Meldung bei verweigerter Entladung, Datenspende, Installateurs-Portal,
  Ortsnetz-Auslastung, voller Export für den Geräte-Tausch, Prüfung der Systemuhr.

### Neu

- **Meldung, wenn der Speicher trotz Sollwert nicht entlädt.** Am 07.10. gab ein Wechselrichter ab
  dem Nachmittag nichts mehr aus dem Akku ab, obwohl DVhub den Sollwert korrekt schrieb — der
  Abendverkauf fiel aus und niemand bekam es mit. Ein Wächter erkennt jetzt Netzbezug über dem
  Sollwert bei stehendem, gefülltem Akku und meldet es nach zehn Minuten per Push (Pushover,
  Telegram, ntfy) und im Protokoll (`setpoint_not_followed`, Entwarnung `setpoint_followed_again`);
  solange es anhält, erinnert er alle drei Stunden. Er meldet nur und steuert nichts. Gegen 22 Tage
  Messdaten geprüft: kein Fehlalarm. Abschaltbar über `victron.setpointWatchdog.enabled`.
- **Familien-Dashboard im Bild des Leitstands, Tablets richtig skaliert.** Farben, Karten und
  Beschriftungen wie im Leitstand (Netz pink, ein Glas, gesperrte Kartenköpfe), Zahlen mit
  Dezimalkomma, Systemschrift statt nachgeladener Google Fonts. Auf Touch-Geräten skaliert der
  Browser die Seite selbst: ein iPad 10,2" zeigt damit so viel wie ein großer Bildschirm
  (Voreinstellung automatisch, pro Gerät über die Uhr einstellbar). Vorher ließ der Zoom beim
  Verkleinern unten einen schwarzen Streifen und verschob die Flusslinien.
- **Beschriftungen der Preis-Einstellungen aus einer Quelle.** Die handgebauten Editoren holen ihre
  Beschriftungen samt Einheiten aus der zentralen Felddefinition (Beitrag von @elschman, #22, #21).

### Behoben

- **Zugangsdaten für Push-Dienste gingen als „***" verloren.** Die Oberfläche bekommt Geheimnisse
  nur maskiert. Gab es beim Speichern keinen echten Wert zum Zurückholen, blieb der Platzhalter als
  Wert in der Config stehen: die Oberfläche zeigte „gesetzt", jeder Versand scheiterte. Der
  Platzhalter wird jetzt nie mehr gespeichert, leere Felder gelten nicht als gesetzt, und schon
  gespeicherte Platzhalter werden beim Laden entfernt (die Zugangsdaten müssen dann einmal neu
  eingetragen werden).
- **Jahr im Datumsfeld nicht tippbar (#18).** Datumsfelder der PV-Anlagen, Akku-Stufen und
  Preiszeiträume wurden schon nach der ersten Ziffer des Jahres übernommen und neu gezeichnet
  („0002"). Sie werden jetzt erst beim Verlassen oder mit Enter übernommen.
- **„Version wird geprüft…" blieb stehen (#19).** In den Einstellungen wurde die Update-Prüfung nie
  von selbst ausgelöst. Sie startet jetzt, sobald die Software-Karte sichtbar wird.
- **Leitstand aufgeräumt.** Steuerungs-Karte einspaltig mit den Standardwerten nebeneinander,
  E-Auto-Karte ohne leere Fläche, Seitenname neben dem Logo nur noch bei eingeklapptem Menü,
  Zeitstempel von heute nur als Uhrzeit, Klartext statt Fehlercode beim EOS-Fahrplan; am Handy
  brechen Kartenköpfe sauber um und die Zeitachse im Preis-Diagramm ist lesbar.

### Entfernt

- **ML-Prognose-Korrektur (LightGBM) komplett entfernt.** Die Korrektur war seit Mai abgeschaltet
  und hatte keine Oberfläche mehr, lief im Hintergrund aber weiter mit: Der Standardwert
  `ml.mlEnabled` stand auf „an“, DVhub startete deshalb bei jedem Start einen dauerhaften
  Python-Prozess (`ml_server.py`). Fehlten der Python-Umgebung Pakete, stürzte er sofort ab, und das
  Protokoll lief danach mit `python_heartbeat_fail` / `python_heartbeat_kill` voll (im Feld: 225 von
  381 Einträgen in knapp drei Stunden). Entfallen sind der ML-Dienst samt Training, der dauerhafte
  Python-Prozess mit Heartbeat, die Endpunkte `/api/ml/*` und `/api/forecast/inspector/ml-correction`,
  der ausgeblendete Einstellungs-Tab „Machine Learning“, die Kurve „ML-korrigiert“ und das ML-Abzeichen
  im Leitstand sowie die Python-Pakete `lightgbm`, `scikit-learn` und `joblib`. PV-Prognose (pvlib,
  Anbieter-Ensemble) und Lastprognose (StatsForecast) arbeiten unverändert. In `/api/forecast`
  entfallen `meta.mlActive`, `meta.mlModel` und `meta.mlSanityFallback`; `rawPv` bleibt und ist
  gleich `pv`. Bestehende Konfigurationen laden weiter, die alten `ml.*`-Schlüssel der Korrektur
  werden ignoriert.
- **Update räumt die Python-Umgebung auf.** Pakete, die ein früheres Lockfile installiert hat und
  die das aktuelle nicht mehr enthält, werden beim nächsten Update aus `/opt/dvhub/forecast-venv`
  deinstalliert (bisher blieb alles liegen). Die Umgebung gehört allein DVhub; EOS hat seine eigene.
  Das Verzeichnis `/opt/dvhub/ml-models` wird nur entfernt, wenn es leer ist.

### Behoben

- **Familienseite ohne Hintergrundbild.** Die Seite lud `/assets/family-scene.png`, das im Paket nie
  enthalten war (404) — zu sehen war nur ein dunkler Verlauf. Sie zeigt jetzt dieselben Bilder wie
  der Energiefluss im Leitstand: nachts das Nachtbild, zwischen Sonnenauf- und -untergang am
  Anlagenstandort das Tagbild, weich übergeblendet.
- **Prognose-Python ohne Pakete blieb unbemerkt.** Scheiterte die Paket-Installation (im Feld auf
  einer Anlage seit Wochen: `ModuleNotFoundError: No module named 'pvlib'`), blieb eine Python-Umgebung
  ohne Pakete zurück. DVhub prüfte nur, ob der Interpreter existiert, meldete „Python vorhanden“ und
  ließ jedes Prognose-Skript in den Fehler laufen; die Installation wurde bei jedem Dienststart neu
  versucht. Jetzt: `forecast-provision.sh` prüft die Python-Version vorab (das Lockfile braucht
  Python ≥ 3.11 — Ubuntu 22.04 bringt 3.10 mit und kann die Pakete nicht installieren), probiert
  nach der Installation den Import, schreibt den Grund eines Fehlschlags nach
  `forecast-venv-status.json` im Datenverzeichnis und versucht denselben Fehlschlag frühestens nach
  24 Stunden erneut (`--force` sofort). DVhub prüft Interpreter **und** Pakete, startet ohne sie kein
  Skript mehr und meldet stattdessen `python_env_incomplete` mit den fehlenden Modulen und dem Grund
  (höchstens stündlich). Wird die Installation später fertig, greift die Python-Prognose ohne
  Neustart. PV- und Lastprognose laufen in der Zwischenzeit wie bisher über die Ersatzwege.
- **Historie am Handy breiter als der Bildschirm.** Die Inhaltsspalte war 430 statt 390 px breit;
  rechts fehlte bei allen Kacheln ein Streifen (Werte abgeschnitten).
- **Ohne EOS-Plan wird gewartet statt ersatzweise verkauft.** Lieferte EOS keinen Plan und war
  auch kein gemerkter mehr gültig, sprang bisher die eingebaute Schwellenregel ein: sie setzt in
  jeder Viertelstunde über 130 % des Durchschnittspreises „Akku ins Netz“ mit voller Leistung
  und kennt keine Reserve für die Nacht. In der Betriebsart „EOS“ gibt es diesen Ersatz nicht
  mehr. Stattdessen springt die **Kleine Börsenautomatik als Rückfallebene** ein: sie plant mit
  ihrem Suchfenster und lässt die eingestellte Reserve stehen, bis EOS wieder liefert; dann
  räumt sie ihre Regeln weg. Abschaltbar unter Betriebsart → EOS-Optimierung („Ohne EOS-Plan:
  Kleine Börsenautomatik als Ersatz“) — dann gelten ohne Plan nur die Regeln von Hand.
  Protokoll: `eos_plan_waiting`, `eos_plan_back`.
- **„Sofort laden 11 kW“ blieb bei 4,2 kW.** An der OpenEVSE hielt ein zweiter Regler einen
  eigenen Auftrag mit 6 A; bei gleicher Priorität gewinnt der ältere, DVhubs Auftrag blieb
  wirkungslos. DVhub liest die Aufträge der Box jetzt mit und sagt es deutlich: im
  Wallbox-Status („Ein anderer Regler hält … 6 A“) und im Protokoll. Außerdem meinen
  Nennleistungen jetzt ganze Ampere: 11 kW an 3 × 230 V sind rechnerisch 15,94 A und ergeben
  16 A statt wie bisher abgeschnitten 15 A (10,35 kW).
- **§14a begrenzt die Wallbox auch ohne EOS-Steuerung.** Eine direkt angebundene Wallbox
  (OpenEVSE, go-e) zählte nur dann als steuerbare Verbrauchseinrichtung, wenn „E-Auto in EOS
  mitoptimieren“ und die Wallbox-Steuerung an waren. Jetzt zählt sie, sobald sie eingerichtet
  ist: bei einer Begrenzung des Netzbetreibers deckelt DVhub sie auf ihren Anteil (oder stoppt,
  wenn der unter dem Mindeststrom liegt) und gibt sie danach wieder frei.
- **„EOS deaktiviert“, obwohl EOS lief.** Die Ansicht Prognose-Daten meldete „EOS-Service
  deaktiviert oder nicht erreichbar“, sobald EOS während einer Rechnung nicht antwortete.
  Jetzt unterscheidet sie: „eingeschaltet, antwortet gerade nicht — DVhub fährt den letzten Plan
  weiter“ gegenüber „ausgeschaltet“ (mit Weg zum Betriebsart-Schalter).
- **Leitstand: Prognose-Zeile lief aus der Karte.** Die Aufschlüsselung neben PV-Tagesprognose,
  erwartetem Verbrauch und Überschuss stand in einer Zeile und ragte bei fast jeder
  Bildschirmbreite (1024 bis 1600 px und am Handy) bis zu 200 px über den Kartenrand. Sie steht
  jetzt unter dem Wert und bricht um.
- **Status, Prognose-Daten, EOS-Daten und VPN im selben Bild wie die übrigen Einstellungen.** Über
  dem ersten Buchstaben jeder Kartenüberschrift lag ein Farbpunkt, der Inhalt war 24 px tiefer
  eingerückt als die Überschrift, Schalter waren zu breiten Balken gezogen, Ankreuzlisten
  erschienen als Striche, und Karten wurden paarweise auf gleiche Höhe gestreckt (große leere
  Flächen). Jetzt: eine gemeinsame Kante mit Trennlinie unter der Überschrift, Schalter in fester
  Größe, Bezeichnung und Feld in festen Spalten, Prüfkacheln mit Bezeichnung über dem Wert,
  Datei-Auswahl im Knopf-Stil. Der leere Zustand der Installateur-Liste nahm 220 px ein und
  stand in Festbreitenschrift.
- **Speichern der Einstellungen schreibt nur noch, was geändert wurde.** Ein leeres Feld, für das
  nie etwas gespeichert war, wurde beim Speichern als „leer“ in die Konfiguration geschrieben —
  bei manchen Feldern ist das etwas anderes als der Standard (0 statt 100 W Puffer, leere statt
  der üblichen Freigabe-Liste). Solche Felder bleiben jetzt ungesetzt, der Standard gilt weiter.
  Der Zähler „Felder geändert“ zählte sie mit (33 nach einem einzigen Klick) und stimmt nun.
  Einstellungsseite, Status und VPN laufen auf Handy und Tablet nicht mehr seitlich aus dem Bild.
- **Kleine Börsenautomatik: Reserve 0 % ließ sich im Leitstand nicht speichern** — die Karte
  machte daraus 30 %. Das Feld „Aggressiver Preisaufschlag (%)“ ist aus den Einstellungen
  entfernt: es hatte nie eine Wirkung.
- **Eine Zeitzone für alles.** Die Einstellung „Zeitzone“ (System → Zeitzone & Regeltakt) gilt
  jetzt überall. Bisher rechneten etliche Stellen mit der Zeitzone des Betriebssystems —
  Tagesgrenzen beim Abruf der Börsenpreise, die Mehrtages-Logik, das Familien-Dashboard,
  Ruhezeiten der Benachrichtigungen, die Backup-Uhrzeit. Stand das System auf UTC (frisch
  aufgesetztes Linux), lagen sie im Sommer zwei Stunden daneben, obwohl die Einstellung
  stimmte. DVhub stellt die Uhr des Prozesses nun selbst auf die eingestellte Zeitzone. Das
  getrennte Feld „EPEX Zeitzone“ entfällt, Börsenpreise und EOS folgen derselben Einstellung.
- **EOS-Plan übersteht einen Neustart von DVhub.** DVhub fährt den letzten EOS-Plan weiter,
  wenn EOS gerade nichts liefert — gemerkt war er aber nur im Arbeitsspeicher. Nach einem
  Neustart (Update) war er vergessen, und solange EOS mitten in einer Rechnung nicht antwortete,
  übernahm der interne Optimierer (eHive am 06.10.: 20 Minuten). Der Plan liegt jetzt zusätzlich
  im Datenverzeichnis und gilt nach dem Neustart weiter, bis EOS den nächsten liefert.
- **Geräte-Tausch nimmt Datenspende, Fernzugang und Ortsnetz eins zu eins mit.** Beim Umzug auf
  eine neue Box (Voll-Backup mit Passwort, Antwort „Geräte-Tausch“) blieben die Schalter für
  Datenspende und Installateur-Fernzugang bisher auf dem Stand der neuen Box, also aus — obwohl
  die Kopplungs-Dateien mit umgezogen sind. Jetzt kommen sie aus der Sicherung. Wer nur
  Einstellungen kopiert, behält wie bisher die Schalter der Zielbox. Außerdem ändert das
  Speichern der Einstellungsseite den Ortsnetz-Schalter nicht mehr: ein älterer Entwurf der
  Seite konnte ihn zurückschalten.
- **PV-Strings: Einstellungen erscheinen sofort.** Auf kleinen Boards blieb die Liste der
  Strings 45–50 Sekunden leer und sah aus, als seien keine Strings eingerichtet (eHive). DVhub
  hat für die Tageserträge bei jedem der rund 64 000 Messwerte einen neuen
  Zeitzonen-Formatierer gebaut; jetzt gibt es einen je Zeitzone, und der Kalendertag wird je
  Viertelstunde nur einmal bestimmt. Zusätzlich wartet die Anzeige nicht mehr auf das Zählen
  der Abdeckung über die ganze Historie: das läuft einmal im Hintergrund („Abdeckung wird
  berechnet …“) und wird danach nur um die letzten drei Tage ergänzt. Abgeschlossene Tage
  der Ertragsbalken werden gemerkt, gelesen werden nur noch gestern und heute.

### Neu

- **Historie: Tag, Monat und Jahr einzeln wählbar; Kacheln im Bild der Einstellungen.** Neben dem
  Kalender stehen drei Auswahlfelder — so springt man direkt zum selben Tag im Vorjahr oder in
  einen anderen Monat. Je nach Ansicht sind nur die passenden aktiv (Monatsansicht: Monat und
  Jahr). Die Kacheln haben Überschrift mit Trennlinie und Text in der Lese-Schrift statt
  Festbreite; die Farbe je Kachel bleibt. Jede Kachel ist so hoch wie ihr Inhalt, die lange
  Energiebilanz belegt zwei Zeilen statt eine Lücke aufzureißen.
- **Planbare Verbraucher als eigene Integration.** Geschirrspüler, Heizstab und andere Geräte, die
  DVhub mitplant, standen bisher als Abschnitt unten in der Shelly-Ansicht. Jetzt gibt es dafür
  den eigenen Eintrag „Planbare Verbraucher“ in der Integrationsliste, mit eigener Kachel
  (Anzahl Geräte, zeitlich verschiebbar / stufenlos, ob EOS mitplant) und eigener
  Einstellungsansicht. Die Shelly-Ansicht zeigt nur noch die Shelly-Geräte. An den
  gespeicherten Geräten ändert sich nichts.
- **EOS rechnet sofort neu, wenn sich die Grundlage ändert.** Bisher löste nur das An- und
  Abstecken des Autos (und Änderungen an Geräten und Auto-Zielen) einen Sofort-Lauf aus. Jetzt
  auch jede gespeicherte Einstellung, die in den Plan eingeht: Akku-Grenzen, Strompreise,
  Netzladen/-entladen, Wallbox, PV-Größe, §14a. Reine Takt- und Anzeigewerte lösen keinen aus.
- **Energiefluss: Zahlen zählen statt zu springen.** Im Leitstand und auf der Familienseite laufen
  die Werte für PV, Akku, Haus, Netz und die Tagesbilanz in knapp einer Sekunde zum neuen Stand
  — auch durch die Null, wenn das Netz von Einspeisung auf Bezug dreht. Aufteilung und
  Teilchenströme laufen mit. Mit der Systemeinstellung „Bewegung reduzieren“ wird wie bisher
  direkt umgeschaltet.
- **Kleine Börsenautomatik rechnet mit dem gemessenen Wirkungsgrad.** Sobald DVhub den
  Wechselrichter vermessen hat, gilt für die Automatik derselbe Wirkungsgrad Akku → Netz wie
  für EOS (Entlade-Wirkungsgrad des Akkus × gemessene Kennlinie). Das eigene Feld der Automatik
  erscheint nur noch, solange keine Messung vorliegt.
- **Ladestand-Grenzen an einer Stelle erklärt.** „Meine Anlage → Akku-Grenzen“ zeigt jetzt beide
  allgemeinen Untergrenzen nebeneinander — „Untergrenze Sicherheit“ (bisher „Min. SoC /
  Entlade-Floor“) und „Untergrenze bei dauerhafter Handsteuerung“ (bisher „Persistenter Override
  SoC-Floor“ unter Zeitplan) — und beschreibt, wie sie mit dem Mindest-Ladestand im
  Wechselrichter und der Reserve der Kleinen Börsenautomatik zusammenhängen.
- **Integrations-Ansichten vereinheitlicht.** Eingabefelder überall gleich hoch (vorher 24 bis
  40 px), Schalter als Pillen wie in den Einstellungen, Zwischenüberschriften mit Trennlinie,
  Hinweise in einer Schrift. EEBUS und §14a verweisen in beide Richtungen: Kopplung, Geräte
  und Zustand unter Integrationen, Grenzwerte und Aufteilung unter Einstellungen → Netz & Recht.
  Die Voreinstellungen zum Fern-Support stehen jetzt bei den Freigaben statt unter System.
- **Akku-Werte der Anlage gelten für alles.** Kapazität und Entladeleistung unter „Meine Anlage →
  Akku-Grenzen“ gelten jetzt auch für die Kleine Börsenautomatik; ihre eigenen Felder dafür
  entfallen in Einstellungen und Leitstand (im Leitstand werden die Anlagenwerte angezeigt).
  Verkauft wird höchstens mit der kleineren aus Entladeleistung und Wechselrichterleistung.
  Anlagen, bei denen unter „Meine Anlage“ nichts eingetragen ist, rechnen unverändert mit den
  bisherigen Werten der Automatik.
- **Lizenzstufe für reine Netzspeicher.** In der Betriebsart „Nur Netzspeicher“ zählt die Leistung
  des Akku-Wechselrichters in kW wie kWp. Bisher fiel ein Speicher ohne PV mit 0 kWp immer in
  die kleinste Stufe. Für Anlagen mit PV bleibt die PV-Größe das Maß.
- **Integrationen im Bild der Einstellungen.** Die Liste links ist eine Navigationskarte mit
  Suche, der gewählte Eintrag sieht aus wie ein aktiver Reiter, die Karten in der Mitte haben
  Überschrift und Trennlinie wie dort. Die Farbe je Integration bleibt (Logo, Kante am gewählten
  Eintrag, Linie über der Kachel). Erfolgsmeldungen („✓ …“) sind grün statt rot.
- **Sicherheitspuffer der Prognose-Anpassung einstellbar.** Die Kleine Börsenautomatik ließ bei
  „Reserve nach Prognose anpassen“ fest 1,5 kWh zusätzlich im Akku — für einen 10-kWh-Akku
  etwas anderes als für einen mit 60 kWh. Der Wert steht jetzt im Abschnitt „Reserve“
  (Einstellungen und Leitstand), sobald die Prognose-Anpassung an ist. Standard bleibt 1,5 kWh.
- **Einstellungen: Karten offen, Status aufgeräumt, neuer Bereich „Freigaben“.** Die Karten eines
  Bereichs stehen beim ersten Öffnen aufgeklappt; nur „Erweitert“ bleibt zu. Die Sammelseite
  „Status“ ist aufgeteilt: Zugangstoken, Konfiguration sichern & einspielen, Updates, Neustart,
  Historie importieren und Diagnose-Paket stehen unter **System → Werkzeuge**;
  Installateurs-Portal, Fern-Support, Datenspende, Ortsnetz-Auslastung und der Eingang für Home
  Assistant / Loxone im neuen Bereich **Freigaben**. „Status“ zeigt nur noch den Zustand:
  Prüfungen, API, DV-Signale, Modbus, Zeitplan.
- **Standort nur noch einmal.** Der Standort unter „Meine Anlage“ gilt auch für die Kleine
  Börsenautomatik (Sonnenauf- und -untergang); ihre eigenen Standort-Felder erscheinen nur noch,
  solange der Anlagen-Standort fehlt. Wer die Kleine Börsenautomatik zum ersten Mal einschaltet,
  bekommt Akku-Kapazität und Entladeleistung aus „Meine Anlage“ vorgeschlagen statt der
  Werkswerte (30 kWh, 12 kW). Bereits gespeicherte Werte bleiben unverändert.
- **Betriebsart-Schalter mit drei Stellungen: Aus · Kleine Börsenautomatik · EOS.** Oben im
  Bereich „Betriebsart“ steht ein Schieber statt zweier unabhängiger Schalter („Optimierung
  aktiv“, „Kleine Börsenautomatik aktiv“), die sich auch widersprechen konnten. Ein Satz
  darunter sagt, was die gewählte Art tut. Die Karten der gewählten Betriebsart sind
  hervorgehoben und aufgeklappt („aktiv“), die der anderen abgeblendet („nur bei …“), aber
  weiter einsehbar. Die bisherige Karte „Optimierung“ heißt „EOS-Optimierung“ und enthält nur
  noch EOS-Werte. Die Stellung „EOS“ schaltet die Optimierung ein und wählt EOS als Planer.
  Im Leitstand lässt sich die Kleine Börsenautomatik nicht mehr zusätzlich einschalten, solange
  die Optimierung läuft; der Hinweis dort führt zum Schalter.
- **Einstellungen nach Aufgabe gegliedert.** Statt der Reiter Anlage / Steuerung / Preise (allein
  „Steuerung“ hatte 69 Felder in 15 Gruppen) gibt es sieben Bereiche: **Meine Anlage ·
  Strompreise · Betriebsart · Geräte · Netz & Recht · Prognosen · System**. Jeder Bereich zeigt
  zuerst das Nötige; selten gebrauchte Feineinstellungen und Beta-Funktionen liegen eingeklappt
  unter „Erweitert“. Neu ist die **Suche** oben in der Seitenleiste: Stichwort eingeben, Treffer
  anklicken, die Seite springt zum Feld und hebt es hervor. §14a, EEBUS, Nulleinspeisung und die
  Zugangs-Einstellungen sind jetzt auch auf der Einstellungsseite erreichbar (bisher nur über
  Einrichtung bzw. Integrationen). Status, Prognose-Daten, EOS-Daten und VPN stehen darunter
  als „Diagnose & Dienste“. An den gespeicherten Werten ändert sich nichts; alte Sprungmarken
  führen auf den passenden neuen Bereich.
- **Kleine Börsenautomatik: klare Gliederung, Reserve auf einen Blick.** In den Einstellungen
  stand alles in einem Block mit 15 Feldern; wo die Reserve über Nacht eingestellt wird und ob
  die Automatik sie verkauft, war nicht zu erkennen. Jetzt fünf Abschnitte: Ein/Aus &
  Zeitfenster · **Reserve (wird nicht verkauft)** · Akku & Leistung · Standort · Erweitert. Die
  Reserve heißt „Reserve am Abend (% Ladestand)“ statt „Automatik Minimum-SOC“, der
  Prognose-Schalter „Reserve nach Prognose anpassen“; beide Texte sagen, was verkauft
  wird und was stehen bleibt. Die Karte im Leitstand hat dieselben Abschnitte, den
  Prognose-Schalter (bisher nur in den Einstellungen) und einen Satz in Klartext: bis zu welchem
  Ladestand verkauft wird, wohin die Grenze über Nacht sinkt und was der letzte Plan daraus
  gemacht hat.
- **Einstellungen unterscheiden „Optimierung an“ und „aus“.** Ist die Optimierung (EOS) aktiv,
  plant sie Verkauf und Reserve selbst — von der Kleinen Börsenautomatik steht dann zunächst
  nur der Ein/Aus-Schalter da. Wer sie einschaltet, bekommt sofort alle ihre Abschnitte zum
  Einstellen; ausgeblendete Werte bleiben gespeichert. Ist die Optimierung aus, erscheinen die
  Abschnitte immer. Im Leitstand steht derselbe Hinweis.
- **Betriebsart „Nur Netzspeicher“ (Graustrom-Arbitrage).** Für einen Speicher ohne PV-Anlage
  und ohne Hausverbrauch hinter einem einzigen Zähler, der nur aus dem Netz lädt und nur ins
  Netz einspeist (Einstellungen → Netz & Recht → Rechtliche Schalter). EOS bekommt dann PV = 0 als
  Reihe — ohne PV-Reihe rechnet EOS nicht — und als Verbrauch nur den Ruhebedarf der Anlage.
  Den Ruhebedarf nimmt DVhub aus dem Netzzähler in den Minuten, in denen der Akku ruht (Median,
  bis genug Werte da sind 100 W); ein fester Wert lässt sich eintragen. Netzladen hängt in
  dieser Betriebsart allein am Schalter „Netzladen erlaubt“, ohne MiSpeL-Bedingung.
- **EOS-Netzladen wird ausgeführt.** Plant EOS das Laden aus dem Netz, stellt DVhub den
  geplanten Netzbezug jetzt als Sollwert (im Plan: „Akku lädt aus dem Netz“). Bisher wurde ein
  solcher Slot nie gestellt. Voraussetzung ist dieselbe wie für die Planung: „Netzladen
  erlaubt“, bei Anlagen mit PV zusätzlich die MiSpeL-Pauschal- oder Abgrenzungsoption. Eine
  §14a-Begrenzung des Netzbetreibers kappt den Bezug wie bisher an der Ausführung. Anlagen
  ohne diese Erlaubnis verhalten sich unverändert.
- **Integrationen: Liste links, Einstellungen in der Mitte.** Für die inzwischen 15 Integrationen
  war das Kachelraster zu eng. Auf breiten Bildschirmen (ab 1000 px) steht links eine kompakte
  Liste mit Status, in der Mitte die Kachel der gewählten Integration und direkt darunter ihre
  Einstellungen — das, was bisher rechts als Seitenleiste aufging. Die Auswahl steht in der
  Adresse (`#schlüssel`) und bleibt beim Neuladen erhalten; die MQTT-Kacheln sind ein eigener
  Eintrag in der Liste. Auf dem Handy bleibt es bei Kacheln mit Seitenleiste. Im
  Wallbox-Bereich erscheint „Bei Stopp“ nur noch mit evcc.
- **E-Auto: Einstellungen je Wallbox-Typ, Ladestand aus wählbarer Quelle.** Die evcc-Felder
  („evcc-Ladepunkt“, „evcc-Modus bei Stopp“) erscheinen nur noch, wenn unter Integrationen evcc
  als Wallbox gewählt ist; der Schalter heißt jetzt „Wallbox nach EOS-Plan steuern“ und gilt
  für evcc, OpenEVSE und go-e. Neu: „Ladestand des Autos von“ — automatisch (TeslaMate, sonst
  evcc, sonst MQTT), TeslaMate, evcc oder ein frei wählbares MQTT-Topic. Über MQTT lässt sich
  jede Marke anbinden, z. B. aus Home Assistant; das Topic darf eine Zahl oder ein JSON-Objekt
  mit Feldname liefern. Optional ein zweites Topic für „angesteckt“, falls weder Wallbox noch
  evcc das melden. Bisher gab es ohne Tesla und ohne evcc keinen Ladestand, und EOS konnte das
  Auto dann nicht planen.
- **EOS-Läufe weitere 5–9 % schneller bei identischem Ergebnis (DV-EOS rc1.18).** Vier
  Kleinteile rund um die Simulation, einzeln und zusammen gemessen (Mac, 36 h, 1–3 Kerne, mit
  und ohne Auto): Steuergrößen je Slot aus einer Nachschlagetabelle (2–3 %), Auto-Korrektur
  erst nach der Prüfung, ob das Auto irgendwo voll ist (4–5 % mit Auto), weniger Aufrufe je
  Slot (1–2 %), restliche Grenzwerte der Slot-Verarbeitung als Bedingungen (rund 1 %). Überall
  dieselbe Bilanz. Raspberry Pi 4: 136 s statt 145 s (2 Kerne), 107 s statt 116 s (3 Kerne) —
  seit rc1.11 insgesamt 136 s statt 333 s.
- **EOS-Läufe weitere 10–16 % schneller bei identischem Ergebnis (DV-EOS rc1.17).** Drei
  Stellen, jede einzeln gemessen (Mac, 36 h, 1–3 Kerne, mit und ohne Auto): der Restwert des
  Speichers wird je Kandidat nur noch als Betrag berechnet, der Bericht dazu nur für die
  fertige Lösung (5–8 %); Gerätestarts und Lastkurven werden je Kombination einmal berechnet
  (2–4 %); das Entladen eines Slots wird in einem Zug gerechnet (2–3 %). Überall dieselbe
  Bilanz, beide Referenz-Eingaben aus dem EOS-Repo Byte für Byte gleich. Raspberry Pi 4:
  145 s statt 174 s (2 Kerne), 116 s statt 134 s (3 Kerne); eHive ohne Lüfter (gedrosselt,
  ohne Geräte): 384–416 s statt 447–504 s.
- **EOS-Läufe weitere 11–20 % schneller bei identischem Ergebnis (DV-EOS rc1.16).** Sechs
  Stellen im Rechenkern, jede einzeln gemessen (Mac, 36 h Steuerhorizont, 1–3 Kerne, mit und
  ohne Auto): Entlade-Freigabe zuerst prüfen und Entlade-Buchführung in einfachen Zahlen
  (7–9 %), Lade-Buchführung in einfachen Zahlen und vorsortierte Ladestufen (3–5 %),
  Gerätelasten einmal je Kandidat summieren (3–5 %), Verschiebe-Ziele der Mutation einmal je
  Lauf (bis 6 % bei 3 Kernen), Wirkungsgradkurve per binärer Suche und Horizont-Ende einmal je
  Lauf (je 1–3 %). Alle Läufe der Messreihe liefern dieselbe Bilanz, beide Referenz-Eingaben
  aus dem EOS-Repo bei 400 Generationen eine Byte für Byte gleiche Lösung. eHive live
  (2 Geräte, 3 Kerne, 24 h + Ausblick): 300–313 s statt 371–388 s; Raspberry Pi 4: 174 s statt
  197 s (2 Kerne), 134 s statt 150 s (3 Kerne).
- **EOS-Läufe nochmals rund 30 % schneller bei identischem Ergebnis (DV-EOS rc1.15).** Vier
  Stellen im Rechenkern: (1) der Vergleichsschlüssel je Kandidat wird in C geprüft und ohne
  Kopie gebildet; (2) die Eigenverbrauchs-Tabelle hat einen eigenen schlanken
  Zwischenspeicher je Lauf (vorher gemeinsamer Speicher mit nur 100 Plätzen, 18 % Fehlgriffe);
  (3) die Slot-Schleife der Simulation rechnet mit einfachen Zahlen statt mit
  NumPy-Einzelzugriffen und überspringt Laden/Einspeisen in Slots ohne PV-Überschuss;
  (4) gleiche Kandidaten innerhalb einer Generation werden auch ohne Fitness-Cache nur einmal
  gerechnet (kostet keinen Speicher; der Cache bräuchte 85–95 MB). Beide Referenz-Eingaben aus
  dem EOS-Repo liefern bei 400 Generationen eine Byte für Byte gleiche Lösung. eHive live
  (Auto + 2 Geräte, 3 Kerne): 269–294 s statt 408–437 s; Raspberry Pi 4: 197 s statt 233 s
  (2 Kerne), 150 s statt 170 s (3 Kerne).
- **EOS-Läufe 30–45 % schneller bei identischem Ergebnis (DV-EOS rc1.13).** Die
  Lastverteilung der Eigenverbrauchs-Tabelle wird je Lastwert nur einmal berechnet, und
  Nachkommen entstehen ohne `deepcopy`. Beide Referenz-Eingaben aus dem EOS-Repo liefern
  bei 400 Generationen eine identische Lösung. eHive (Auto + 2 Geräte, 3 Kerne): 461 s
  statt 707–916 s; Raspberry Pi 4 (2 Kerne): 233 s statt 333 s.
- **Heizstab in der EOS-Planung berücksichtigt.** EOS kann neben dem Akku nur ein stufenlos
  regelbares Gerät planen (das Auto); der Heizstab wird weiter von DVhub nach Überschuss
  geregelt. Neu: sein erwarteter Verbrauch (Tagesmenge = `capacityWh`, heute abzüglich der
  schon gelieferten Energie) geht als Last in die Prognose für EOS — in den Stunden mit
  PV-Überschuss, die mit dem niedrigsten Einspeisewert zuerst. EOS verplant denselben
  Überschuss damit nicht mehr doppelt. Abschaltbar: `optimizer.heaterLoadReservation: false`
  oder je Gerät `plan.reserveInForecast: false`.
- **Historie Jahr/Alle aus vorberechneten Monatsständen.** Nach jedem abgeschlossenen Monat
  wird der Rechenstand gesondert abgelegt (`history_summary_cache`); ein Aufruf rechnet nur
  noch die Monate danach. Ein Prüfwert über Rohdaten, Preise, Tarife, Monatsmarktwerte und
  Programmversion entscheidet, ab welchem Monat neu aus den Rohdaten gerechnet wird. Die
  Rohdaten bleiben unverändert; das Ergebnis ist bitgleich zur Rechnung ohne Ablage.
- **MQTT-Explorer hört nur noch bei Bedarf mit.** Das Abo auf alle Topics (`#`) lief
  dauerhaft und war der größte Posten der Leerlauf-CPU. Jetzt wird es beim Öffnen des
  Inspektors bzw. Geräte-Editors gesetzt und 10 Minuten nach dem letzten Abruf beendet.
  Datenverbindungen (Victron-MQTT, Geräte, Kacheln, TeslaMate, Befehle) sind nicht betroffen.
- **Prüfung der Systemuhr.** DVhub fragt stündlich einen Zeitserver ab (stellt nichts),
  zeigt die Abweichung im Status (`clock`) und warnt im Protokoll ab 2 s. Ein Container kann
  die Uhr nicht stellen — der Abgleich ist Sache des Betriebssystems (`clockCheck`).

- **EOS-Läufe starten zur vollen Viertelstunde (DV-EOS rc1.11).** Bisher begann ein Lauf
  15 Minuten nach dem Ende des vorigen, die Starts wanderten gegen die Uhr. Jetzt startet
  EOS bei :00, :15, :30, :45, passend zu den Börsen-Slots; dauert ein Lauf länger als der
  Takt, startet der nächste zur nächsten Viertelstunde nach seinem Ende. Abschaltbar über
  `optimizer.eosStartAfterPreviousRun`.

- **EOS-Warmstart bleibt erhalten, wenn DVhub den Steuerhorizont ändert (DV-EOS rc1.10).**
  DVhub kürzt den Horizont stündlich auf die bekannten Preise; EOS verwarf den
  Vorgängerplan dann wegen der anderen Länge und startete ohne Warmstart. Jetzt wird er
  verschoben und auf die neue Länge gebracht (eHive: 10 Warmstarts + 50 Varianten statt 0).
- **EOS meldet fertige Pläne (Push statt Abfrage, DV-EOS rc1.9).** EOS ruft nach jedem
  Lauf `POST /api/eos/solution-ready` auf (nur von der Box selbst); DVhub holt den Plan
  sofort und übernimmt ihn. Solange Meldungen kommen, fragt DVhub nur noch alle 10 min
  nach statt jede Minute. Je DVhub-Lauf wird die EOS-Lösung nur noch einmal geholt
  (vorher 3–4 Mal). DVhub trägt die Adresse selbst ein, wenn EOS auf derselben Box läuft.
- **Leitstand: DV-EOS-Fahrplan aus dem Plan, den DVhub schon hat** (`/api/eos/plan`).
  Kein Live-Aufruf an EOS und kein Prognose-Push mehr beim Anschauen (vorher 6–15 s auf
  dem eHive). Nach einem EOS-Neustart bleibt der letzte Plan sichtbar („EOS rechnet neu“).
- **EOS-Fitness-Cache einstellbar** (`optimizer.eosFitnessCacheMaxEntries`, 0 = aus wie
  bisher).

- **EOS rechnet mit zwei Kernen (DV-EOS rc1.8).** Die Bewertung der Kandidaten läuft
  in bis zu zwei Prozessen; ein Kern bleibt immer frei (2 Kerne → 1, ab 3 Kernen → 2).
  eHive One (4× Cortex-A55, 300×200): Lauf 460 s statt 703 s, Spitze 224 MB. Ab rc1.10
  sind die Rechenprozesse auf die letzten Kerne gepinnt; der EOS-Server bleibt frei
  und antwortet auch während eines Laufs (10–110 ms). Der Container hat deshalb kein
  CPU-Kontingent mehr (`EOS_CPUS=0`, vorher 1), dafür eine niedrigere CPU-Gewichtung; `EOS_MEM_LIMIT` 320 MB. rc1.7 friert zudem die Einstellungen je
  Lauf ein (Horizont-Änderung mitten im Lauf führte zu `IndexError`).

- **RAM-Stufen entfernt.** DVhub schaltet keine Funktionen mehr nach Speichergröße
  ab. EOS-Pläne werden jetzt auch auf Boxen mit 1 GB RAM übernommen (vorher rechnete
  EOS dort, DVhub nutzte den Plan aber nie). Python-Prognosemodule hängen nur noch an
  ihren Schaltern und an einer installierten Python-Umgebung; die Einstellungen zeigen
  sie unter „Prognose-Module“. Der interne Optimierer nutzt bei „auto“ MILP mit
  Heuristik als Rückfall.
- **§14a: Aufteilung und Mindestleistung nach BNetzA-Festlegung** ([docs/EEBUS.md](docs/EEBUS.md)).
  DVhub berechnet die Mindestleistung Pmin,14a nach Anlage 1 Ziffer 4.5.2 (Gleichzeitigkeitsfaktor,
  Sonderfall Wärmepumpe/Klima über 11 kW) aus Wallbox, Speicher, EEBUS-Geräten und Geräten von Hand.
  Vorgaben kommen von der EEBUS-Steuerbox oder dem Relais einer FNN-Steuerbox (MQTT). Das Budget
  (Grenze + PV-Überschuss) geht nach Vorrang oder anteilig an Wärmepumpe, Wallbox und Speicher; der
  Speicher lädt jetzt bis zu seinem Anteil aus dem Netz statt gar nicht. Integrationen → §14a zeigt
  Rechenweg und Geräteliste; Leitstand und Installateurportal zeigen, welche Steuerungen und
  Abregelungen gelten (DV, §51, Einspeisegrenze, §14a, §9).
- **EEBUS: §14a-Steuerbox und EEBUS-Geräte** ([docs/EEBUS.md](docs/EEBUS.md)).
  DVhub nimmt Leistungsgrenzen der Steuerbox des Netzbetreibers an (LPC/LPP mit
  den EEBUS-Zuständen inkl. Failsafe nach 120 s ohne Heartbeat), meldet den
  Netzanschlusspunkt (MGCP) und setzt die Grenzen um: Akku lädt nicht aus dem
  Netz, Wallbox und EEBUS-Wärmepumpen teilen sich die Bezugsgrenze, die
  Einspeisegrenze geht an den Einspeisebegrenzer. EEBUS-Geräte werden begrenzt
  und gemessen, angekündigte Verdichterläufe in die günstigste Zeit gelegt.
  Hilfsprozess dvhub-eebus auf Basis von openeebus (NIBE), ~13 MB RAM; Kopplung
  unter Integrationen → EEBUS. Drei Fehler in openeebus behoben und als Pull
  Requests gemeldet.
  Der Leitstand zeigt in der Karte „§14a / §9 · EEBUS“ Steuerbox, Bezugs- und
  Einspeisegrenze und ihre Umsetzung; jeder Schreibversuch der Steuerbox steht
  im Protokoll, abgelehnte als Warnung. Eine neu gekoppelte Steuerbox erbt keine
  Failsafe-Werte der vorherigen.

- **Direktvermarkter-Schnittstelle umschaltbar: Plexlog oder LUOX/Lumenaza.**
  Einstellungen → System → „Direktvermarkter-Schnittstelle" (`dvInterface.profile`,
  Standard `plexlog` = unverändert). Das LUOX-Profil folgt der offiziellen
  Registerbelegung vom 02.06.2026: getrennte Input-/Holding-Register,
  Einspeisung (i32), Produktion (u32), Netzbetreiber-Vorgabe (immer 100 %),
  Referenzleistung (aus den kWp der PV-Anlagen oder fest eingestellt),
  Vorgabe 0–100 % und Watchdog: 15 min ohne Schreibvorgang → wieder 100 %.
  Teilvorgaben (1–99 %) begrenzen die Einspeisung über Victron
  `MaxFeedInPower` (Reg. 2706); der Wert davor wird gesichert und danach
  zurückgeschrieben. Ohne Begrenzer oder bei Schreibfehlern regelt DVhub
  sicherheitshalber ganz ab. Wirkt ohne Neustart.

### Geändert

- **DV-EOS rc1.6:** Die SciPy-freie Eigenverbrauchstabelle ist in EOS jetzt ein
  Schalter (`optimization.self_consumption_interpolator`, Standard `scipy`, wie
  im Upstream-PR #1378). DVhub setzt ihn automatisch auf `numpy`, sobald EOS den
  Schalter kennt — gleiche Werte, ~35 MB weniger nach dem ersten Lauf.

- **Nur noch EOS 0.4.** Der Installer liefert DV-EOS `dvhub-v0.4.0rc1.3` aus
  (wie das Docker-Image); Boxen mit dem 0.3-Fork wechseln beim nächsten Update
  automatisch, EOS-Daten und -Konfiguration werden vorher gesichert. Findet
  DVhub ein älteres EOS, schreibt es nichts mehr hinein und meldet „EOS-Version
  wird nicht mehr unterstützt“. EOS läuft mit niedriger Priorität und höchstens
  (Kerne − 1) Kernen.
- **Zentraler EOS-Monitor** (`/api/eos/status`): ein Punkt für „läuft EOS?“
  (`up` / `busy` = rechnet / `down`) und den letzten Plan; Kacheln, Inspector,
  Neustart-Wache und Bridges fragen EOS nicht mehr jeweils selbst.
- **Wechselrichter-Wirkungsgrad wird autonom gemessen und an EOS gegeben.**
  Aus den eigenen 5-s-Messwerten entsteht je Lastbereich (18 Bereiche) ein
  Tageswert; daraus rechnet DVhub die lastabhängige Kurve über 180 Tage —
  nur alle 30 Tage neu (feste Perioden ab 01.01.2026), deterministisch:
  gleiche Daten ergeben bitgleich dieselbe Kurve (Prüfsumme). Freigabe erst
  nach 14 Tagen Betrieb. EOS bekommt den Mittelwert als `dc_to_ac_efficiency`
  und — sobald EOS die Kurve kennt (Akkudoktor-EOS PR #1375) — die Kurve selbst.
  `GET /api/inverter-efficiency/curve`; abschaltbar mit
  `optimizer.inverterEfficiencyAuto: false`.
- **EOS-Quelle als Parameter** (`EOS_REPO`/`EOS_TAG`, `EOS_REPO_URL`/`EOS_PIN`):
  der Umstieg auf ein offizielles Akkudoktor-EOS-Release ist eine Pin-Änderung.
- **Voller Export für den Geräte-Tausch.** Der passwortgeschützte Export trägt
  jetzt auch API-Token, Lizenz, Geräte-Kennung, Datenspende-Schlüssel,
  Installateur-Portal-Kopplung, Support-Schlüssel, HTTPS-Zertifikat und
  VPN-Profile (u. a. Direktvermarkter). Der Import fragt „Geräte-Tausch?“ und
  übernimmt sie nur dann. Zusammen mit dem Datenbank-Backup ist ein Ersatzgerät
  ohne Neueinrichtung betriebsbereit (Prod → Container durchgetestet).

- **Gestufte Log-Aufbewahrung** (bisher wuchsen die Log-Tabellen unbegrenzt,
  prod 1,2 GB nach 7 Monaten): Seltenes (Abregelung, Steuerung an/aus,
  Schreibfehler, Negativpreis-Schutz, Einstellungen, Lizenz, Restore,
  Rechtsfreigaben) bleibt für immer; Sollwert-Befehle nach 60 Tagen als
  15-min-Werte, Rauschen als Tageszähler — beides für immer. Fehler: ohne
  Installateur-Portal 60 Tage voll, dann Episoden (Beginn, Ende, Anzahl, erste
  Meldung); mit Portal lokal 24 h voll + 7 Tage 15-min-Bündel, dauerhaft im
  Portal. Optimierer-Reihen nach 60 Tagen nur der letzte Lauf je Tag.
- **Installateur-Portal: Fehlerprotokoll je Anlage.** Die Anlage meldet ihre
  Fehler beim Poll, das Portal speichert und quittiert sie; Ansicht mit
  Übersicht je Fehlerart und den neuesten Einträgen.
- **SD-Karten-/eMMC-Schonung** (gemessen auf prod):
  - EOS schrieb alle 10 s seinen kompletten Zustand (12–14 MB/min ≈ 20 GB/Tag):
    automatisches Speichern aus (Daten liegen im RAM, DVhub schickt nach einem
    EOS-Neustart alles neu), EOS-interne Messwerte 48 h statt 2 Jahre, SoC an
    EOS mit einem statt zwei Zeitstempeln → ~1 KiB/min.
  - DVhubs eigene Aufzeichnung behält ihre volle Auflösung (5 s) — es wird nur
    seltener auf die Platte geschrieben.
  - PostgreSQL schreibarm (synchronous_commit=off, Checkpoint 15 min,
    WAL-Kompression) → 1,66 → 0,73 MB/min; die 5-s-Live-Messwerte werden im
    RAM gesammelt und einmal pro Minute als Block geschrieben
    (`telemetry.writeBatchSec`, Auflösung unverändert).
  - VPN-Watchdog ohne sudo (vorher ~25 Journalzeilen/min).
- **DVhub stellt seine Datenbank selbst ein** — kleiner Speicher-Footprint für
  alle Boxen (64 MB shared_buffers, ohne Parallel-Worker), „winzig“ für
  512-MB-Boards; nativ über `pg-write-tuning.sh` (Updates), im Container und
  unter balena per Admin-Zugang beim Start — unabhängig von der Compose-Datei.

### Behoben

- **EOS-Neustart im Container wurde nicht erkannt.** DVhub erkannte ihn nur an einer
  geänderten Prozessnummer; im Container ist die immer 1. Prognosen und Einstellungen kamen
  dann erst mit dem nächsten 15-Minuten-Push, die ersten Läufe brachen ab. Jetzt zählt auch
  eine geänderte Startzeit (`started_at`, DV-EOS rc1.14) und „Verbindung abgelehnt, wieder
  da“. eHive: Neustart nach 58 s erkannt, Prognosen nach 95 s neu, Lauf nach 2 min.
- **Uhr-Prüfung schreibt jede Messung ins Protokoll** (`clock_check` mit der Abweichung in
  Sekunden); der Status zeigt zusätzlich die Heizstab-Vorhaltung (`heater`).
- **Heizstab lief mit Netzbezug statt mit PV-Überschuss.** Die Überschuss-Regelung nahm
  fest „Einspeisung = negativer Netzwert“ an. Auf Anlagen mit `gridPositiveMeans: feed_in`
  galt damit Netzbezug als Überschuss (nachts kleine Leistungen aus dem Netz), echte
  Einspeisung wurde nicht erkannt. Außerdem zählte jede Einspeisung als Überschuss, auch
  eine geplante Akku-Einspeisung zu hohen Preisen. Jetzt zählt nur PV-Leistung, die ins Netz
  geht (plus die eigene Heizleistung), abzüglich Netzbezug und Akku-Entladung.
- **EOS brach Läufe mit „Fresh SoC missing“ ab** (DV-EOS rc1.12), wenn ein Lauf genau
  zwischen zwei Messwert-Schreibvorgängen derselben Minute startete — seit dem Start zur
  vollen Viertelstunde bei jedem Lauf. EOS nimmt jetzt den neuesten gültigen Wert.
- **MQTT: nackte Zahlen aus der Bridge wurden wortlos verworfen.** Der
  Venus-Zweig (`N/`-Topics) verlangte ausschließlich `{"value": X}` und ignorierte
  alles andere ohne eine Zeile Log — eine Bridge, die `26` statt `{"value":26}`
  publiziert (live gefunden auf Deye-Bridge „deye1“, 2026-10-02), hinterließ
  `victron.soc/batteryPowerW/pvPowerW = null` und `meter.error = "MQTT: Netzwerte
  fehlen oder sind veraltet (Zufluss prüfen)"`, obwohl der Bus voll Daten war.
  Der Zweig nutzt jetzt denselben Toleranz-Parser wie das DVhub-Schema
  (`parseMqttPayload`: nacktes Zahl, JSON-Zahl, `{"value":X}`) und meldet
  unverwertbare Payloads entprellt (1×/min/Topic) als
  `[MQTT] Payload für <topic> nicht verwertbar` plus Leitstand-Event
  `mqtt_payload_unusable`. `emitEvent` ist per `typeof`-Guard abgesichert, damit die
  Toleranz auch auf Ständen zwischen 2026-09-14 und 2026-09-29 läuft. Unverändert:
  `{"value": null}` bleibt „kein Wert“ (nicht 0), retained Replays bleiben
  verworfen (T-MQTT-RETAIN). Test `test/bridge-mqtt-venus-bare-payload.test.js`
  schlägt ohne den Fix fehl; gegengeprüft gegen v1.0.4, v1.0.5/v1.0.6, 572475c und main.

- **EOS 0.4 plante bei fester Einspeisevergütung nie.** EOS bekam die
  Einspeisevergütung nur im Spot-Modus; 0.4 bricht ohne sie jeden Lauf ab
  („Missing or invalid feed-in tariff within the control horizon"). Jetzt geht
  auch die feste Vergütung als Reihe an EOS — gleiche Regel wie der interne
  Optimierer (`optimizer.tariff.feedInCtKwh`, Standard 7,78 ct, 0 bei negativem
  Spot).

- **Explorer: große Zeiträume in feiner Auflösung** (z. B. 7 Tage × 5 s) ließen
  DVhub mit „JavaScript heap out of memory“ abstürzen — alle ~970.000 Zeilen
  lagen gleichzeitig im Speicher. Feine Abfragen (5 s … 5 min) werden jetzt in
  der Datenbank auf die gewählte Auflösung gebündelt und in 6-h-Fenstern
  komprimiert gestreamt (7 Tage × 5 s: 61 MB JSON → 3,7 MB übertragen, DVhub
  bleibt unter 135 MB). Dabei behoben: „1min“/„5min“ lieferten bisher trotzdem
  alle 5-s-Rohwerte.

- **EOS plante nie, wenn forecast.solar die PV-Prognose lieferte.** forecast.solar
  schickt neben den Rasterwerten Punkte zu Sonnenauf- und -untergang (z. B.
  19:00:15 neben 19:00:00). EOS 0.4 leitet die Taktung aus dem kleinsten
  Abstand ab, hielt die PV-Reihe für 15-Sekunden-Werte ohne Abdeckung und brach
  jeden Lauf ab („Missing or invalid PV within the control horizon“). DVhub
  gibt EOS jetzt nur Rasterpunkte; der Positions-Push des Optimierers verschob
  durch solche Punkte zudem alle folgenden PV-Werte um einen Slot.
- **Frische EOS-Installationen planten nie** (EMS-Modus stand auf DISABLED);
  der Abgleich setzt jetzt `ems/mode = OPTIMIZATION`.
- **Historie: schnelles Durchblättern** der Monate brachte den 192-MB-Container
  zum Absturz („Load failed“) und danach das Anfrage-Limit (429). Schwere
  History-Abfragen laufen serverseitig in Reihe (gleiche Anfrage nur einmal,
  verlassene Anfragen entfallen); die Seite wartet 0,5 s, bis man stehen
  bleibt, und bricht veraltete Abrufe ab — statt ~1500 nur noch ~150 Anfragen
  für 120 Monatswechsel.

- E-Auto-Kachel zeigte „kein Plan: eos_off“, während EOS rechnete.
- Antwortete EOS beim Abgleich nicht rechtzeitig, ging das E-Auto im alten
  Listenformat raus und EOS 0.4 lehnte es ab.
- **Planbare Geräte legten EOS 0.4 lahm:** ohne Messwert
  `<gerät>.cycles_completed` brach EOS jeden Lauf ab („Invalid completed cycle
  count“). DVhub zählt die Läufe je Tag und meldet sie mit dem SoC.
- **Lese-Modus sperrte die Wallbox nicht:** mit `DVHUB_READ_ONLY=1` waren
  Modbus/MQTT gesperrt, OpenEVSE/go-e/evcc und Shelly-Relais aber nicht — eine
  Kopie mit Prod-Konfiguration hätte die echte Wallbox gesteuert.
- **Docker: Restore großer Datenbanken** wurde im DB-Container OOM-gekillt
  (Index-Aufbau mit 3 × 48 MB). Speicher-Parameter fest begrenzt; die volle
  Prod-DB (6 GB) läuft jetzt in 85 s durch.
- Integrationskarte „Wallbox“ mit evcc zeigte 5 statt 4 Kacheln (CI rot).
- `control_write` stand doppelt im Audit-Log (zusätzlich zu `control_events`).

### Neu

- **OpenEVSE / go-e: Anstecken wird direkt an der Wallbox erkannt.** Bisher
  kam der Steckzustand nur aus evcc — lief evcc nicht, blieb das Auto
  „Steckzustand unbekannt“ und wurde bei EOS nicht angemeldet. DVhub fragt
  OpenEVSE bzw. go-e jetzt selbst alle 15 s (angesteckt / lädt / Leistung);
  evcc bleibt die Quelle, wenn evcc als Wallbox gewählt ist.
- **Integrationskachel heißt jetzt „Wallbox“ statt „EVCC Wallbox“.** Status und
  Details zeigen die gewählte Wallbox (OpenEVSE / go-e direkt, evcc separat).

- **Home Assistant und Loxone liefern Messwerte — auch ohne MQTT.** Im
  Profil „Universal (DVhub-MQTT-Schema: HA/Loxone)“ nimmt DVhub Netz, PV,
  Batterie, SoC und Hausverbrauch jetzt auch als Gesamtwerte
  (`dvhub/input/grid/total_w`, `pv/total_w`, `consumption/total_w`) und per
  HTTP-Push an `/api/input/push` an (Loxone Virtueller Ausgang, HA
  `rest_command`), gesichert mit eigenem Push-Schlüssel. Ohne Broker läuft
  der Eingang als reiner HTTP-Push. Fehlt der Hausverbrauch, rechnet DVhub
  ihn aus PV, Netz und Batterie. Kommen keine Netzwerte mehr, ist der Zähler
  ungültig statt „0 W“. Anleitung: `docs/LOXONE.md`.
- **Datenspende an die RWTH Aachen (COMSYS).** Opt-in: Netz, PV,
  Hausverbrauch, Batterie und alle Geräte alle 10 s; historische Daten
  lassen sich nachsenden. Einstellungen → Status → Datenspende.
- **Installateurs-Portal.** Opt-in: Kopplung per Code, Anmeldung mit
  Signatur; der Installateur liest Status und Historie, Updates und
  Support-Tunnel nur mit eigener Freigabe des Kunden.
- **„Sofort laden“ fürs E-Auto** — mit gewählter Leistung laden, unabhängig
  vom EOS-Plan und auch, wenn EOS nicht läuft.
- **API-Referenz aller Endpunkte** in `docs/API.md`.
- **Ortsnetz-Auslastung** (opt-in, Einstellungen → Status): DVhub sendet
  alle 5 Minuten die Netzspannung L1–L3 und die Netzfrequenz des Netzzählers
  am Übergabepunkt an www.ortsnetz-auslastung.de (Karte der Spannungen in
  Ortsnetzen, Projekt von Thomas Lehmann). Standort aus dem Prognose-Standort
  oder eigene Angabe, optional Anlagengröße und heutige PV-Prognose. Regeln
  wie in den offiziellen Integrationen: nur 150–300 V, Frequenz nur 45–55 Hz.
  Die Antwort (Ampel je Phase, Speicherempfehlung) steht in der Kachel. Quelle
  bisher Victron GX per Modbus (Netzzähler-Register 2616/2618/2620, 2644).
- **Docker-Installation per Einzeiler:**
  `curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/docker/install.sh | bash`
  — legt `./dvhub` mit `compose.yml` und `.env` (Zufallspasswörter) an, lädt
  die Images und startet; wiederholbar zum Aktualisieren. Die DB-Einrichtung
  steckt jetzt in `compose.yml` (vorher eigene Datei, die beim Fehlen die
  Einrichtung still übersprang → DVhub konnte sich nicht anmelden).
- **DVhub als Container-Suite: DVhub + TimescaleDB + EOS in ≤ 704 MB RAM.**
  `docker/compose.yml` startet DVhub, TimescaleDB 2.28/PostgreSQL 17 (Rollen
  wie nativ: `postgres` Admin, `dvhub` App) und optional EOS (DV-EOS
  `dvhub-v0.4.0rc1.3`, ohne EOSdash). Die Speicher-Obergrenzen aller drei
  zusammen: 704 MB (gemessen im Betrieb ~400–500 MB, mit 18 Monaten Echtdaten).
  Images öffentlich auf Docker Hub (`bikinibottomcapital/dvhub`,
  `…/dvhub-eos`), gespiegelt nach GHCR; Workflow `container.yml` baut nach
  einem Smoke-Test für amd64 + arm64. DB-Backup und -Restore funktionieren im
  Container (pg-Client im Image, direkt als DB-Admin) — eine bestehende Anlage
  samt Datenbank lässt sich umziehen (`docker/README.md`). Update-, Reboot- und
  Neustart-Knöpfe sagen im Container, dass das Image getauscht wird; Configs
  mit Port 80/443 laufen auf 8080/8443.
- **Historie: Jahr und „Alle“ rechnen Monat für Monat.** Bisher lag der ganze
  Zeitraum als bewertete 15-min-Slots gleichzeitig im Speicher (Jahr ~100 MB,
  „Alle“ auf einer Anlage mit 18 Monaten Daten bis ~1 GB Prozess-Spitze). Jetzt
  wird je Monat geladen, bewertet und in die Summen gefüttert — Jahr +41 MB,
  „Alle“ +51 MB, und das wächst kaum noch mit der Länge der Historie.
  Ergebnisse bit-identisch (Golden-Vergleich auf Echtdaten, alle Ansichten und
  §51-Regeln); der §51-Stundenzähler läuft über Monatsgrenzen weiter.
- **Familien-Dashboard rechnet nur, wenn es jemand ansieht.** Die Monats- und
  Jahres-KPIs wurden beim Start und danach alle 10 Minuten berechnet — auch
  ohne Lizenz und ohne Zuschauer (bis ~100 MB Speicher-Spitze, beim Booten).
  Jetzt stößt der erste Abruf des Dashboards die Rechnung an; ohne Abruf in den
  letzten 15 Minuten ruht sie. Monat und Jahr laufen nacheinander.
- **Heizstab lässt dem E-Auto den Vortritt.** Neue Option je Heizstab
  (MYPV Elwa / AC Thor): „Pausieren, solange das E-Auto lädt“ — lädt die
  Wallbox (evcc, OpenEVSE oder go-e), bekommt der Heizstab 0 W; danach heizt
  er wieder dem Überschuss nach.
- **Datenspende- und Eingangs-Status unter „LAN-Vertrauen: eingeschränkt“**
  ohne Token lesbar (Gruppe „integrations“), wie die übrigen Status-Kacheln.
- **Akku halten: Last aus dem Netz, wenn EOS es plant.** EOS entscheidet
  manchmal, den Hausakku für später aufzusparen — etwa weil seine Energie
  abends teuer verkauft werden kann — und Haus und E-Auto solange aus dem
  Netz zu versorgen. Bisher setzte DVhub nur Einspeise-Viertelstunden um; in
  allen anderen machte der Victron Eigenverbrauch und entlud den Akku genau
  dafür. Neu setzt DVhub in diesen Viertelstunden alle 5 Sekunden
  „Netzbezug = Live-Hauslast − Live-PV − Puffer“ (300 W, beim geplanten
  E-Auto-Laden 1 kW). Der Bezug bleibt dabei immer unter der Last, der Akku
  lädt nie aus dem Netz — deshalb gilt das Netzlade-Verbot für genau diese
  Regel nicht, für alles andere unverändert. Einstellung „Akku halten“ unter
  Zeitplan → Optimierung, Standard aus.
- **E-Auto: Abfahrtszeit und Ladeziel.** Wöchentliche Abfahrt (Tage +
  Uhrzeit) oder ein einmaliger Termin, Ziel in %, kWh oder km (über den
  Verbrauch je 100 km). DVhub gibt EOS 0.4 daraus den Termin und den
  Mindest-SoC; EOS plant die Ladung so, dass das Ziel bis zur Abfahrt steht.
  Der SoC des Autos kommt aus TeslaMate oder evcc.
- **E-Auto-Plan an die Wallbox — über evcc, OpenEVSE oder go-e.** EOS plant
  je Viertelstunde „laden mit x A“ oder „nicht laden“; DVhub gibt das an den
  gewählten Ladepunkt weiter: an evcc (Modus + Ladestrom), direkt an eine
  OpenEVSE (auch Kinetos, über die Claims-API mit eigener Priorität — ein
  Eingriff von Hand an der Box gewinnt immer) oder an einen go-e Charger
  (API v2). Einstellbar und beobachtbar unter Integrationen → evcc,
  inklusive Live-Status der Box.
- **Weniger Arbeitsspeicher: jemalloc und Port-Recht über systemd.** DVhubs
  JavaScript braucht ~40 MB, der Prozess belegte trotzdem 250–500 MB, weil
  der C-Speicherverwalter freigegebenen Speicher nicht zurückgibt. Mit
  jemalloc sinkt der Bedarf auf dem Raspberry Pi von ~245 auf ~130 MB. Dafür
  bekommt der Dienst das Recht für Port 80/443/502 jetzt von systemd statt
  per `setcap` an der node-Datei (die schaltete glibc in einen Modus, der
  jemalloc verhinderte). Die Umstellung passiert beim Update von selbst über
  zwei Starts, sodass DVhub nie ohne Port 80 startet; abschaltbar mit
  `.no-jemalloc` im Datenverzeichnis.
- **Historie → Jahresansicht → Direktvermarktung: Monatsverlauf als Chart
  und Tabelle.** Marktwert Solar, erzielter Börsenpreis für PV direkt, für
  den Speicher und kombiniert sowie der Ø-Börsenpreis je Monat; per
  Umschalter auch als Tabelle der Erzeugungserlöse.
- **EOS 0.4 im Dauerbetrieb.** Der Steuerzeitraum folgt der tatsächlichen
  Preis- und Prognoseabdeckung (nachts reicht Day-Ahead nur bis Mitternacht;
  0.4 bricht sonst jeden Lauf ab), der Akku-SoC geht minütlich an EOS
  (0.4 akzeptiert nur Messwerte der letzten 5 Minuten), und eine zweite
  EOS-Instanz lässt sich für einen A/B-Vergleich parallel betreiben.

- **EOS-Fassung wird erkannt, beide Stände werden unterstützt.** DVhub fragt
  beim Konfigurationsabgleich einmal die EOS-Konfiguration ab und erkennt
  daraus, mit welcher Fassung es spricht: unserem DV-Fork, dem
  Direktvermarktungs-Branch des Maintainers (dem künftigen Upstream-Stand)
  oder dem heutigen Upstream-main. Danach richtet sich, was geschrieben wird:
  der Direktvermarktungs-Schalter geht nur an Fassungen, die ihn kennen (beim
  Fork entfällt der bisher dauerhaft fehlschlagende Versuch), das Intervall
  geht auf den jeweils richtigen Pfad, und wo 15 Minuten nicht vorgesehen
  sind, wird auf eine Stunde herabgestuft statt einen Fehler zu erzeugen. Die
  erkannte Fassung steht in `/api/optimizer/status` unter `eos` und im Log.
  Ein späterer Wechsel ist damit nur noch ein Umhängen des Branches.
  Seit dem GENETIC-Umbau von EOS (upstream #1330, enthalten in `v0.4.0rc1`)
  kommt eine vierte Fassung dazu, und sie unterscheidet sich in mehr als dem
  Intervall-Pfad: Geräte werden dort als Abbildung nach `device_id`
  geschrieben statt als Liste, die Speicherkosten heißen
  `levelized_cost_of_storage_amt_kwh`, der Algorithmus (`GENETIC` neben dem
  alten `GENETIC0`) wird ausdrücklich gewählt, und die Preisaufschläge
  `elecprice/charges_kwh`/`vat_rate` entfallen — es gab sie dort nicht mehr,
  und auf DVhubs Pfad hatten sie ohnehin nie eine Wirkung, weil die Bridge
  bereits den aufgelösten Endkundenpreis schickt. Wichtig ist die
  Unterscheidung zum Upstream-Stand davor: dort waren 15 Minuten nicht
  möglich, ab `v0.4.0rc1` sind sie es wieder. Wer beide gleich behandelt,
  plant still in Stundenslots. Gegen eine echte `v0.4.0rc1`-Instanz gemessen:
  14 von 14 Konfigurationswerten kommen an (mit dem alten Schema waren es 10
  von 16).
- **EOS wird mitgeliefert und lässt sich aktualisieren.** Bisher gab es für
  Bestandsanlagen gar keinen EOS-Update-Pfad: war EOS einmal installiert,
  prüfte ein DVhub-Update nur noch, ob der Dienst läuft. Neu legt
  `eos-version.env` fest, welcher EOS-Stand ausgeliefert wird (Repository und
  Tag/Branch/Commit); die Anlage merkt sich den installierten Stand und zieht
  bei einer Abweichung im Hintergrund nach — inklusive Wechsel des
  Repositorys und Neuaufbau der Python-Umgebung. Ein Versionssprung ist damit
  eine Zeile. Die bisherige Speicherhürde (kein EOS unter 1 GB RAM) entfällt;
  wer EOS nicht will, legt weiterhin `.no-eos` im Datenverzeichnis an.
- **Steuerbefehle transparent nach außen — MQTT, Home Assistant, Loxone.**
  DVhubs aktive Sollwerte (Netz-Sollwert, Ladestrom, Min-SoC, Entladegrenze)
  werden retained unter `dvhub/control/*` publiziert, dazu Quelle/Regel,
  Zeitstempel und Not-Halt-Status. Ein fremder Akku in Home Assistant oder
  eine Loxone-Logik kann damit den DVhub-/EOS-Entscheidungen folgen, ohne
  dass DVhub das Gerät kennt. HA-Auto-Discovery legt die Sollwerte als
  Sensoren an; der Loxone-Text-Endpunkt liefert sie als flache
  `dvhub_control_*`-Zeilen. Victron-spezifische Register (feedExcess) sind
  bewusst nicht dabei. Schema: `docs/MQTT-SCHEMA.md`.
  `control/source` nennt die Herkunft (`eos`, `optimizer`,
  `market_automation`, `rule`, `override`, `default`, `runtime`), die
  Regel-ID steht in `control/rule`.
- **EOS-/Optimizer-Plan nach Home Assistant.** `dvhub/optimizer/plan`
  liefert die vom Optimizer erzeugten Slots „von … bis … → Befehl" (export,
  import, hold, export_surplus mit Ladereserve) als JSON, dazu
  `plan/ranges` (aufeinanderfolgende Slots mit gleichem Befehl als Bereiche
  „von … bis …", kompakt für HA-Attribute), `plan/current`, `plan/next` (mit
  Vorlauf in Minuten), `plan/next_start` und `plan/slot_count`. HA-Discovery
  legt `sensor.dvhub_optimizer_plan`
  (Zustand = Slots, Attribute = Bereiche) und `sensor.dvhub_optimizer_plan_next`
  (Zeitstempel) an. `devices` ist im Plan reserviert für Geräte-Slots mit
  An/Aus, sobald EOS flexible Verbraucher plant. Direkt nach dem Start meldet
  `optimizer/status` jetzt `starting` statt `disabled`.
- **VRM-Nachimport: Fehler wird benannt statt „internal server error" (#16).**
  Warf der Import (fehlender VRM-Token, VRM-API 401/5xx), lief der Fehler in
  den generischen 500. Jetzt antwortet der Endpunkt mit 502 und dem Grund und
  schreibt `backfill_finished status=error` ins Log.
- **MQTT-Optimizer-Topics aus dem echten Optimizer-Zustand.**
  `dvhub/optimizer/source` sagte „disabled", während EOS mit 18 Regeln lief —
  die Topics hingen nur an der Kleinmarkt-Automation. Jetzt: `eos` /
  `internal` / `market_automation` / `gated` / `none`, Status
  `active`/`error`/`disabled`, `last_run_at` als ISO-Zeitstempel, dazu
  `rules_count` und `error`. Textwerte werden roh gesendet, nicht mehr
  JSON-kodiert — in Home Assistant standen sie in Anführungszeichen
  („active"), und der Zeitstempel „Sollwert geändert" blieb deshalb
  unbekannt.
- **Eingänge aus Home Assistant/Loxone: Profil „Universal (DVhub-MQTT-Schema)".**
  Neues Herstellerprofil für Anlagen, deren Speicher/PV/Zähler nur in HA oder
  Loxone existieren: Lesewerte kommen als nackte Zahlen unter
  `dvhub/input/…` herein (Netz je Phase, SoC, Akkuleistung, PV, Verbrauch,
  optional Rücklesung der Sollwerte), Steuerbefehle gehen unter
  `dvhub/control/<ziel>/set` hinaus. Kein Venus-Keepalive, keine
  Venus-Topics; die Frische-Disziplin (retained Replays verwerfen, Stale =
  unbekannt) gilt unverändert. Topic-Prefix unter Einstellungen → Verbindung
  → MQTT-Bridge einstellbar.
- **MQTT-Hub steuern und debuggen (Integrationen → MQTT Hub).** Neuer Tab
  „Verbindung": Zustand (Verbinde/Verbunden/Offline/Getrennt/Deaktiviert),
  Broker, verbunden/getrennt seit, Reconnect-Zähler, letzter Fehler, dazu die
  Knöpfe **Verbinden / Neu verbinden / Trennen** und das Ereignis-Log des Hubs
  (Reconnects, Fehler, Broker-DISCONNECT) — ohne `journalctl`. Der
  Einstellungen-Tab zeigt jetzt auch die bisher nur in `config.json`
  erreichbaren Felder (Hauptschalter, Embedded-Port, Publish-Intervall,
  Client-ID, Keepalive, Reconnect-Periode, Connect-Timeout, TLS-Prüfung);
  **Speichern & übernehmen** baut die Verbindung im laufenden Prozess neu auf,
  der Service-Neustart aus GH #9 entfällt. Neue Endpunkte
  `GET /api/integrations/mqtt/status`, `POST /api/integrations/mqtt/action`;
  `POST /api/family/mqtt-config` nimmt die neuen Felder plus `applyNow` an.
  Ein wiederholter Verbindungsfehler landet nur noch alle 5 min im Audit-Log
  statt alle 5 s (Anlass: Broker weg → 17.000 identische Zeilen pro Tag).
- **Börsenerlös je Einspeisequelle — Speicher und PV-direkt getrennt.** Der
  gemeinsame Börsenschnitt verdeckt, was den Speicher ausmacht: die PV speist
  in die billigen Mittagsstunden, der Speicher entlädt gezielt in die teuren.
  Historie zeigt in der DV-Karte jetzt unter „∅ Börse ct/kWh" zwei Zeilen —
  „davon Speicher" und „davon PV direkt", jeweils Erlös in € und erlöster Satz
  in ct/kWh — und in der Detailtabelle (Woche/Monat/Jahr/Alle) die Spalten
  „Erlös Speicher" und „Erlös PV direkt". Grundlage ist die vorhandene
  Flow-Zerlegung je Viertelstunde (PV→Netz, Akku→Netz) mit dem Slotpreis.
  Slots ohne Börsenpreis zählen weder im Betrag noch im Nenner, damit sie den
  Satz nicht nach unten ziehen; „–" heißt „nichts bepreist eingespeist", nicht
  0 ct. API: `exportPvRevenueEur`, `exportBatteryRevenueEur`,
  `exportPvCtKwh`, `exportBatteryCtKwh` sowie die bewerteten kWh
  `exportPvValuedKwh`/`exportBatteryValuedKwh` in KPIs, Zeilen und
  `periodFinancialBars`.
- **DVhub als Container.** `Dockerfile`, `.dockerignore` und
  `docker/docker-entrypoint.sh` liegen jetzt im Repo, Betriebsdoku unter
  `docker/README.md`: Multi-Arch-Build (amd64/arm64), Entrypoint legt Config
  und `appliance-id` in Volumes an, schreibt `telemetry.database.*` aus
  `DVHUB_DB_*`, wartet auf die Datenbank und leitet den Node-Heap aus dem
  cgroup-Limit ab. Nachgewiesen auf einem Raspberry Pi 4 (nativer arm64-Build
  55 s, 335 MB, healthy, Store verbunden, Migrationen gelaufen). Dazu der
  **Lese-Modus** `DVHUB_READ_ONLY=1`: sperrt jeden Modbus-/MQTT-Schreibzugriff
  im Transport — ohne die Variable verhält sich eine Anlage exakt wie bisher.

### Behoben

- **DB-Wiederherstellung auf eine laufende Anlage schlug fehl**, sobald
  TimescaleDB aktiv war: `pg_restore --clean` kann die Hypertable nicht
  löschen („other objects depend on it“). Ein vollständiger Dump legt die
  Datenbank jetzt leer neu an und spielt ohne `--clean` ein; ein Dump nur der
  15-min-Werte ersetzt weiterhin nur diese Tabelle. Geprüft mit einem
  echten 857-MB-Dump (85 Mio. Zeilen): 84 s, 0 Fehler.
- **Wallbox schaltet nicht mehr ab, wenn der EOS-Plan kurz nicht abrufbar
  ist** — die schon geplanten Viertelstunden gelten weiter.
- **Node.js 22 ist Mindestversion** (Installer und `package.json`).
- **Erster EOS-Plan nach einem Neustart in Minuten statt 15–30 Minuten** —
  sowohl nach einem DVhub- als auch nach einem EOS-Neustart. Bisher zählte
  eine aus EOS' Datenbank wiederhergestellte alte Lösung als frisch, und der
  Boot-Abgleich setzte den kurzfristig schnelleren EOS-Takt wieder zurück.
- **Ohne E-Auto-SoC meldet DVhub das Auto bei EOS 0.4 ab**, statt jeden
  Planungslauf mit „Fresh SoC missing“ scheitern zu lassen.
- **`eos-provision.sh` verliert keine lokalen EOS-Anpassungen mehr**: sie
  werden vor einem Versionswechsel gesichert, bei unverändertem Stand bleibt
  der Checkout unangetastet.
- **DV-Monatstabelle zeigt einen fehlenden Monatsmarktwert als „–“** statt
  als 0 ct.
- **EOS bekam die Gerätezähler nie gesetzt — und lieferte deshalb still keinen
  Plan mehr.** Der Konfigurationsabgleich schrieb Akku und Wechselrichter, aber
  nicht `devices/max_batteries` bzw. `max_inverters`. Ohne sie gilt die
  Geräteliste für EOS als nicht konfiguriert: es rechnet mit einem
  Standardakku, und die daraus abgeleiteten Messschlüssel entstehen gar nicht
  erst. Jeder SoC-Wert läuft dann in ein „Key 'battery1-soc-factor' not found",
  der Optimierer rechnet mit einem Ladestand von 0 und gibt keine Lösung aus —
  DVhub fällt still auf den internen Plan zurück. Auf einer Anlage, deren EOS
  seit Wochen durchlief, fiel das erst beim ersten Neustart auf: die Werte
  waren nur zur Laufzeit gesetzt und nie in die EOS-Konfigurationsdatei
  gelangt. Beide Zähler werden jetzt vor den Geräten geschrieben.
- **Abhängigkeits-Pin für EOSdash hing an der Gewohnheit statt an seiner
  Ursache.** Die Bereitstellung nagelte `starlette` pauschal auf `<1.0` —
  nötig war das nur für EOS `v0.3.0`, das über `monsterui` ein altes
  `fasthtml` hereinzieht. Bei neueren EOS-Ständen stufte der Pin die
  Abhängigkeit wieder herunter, in ein Regime, gegen das upstream nicht
  testet, und zwar lautlos: EOS startete trotzdem. Der Pin greift jetzt nur
  noch, wenn die aufgelöste `python-fasthtml` älter als 0.14 ist.

## [1.0.6] - 2026-09-05

### Neu

- **Akku-Ausbaustufen mit Datum.** Die Zyklenberechnung teilte die Entladeenergie
  jedes historischen Tages durch die *heutige* Nennkapazität. Wer seinen Speicher
  erweitert, verschob damit rückwirkend seine gesamte Zyklenhistorie: nach einem
  Ausbau von 43 auf 77 kWh zeigte derselbe Monat nur noch gut die Hälfte der
  tatsächlich gefahrenen Zyklen. In den Einstellungen lassen sich jetzt datierte
  Kapazitätsstufen pflegen; jeder Tag der Historie rechnet mit der Kapazität, die
  damals verbaut war. Ein Rückbau ist dieselbe Eingabe mit kleinerem Wert.

  Die heute gültige Stufe ist zugleich der aktuelle Kapazitätswert — Optimierung
  und EOS lesen ihn automatisch, es bleibt genau ein Feld statt zweier Wahrheiten,
  die auseinanderlaufen können. Zeiträume vor der ältesten Stufe erben deren Wert;
  wer das erste Inbetriebnahmedatum nicht mehr weiß, muss keines erfinden. Ohne
  gepflegte Stufen ändert sich nichts.

- **Steuerbare Last wird aus der gelernten Lastkurve herausgerechnet.** Die
  Lastprognose lernte bisher aus dem Gesamthausverbrauch — inklusive Wallbox und
  geschalteter Geräte. Plant EOS diese Lasten anschließend zusätzlich ein, zählt
  dieselbe Kilowattstunde doppelt. Neben der unveränderten Rohserie steht jetzt
  eine bereinigte Serie, aus der die Prognose künftig lernt. Abgezogen wird nur,
  was positiv bestätigt ist: das Auto muss laden, zuhause sein, und die Messwerte
  müssen frisch sein; Geräte müssen als gesteuert markiert und online sein. Bei
  jedem Zweifel bleibt die bereinigte Serie gleich der rohen.

  Zwei Randbedingungen sind an echten Anlagendaten gemessen, nicht angenommen:
  Der Ortsfilter ist zwingend — ohne ihn würde Auswärtsladen am fremden Lader mit
  rund 10,7 kW aus dem eigenen Hausverbrauch abgezogen, den es nie belastet hat.
  Und das Ladesignal des Autos bleibt nach Ladeende stehen, im Extremfall über
  22 Stunden; ohne Frischeprüfung würde ein solcher Wert stundenlang weiter
  abgezogen. Ergibt die Rechnung einen negativen Wert, wird bewusst *nicht*
  abgezogen und ein Ereignis protokolliert, statt den Fehler auf null zu kappen.

  Die Prognose selbst wird noch nicht umgestellt — dafür muss die neue Serie
  erst Historie aufbauen.

- **Beta-Gate für Einstellungen.** Ein Feature, das noch im Feldtest ist, taucht
  in den Einstellungen nur im Bleeding-Edge-Kanal auf — und läuft auch nur dort.
  Der zweite Teil ist der wichtige: der Schalter eines Beta-Features wird nicht
  mehr direkt ausgewertet, sondern nur zusammen mit dem Kanal. Ein `enabled:
  true`, das aus einer Testkonfiguration stammt oder von einem früheren
  Kanalwechsel übrig ist, bleibt auf einer Produktivanlage damit wirkungslos,
  statt still mitzulaufen. Für Herstellerprofile gab es dieses Gate schon; jetzt
  gilt dasselbe für Einstellungen. Betrifft zunächst Einfrier-Wächter,
  MQTT-Kreuzprobe und Schreib-Verifikation — alle drei sind Feldtests.

- **PV an Netz-Eingang UND Verbraucher-Ausgang gleichzeitig (#13).** Die
  Positionsauswahl kannte bisher nur ein Entweder-oder — ein Registerblock,
  verschoben. Wer zwei AC-Wechselrichter an verschiedenen Stellen des
  Victron-Systems hat (etwa Hoymiles am Netz-Eingang, SolarEdge am
  Verbraucher-Ausgang), konnte das nicht abbilden, egal wie das Profil
  bearbeitet wurde. Neu unter Einstellungen → Verbindung: „Zweite AC-PV-Position
  (optional)". Ist sie gesetzt, werden beide Registerblöcke gelesen und ihre
  Leistung addiert (on-output 808–810, on-grid 811–813, on-genset 814–816).
  Dieselbe Position zweimal bleibt wirkungslos, sonst stünde ein Block doppelt
  in der Summe. Ohne zweite Position ändert sich nichts.

- **SPiNE EnergyLink One als Netzzähler-Quelle.** Vierter Zählerzweig neben
  MQTT, float32 und Modbus: liest den eingebauten Dreiphasenzähler des
  EnergyLink One über dessen lokale API (`GET /rpc/EM.GetStatus`,
  Shelly-Pro-3EM-Semantik). Aktiv nur mit `meter.readType = 'spine-http'`; die
  bestehenden Zweige und die Victron-/Fronius-Punkte bleiben unverändert.
  Fehler und ungültige Werte laufen in den vorhandenen Backoff-Pfad — keine
  stille 0 im Steuerpfad.

### Behoben

- **Der Einspeise-Puffer wirkte während der Abregelung doch nicht.** Das
  Herstellerprofil enthielt weiterhin ein fest eingetragenes `-40 W`, und der
  gesamte `dvControl`-Zweig galt als „vom Hersteller verwaltet": er wurde beim
  Laden aus der Konfiguration entfernt und komplett durch den Profil-Block
  ersetzt. Damit gewann das Profil-`-40` gegen den eingestellten Default Grid
  Setpoint — der in 1.0.5 gebaute Puffer kam in der Abregelung nie an. Der
  Schlüssel ist jetzt aus allen vier ausgelieferten Profilen entfernt; die
  Abregelung folgt dem Wert unter „Zeitplan → Grundzustand" (ein Wert, wie
  vorgesehen). Ein Regressionstest prüft, dass kein Profil ihn wieder festnagelt.
- **Der Schalter „Aktive Anlagensteuerung (DV-Schnittstelle)" ließ sich nicht
  bedienen.** Er lag im selben verworfenen Zweig: Speichern blieb wirkungslos,
  nach dem Neuladen stand er wieder auf AUS. Vom Herstellerprofil verwaltet ist
  jetzt nur noch die Register-Verdrahtung (`feedExcessDcPv`,
  `dontFeedExcessAcPv`, `zeroFeedIn`); die beiden Betreiber-Entscheidungen
  darin — der Schalter selbst und der Negativpreis-Schutz — bleiben in der
  Konfiguration stehen und schlagen den Profil-Default.
- **Schalter ohne gespeicherten Wert zeigten AUS, obwohl die Funktion lief.**
  Die Einstellungen-Seite stellte für Ja/Nein-Felder nur den gespeicherten Wert
  dar; fehlte er, erschien ein leerer Haken statt des wirksamen Zustands.
  Betraf auf einer typischen Anlage „Aktive Anlagensteuerung" und
  „Hausverbrauch abziehen".
- **Die AC-PV-Positionsauswahl aus #5 war seit 1.0.3 wirkungslos.** Das
  Herstellerprofil besitzt den kompletten `victron`-Block und ersetzt ihn beim
  Laden; persistierte Schlüssel überleben das nur über eine ausdrückliche
  Durchreichliste — `acPvSource` stand nicht darin und fiel still weg. Auf jeder
  Box mit aktivem Profil, also praktisch jeder, blieben die Adressen damit auf
  808–810, gleich was eingestellt war (der Befund hinter #13 „ohne Wirkung").
  Beide Felder stehen jetzt in der Durchreichliste; ein Regressionstest läuft
  mit echtem Profil-Setup, weil die bisherigen Tests ohne Profil liefen und das
  deshalb nicht sehen konnten.
- **Jahres- und Alle-Auswertung liefen ins Timeout — und „Alle" konnte den Hub
  anhalten.** Die Antwort ist klein, der Weg dorthin war es nicht: die Datenbank
  hält rund 35 Zeilen je Viertelstunden-Slot (24 Serien × Quellen), ein Jahr
  waren ~725.000 Zeilen über die Leitung für ~24.000 Slots. Dazu lud „Alle" die
  gesamte Historie in einer einzigen Abfrage — auf einer Box mit 2 GB hat das
  den Speicher aufgebraucht, bis kein Dienst mehr antwortete. Und die
  Aggregation blockierte den Prozess mehrere Sekunden am Stück, länger als der
  Modbus-Keepalive.

  Jetzt fasst die Datenbank die Zeilen zu einer je Slot zusammen, Jahr und Alle
  laden monatsweise (der Speicherbedarf hängt am größten Monat, nicht an der
  Spanne), Datumsformatierer werden wiederverwendet statt je Slot neu gebaut,
  und zwischen den Rechenschritten gibt der Prozess die Steuerung zurück.
  Gemessen auf einer 2-GB-Anlage: Jahr 20 s → 7 s, Alle 31 s → 12 s (vorher
  Speicherabbruch), längste Blockade 14 s → 3 s. Die Zahlen selbst sind
  unverändert — über abgeschlossene Zeiträume liefern alter und neuer Stand
  dasselbe Ergebnis Byte für Byte.

## [1.0.5] - 2026-07-28

Wartungs-Release. Es behebt den Netzbezug während der Abregelung und macht den
Einspeise-Puffer aus dem Anwender-Feedback überall wirksam. Dazu der
vollständige MQTT-Anschluss.

Zwei Diagnose-Funktionen (Einfrier-Wächter, Zweitquellen-Kreuzprobe) reisen im
Code mit, sind **standardmäßig ausgeschaltet** und stehen unter „Enthalten, aber
noch nicht freigegeben". Freigabe, sobald sie genügend getestet sind.

### Neu

- **„Default Grid Setpoint" ist jetzt der Einspeise-Puffer — überall.** Steht der
  Netz-Sollwert auf 0, regelt die Anlage auf „null am Zähler"; schaltet dann ein
  großer Verbraucher zu (Herd, Wärmepumpe, Wallbox), entsteht kurzzeitig bis zu
  1 kW Netzbezug, weil die Regelung dem Lastsprung hinterherläuft. Der bereits
  vorhandene Wert unter „Zeitplan → Grundzustand" wirkt deshalb nicht mehr nur
  als Rückfallwert, wenn gar keine Regel läuft, sondern als **Untergrenze für
  jeden** Sollwert — auch gegenüber Regel, Optimierer und EOS. Richtwert: etwa
  so viel, wie die größte einzelne Last zieht, typisch −100 bis −500 W. Der
  kleine Dauer-Export ist reiner Regel-Puffer; nennenswert eingespeist wird
  dabei nichts. **Es gibt dafür bewusst keine zweite Einstellung**, auch nicht
  für die Abregelung — ein Wert, der überall gilt. Ein stärkerer Export wird nie
  abgeschwächt und ein gewolltes Netzladen nie umgedreht. Aus bleibt der Puffer,
  wenn der Börsenpreis negativ **oder unbekannt** ist (ein ausgefallener
  Preis-Feed darf keinen Export erzwingen), im Not-Halt und unterhalb des
  Entlade-Bodens — der Akkuschutz behält immer Vorrang.
  Danke an **Johann (@VdwBM)** für den Hinweis (GitHub #12).

- **MQTT-Weg vervollständigt.** Wer die Anlage über MQTT statt Modbus anbindet,
  bekommt jetzt auch Geräte-Alarme (Banner), die Rücklesung der Steuerpunkte und
  die Entladegrenze — bisher gab es das nur über Modbus. Außerdem unterstützt
  der MQTT-Zugang endlich Benutzername/Passwort und verschlüsselte Verbindungen;
  ohne das ließ sich ein aktuelles Victron-GX gar nicht anbinden.

- **Wirkungsgrad-Anpassung der Reserve-Freigabe wird angezeigt.** Die
  Einstellungen zeigen jetzt auch, ob die Übernacht-Reserve ihre Freigabe-Schwelle
  mit dem gemessenen Wirkungsgrad rechnet oder mit einem angenommenen. Die
  Einstellung war schon aktiv, ließ sich am Gerät aber nirgends ablesen.

### Enthalten, aber noch nicht freigegeben

Standardmäßig ausgeschaltet und noch im Feldtest — bitte noch nicht
einschalten. Beide greifen in den Regelpfad ein bzw. halten Entladebefehle an.
Freigabe, sobald sie genügend getestet sind.

- **Einfrier-Wächter für die Live-Daten.** DVhub erkennt jetzt den Fall, dass die
  Anlage zwar sauber antwortet, aber immer denselben Messwert liefert — eine
  halb-tote Modbus-Sitzung am GX/Wechselrichter (beobachtet am 24.07.2026: der
  Ladestand hing 2,5 Stunden bei 7 %, während die Anlage real weiterlief; kein
  einziger Lesefehler, keine Warnung). Zwei Erkennungen: (1) alle Live-Werte
  stehen gleichzeitig unverändert still, obwohl Leistung fließt; (2) der
  Ladestand bewegt sich nicht, obwohl fortlaufend Akku-Leistung gemeldet wird.
  Bei Verdacht datiert DVhub die Frische der Messwerte auf den letzten echten
  Wertwechsel zurück (womit der bestehende Entlade-Boden-Schutz jede erzwungene
  Entladung anhält), verwirft die Modbus-Verbindung und baut sie neu auf und
  schlägt laut Alarm: Banner im Leitstand, Push-Benachrichtigung, Log-Eintrag
  „critical", Monitoring-Signal (`dvhub_telemetry_freeze_active`). Neue
  Einstellungen unter „Verbindung" (`victron.freezeWatchdog.*`), **Standard AUS**
  — der Wächter greift in die Regelung ein und seine Schwellen sind bisher nur
  an einer einzigen Anlage erprobt; einschalten, wenn eingefrorene Messwerte
  vermutet werden.
  Die Schwellen sind gegen fünf Tage echte Anlagendaten kalibriert: die
  Ladestand-Erkennung arbeitet nur im linearen Bereich (10–95 %), weil der
  Ladestand in der Absorptionsphase eines vollen Akkus stundenlang legitim
  stillsteht. Der Verbindungs-Neuaufbau ist auf drei Versuche je Vorfall
  begrenzt — ein Abriss-/Neuaufbau-Karussell belastet die Anlagensteuerung
  nachweislich bis zum Neustart; hilft der Neuaufbau nicht, bleibt der Alarm.

- **Zweitquellen-Kreuzprobe (MQTT).** DVhub kann die Messwerte der Anlage jetzt
  über einen zweiten, unabhängigen Weg gegenlesen: den MQTT-Dienst der Anlage.
  Der läuft als eigener Dienst neben der Modbus-Schnittstelle und zeigt dasselbe
  wie das Display am Gerät. Widersprechen sich beide Wege dauerhaft (Standard:
  3 Minuten), meldet DVhub das laut — Banner, Push-Nachricht, Log-Eintrag
  „critical", Monitoring-Signal — und setzt keine neuen Entladebefehle mehr ab.
  Hintergrund: Am 24.07.2026 lieferte die Modbus-Schnittstelle 2,5 Stunden lang
  veraltete, aber in sich stimmige Werte; kein einziger Test *innerhalb* der
  Modbus-Daten konnte das erkennen (auch eine zweite Modbus-Verbindung nicht).
  Neue Einstellungen unter „Verbindung" (`victron.mqttCrossCheck.*`), Standard
  AUS — sie braucht die Zugangsdaten des MQTT-Dienstes.

### Behoben

- **Netzbezug während der Abregelung.** Zwei Fehler wirkten hier zusammen.
  Erstens überschrieb die Abregelung bei negativen Börsenpreisen einen
  eingestellten Netz-Sollwert (z. B. −100 W) für ihre gesamte Dauer mit fest
  eingebauten −40 W — der eingestellte Wert kam einfach nicht durch. Zweitens
  griff der Schutz nur, wenn eine Regel *mehr* Export wollte als dieser Wert:
  wollte sie 0, fiel das durch und es wurde tatsächlich 0 geschrieben, also
  „null am Zähler" mitten in der Abregelung — mit genau den Bezugsspitzen, die
  dort besonders teuer sind. Jetzt gilt auch während der Abregelung dein
  eingestellter Sollwert, und er wird **gehalten** statt nur nach oben begrenzt.
  Zur Sicherheit ist er dabei auf 1000 W gedeckelt, damit aus dem Ausregeln kein
  echter Verkauf bei negativem Preis wird. Ein bewusstes Netzladen (positiver
  Sollwert) bleibt unangetastet — das ist bei negativen Preisen wirtschaftlich
  richtig und keine Einspeisung.

- **Einstellungen der Gruppe „Verbindung" wirkten nicht.** „Telemetrie-Frische
  max. Alter" und „Modbus Connect-Timeout" wurden beim Anwenden des
  Herstellerprofils überschrieben und fielen still auf ihre Standardwerte
  zurück. Beide Werte (und die neuen Wächter-Einstellungen) überleben die
  Profil-Anwendung jetzt.

## [1.0.4] - 2026-07-21

Bugfix-/Komfort-Release. Schwerpunkte: korrekte §14a-Modul-3-Preisrechnung,
robuste Lizenz-Aktivierung in einem Schritt, Sichtbarkeit der
EOS-Übernacht-Reserve in den Einstellungen und die Fronius-Nulleinspeisung
bei vollem Akku.

### Neu

- **Fronius GEN24: Nulleinspeisung bei Abregelung auch mit vollem Akku.** Die
  Negativpreis-/Direktvermarkter-Abregelung hält den Eigenverbrauch jetzt in
  jedem Fall aufrecht: Solange der Akku Platz hat, zwingt Force-Charge den
  PV-Überschuss in den Speicher (wie bisher); ist der Akku voll (Schwelle
  einstellbar, Standard 95 % SoC), drosselt ein 5-s-Regelkreis den
  Wechselrichter lastfolgend auf die Hauslast (SunSpec Model 123 `WMaxLimPct`,
  nie auf 0) und gibt die Akku-Entladung frei, damit der Akku bei PV-Defizit
  das Haus stützt — Export aus dem Akku verhindert der Leistungsdeckel
  physikalisch. Failsafe über `WMaxLimPct_RvrtTms`: Fällt DVhub aus, hebt der
  Wechselrichter das Limit selbst wieder auf. Neue Einstellungen unter
  „Nulleinspeisung bei Abregelung" (`zeroFeedIn.*`).
- **Lizenz-Aktivierung in einem Schritt.** „Aktivieren" bindet die Lizenz
  jetzt automatisch an die Box — der bisher nötige zweite Klick auf „An diese
  Box binden" entfällt (der Button bleibt als Fallback). Bereits aktivierte,
  aber nie gebundene Bestands-Lizenzen werden bei der nächsten periodischen
  Prüfung automatisch nachgebunden. Zusätzlich ist die Schlüssel-Eingabe
  robust gegen Zeilenumbrüche/Leerzeichen aus kopierten Lizenz-Mails.
- **Nacht-Reserve-Status sichtbar.** Der EOS-Inspector zeigt eine neue Karte
  „Nacht-Reserve" mit dem wirksamen Zustand der EOS-Übernacht-Reserve
  (aktiv/aus, Verkaufs-Marge, Blackout-Puffer, Wasserfall-Modus) — bisher war
  diese serverseitige Konfiguration in der Oberfläche unsichtbar. Der
  Hilfetext der (unverwandten) „Forecast-aware Reserve" der Kleinen
  Börsenautomatik grenzt die beiden Features jetzt klar ab.
- **Standard-Werte sichtbar.** Leere Einstellungs-Felder zeigen ihren wirksam
  greifenden Standard als Platzhalter („Standard: X") — aktive Default-Werte
  sind damit nicht mehr unsichtbar.
- **Steuerbefehl-Verifikation (Opt-in, experimentell).** Neuer
  Read-after-Write-Regelkreis: Nach jedem Steuerbefehl liest DVhub den
  Ist-Zustand vom Gerät zurück und schreibt bei Abweichung automatisch neu
  (`schedule.controlWriteVerify.enabled`, Standard aus). Feldtest auf einer
  Victron/Modbus-Anlage bestanden.
- **Echte DC-Akku-Leistung am Fronius GEN24** via SunSpec Model 160
  (`batteryPowerW`) — Grundlage für genauere Akku-Telemetrie und -Historie.
- **Fronius M124: Kunden-Registerwerte werden vor dem ersten Sperren
  restart-fest gesichert** und bei der Freigabe wiederhergestellt.
- **EOS → E-Auto-Mitoptimierung** als Beta-Karte in den Einstellungen
  zuschaltbar; die **DV-EOS-Endpunkt-URL** ist im Integrations-Drawer
  editierbar (beliebige EOS-Installation anbindbar).
- **PV-Nowcast** ist im bezahlten Plan jetzt automatisch aktiv (kein
  separater Schalter mehr).
- **EOS-Fork (Beta, standardmäßig aus):** Wasserfall-Reserve-Release
  (`EOS_RESERVE_WATERFALL`) und lastabhängige
  Wechselrichter-Wirkungsgradkurve (`EOS_INVERTER_EFF_CURVE`) liegen dem
  EOS-Drop-in bei — Aktivierung bewusst nur serverseitig, Replay-validiert.

### Behoben

- **§14a Modul 3: Fensterpreis ersetzt das Netzentgelt, nicht den ganzen
  Bezugspreis** (Issue #11). Bei dynamischem Tarif wurde der
  Hoch-/Tiefphasen-Bruttopreis fälschlich als absoluter Bezugspreis
  angesetzt — betroffen waren Slot-Preise, History-Chart und die
  EOS-Optimierung. Festpreis-Tarife behalten die bisherige Semantik.
- **Zeitplan-Vorschau zeigte nach einem Leistungs-Upgrade weiter „Akku
  16000".** Der Vorschau-Cap folgt jetzt der Leistungs-Kette
  (`akkuAcLimitW → maxDischargeW → maxChargeW → inverterMaxPowerW`) statt
  einem hartcodierten 16-kW-Wert.
- **Fronius: Meter-Kalibrierung + Hauslast-Ableitung** am Kunden-GEN24
  verifiziert; **Not-Halt** erzeugt kein irreführendes
  `neutralize_failed`-Fehlerlog mehr, wenn kein gridSetpointW-Stellpfad
  aktiv ist; **`feedExcessDcPv`-API** antwortet auf Sequenz-Profilen ehrlich
  (Modbus-exception-2-Bug).
- **VRM-Forecast ohne Token** erzeugt keinen Log-Spam mehr
  (`vrm_forecast_read_empty` still bzw. auf 1×/15 min gedrosselt).
- **Einstellungen:** PV-Prognose-Quelle zeigt ehrliche Ensemble-Labels;
  tote „ML & Forecast-Korrektur"-Karte entfernt.

## [1.0.3] - 2026-07-11

Bugfix-/Stabilisierungs-Release. Führt das **Beta-Flag für Herstellerprofile**
ein: ungetestete Treiber (Fronius, Deye, MQTT-Bridge) bleiben damit aus dem
Stable-Kanal heraus und sind nur noch im Bleeding-Edge-Kanal sichtbar, bis ihr
Test an echter Hardware bestanden ist. An der Victron-Steuerung ändert dieses
Release nichts.

### Neu

- **Beta-Flag für Herstellerprofile:** Ein Herstellerprofil kann sich als
  `"beta": true` markieren. Solche Profile erscheinen im Hersteller-Dropdown
  nur, wenn der Update-Kanal auf „Bleeding Edge (Dev)" steht — im
  Stable-Kanal sind sie unsichtbar, damit unfertige Treiber nicht versehentlich
  in einer Produktivumgebung landen. Ein bereits aktiv gewähltes Beta-Profil
  bleibt immer sichtbar. Markiert sind aktuell `fronius`, `deye-lv` und
  `bridge-mqtt` (Test an echter Hardware ausstehend — Tester bitte melden:
  info@bikinibottom.capital).
- **Fronius GEN24 (Beta): Abregelung über Batteriesteuerung statt
  Leistungskappung:** Die DV-Abregelung nutzt jetzt die
  SunSpec-Model-124-Batteriesteuerung — derselbe Weg, den evcc fährt:
  „keine Einspeisung" zwingt den PV-Überschuss in den Speicher
  (`StorCtl_Mod=2` + `OutWRte=-100 %`), das Haus bleibt aus PV+Akku versorgt;
  die Freigabe stellt den Normalbetrieb wieder her (`0` / `100 %`). Das in
  1.0.2 deaktivierte `WMaxLimPct`-Verfahren (kappte die gesamte
  Wechselrichter-Leistung) ist vollständig entfernt. Hinweis: Bei vollem
  Speicher kann wieder eingespeist werden — eine garantierte Nulleinspeisung
  braucht zusätzlich das geräteseitige Fronius-Export-Limit. Voraussetzung:
  Energiekosten-Assistent (ECA) in Solar.web deaktiviert.
- **Universal-MQTT-Herstellerprofil (`bridge-mqtt`, Beta):** Neues offizielles
  Herstellerprofil „Universal (MQTT-Bridge)" — jeder nicht nativ unterstützte
  Wechselrichter (Deye, Growatt, …) wird über eine kleine MQTT-Bridge nach dem
  dokumentierten Venus-Topic-Schema angebunden (erster Baustein des
  v1.1-Multi-Vendor-Plans, D-27). Broker-URL und Portal-ID sind jetzt direkt in
  den Einstellungen konfigurierbar (`victron.mqtt.*` ist nicht mehr
  profil-verwaltet; leere Felder nutzen die Profil-Defaults) — der bisherige
  Datei-Edit an `victron.json` entfällt. Das Hersteller-Dropdown listet
  Profile dynamisch aus dem `hersteller/`-Ordner (inkl. Anzeigename aus dem
  neuen `label`-Feld), Installer und Updater legen neue mitgelieferte Profile
  auf Bestandsboxen nach (ohne bestehende Dateien zu überschreiben), und der
  Einrichtungs-Assistent setzt einen vorkonfigurierten Hersteller nicht mehr
  auf Victron zurück.

### Behoben

- **Hersteller-Dropdown zeigte eine interne Datei:** Die Manifest-Datei
  `.shipped-hashes.json` (Baseline der Profil-Updates aus 1.0.2) tauchte als
  wählbarer „Hersteller" im Dropdown auf. Versteckte Dateien werden jetzt
  übersprungen.

## [1.0.2] - 2026-07-11

Bugfix-Release. Behebt gemeldete Multi-Vendor-/Steuerungs-Issues aus dem Feldtest.

### Behoben

- **#3 Fronius (Beta) legte Hybrid-Anlagen lahm:** Die DV-Abregelung mappte die
  Victron-„Nulleinspeisung" auf SunSpec Model 123 `WMaxLimPct=0` — das kappt die
  GESAMTE Wirkleistung des Wechselrichters, nicht nur die Netzeinspeisung. Bei
  GEN24 + Batterie lud die PV nur noch den Speicher, das Haus zog Netzstrom. Die
  aktive Abregelung ist in Stufe 1 jetzt deaktiviert (DVhub schreibt kein
  `WMaxLim`-Register mehr); die korrekte Export-Limitierung folgt mit dem
  Soft-ESS-Regler. Rücksetz-Anleitung: `docs/FRONIUS-ABREGELUNG-RUECKSETZEN.md`.
  Die MinRsvPct-Anzeige (lieferte `0xFFFF`) ist ebenfalls deaktiviert.
- **#10 Victron: Dynamische Regelung blieb nach dem Deaktivieren aktiv:** Die
  Venus-Settings `OvervoltageFeedIn`/`PreventFeedback` (reg 2707/2708) sind
  persistent; DVhub ließ seine zuletzt gesetzte Sperre stehen. Jetzt gibt DVhub
  die Einspeisung beim Deaktivieren der Steuerung (und bei jedem Start mit
  deaktivierter Steuerung) einmalig aktiv wieder frei — es setzt keine Sperre bei
  deaktivierter Steuerung. Offenlegung + manuelle Rücksetz-Wege:
  `docs/VICTRON-DYNAMISCHE-REGELUNG-ABSCHALTEN.md`.

### Neu

- **Herstellerprofil-Updates erreichen Bestandsboxen (T-MANAGED-VENDOR-PROFILES):**
  Bisher wurde ein vorhandenes Herstellerprofil beim Update NIE überschrieben, sodass
  Profil-Bugfixes (wie der Fronius-Fix) Bestandsanlagen nicht erreichten. Jetzt
  aktualisiert der Installer/Updater ein UNVERÄNDERTES Profil auf die neue Version,
  lässt aber vom Operator geänderte Profile (z. B. `victron.json` auf
  `transport=mqtt`) unangetastet und legt die neue Version als `<name>.dist` daneben.
- **Gezielter Commit-Pin im Self-Update:** Beta-Tester können im Bleeding-Edge-Kanal
  einen bestimmten Commit installieren (Eingabefeld in den Einstellungen bzw.
  `ref` an `/api/admin/update/apply`) — mit Erreichbarkeits-Anker gegen `origin/main`.
- **Deye-Direktanbindung (Beta):** Herstellerprofil „Deye SUN-…SG04LP3 (LV, 3-phasig)"
  für Telemetrie + DV-Abregelung über ein RS485-Ethernet-Gateway
  (`docs/DEYE-ANBINDUNG.md`); Fronius-GEN24-SunSpec-Profil (Beta).

## [1.0.1] - 2026-07-09

Bugfix-Release. Behebt gemeldete GitHub-Issues aus dem 1.0-Feedback.

### Behoben

- **#2 Min-SOC:** wird serverseitig auf 5%-Schritte gerundet. Venus OS akzeptiert
  den SOC-Mindestwert nur in 5er-Schritten — krumme Werte (z. B. 23%) sprangen
  zuvor auf ~20% zurück.
- **#8 DV-Schnittstelle abschaltbar + Not-Halt:** Die aktive Anlagensteuerung
  lässt sich jetzt in den Einstellungen deaktivieren — wichtig für Volleinspeiser
  mit fester EEG-Vergütung, deren PV sonst ungewollt abgeregelt wurde. Zusätzlich
  gibt der Not-Halt die dynamische PV-Abregelung jetzt korrekt wieder frei.
- **#9 MQTT-Aktivierung:** Das Speichern der MQTT-Konfiguration zeigt nun den
  erforderlichen Neustart-Hinweis (MQTT verbindet beim Boot) — vorher schien das
  Aktivieren wirkungslos.
- **#9 „Instabil"-Anzeige:** Die Verbindungs-Einstufung „Instabil" hing bis zu
  24 Stunden nach — ein einmaliger Fehler-Burst beim Einrichten markierte die
  Anlage stundenlang als instabil, obwohl längst alles lief. Jetzt zeigt sie nur
  noch **aktuelles** Flappen (letzter Fehler < 15 min) und erholt sich selbst.
- **#7 Kein API-Token mehr im LAN:** Der Standard ist jetzt „LAN offen" — im
  lokalen Netz ist kein API-Token nötig (behebt „Speichern fehlgeschlagen:
  unauthorized"). Härtung bleibt optional (Einstellungen → Sicherheit).
- **#6 / #7 Hilfetexte:** Präzisere Anleitungen für VRM (Portal-ID vs. Site-ID,
  Access-Token) und den Netzzähler (Modbus-RTU-Altzähler wie EM540/ET340 werden
  über das Victron-System gelesen).

### Neu

- **#5 AC-PV-Position wählbar:** Bei AC-gekoppelter PV (eigener String-Wechsel-
  richter am Victron-System, z. B. SMA oder Fronius) kann die Verdrahtungsposition
  gewählt werden: **Am Verbraucher-Ausgang** (Standard), **Am Netz-Eingang** oder
  **Am Generator-Eingang**. Hintergrund: Das Victron-GX führt die AC-PV-Leistung
  je nach Anschlussstelle in getrennten Registern. Ein nachgerüsteter Wechsel-
  richter am Netz-Eingang wurde dadurch bisher nicht als PV erkannt, sondern als
  Netzbezug verbucht — die neue Einstellung ordnet die Erzeugung korrekt zu, ganz
  ohne separaten Netzzähler.

## [1.0.0] „Sushi" - 2026-07-08

> Codename **„Sushi"** — gewidmet dem jungen Kater, der die Entwicklung begleitet
> hat: Tastaturen inspiziert, Logs überwacht und dafür gesorgt, dass kein
> Entwickler zu produktiv wurde. _This release is dedicated to him._

<!-- Veröffentlichungsdatum = Datum des operator-gegateten `v1.0.0`-Git-Tags. -->

Erstes öffentliches v1.0-Release. Konsolidiert den vollständigen Funktionsumfang
des HEMS-Ausbaus aus 0.8.0 und ergänzt ihn um fünf gezielte Go-Live-Härtungswellen
(23–27), die DVhub von „funktioniert auf der eigenen Box" zu „auslieferbar" bringen.

**Kernfunktionen (zur v1.0 ausgereift):**

- PV-/Last-Prognose-Engine (pvlib + statsforecast/LightGBM, Multi-Modell-Ensemble,
  Accuracy-Tracking, Forecast-Snapshots)
- Batterie-Optimierung: interner MILP-Optimizer (HiGHS) und Anbindung von
  Akkudoktor-EOS als externer Arbitrage-Engine mit 15-Minuten-Slots
- zweistufige Forecast-aware Börsenautomatik mit Reserve-/Hoarding-Gate und
  vorausschauender Akku-Leerung
- Aurora Design System über alle Seiten, Familien-Dashboard mit haus-zentriertem
  Energy-Flow, History-Seite mit Visualisierungs-Karten und Export
- Integrationen: Victron ESS (Modbus), MQTT mit Home-Assistant-Auto-Discovery,
  TeslaMate, Telegram-/Pushover-Benachrichtigungen, VPN-Manager
- Lizenz-Gating (Pro-Features) für die kommerzielle Auslieferung

**Deploy-Blocker behoben (Welle 1 / Phase 23):**

- TimescaleDB-Frischinstall: `timescaledb`-Default entschärft, ungegatete
  Retention-Migration (018) abgesichert
- Migrations-Runner mit Per-Migration-Fehlertoleranz; `deploy-test.sh` prüft
  jetzt echte Schema-Migrationsversionen statt nur Zeilenzahlen
- eine saubere Neuinstallation läuft ohne Crash durch

**Sichere Auslieferungs-Defaults (Welle 2 / Phase 24):**

- VPN-Config-Upload-Pfad re-auditiert
- LAN-Trust-/Host-/Proxy-Defaults gehärtet, Bootstrap-Setup-Token
  constant-time-vergleich, Redaction-Lücken geschlossen
- `family.html`-Shell hinter das Pro-Gate gelegt (explizite Route vor
  Static-Fallback)

**Steuerpfad-Korrektheit (Welle 3 / Phase 25):**

- EEG-Gate verfeinert: Selbstverbrauch/mandatory/`dc_export` passieren,
  erzwungene Netz-Entladung bleibt blockiert
- atomare (tmp+rename) Persistenz des Not-Halt-Zustands
- konfigurierbarer Modbus-Connect-Timeout (Default 5000 ms) — ein toter Host
  blockiert den Poll nicht mehr

**Forecast-Qualität (Welle 4 / Phase 26):**

- VRM/forecast_solar/open_meteo fließen ins gewichtete Ensemble (größter
  Qualitäts-Hebel)
- Inverse-MAE-Gewichte pro Slot auf vorhandene Provider renormiert
- Solcast auf Perioden-START normalisiert, Zeitzonen-Eingaben gegen ungültige
  IANA-Zonen abgesichert, §51-Stundenstreak über die View-Range-Grenze hinweg

**Test-Fundament & CI (Welle 6 / Phase 27):**

- kaputte SQLite-Test-Importpfade repariert (Suite wieder lauffähig)
- `pickMilpPlan`-Steuerpfad unter Test gestellt
- GitHub-Actions-CI (Fast-Lane + ephemeres Postgres für Migrationen + e2e),
  Setup-Wizard-Happy-Path als e2e-Test

**Release-Metadaten (Welle 5 / Phase 28):**

- Version `0.8.0` → `1.0.0`, defensiver Semver-Filter bei der Self-Update-
  Tag-Auswahl
- diese standalone `CHANGELOG.md` angelegt

**Feinschliff zum Go-Live (2026-07):**

- Historie: die Zeiträume **Woche/Monat/Jahr/Alle** hinter das Pro-Gate gelegt
  (`history-multiperiod`) — die **Tagesansicht bleibt für alle frei**; serverseitig
  (`/api/history/summary|viz/*|export` für `view≠day`) plus Dropdown-Lock mit Pro-Modal
- Forecast: güte-basierte **Ensemble-Gewichtung reaktiviert** — der Merge fiel bei
  fehlender Gestern-Accuracy still auf Gleichgewichtung zurück; jetzt Fallback auf den
  zuletzt verfügbaren Accuracy-Stand statt uniform
- Forecast: **Negativpreis-/Abregelungs-Slots aus der Accuracy ausgeschlossen** —
  abgeregelte Ist-Erzeugung verzerrte sonst MAE und Provider-Gewichte
- **pvnode-Nowcast-Tracking**: Nowcast vs Day-Ahead vs Ist je Tag
  (`/api/forecast/nowcast-track` + nächtliche Historie) — misst, wie viel die
  15-Minuten-Reruns gegenüber der Tagesprognose bringen
- Onboarding: dokumentiert, dass nach der Erstinstallation automatisch
  `onboarding.html` unter `/` erscheint (nicht `setup.html`)

## [0.8.0] - 2026-05-18 — HEMS-Ausbau

Großer Funktionssprung von der reinen DV-Schnittstelle zum Home Energy Management
System. Verdichtete Übersicht der Arbeit seit 0.4.0:

**Prognose-Engine:**

- PV-Ertragsprognose über pvlib mit Standort-/Anlagenparametern
- Lastvorhersage über statistische Modelle (statsforecast) und LightGBM
- Multi-Modell-Ensemble, Nebel-Korrektur, Accuracy-Tracking und Forecast-Snapshots
- optionale Cloud-PV-Provider (Solcast, pvnode.de) als zusätzliche Eingangsdaten

**Optimierung & Börsenautomatik:**

- interner MILP-Batterieoptimizer (HiGHS-Solver) und schnelle Heuristik
- Anbindung von Akkudoktor-EOS als externer Optimizer-Dienst
- Confidence-Gate verwirft Optimierungen bei zu unsicherer Prognose
- zweistufige Forecast-aware Börsenautomatik: Stufe 1 dimensioniert Reserve/Hoarding-Gate
  aus dem PV-Forecast, Stufe 2 („Forecast Aware++") leert den Akku vorausschauend
  mit Soft-/Hard-Limit-Taper und Live-Runtime-Clamp

**ML & Edge-KI:**

- selbstlernende ML-Korrektur des Prognosefehlers mit atomarem Modell-Swap und Schema-Guard
- Hintergrund-Retraining als Jobs, ML-Health-Überwachung
- optionales lokales LLM (TinyLlama via Ollama) für natürlichsprachige Dashboard-Kacheln
  mit deterministischem Template-Fallback und Spracherkennung
- hardware-abhängige Leistungsstufen (RAM-Tiers) im Installer

**Oberfläche & Familien-Dashboard:**

- vollständige Portierung aller Seiten auf das Aurora Design System
- Familien-Dashboard mit Haus-zentriertem Energy-Flow, MQTT-Kacheln,
  Tesla-/EV-Integration und Screensaver-Modus
- History-Seite mit 14 Visualisierungs-Karten und CSV-/Parquet-Export
- eigene Integrations-Seite inkl. MQTT-Inspector, eigener Explorer
- Tools-Seite in die Einstellungen / Status integriert

**Integrationen & Betrieb:**

- MQTT-Publisher mit Home-Assistant-Auto-Discovery, eingebauter Broker (aedes)
- TeslaMate-Anbindung mit DB-historisierten Fahrzeugwerten
- Telegram-/Pushover-Benachrichtigungen
- VPN-Manager für OpenVPN-/WireGuard-/IPsec-Tunnel
- Hersteller-Adapter-Layer, Service-orientierte Architektur
- Prometheus-Metriken unter `/api/metrics`
- TimescaleDB-Unterstützung (Continuous Aggregates & Retention)
- Multi-Schema-Telemetrie, Defence-in-Depth-Security-Hardening
- `THIRD-PARTY-LICENSES.md` als Attributionsdatei ergänzt

## [0.4.0] - 2026-03-24

- Responsive Dashboard (iPhone-Viewport), Hamburger-Navigation ohne JS
- PV-Export-Modus (nutzt `pvTotalW` statt nur DC-PV), Negativpreis-Pause
- sinnvolle Defaults bei Erstinstallation, PV-Kopplungsauswahl (AC/DC/AC+DC)
