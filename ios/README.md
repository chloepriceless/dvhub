# DVhub für iPhone

Native App (SwiftUI, iOS 17+) für die Handy-Kopplung mit DVhub: Leitstand mit
Energiefluss, Detailwerte, Börsenpreise und Residuallast-Frühwarnung, Historie,
Fahrplan, Zustand der Anbindungen, Nachrichten und Widgets. Mit Freigabe
„Steuern“ kann sie auch den Not-Halt auslösen. Anlagendaten laufen Ende zu
Ende verschlüsselt: im Heimnetz direkt zur Box, unterwegs über das Relay
(`relay.dvhub.de` oder ein selbst gehostetes). Das Protokoll steht in
[`docs/HANDY-APP-PROTOKOLL.md`](../docs/HANDY-APP-PROTOKOLL.md). Öffentliche
Daten (Preise, Prognose, Nachrichten) holt die App direkt bei `dvhub.online`.

| Ordner | Inhalt |
|---|---|
| `DVhubLink/` | Swift-Paket: Kryptografie, QR-Code, Kopplung, Verbindung, Schlüsselbund |
| `DVhubApp/` | Die App und die Widget-Erweiterung `DVhubWidgets` (Xcode-Projekt aus `project.yml` per XcodeGen); `Shared/` gehört beiden |
| `interop/harness.mjs` | Echte DVhub-Gegenstelle (Relay + Box-Agent mit Beispielwerten) für Tests |

## Bauen

Voraussetzung: Xcode 26 oder neuer, für die Gegenstelle Node 22.

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

Fünf Reiter:

- **Leitstand:** Energiefluss mit Partikeln (PV, Akku, Netz, Haus; Richtung,
  Dichte und Tempo folgen der Leistung; mit „Bewegung reduzieren“ stehen Pfeile).
  Darunter antippbare Karten mit Tagesverlauf: PV, Akku, Netz, Haus, Heute
  (Erlöse/Kosten), Börse, Zustand, Meldungen aus dem Briefkasten. Jede Karte und
  jeder Knoten öffnet Detailwerte (Phasen, Flüsse, Min-SoC, Sollwert, Zähler,
  Tagessummen). Ist die Anlage nicht erreichbar, zeigt die App den letzten Stand
  aus dem Briefkasten mit Uhrzeit.
- **Markt:** Börsenpreis jetzt, Frühwarnung vor teuren Tagen und eine
  Tagesleiste: Heute und Morgen als feste Börsentage (Viertelstunden, günstigste
  und teuerste drei Stunden, eigener Bezugspreis aus DVhub), danach fünf
  Prognosetage mit Bandbreite, Einstufung, Residuallast, Wind und Sonne. Dazu
  die Bilanz der Prognose und, als „explorativ“ gekennzeichnet, die Vergleiche
  (Darius-Nachbau, EpexPredictor). Quelle: `dvhub.online`
  (`/api/prices`, `/v1/residual-load/outlook`, `/v1/residual-load/score`).
- **Historie:** Tag, Woche, Monat, Jahr aus `/api/history/summary?lean=1`
  (Energie, Erlöse, Kosten, Autarkie, Kennzahlen); Zeile antippen öffnet den
  Tag bzw. Monat. Woche/Monat/Jahr brauchen in DVhub Pro.
- **Nachrichten:** Energie-Meldungen von `dvhub.online/api/news`, Filter nach
  Quelle, Artikel im eingebauten Browser mit Lesemodus.
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

Nach Apples Richtlinien (Stand 13.11.2026: HIG „Designing for iPhone Duo“,
<https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo>;
Tech Talk „Prepare your app for iPhone Duo“,
<https://developer.apple.com/videos/play/tech-talks/111461/>;
<https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo>):

- **Zugeklappt** (und aufgeklappt im Querformat) legt das System Reiter und
  Toolbar an den rechten Rand, **aufgeklappt im Hochformat** bleiben sie
  waagerecht oben und unten, und der Inhalt füllt die Fläche. Das gilt nur für
  Standard-Bausteine. Die App nutzt deshalb `TabView`, `NavigationStack` und
  Toolbar-Einträge als `Label` mit Symbol und Titel.
- Das System legt die Leisten erst um, wenn die App mit dem **iOS-27.1-SDK**
  (Xcode 27.1) gebaut ist. Mit älterem SDK gibt es dafür einen Ersatz mit
  derselben Anordnung (`SideRail` in `Views/RootView.swift`): Reiter und
  Aktionen der Ansicht stehen rechts, wenn die Fläche niedrig ist (Querformat)
  oder kurz und breit wie das Außendisplay. Er schaltet sich ab, sobald
  `DTSDKName` 27.1 oder neuer meldet. Unter Mehr → Darstellung lässt sich die
  Leiste auch fest auf „Rechts“ oder „Unten“ stellen.
- Layout nur nach Fläche und Größenklasse, nie nach Gerätetyp: Ab 600 pt
  Inhaltsbreite stehen Karten und Diagramme zweispaltig.
- Auf-/Zuklappen und Drehen bauen nur die Ansicht neu. Verbindung, Auswahl und
  Navigationspfade bleiben stehen.
- Schaltbefehle bestätigt man mit Touch ID (iPhone Duo), Face ID oder
  Gerätecode; der Text richtet sich nach `LAContext.biometryType`.

**Annahmen (von Apple nicht belegt):** die Punktgrößen 466 × 678 (außen) und
669 × 951 (innen), abgeleitet aus den Pixelmaßen bei @3x; daraus die Schwelle
„Seitenverhältnis unter 1,72“ für das Außendisplay. Einen iPhone-Duo-Simulator
gibt es erst ab Xcode 27.1. Bis dahin zeigen die Debug-Startargumente
`-DVHUB_DUO closed|closed-landscape|open` die App in diesen Flächen (auf einem
iPad-Simulator starten). Nach dem Umstieg auf Xcode 27.1 offen: Falz über
`reservedRegions(kind: .division)` berücksichtigen, `toolbarVerticalBehavior`
prüfen.

## Widgets

Zwei Widgets: **Anlage** (klein, mittel, Sperrbildschirm rund/rechteckig/
einzeilig: Akkustand, Erzeugung, Einspeisung bzw. Bezug, Hausverbrauch) und
**Heute** (klein, Sperrbildschirm rechteckig: verdient oder gekostet, Erlös,
Kosten). Sie zeigen den letzten Stand, den die App gesehen hat, mit Uhrzeit.
Selbst holen können sie nichts: Der Geräteschlüssel liegt in der Secure
Enclave der App.

App und Widgets teilen sich die Daten über eine App-Gruppe. Ihre Kennung folgt
der Bundle-ID (`group.$(DVHUB_BUNDLE_ID)`, `Config/App.xcconfig`). Lehnt eine
Signatur die App-Gruppe ab, beim Bauen
`DVHUB_APP_ENTITLEMENTS= DVHUB_WIDGET_ENTITLEMENTS= DVHUB_APP_GROUP=` anhängen:
Die App läuft normal, die Widgets zeigen einen Hinweis.

**Kostenloses Personal Team (geprüft 14.11.2026, Xcode 27.0):** Die Fähigkeit
„App Groups“ ist erlaubt, aber `xcodebuild -allowProvisioningUpdates` legt die
Gruppe nicht an – das Profil kommt mit leerer Gruppenliste, und der Bau
scheitert („doesn't match the entitlements file's value for the
com.apple.security.application-groups entitlement“). Abhilfe: einmal in Xcode
bei beiden Zielen (DVhubApp, DVhubWidgets) unter *Signing & Capabilities* →
*App Groups* die Gruppe `group.<Bundle-ID>` mit „+“ anlegen und anhaken; danach
baut auch die Kommandozeile mit Gruppe. Bis dahin mit den drei leeren Werten
oben bauen.

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

Der Harness kennt außerdem diese Umgebungsvariablen:
- `HARNESS_APPROVE_DELAY_MS`: Freigabe verzögern, um den Vergleichscode anzusehen.
- `HARNESS_NO_LAN=1`: Kopplung nur über das Relay.
- `HARNESS_FULL_DAY=1`: Verlauf und Historie für den ganzen heutigen Tag liefern.
- `SIGUSR1` / `SIGUSR2`: Box vom Netz nehmen bzw. wieder verbinden.
