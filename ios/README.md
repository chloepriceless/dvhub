# DVhub für iPhone

Native App (SwiftUI, iOS 18+, Deutsch und Englisch) für die Handy-Kopplung mit DVhub: Leitstand mit
Energiefluss, Detailwerte, Börsenpreise und Residuallast-Frühwarnung, Historie,
Fahrplan, E-Auto, Zustand der Anbindungen, Nachrichten, Widgets, Kurzbefehle/Siri, ein Knopf
im Kontrollzentrum und eine Live-Aktivität. Mit Freigabe
„Steuern“ bedient sie die Anlage: Zeitplan, Börsenautomatik, E-Auto-Planung und Not-Halt. Anlagendaten laufen Ende zu
Ende verschlüsselt: im Heimnetz direkt zur Box, unterwegs über das Relay
(`relay.dvhub.de` oder ein selbst gehostetes). Das Protokoll steht in
[`docs/HANDY-APP-PROTOKOLL.md`](../docs/HANDY-APP-PROTOKOLL.md). Öffentliche
Daten (Preise, Prognose, Nachrichten) holt die App direkt bei `dvhub.online`.
Ohne eigene Anlage zeigt die **Demo** alles an einer Beispielanlage (siehe unten).

| Ordner | Inhalt |
|---|---|
| `DVhubLink/` | Swift-Paket: Kryptografie, QR-Code, Kopplung, Verbindung, Schlüsselbund; `Demo/` = die Beispielanlage |
| `DVhubApp/` | Die App und die Widget-Erweiterung `DVhubWidgets` (Xcode-Projekt aus `project.yml` per XcodeGen); `Shared/` gehört beiden |
| `tools/` | String-Kataloge abgleichen und prüfen |
| `interop/harness.mjs` | Echte DVhub-Gegenstelle (Relay + Box-Agent mit Beispielwerten) für Tests |

## Bauen

Voraussetzung: Xcode 27 oder neuer (für das iPhone Duo Xcode 27.1 oder neuer, siehe unten), für die Gegenstelle Node 22 oder neuer.

```bash
brew install xcodegen                     # einmalig
cd ios/DVhubApp && xcodegen generate      # nach Änderungen an project.yml
open DVhubApp.xcodeproj
```

Kommandozeile (Simulator):

```bash
xcodebuild -project ios/DVhubApp/DVhubApp.xcodeproj -scheme DVhubApp \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build
```

## Aufs eigene iPhone (kostenloses Apple-Konto)

Ein bezahlter Entwickler-Account ist dafür nicht nötig.

1. In `DVhubApp/Config/App.xcconfig` eine eigene, weltweit eindeutige Bundle-ID
   eintragen, z. B. `DVHUB_BUNDLE_ID = de.deinname.dvhub`.
2. Xcode → Einstellungen → Accounts → mit der Apple-ID anmelden.
3. Projekt öffnen → Ziel „DVhubApp“ → *Signing & Capabilities* → *Team*: das
   „Personal Team“ wählen (automatisches Signieren bleibt an).
4. iPhone per Kabel verbinden (beim ersten Mal „Diesem Computer vertrauen“) und
   in Xcode als Ziel wählen.
5. Am iPhone den **Entwicklermodus** einschalten: Einstellungen → Datenschutz &
   Sicherheit → Entwicklermodus → Neustart.
6. In Xcode ▶︎ (Run). Beim ersten Start am iPhone: Einstellungen → Allgemein →
   VPN & Geräteverwaltung → Entwickler-App → „Vertrauen“.

**Grenzen ohne bezahltes Konto:**
- Das Profil läuft nach **7 Tagen** ab. Dann startet die App nicht mehr; einfach
  in Xcode erneut ▶︎ drücken. Kopplungen und Schlüssel bleiben erhalten, solange
  die App nicht gelöscht wird.
- Keine **Push-Meldungen** (APNs braucht den bezahlten Account). Alarme sieht
  die App beim Öffnen über den Briefkasten am Relay.
- Kein TestFlight, höchstens 3 eigene Apps gleichzeitig.

**Exportkontrolle (Verschlüsselung):** Die App bringt eine eigene
Ende-zu-Ende-Verschlüsselung mit. Deshalb steht `ITSAppUsesNonExemptEncryption`
bewusst **nicht** in der Info.plist. Beim ersten Hochladen nach App Store
Connect/TestFlight fragt Apple die Einstufung ab; die Antwort ist dann dort zu
geben (ggf. mit Selbsteinstufung nach US-Exportrecht). Beim Aufspielen über
Xcode spielt das keine Rolle.

## Koppeln

1. DVhub-Oberfläche → Einstellungen → „Handy-App“ → „Handy koppeln“.
2. QR-Code in der App unter „Anlage koppeln“ scannen; dann geht es sofort los.
   Kommt der Code über die Kamera-App oder einen Link (`dvhub://…`), zeigt die
   App erst Name, Kennung und Wege (Heimnetz, Relay) der Anlage und koppelt
   erst nach „Koppeln“. Ohne Kamera (Simulator) den Text einfügen.
3. Die App zeigt „Warte auf Freigabe in DVhub …“ und einen **Vergleichscode**.
   In der DVhub-Oberfläche muss derselbe Code stehen; nur dann freigeben und
   „Nur anzeigen“ oder „Anzeigen und steuern“ wählen.

Der Code gilt 5 Minuten und nur für ein Gerät.

Der Geräteschlüssel entsteht in der **Secure Enclave**. Er verlässt das iPhone
nie und ist nur bei entsperrtem Gerät nutzbar. Im Simulator, der keine
Secure Enclave hat, liegt ein Software-Schlüssel im Schlüsselbund
(`ThisDeviceOnly`). Schaltbefehle bestätigt man mit Touch ID (iPhone Duo),
Face ID oder dem Gerätecode.

## Demo

Für alle, die die App ohne DVhub-Box ansehen wollen: Auf dem Startbildschirm steht neben dem Koppeln
**„Demo ansehen“** (ebenso unter Mehr → Anlagen und überall, wo sonst nur „Anlage koppeln“ stünde). Die Demo ist
eine eigene Anlage in der Anlagenliste – eine Beispielanlage mit Victron, 20 kWp Photovoltaik, 20 kWh Akku, Wallbox
und dynamischem Tarif. Jeder Bereich der App zeigt Inhalt, und alles lässt sich bedienen: Not-Halt, Zeitplan-Regeln,
Grundwerte, Börsenautomatik, E-Auto-Planung, Wochenplan, „Sofort laden“. Dabei ändert sich nur der Zustand der Demo.

**Nie verwechselbar.** Solange die Demo gewählt ist, trägt jede Seite oben das Band „DEMO · Beispielanlage · nichts
wird geschaltet“ (es bleibt beim Rollen stehen), die Verbindungsanzeige sagt „Demo läuft – im Gerät, ohne Netz“, die
Anlage heißt „Demo-Anlage“ und steht in der Anlagenliste unter „Demo“ mit der Marke DEMO. Widgets schreiben „Demo“
statt „Stand“, Kurzbefehle antworten mit „Demo-Anlage: …“. **Beenden** geht jederzeit: über das Band, unter „Mehr“
und unter Mehr → Anlagen. Wer eine eigene Anlage koppelt, beendet die Demo damit.

**Kein Netz.** Die Demo rechnet im Gerät. Solange sie gewählt ist, ruht jede Verbindung zu einer gekoppelten Anlage,
und auch Börsenpreise, Prognose und Nachrichten kommen als Beispieldaten aus dem Gerät (als „Beispiel“
gekennzeichnet) – die Demo läuft offline. Abrufe für Widgets, Kurzbefehle und Kontrollzentrum rechnen dann ebenfalls
die Demo; `LinkAccess.selected()` gibt keine Zugangsdaten heraus, auch nicht ersatzweise die einer gekoppelten Anlage.
Der Not-Halt-Kurzbefehl schaltet genau das Ziel, das in seiner Rückfrage stand (`EmergencyStopAction.Target`): Wird
zwischen Rückfrage und Ausführung eine andere Anlage gewählt oder die Demo beendet, schaltet nichts.
Die Bestätigung mit Touch ID, Face ID oder Gerätecode entfällt in der Demo – dort wird nichts geschaltet.
Beispielmeldungen haben ein eigenes Lesezeichen; das der echten Nachrichten bleibt, wo es war.

**Aufbau.** Keine `if demo`-Zweige in den Ansichten, sondern eine zweite Umsetzung derselben Schnittstellen:

| Schnittstelle | echte Anlage | Demo |
|---|---|---|
| `PlantConnection` (Paket) – Ereignisse, Live-Werte, Anfragen | `DeviceConnection` (Heimnetz, Relay) | `DemoConnection` → `DemoBox` |
| `PlantDialer` (`SystemController.swift`) – wie die Verbindung entsteht | `LinkDialer` | `DemoDialer` |
| `OnlineSource` (`Online/OnlineService.swift`) – Preise, Prognose, Nachrichten | `LiveOnline` (dvhub.online) | `DemoOnline` → `DemoMarket` |

Die Beispielanlage liegt im Paket (`DVhubLink/Sources/DVhubLink/Demo/`), damit `swift test` sie prüft:
`DemoWorld` (Sonne, Wetter, Verbrauch und Börsenpreise als reine Funktionen der Zeit), `DemoPlant` (Lauf eines Tages
in Viertelstunden samt den Vorgaben, die ein Optimierer fände; dazu der bediente Zustand) und `DemoPlant+API`
(Antworten auf dieselben Pfade und in derselben Form wie die Box – Vorbild `interop/harness.mjs`). Derselbe Zeitpunkt
ergibt überall dieselben Werte: Leitstand, Historie, Fahrplan, Markt und Widgets passen zusammen, und ein vergangener
Tag ändert sich nicht mehr. Die Anlage lebt in der Zeitzone des Geräts (Tag und Nacht passen zur Uhr), die Jahreszeit
ist die echte; ab zwei Tagen vor dem Start der Demo ist das Wetter freundlich, damit es etwas zu sehen gibt. Die
Tagesläufe hängen lückenlos aneinander (jeder Tag beginnt mit dem Ladestand, mit dem der Vortag endete). Was man
bedient, wirkt von jetzt an auf den Fluss: Regeln und Grundwert am Netzpunkt, Ladestrom, Stopp-Stand, Sofort laden,
Not-Halt – vergangene Tage ändern sich dadurch nicht. Der bediente Zustand liegt in den Einstellungen der App-Gruppe
(`Shared/DemoStore.swift`), nichts davon im Schlüsselbund.

## Bedienung

Fünf Reiter (auf breiter Fläche – iPhone Duo aufgeklappt, iPad – stattdessen
eine Seitenleiste mit allen Bereichen, siehe unten):

- **Leitstand:** Jede Angabe steht einmal. Der Energiefluss zeigt, was
  **jetzt** fließt: Leistung an jedem Knoten, angeordnet wie im Web-Leitstand
  (PV oben, Haus links, Netz rechts, Akku unten; Netz mit Vorzeichen wie dort:
  + Bezug, − Einspeisung, gerechnet als Bezug minus Einspeisung). Partikelstrom
  nach dem Vorbild von `dvhub/public/dvhub-powerflow.js`: Leuchtpunkte mit
  Schweif in der Farbe ihrer Quelle; Richtung, Dichte und Tempo folgen der
  Leistung; mit „Bewegung reduzieren“ stehen Pfeile. Die Karten darunter zeigen,
  was **heute** zusammenkam – erzeugt, verbraucht, Akku geladen/entladen,
  eingespeist/bezogen, je mit Spitze und Tagesverlauf (aus den 5-Minuten-Werten
  der Box, `DayEnergy` im Paket) – also keine zweite Anzeige der Momentanwerte.
  Dazu Erlös und Kosten, die Preis-Karte (Tagesverlauf und Ausblick; was gerade
  gilt, steht klein), Zustand und Meldungen. Jede Karte und jeder Knoten öffnet
  Detailwerte. Ist die Anlage nicht erreichbar, zeigt die App den letzten Stand
  aus dem Briefkasten mit Uhrzeit.
- **Markt:** die nächsten Tage als Karten (Datum,
  Tagesmittel, Spanne, Ampel und die Lage des Tagesmittels zwischen den
  Schwellen P20 und P80 der letzten vier Wochen). Prognosetage tragen die
  Einstufung der Schnittstelle. Heute und morgen stuft die Schnittstelle nicht
  ein (die Prognose beginnt danach) – für sie gilt dieselbe Regel auf das echte
  Tagesmittel der Börse: unter P20 günstig, über P80 teuer, sonst normal
  (`MarketDay.build` im Paket). Die Lage zeigt jede Karte dreifach: Marke auf
  der Skala, Text („nahe günstig · 8 %“; 0 % = P20, 100 % = P80) und Farbe; bei
  einem normalen Tag nahe einer Schwelle glimmt in der Ampel das Nachbarlicht
  mit. Die Lage ist eine Darstellung, keine zweite Einstufung. Darunter zwei
  getrennte Diagramme:
  **Einspeisung und Bezug** von heute bzw. morgen in einem Bild – Balken: was
  die Einspeisung bringt (Börsenpreis je Viertelstunde, so rechnet DVhub die
  Erlöse, ohne Marktprämie); Linie: was der Bezug kostet (eigener Tarif brutto
  aus der Box, `/api/status` → `userEnergyPricing.slots`); der Abstand ist die
  Spanne, mit Mittelwerten, kleinster und größter Spanne. Was gerade gilt,
  steht klein darüber. Ohne gekoppelte Anlage oder ohne Tarif in DVhub bleiben
  die Balken, mit Hinweis. Dazu die Preisprognose der Folgetage
  mit Band. Quelle: `dvhub.online` (`/api/prices`, `/v1/residual-load/outlook`).
  Methodik, Bilanz und Vergleichsverfahren zeigt die App bewusst nicht.
- **Historie:** Tag, Woche, Monat, Jahr aus `/api/history/summary?lean=1`
  (Energie, Erlöse, Kosten, Autarkie, Kennzahlen); Zeile antippen öffnet den
  Tag bzw. Monat. Woche/Monat/Jahr brauchen in DVhub Pro.
- **Nachrichten:** Energie-Meldungen von `dvhub.online/api/news`, Filter nach
  Quelle. Antippen zeigt Bild und Auszug (schmal als Blatt, breit als Seite
  neben der Seitenleiste, Lesespalte höchstens 620 pt); „Ganzen Artikel lesen“
  öffnet die Website der Redaktion im eingebauten Browser (ohne erzwungenen
  Lesemodus).
- **Mehr:**
  - **Fahrplan:** EOS-Plan (`/api/eos/plan`, lesend) und der Zeitplan der
    Steuerung zum Bedienen: Regeln von Hand anlegen, ändern, löschen (Netz-Sollwert
    mit Richtung „Einspeisen/Beziehen“ und optionalem Stopp bei einem Akku-Stand,
    Ladestrom), jede Regel – auch die vom Optimierer – einzeln aus- und
    einschalten, Grundwerte, Börsenautomatik (an/aus, Suchfenster, Reserve,
    Entladeleistung) und „Neu planen“.
  - **E-Auto:** Zustand, nächste Abfahrt, was EOS bis dahin lädt.
    **Sofort laden** und **Laden stoppen** mit Leistung (in den Grenzen der
    Wallbox) und Dauer (bis zum Abstecken oder 30 min … 8 h), jederzeit zu
    beenden – je mit Rückfrage und Bestätigung am Gerät. Planung (EOS plant
    mit, nur wenn angesteckt, Abfahrten planen, Mindest-Ladestand, „weiter
    laden, wenn günstig“ bis zu einem Höchststand), Einmal-Ziel und der ganze
    **Wochenplan**: Abfahrten anlegen (auch mehrere am Tag, höchstens 14),
    ändern und löschen, je mit eigenem Ziel, Verbrauch der Fahrt (in % des
    Akkus, wie in der Weboberfläche) und „Zuhause ab“ (am selben Tag oder am
    Vortag). Der Plan geht als Ganzes zur Box: Die App liest ihn vor dem
    Speichern frisch und ändert genau eine Zeile (`EVEdit.weekPlan`).
  - **Integrationen:** Zustand und Datenfluss, dazu „Eingerichtet“: was in DVhub
    eingerichtet ist – ohne Adressen und Zugangsdaten (siehe unten).
  - System (Einstellungen zum Nachsehen), Steuern (Not-Halt), Anlagen,
    Darstellung, Über.

### Was die App ändern darf

Nur mit der Freigabe „Anzeigen und steuern“ (in DVhub unter „Handy-App“), und
jede Änderung bestätigt man am Gerät mit Touch ID, Face ID oder Gerätecode
(`SystemController.confirmed`, `Views/Control/WriteSupport.swift`). Die Box
prüft das Recht selbst und trägt jede Schaltung mit der Kennung des Handys ins
Protokoll ein.

| Was | Endpunkt |
|---|---|
| Not-Halt auslösen/aufheben | `POST /api/control/stop`, `/resume` |
| Regeln von Hand anlegen, ändern, löschen | `POST /api/schedule/rules` |
| Regel aus-/einschalten | `POST /api/schedule/rules/toggle` |
| Grundwerte | `POST /api/schedule/config` |
| Börsenautomatik, Neu planen | `POST /api/schedule/automation/config`, `/replan` |
| E-Auto-Planung, Einmal-Ziel, Wochenplan | `POST /api/ev` |
| Sofort laden / Laden stoppen starten, beenden | `POST /api/ev/override`, `DELETE /api/ev/override` |

`POST /api/schedule/rules` ersetzt **alle** Regeln von Hand. Die App liest
deshalb vor jedem Speichern den Stand frisch, ändert genau eine Regel und
schickt alle anderen unverändert zurück (auch Felder, die sie nicht kennt);
steht die Regel auf der Box inzwischen anders, schickt sie nichts
(`ScheduleEdit.payload` im Paket, getestet). Plan-Regeln (Optimierer,
Börsenautomatik) verwaltet die Box; die App kann sie nur umschalten. Anlegen
und ändern kann die App Netz-Sollwert und Ladestrom.

Die Editoren stehen auf der Seite selbst, nicht in Blättern – gleiches
Verhalten zugeklappt und aufgeklappt.

**Nicht freigegeben** (`dvhub/services/mobile-link/permissions.js`): die
Konfiguration (`/api/config`), `/api/integrations/status` (nennt Adressen im
Heimnetz, Benutzernamen, Kennungen) und die Vorschau des Wochenplans
(`/api/ev/preview` – die App prüft den Entwurf selbst mit denselben Regeln,
die Box prüft beim Speichern). Für die Integrationen baut die
Box eine eigene Sicht per Positivliste, `GET /api/mobile-link/integrations`:
nur Wahrheitswerte, Zähler, Modell und Firmware. Die Börsenautomatik liest und
schreibt die App ebenfalls nur über benannte Felder – der Standort der Anlage,
der in derselben Config steht, bleibt auf der Box.

**Verbindung:** zuerst die Heimnetz-Adressen (2,5 s), dann das Relay. Über das
Relay prüft die App alle 30 s, ob das Heimnetz wieder erreichbar ist, und
wechselt dann. Bricht eine Verbindung ab (oder hält sie keine 10 s), wartet die
App wachsend 1, 2, 4 … bis 30 s.

## iPhone Duo und iPad

Gelesen (Stand 14.11.2026): HIG „Designing for iPhone Duo“
(<https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo>),
„Preparing your app for iPhone Duo“
(<https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo>),
Tech Talk 111461 (<https://developer.apple.com/videos/play/tech-talks/111461/>),
TN3192 (<https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key>).

Was Apple vorgibt, und wie die App es umsetzt:

- **Standard-Bausteine statt Eigenbau.** Zwei Anordnungen, gewählt nach der
  Breiten-Größenklasse (`Views/RootView.swift`):
  - *schmal* (zugeklappt, gewöhnliches iPhone): `TabView` mit `Tab` und
    `.tabViewStyle(.sidebarAdaptable)`, je Reiter ein `NavigationStack`;
    „Mehr“ ist eine Liste, die in den Bereich hineinführt.
  - *breit* (aufgeklappt, iPad): eine `NavigationSplitView` (`.balanced`) mit
    **einer** Seitenleiste (`List(selection:)`, `.listStyle(.sidebar)`) für
    alle Bereiche – Leitstand, Markt, Historie, Nachrichten und darunter, was
    schmal unter „Mehr“ steht. Es gibt keine zweite Navigation daneben; die
    Seitenleiste lässt sich mit dem Knopf des Systems einklappen.

  Reiter, Bereich und Navigationspfade leben in `RootView`: Beim Auf- und
  Zuklappen bleibt man im selben Bereich. Die Ansichten selbst baut der
  Wechsel der Anordnung neu auf (Rollposition, gewählter Tag im Markt und
  Zeitraum der Historie beginnen neu). Aktionen stehen in
  `.toolbar` an der `NavigationStack`, als `Label` mit Symbol und Titel in
  einer `ToolbarItemGroup`; Schließen-Knöpfe mit `.cancellationAction`.
  Blätter: `.sheet`, Bestätigungen: `.confirmationDialog`.
- **Leisten an der Seite.** Zugeklappt und aufgeklappt im Querformat legt das
  System Tab-Leiste, Toolbar und Navigation an den rechten Rand, aufgeklappt
  im Hochformat bleiben sie waagerecht (so die Richtlinie; gesehen ist bisher
  nur zugeklappt, siehe unten). Das macht das System selbst – aber
  erst bei einem Build mit dem **iOS-27.1-SDK oder neuer** (aktuell Xcode 27.2).
- **Größe frei änderbar.** Alle vier Ausrichtungen sind freigegeben, kein
  `UIRequiresFullScreen` (TN3192). Layout nur nach Fläche und Größenklasse:
  ab 540 pt Inhaltsbreite stehen Karten und Diagramme zweispaltig.
- **Gleicher Zustand in jeder Pose.** Verbindung, Auswahl und Navigationspfade
  leben außerhalb der Ansichten; Auf-/Zuklappen baut nur die Oberfläche neu.
- Schaltbefehle bestätigt man mit Touch ID (iPhone Duo), Face ID oder
  Gerätecode; der Text richtet sich nach `LAContext.biometryType`.

**Stand mit Xcode 27.2 (iOS-27.2-SDK), geprüft am 14.11.2026 im iPhone-Duo-Simulator (iOS 27.2, iPhone19,4):**

- **Zugeklappt** legt das System die Leisten selbst: Reiter als senkrechte Leiste unten rechts, Aktionen der
  Ansicht (Aktualisieren, Zurück) darüber, Uhr und Status in der Spalte neben der Kamera. Die App bekommt die
  volle Fläche des Außendisplays (466 × 678 pt; mit dem iOS-27.0-SDK waren es 386 × 678 pt). Die eigene
  Seitenleiste ist aus. Abgesichert durch `DVhubAppUITests/DuoTests` (läuft nur im Duo-Simulator).
- **Aufgeklappt quer** (951 × 669 pt, Breite regular): geprüft mit `DuoTests` und `WideTests` – Seitenleiste links
  für alle Bereiche, Karten zweispaltig, Aktionen und Zurück-Knopf legt das System in seine Leiste am rechten Rand.
  **Aufgeklappt hochkant ist nicht geprüft:** Der aufgeklappte Simulator nahm die andere Ausrichtung nicht ein.
  Auf- und Zuklappen geht nur in Device Hub (Inspektor → *Device Configuration*), nicht mit `simctl`. Die Tests
  prüfen und fotografieren die Pose, in der der Simulator gerade steht (`TEST_RUNNER_DVHUB_POSE=auf` benennt die
  Bilder; aufgeklappt liegt die App auf dem zweiten Bildschirm, die Bilder kommen im Hochformat des Panels heraus).
- **Falz.** Das System meldet ihn als reservierte Fläche (`GeometryProxy.reservedRegions(kind: .division)`,
  iOS 27.1+). Meldet es einen aktiven senkrechten Falz und bleibt der Inhalt danach zweispaltig, rückt `AuroraPage`
  ihn so ein, dass seine Mitte auf dem Falz liegt – der Spaltenabstand liegt dann dort, keine Karte darüber
  (`FoldRule` im Paket, getestet; `FoldInsets` in `Design/Theme.swift`). Ein waagerechter Falz (aufgeklappt
  hochkant) teilt nur die Rollrichtung und ändert nichts. Zugeklappt meldet der Simulator keine reservierten
  Flächen. Aufgeklappt und flach meldet er den Falz als **inaktiv** (`Falz 455,0 40×669 (inaktiv)`) – dann rückt
  nichts ein; aktiv wird er vermutlich erst halb geklappt, das ist nicht gesehen. Unter Mehr → Darstellung
  steht dafür eine Diagnosezeile (Fläche, SDK, reservierte Flächen).
- Das SDK bietet außerdem `toolbarVerticalBehavior`, `toolbarVerticalCompressionBehavior` und `ArrangementView`
  (Inhalt in zwei Hälften um den Falz). Die App nutzt sie bisher nicht: Die Vorgaben des Systems passen
  zugeklappt, und für `ArrangementView` fehlt die Prüfung am aufgeklappten Gerät.

**Ersatz-Seitenleiste (`SideRail` in `Views/RootView.swift`).** Nur noch Rückfall: Sie greift von selbst, wenn mit
einem SDK vor 27.1 gebaut wird (`Chrome.systemPlacesBars` liest `DTSDKName`; Regel `BarPlacementRule` im Paket),
und wenn man unter Mehr → Darstellung „Rechts“ wählt. Mit „Automatisch“ gilt bei einem Build mit Xcode 27.2
allein das System.

Am Gerät gemessen (iPhone Duo, iOS 27.2.1, Build mit iOS-27.0-SDK): zugeklappt 386 × 678 pt (das System behielt
rechts 80 pt für Statusleiste und Kamera), aufgeklappt quer 871 × 669 pt. Volle Flächen laut Gerät: 466 × 678 pt
außen, 669 × 951 pt innen (@3x).

Ohne Duo-Simulator zeigen die Debug-Startargumente
`-DVHUB_DUO closed|closed-27.0|closed-landscape|open|open-landscape` die App in diesen Flächen (auf einem
iPad-Simulator starten) – das bildet nur die Fläche nach, nicht die Leisten des Systems.

## Widgets, Kontrollzentrum, Live-Aktivität

**Widgets.** Zwei Widgets: **Anlage** (klein, mittel, Sperrbildschirm rund/rechteckig/einzeilig: Akkustand,
Erzeugung, Einspeisung bzw. Bezug, Hausverbrauch) und **Heute** (klein, Sperrbildschirm rechteckig: verdient oder
gekostet, Erlös, Kosten). Antippen öffnet den Leitstand bzw. die Tageswerte; das mittlere Widget hat einen
Aktualisieren-Knopf (App Intent, nur Lesen).

So bleiben sie aktuell (Apple: „Keeping a widget up to date“):

1. Ist die App offen, schreibt sie alle 30 s den Stand in die App-Gruppe (Not-Halt und Alarme sofort).
2. Im Hintergrund holt die App ihn mit einer `BGAppRefreshTask` (`DVhubApp/BackgroundRefresh.swift`,
   `.backgroundTask(.appRefresh)`), schreibt ihn und ruft `WidgetCenter.reloadAllTimelines()`.
3. Zeichnet das System ein Widget neu und der Stand ist älter als zehn Minuten, ruft das Widget selbst ab
   (`Shared/LinkAccess.swift`, `QuickLink` im Paket): Heimnetz zuerst, sonst Relay, Ende zu Ende verschlüsselt.
   Die Timeline bittet alle 15 min um Neuladen.

Was das System dabei begrenzt: Wann eine Hintergrundaufgabe läuft und wie oft ein Widget neu geladen wird
(Richtwert 40–70-mal am Tag), entscheidet iOS. Ein Widget hat für seinen Abruf nur wenige Sekunden; reicht die
Zeit nicht, bleibt der alte Stand.

**Zugangsdaten.** Sie liegen ausschließlich im Schlüsselbund, in einer Gruppe, die App und Erweiterung teilen
(`keychain-access-groups`: `$(AppIdentifierPrefix)$(DVHUB_BUNDLE_ID).shared`, `Config/App.xcconfig`). Beim ersten
Start nach dem Update zieht die App vorhandene Einträge in diese Gruppe um (`KeyStore.migrateToSharedGroup`).
Im Container der App-Gruppe liegen nur Anzeigewerte (`widget-snapshot.json`) und die Kennung der gewählten Anlage.
Schutzklasse und Geräteschlüssel bleiben, wie sie waren: Der Schlüssel liegt in der **Secure Enclave** und ist nur
bei entsperrtem Gerät nutzbar (`WhenUnlockedThisDeviceOnly`). Folgen:

- **Gesperrt ruft niemand ab** – weder App noch Widget. Der letzte Stand bleibt stehen, mit Uhrzeit.
- Ob die Erweiterung den Secure-Enclave-Schlüssel der App verwenden kann, ist im Simulator nicht prüfbar (dort
  gibt es nur Software-Schlüssel). Laut Apple ist die gespeicherte Hülle an das Gerät gebunden, nicht an die App
  (CryptoKit „Storing CryptoKit Keys in the Keychain“; Apple-Forum 804612, 810676) – es sollte also gehen. Geht es
  auf einem Gerät doch nicht, greifen die Wege 1 und 2 unverändert; das Widget zeigt dann den Stand der App.

**Sperrbildschirm.** Geldwerte tragen `privacySensitive()`: Bei gesperrtem Gerät zeigt iOS dort Platzhalter. Die
einzeilige Anzeige über der Uhr zeigt bewusst keine Geldwerte.

**Kontrollzentrum (iOS 18+).** Der Knopf **Not-Halt** (`ControlWidget`) zeigt, ob der Not-Halt aktiv ist, und öffnet
DVhub mit der Rückfrage. Er schaltet nicht selbst: Das Kontrollzentrum kann keine Rückfrage zeigen (Apple
dokumentiert für Controls keinen Dialog), ein Schalter würde ohne Bestätigung schalten. Ablauf: iOS verlangt das
entsperrte iPhone (`authenticationPolicy = .requiresLocalDeviceAuthentication`), die App fragt nach
(`confirmationDialog`) und lässt mit Touch ID, Face ID oder Gerätecode bestätigen. Ob ausgelöst oder aufgehoben wird,
entscheidet die App nach dem Live-Zustand der Anlage, nicht nach dem Stand, den der Knopf zuletzt kannte.

**Live-Aktivität (ActivityKit).** Solange der Not-Halt aktiv ist: Sperrbildschirm und Dynamic Island mit laufender
Dauer, Akku, Erzeugung, Netz und Uhrzeit des Stands; Antippen öffnet „Steuern“. Abschaltbar unter Mehr →
Darstellung. Ohne eigenen Push-Server gilt:

- Starten kann die App nur im Vordergrund oder aus einem `LiveActivityIntent` (Kurzbefehl „Not-Halt auslösen“).
  Erkennt erst der Hintergrundabruf den Not-Halt, erscheint die Aktivität beim nächsten Öffnen.
- Aktualisiert und beendet wird sie, solange die App offen ist, sonst bei jedem Hintergrundabruf. Dazwischen zählt
  das System die Dauer selbst weiter; nach 20 min ohne neue Werte sagt die Ansicht, von wann sie sind.
- iOS beendet eine Aktivität nach acht Stunden und zeigt sie noch bis zu vier Stunden auf dem Sperrbildschirm.

**App-Gruppe.** Ihre Kennung folgt der Bundle-ID (`group.$(DVHUB_BUNDLE_ID)`). Lehnt eine Signatur App-Gruppe oder
Schlüsselbund-Gruppe ab, beim Bauen
`DVHUB_APP_ENTITLEMENTS= DVHUB_WIDGET_ENTITLEMENTS= DVHUB_APP_GROUP= DVHUB_KEYCHAIN_GROUP=` anhängen: Die App läuft
normal, die Widgets zeigen einen Hinweis.

**Kostenloses Personal Team (geprüft 14.11.2026, Xcode 27.0):** „App Groups“ und „Keychain Sharing“ sind erlaubt,
aber `xcodebuild -allowProvisioningUpdates` legt die App-Gruppe nicht an – das Profil kommt mit leerer Gruppenliste.
Abhilfe: einmal in Xcode bei beiden Zielen (DVhubApp, DVhubWidgets) unter *Signing & Capabilities* → *App Groups*
die Gruppe `group.<Bundle-ID>` mit „+“ anlegen und anhaken; danach baut auch die Kommandozeile mit Gruppe. Die
Schlüsselbund-Gruppe braucht keine Anmeldung bei Apple. Push gibt es mit dem Personal Team nicht – die
Live-Aktivität braucht keinen.

## Kurzbefehle und Siri (App Intents)

`DVhubApp/Intents/AppIntents.swift`, ohne Einrichtung in der Kurzbefehle-App und per Siri verfügbar
(`AppShortcutsProvider`):

| Kurzbefehl | Beispiel | Schutz |
|---|---|---|
| Akkustand, Erzeugung, Netz, Verbrauch, Überblick | „Wie voll ist der Akku in DVhub?“ | – |
| Tagesverdienst | „Was hat DVhub heute verdient?“ | entsperrtes Gerät |
| Not-Halt auslösen / aufheben | „Not-Halt mit DVhub auslösen“ | entsperrtes iPhone **und** Rückfrage |

Die Antwort kommt frisch von der Anlage, wenn das geht, sonst vom letzten Stand – dann mit Uhrzeit. Der Not-Halt
verlangt `authenticationPolicy = .requiresLocalDeviceAuthentication` (das iPhone selbst, nicht nur eine entsperrte
Uhr) und `requestConfirmation`. Weitere Schaltpfade gibt es nicht; die Box prüft das Recht „Steuern“ selbst.

## Sprachen

Ausgangssprache Deutsch, dazu Englisch. Texte stehen in String-Katalogen: `DVhubApp/Shared/Localizable.xcstrings`
(App, Widgets, Intents), `DVhubApp/DVhubApp/InfoPlist.xcstrings`, `DVhubApp/DVhubApp/AppShortcuts.xcstrings` (Sätze
für Siri) und `DVhubLink/Sources/DVhubLink/Resources/Localizable.xcstrings` (Fehlertexte des Pakets). Zahlen,
Einheiten, Währung, Datum und Dauer formatiert Foundation in der Sprache und Region des Geräts
(`Shared/Format.swift`).

```bash
ios/tools/sync-strings.sh          # neue Texte aus dem Quelltext in die Kataloge (macht Xcode beim Bauen selbst)
python3 ios/tools/strings.py check # jede Zeichenkette hat Englisch, Platzhalter stimmen überein
```

Im Code: Literale in `Text`, `Label`, `Button` … übersetzt SwiftUI selbst; wo ein `String` gebraucht wird, steht
`String(localized:)`. Kennungen, Codes und Jahreszahlen als `String(zahl)` einsetzen – sonst setzt der Katalog
Tausenderpunkte („4.003“).

## Bedienungshilfen

- **Dynamic Type:** Textstile statt fester Größen; große Ziffern mit `@ScaledMetric`. In den Bedienungshilfen-Größen
  stehen Karten ein- statt zweispaltig (`AuroraPage.layoutWidth`). Feste Maße haben nur Grafiken (Energiefluss,
  Platzhalterbild) und die Ersatz-Seitenleiste – die zeigt wie die Leisten des Systems jeden Eintrag groß an, wenn
  man ihn gedrückt hält (Large Content Viewer).
- **VoiceOver:** Jede Karte ist ein Element mit Wert und Hinweis. Der Energiefluss sagt in Worten, wohin Energie
  fließt. Diagramme tragen einen `AXChartDescriptor` (`Design/ChartAccessibility.swift`) – VoiceOver beschreibt sie
  und spielt sie als Audiograph ab.
- **Haptik** (`sensoryFeedback`): Warnung bei der Rückfrage zum Not-Halt, Erfolg bzw. Fehler nach dem Schalten und
  nach einer Kopplung, leichter Anschlag bei Aktionen wie „Aktualisieren“.

## Datenschutz-Manifest

`DVhubApp/PrivacyInfo.xcprivacy` und `DVhubWidgets/PrivacyInfo.xcprivacy`: kein Tracking, keine Tracking-Domains,
keine erhobenen Datenarten. Begründung: Anlagendaten laufen Ende zu Ende verschlüsselt zwischen dem iPhone und der
eigenen Anlage; das Relay sieht nur verschlüsselte Daten, der Entwickler nichts. Von `dvhub.online` holt die App
öffentliche Daten ohne Kennung. Required-Reason-APIs: `UserDefaults` (CA92.1 eigene Einstellungen, 1C8F.1
App-Gruppe) und in der App Dateizeitstempel (C617.1, Alter der eigenen Zwischenspeicher-Dateien).
Vor der Einreichung die Angaben in App Store Connect gleich halten („Data Not Collected“).

## Tests

```bash
# Prüfwerte (bit-genau gegen dvhub/test/fixtures/mobile-link-vectors.json)
cd ios/DVhubLink && swift test

# Gegen die echte Node-Gegenstelle
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  HARNESS_PERMS=read,control HARNESS_QR_FILE=/tmp/dvhub-qr.txt node ios/interop/harness.mjs &
DVHUB_INTEROP_QR_FILE=/tmp/dvhub-qr.txt DVHUB_INTEROP_HARNESS_PID=$! swift test

# Oberfläche im Simulator (Drehen, Not-Halt). Die App muss mit dem Harness
# gekoppelt sein; für den Not-Halt Face ID einschreiben und fortlaufend bestätigen:
#   xcrun simctl spawn <Gerät> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
#   xcrun simctl spawn <Gerät> notifyutil -p com.apple.BiometricKit.enrollmentChanged
#   xcrun simctl spawn <Gerät> notifyutil -p com.apple.BiometricKit_Sim.pearl.match   (in Schleife)
xcodebuild test -project ios/DVhubApp/DVhubApp.xcodeproj -scheme DVhubApp \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
```

Nur im Debug-Build gibt es Startargumente für Simulator-Tests und Bildschirmfotos:
`-DVHUB_PAIR '<QR-Text>'` koppelt beim Start,
`-DVHUB_TAB dashboard|market|history|news|more|plan|ev|integrations|system|control|systems`
öffnet einen Bereich, `-DVHUB_OPEN pv|battery|grid|home|money|state` eine
Detailansicht, `-DVHUB_HISTORY week|month|year` und `-DVHUB_MARKET_DAY <n>`
wählen Zeitraum bzw. Tag, `-DVHUB_DUO closed|closed-landscape|open` zeigt die
Flächen des iPhone Duo, `-navPlacement side|bottom` erzwingt die Leistenlage.
`-DVHUB_DEMO on|off` startet bzw. beendet die Demo, `-DVHUB_DEMO_SHIFT <Stunden>` verstellt
ihre Uhr (nachts den Mittag der Beispielanlage fotografieren).

Ohne Gegenstelle laufen die Tests der Demo: `DVhubAppTests/DemoModeTests` (im Prozess der App: Demo als eigener
Eintrag, Bedienen ohne Bestätigung am Gerät, kein Weg zu einer gekoppelten Anlage, Quellenwechsel von Markt und
Nachrichten) und `DVhubAppUITests/DemoTests` (Demo starten, jeder Bereich zeigt Inhalt, Regel anlegen, Sofort laden,
Not-Halt, Neustart, Demo beenden). Im Paket prüfen `DemoPlantTests`, `DemoMarketTests` und `DemoConnectionTests`
die Beispielanlage selbst – auch, dass sie kein Netz anfasst.

`ControlPagesTests` prüft die Bedien-Seiten in der Pose, in der der Simulator steht: Leitstand (Anordnung wie
im Web-Leitstand, Momentanwerte nur im Energiefluss), Markt (Einspeisung und Bezug in einem Diagramm, aktueller
Preis klein), Integrationen (nichts auf der Seite sieht nach Adresse aus – der Harness legt Köder in die große
Übersicht), E-Auto (speichern und zurücklesen; Sofort laden starten und beenden; Abfahrt anlegen und löschen) und Zeitplan (Regel anlegen, in der Liste sehen, löschen). Die
Schreib-Tests brauchen `HARNESS_PERMS=read,control`, eingeschriebene Biometrie und die Freigabe in Schleife
(iPhone Duo: `com.apple.BiometricKit_Sim.fingerTouch.match`).

Weitere Oberflächentests: `AccessibilityTests` (Schriftgröße accessibility-XL: Karten einspaltig, nichts
abgeschnitten), `DuoTests` (nur im iPhone-Duo-Simulator, in der Pose, in der er steht: Leisten des Systems bzw.
Seitenleiste, Ersatz aus, Artikel-Vorschau im Bild) und `WideTests` (breite Fläche – iPhone Duo aufgeklappt oder
iPad: eine Seitenleiste für alle Bereiche, keine zweite Navigation, Artikel-Vorschau neben der Seitenleiste;
schmal übersprungen):

```bash
xcodebuild test -project ios/DVhubApp/DVhubApp.xcodeproj -scheme DVhubApp \
  -destination 'platform=iOS Simulator,name=iPhone Duo' \
  -only-testing:DVhubAppUITests/DuoTests -only-testing:DVhubAppUITests/WideTests
```

Die Gegenstelle hält höchstens zehn Geräte und entfernt dann das älteste. Meldet die App danach „entkoppelt“,
den Schlüsselbund des Simulators leeren (`xcrun simctl keychain <Gerät> reset`) und neu koppeln.

Der Harness kennt außerdem diese Umgebungsvariablen:
- `HARNESS_APPROVE_DELAY_MS`: Freigabe verzögern, um den Vergleichscode anzusehen.
- `HARNESS_NO_LAN=1`: Kopplung nur über das Relay.
- `HARNESS_FULL_DAY=1`: Verlauf und Historie für den ganzen heutigen Tag liefern.
- `SIGUSR1` / `SIGUSR2`: Box vom Netz nehmen bzw. wieder verbinden.
