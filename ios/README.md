# DVhub für iPhone

Native App (SwiftUI, iOS 17+) für die Handy-Kopplung mit DVhub. Sie zeigt die
Live-Werte der Anlage, den Tagesverlauf und den EOS-Plan. Mit Freigabe
„Steuern“ kann sie auch den Not-Halt auslösen. Alles läuft Ende zu Ende
verschlüsselt: im Heimnetz direkt zur Box, unterwegs über das Relay
(`relay.dvhub.de` oder ein selbst gehostetes). Das Protokoll steht in
[`docs/HANDY-APP-PROTOKOLL.md`](../docs/HANDY-APP-PROTOKOLL.md).

| Ordner | Inhalt |
|---|---|
| `DVhubLink/` | Swift-Paket: Kryptografie, QR-Code, Kopplung, Verbindung, Schlüsselbund |
| `DVhubApp/` | Die App (Xcode-Projekt aus `project.yml` per XcodeGen) |
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

## Koppeln

1. DVhub-Oberfläche → Einstellungen → „Handy-App“ → „Handy koppeln“.
2. QR-Code mit der Kamera-App oder in der App unter „Anlage koppeln“ scannen.
   Ohne Kamera (Simulator) den Text des QR-Codes einfügen.
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

- **Übersicht:** PV, Akku (+ = Laden), Netz (Bezug/Einspeisung), Haus, Ertrag
  heute und Zustand (Alarme, Not-Halt, Abregelung). Ist die Anlage nicht
  erreichbar, zeigt die App den letzten Stand aus dem Briefkasten mit Uhrzeit.
- **Verlauf:** heute/gestern aus `/api/telemetry/series`.
- **Plan:** EOS-Fahrplan aus `/api/eos/plan` (braucht in DVhub Pro).
- **Steuern:** Not-Halt auslösen/aufheben, nur mit Freigabe „Steuern“.
- **Anlagen:** mehrere Anlagen. Entfernen löscht nur die Zugangsdaten auf dem
  Handy; in DVhub die Kopplung ebenfalls entfernen.

**Verbindung:** zuerst die Heimnetz-Adressen (2,5 s), dann das Relay. Über das
Relay prüft die App alle 30 s, ob das Heimnetz wieder erreichbar ist, und
wechselt dann.

**iPhone Duo und iPad:** Ist das Gerät zugeklappt (schmal), gibt es eine
Tab-Leiste mit einer Spalte. Aufgeklappt (breit) gibt es eine Seitenleiste mit
Anlagen und Bereichen; die Kacheln stehen zweispaltig, Verlauf und Diagramme
nebeneinander, sobald genug Breite da ist. Drehen und Auf-/Zuklappen bauen nur
die Ansicht neu, die Verbindung bleibt stehen.

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

Nur im Debug-Build gibt es Startargumente für Simulator-Tests:
`-DVHUB_PAIR '<QR-Text>'` koppelt beim Start, `-DVHUB_TAB history|plan|control|systems`
öffnet einen Bereich.

Der Harness kennt außerdem diese Umgebungsvariablen:
- `HARNESS_APPROVE_DELAY_MS`: Freigabe verzögern, um den Vergleichscode anzusehen.
- `HARNESS_NO_LAN=1`: Kopplung nur über das Relay.
- `SIGUSR1` / `SIGUSR2`: Box vom Netz nehmen bzw. wieder verbinden.
