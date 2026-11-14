# DVhub für iPhone

Native App (SwiftUI, iOS 18+, Deutsch und Englisch) für die Handy-Kopplung mit DVhub: Leitstand mit
Energiefluss, Detailwerte, Börsenpreise und Residuallast-Frühwarnung, Historie,
Fahrplan, Zustand der Anbindungen, Nachrichten, Widgets, Kurzbefehle/Siri, ein Knopf
im Kontrollzentrum und eine Live-Aktivität. Mit Freigabe
„Steuern“ kann sie auch den Not-Halt auslösen. Anlagendaten laufen Ende zu
Ende verschlüsselt: im Heimnetz direkt zur Box, unterwegs über das Relay
(`relay.dvhub.de` oder ein selbst gehostetes). Das Protokoll steht in
[`docs/HANDY-APP-PROTOKOLL.md`](../docs/HANDY-APP-PROTOKOLL.md). Öffentliche
Daten (Preise, Prognose, Nachrichten) holt die App direkt bei `dvhub.online`.

| Ordner | Inhalt |
|---|---|
| `DVhubLink/` | Swift-Paket: Kryptografie, QR-Code, Kopplung, Verbindung, Schlüsselbund |
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

## Bedienung

Fünf Reiter (auf breiter Fläche – iPhone Duo aufgeklappt, iPad – stattdessen
eine Seitenleiste mit allen Bereichen, siehe unten):

- **Leitstand:** Energiefluss mit Partikelstrom nach dem Vorbild des
  Web-Leitstands (`dvhub/public/dvhub-powerflow.js`): viele kleine Leuchtpunkte
  mit Schweif und Lichtschein in der Farbe ihrer Quelle (PV gelb, Akku grün,
  Netz blau – zum Haus gemischt nach Anteilen); Richtung, Dichte und Tempo
  folgen der Leistung; mit „Bewegung reduzieren“ stehen Pfeile. Die Symbole
  stehen nur im Energiefluss, die Karten darunter tragen Farbe und Namen.
  Antippbare Karten mit Tagesverlauf: PV, Akku, Netz, Haus, Heute
  (Erlöse/Kosten), Börse, Zustand, Meldungen aus dem Briefkasten. Jede Karte und
  jeder Knoten öffnet Detailwerte (Phasen, Flüsse, Min-SoC, Sollwert, Zähler,
  Tagessummen). Ist die Anlage nicht erreichbar, zeigt die App den letzten Stand
  aus dem Briefkasten mit Uhrzeit.
- **Markt:** Börsenpreis jetzt; die nächsten Tage als Karten (Datum,
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
  die Börsenpreise von heute bzw. morgen in Viertelstunden (Tief, Mittel, Hoch,
  günstigste und teuerste drei Stunden) und die Preisprognose der Folgetage
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
- **Mehr:** Fahrplan (EOS-Plan aus `/api/eos/plan`, Zeitplan aus
  `/api/schedule`), Integrationen (Zustand und Datenfluss), System
  (Einstellungen zum Nachsehen), Steuern (Not-Halt, nur mit Freigabe
  „Steuern“), Anlagen, Darstellung, Über.

Die App liest nur. Geschaltet wird allein der Not-Halt. Die Konfiguration
(`/api/config`) und `/api/integrations/status` sind für die App nicht
freigegeben, weil sie Adressen, Kennungen und Standortdaten enthalten.

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
`-DVHUB_TAB dashboard|market|history|news|more|plan|integrations|system|control|systems`
öffnet einen Bereich, `-DVHUB_OPEN pv|battery|grid|home|money|state` eine
Detailansicht, `-DVHUB_HISTORY week|month|year` und `-DVHUB_MARKET_DAY <n>`
wählen Zeitraum bzw. Tag, `-DVHUB_DUO closed|closed-landscape|open` zeigt die
Flächen des iPhone Duo, `-navPlacement side|bottom` erzwingt die Leistenlage.

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
