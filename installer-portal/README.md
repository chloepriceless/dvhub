# DVhub Installateurs-Portal (lokal)

Zero-Dependency Node-App (nur `node:`-Builtins + `openssl`), die die
`/api/installer/*`-Funktionen betreibt. **Pull-Modell:** Kunden sitzen hinter
NAT/Firewall — deshalb meldet sich die **Anlage ausgehend** beim Portal.

## Kopplungs-Ablauf (Pull-Modell)

1. **Appliance-ID holen** — beim Kunden unter Einstellungen → Status →
   „Installateurs-Portal“ (steht auch in `DATA_DIR/appliance-id`).
2. **Code erzeugen** — Installateur trägt die ID im Portal ein und bekommt
   einen 6-stelligen Kopplungs-Code.
3. **Anlage koppeln** — zurück zur DVhub-Oberfläche: Portal-URL + Code in
   dieselbe Kachel eintragen → „Kopplung starten“. Die Anlage ruft das Portal
   ausgehend an (`POST /api/pair/claim`) und erhält ein Appliance-Token.
4. **Freigeben** — die Anfrage erscheint im Portal, einmal „Annehmen“.
5. **Betrieb** — die Anlage pollt das Portal alle 30 s und liefert ihren
   Kompakt-Status (SoC, Batterie, PV, Grid-Setpoint, Alarme, Not-Halt…).
   Kommandos vom Portal (Support-Tunnel öffnen/schließen, Update-Check)
   führt die Anlage gegen ihre eigenen Loopback-Endpunkte aus und meldet
   das Ergebnis zurück.

Kein Portforwarding, kein DNS, kein öffentlicher Endpunkt beim Kunden.
Authentisierung Anlage→Portal: Appliance-Token (beim Claim vergeben),
Transport: HTTPS (http:// nur für lokale Tests im LAN).

## Starten

```bash
cd installer-portal
npm start            # → http://localhost:8700
```

Variablen:

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | 8700 | Portal-Port |
| `DATA_DIR` | `./data` | Konten, Schlüssel, Kopplungen |
| `SESSION_TTL_H` | 12 | Lebensdauer der Browser-Session |
| `ADMIN_ACCOUNTS` | `admin` | Admin-Kontonamen (Komma-getrennt) — für die Registrierung reserviert |
| `ADMIN_SETUP_TOKEN` | — | nötig, um ein Admin-Konto anzulegen bzw. auf frischem Portal ein Backup zu importieren. Nach dem Einrichten wieder entfernen. |
| `WEBAUTHN_ORIGIN` | — | z. B. `https://portal.example.de` — fest erwartete Origin + rpId für Passkeys. **Online setzen.** |
| `WEBAUTHN_RP_ID` | Host aus `WEBAUTHN_ORIGIN` | abweichende rpId (selten nötig) |
| `COOKIE_SECURE` | — | `1` = Session-Cookie nur über HTTPS. **Online setzen.** |

## Kunden-Kontrolle auf der Anlage

- **Opt-in:** `installerPortal.enabled` ist ab Werk `false`. „Kopplung starten“
  in der DVhub-Oberfläche schaltet ihn ein; „aus“ sperrt sofort alles (WAN-
  Endpunkte UND den ausgehenden Poll).
- **Freigaben:** Die Kopplung erlaubt nur Lesen + Update-*Prüfung*. Support-
  Tunnel öffnen (`allowTunnel`) und Updates einspielen (`allowUpdates`) braucht
  je einen eigenen Haken des Kunden. Tunnel *schließen* geht immer.
- **CSRF:** Koppeln/Bestätigen/Freigeben verlangen einen UI-Nonce (aus
  `GET /api/installer/settings`) oder einen Bearer — eine fremde Webseite im
  Browser des Kunden kann nichts koppeln. Ausschalten geht ohne Nonce.
- `installerPortal.*` ist nur über `/api/installer/settings` änderbar; ein
  allgemeines Settings-Speichern oder ein Config-Import überschreibt es nicht.

## Tests

```bash
npm test   # beide E2E-Suites
```

- `test/e2e-real-dvhub.test.js` — **echter** DVhub-Prozess (`dvhub/server.js`,
  ohne Postgres/Hardware) ↔ echter Portal-Prozess, Pull + Push, je einmal mit
  und ohne `apiToken` (~9 s). Poll-Takt über `DV_INSTALLER_POLL_MS=400`.
  `KEEP_RIG=1` lässt das Test-Verzeichnis samt Logs stehen.
- `test/e2e.test.js` — schneller Pull-Durchlauf gegen den Routen-Code im Prozess.

## Typische lokale Verkabelung

| Komponente | Adresse |
|---|---|
| Portal (Browser des Installateurs) | http://localhost:8700 |
| DVhub-Anlage im selben Netz | http://192.168.x.x:8080 — nur für den Browser des Kunden; die ANLAGE wählt ihrerseits das Portal aus (http im LAN erlaubt) |
| DVhub am selben Rechner (Dev) | http://127.0.0.1:8080 |

**Hinweis URL-Validierung:** Die Anlage akzeptiert als Portal-URL nur
`https://…` (online) oder `http://` zu Loopback/RFC1918 (LAN-Test) — ein
anonymes `http://portal.example.de` wird abgewiesen (SSRF-Bremse).

## Sicherheit / Online-Betrieb (TODO vor dem Online-Release)

1. **TLS:** Online MUSS das Portal hinter HTTPS laufen (der Private-Key-Swap
   ist zwar signaturgesichert, aber Kunden-/Sessiondaten verdienen TLS).
   Testweise funktioniert es auch mit http:// im Kunden-LAN.
2. **Reverse-Proxy:** z. B. nginx/caddy mit `proxy_pass http://127.0.0.1:8700`
   + Let's Encrypt. Im reinen LAN tut es auch http://.
3. **Datensicherung:** `data/keys/` enthält die Private Keys — mit
   Lastbackup sichern, bei Verlust ist die Kopplung tot (neu registrieren).
4. **Registrierung:** Kontoanlage ist offen (rate-limited). Für den Online-
   Betrieb Registrierung einschränken (Einladung/Freischaltung durch Betreiber).
5. **Push-Modell online:** `POST /api/appliances` lässt das Portal eine vom
   Installateur angegebene Adresse anrufen (nur Schema/Host/Port, feste Pfade).
   Online hinter einer Egress-Firewall betreiben, die interne Netze sperrt.

## Zwei-Faktor & Passkeys (Konto-Login)

- **TOTP-2FA** (RFC 6238, Authenticator-App): in „Zugang & Sicherheit“
  einrichten (Secret manuell in der App anlegen — QR-Entfall bewusst, kein
  QR-Renderer als Dependency). Der Code wird erst nach korrektem Passwort
  abgefragt; Deaktivieren nur mit gültigem Code.
- **Passkeys** (WebAuthn, Touch-ID/Windows Hello/FIDO2-Key): gleichfalls in
  „Zugang & Sicherheit“ registrierbar (max. 10). Login/Login ganz ohne
  Passwort. Verifiziert wird mit eingebautem Minimal-CBOR-Parser
  (`webauthn.js`): clientDataJSON (Typ/Challenge/Origin) + rpIdHash +
  ECDSA-P-256-Signatur. Attestation „none“ — die Sicherheitsaussage kommt
  aus der Signatur, nicht vom Attest-Zertifikat.
- **Backup:** TOTP-Secret und Passkeys hängen am Konto — der Admin-Export
  nimmt alles mit, ein wiederhergestelltes Portal hat 2FA/Passkeys sofort
  wieder aktiv.
- **rpId-Bindung:** Standard ist der Hostname, unter dem das Portal
  aufgerufen wird. Hinter einem Proxy mit anderer externer Domain
  `WEBAUTHN_RP_ID=portal.example.com` setzen. Auf `http://localhost`
  funktionieren Passkeys (Secure Context); für LAN-IPs HTTP braucht es
  https oder die Chrome-Flag `unsafely-treat-insecure-origin-as-secure`.

## Grenzen des lokalen Aufbaus (bewusst schlank)

- Ein Installateur = ein Konto mit EINEM Key-Paar (mehrgeräte okay).
- Anlagenliste ist pro Konto global (keine Teams/Rollen).
- Status-Anzeige: kompakte Chips (SoC, Batterie, PV, Grid-Setpoint, Min-SoC,
  Alarme) + Roh-JSON für Historie/Updates.
