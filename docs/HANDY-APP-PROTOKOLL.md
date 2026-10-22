# Handy-App: Kopplung und Protokoll (Version 1)

Stand 22.10.2026. Gilt für DVhub (`dvhub/services/mobile-link/`), das Relay
(`relay/`, Standard `relay.dvhub.de`) und die iPhone-App (`ios/`). Die
Referenz ist der Node-Code; die Prüfwerte in
`dvhub/test/fixtures/mobile-link-vectors.json` müssen alle Umsetzungen bit-genau
treffen (`node scripts/mobile-link-vectors.mjs` erzeugt sie neu).

## Überblick

```
iPhone ──WSS──▶ Relay ◀──WSS── DVhub        (unterwegs, Relay selbst hostbar)
iPhone ──WS───▶ DVhub /api/mobile-link/ws   (im Heimnetz, eingebettetes Relay)
```

Beide Wege sprechen exakt dasselbe Protokoll. Das Relay sieht nur
Chiffretext und Kanal-IDs. Es hat kein Register und speichert nichts auf der
Platte; der Briefkasten (letzter Stand, Ereignisse) liegt nur im Arbeitsspeicher
und höchstens 24 h.

## Bausteine

| Zweck | Verfahren | Kodierung |
|---|---|---|
| Identität Box/Gerät | ECDSA P-256, SHA-256 | öffentl. Schlüssel 65 Byte `04‖X‖Y` (CryptoKit `x963Representation`), Signatur 64 Byte `r‖s` (`rawRepresentation`) |
| Kurzlebiger Schlüssel | X25519 | 32 Byte roh |
| Schlüsselableitung | HKDF-SHA256 | |
| Verschlüsselung | ChaCha20-Poly1305 | Chiffretext ‖ 16-Byte-Tag |
| Transkript | SHA-256 über Felder mit Längenpräfix | je Feld `u16 BE Länge ‖ Bytes`; Text als UTF-8, Zahlen als Dezimaltext |
| Binär in JSON | base64url ohne `=` | |

`id(pub)` = base64url der ersten 16 Byte von SHA-256(pub) (22 Zeichen). So
heißt die Box (`boxId`) und jedes Gerät (`devId`).

Auf dem iPhone liegt der Geräteschlüssel in der Secure Enclave
(`SecureEnclave.P256.Signing.PrivateKey`), nur mit Gerätesperre nutzbar, nicht
in Backups.

## QR-Code

```
dvhub://pair?v=1&b=<Box-Schlüssel 65 B>&s=<Geheimnis 32 B>&e=<Ablauf Unix-s>
             &n=<Name>&l=192.168.1.60:8080,dvhub.local&r=wss%3A%2F%2Frelay.dvhub.de%2Fv1%2Fws
```

Kodierung wie `URLSearchParams`. `l` (höchstens zwei Heimnetz-Adressen,
`host:port`) und `r` (Relay) können fehlen. Aus jedem Host in `l` wird
`ws://<host>/api/mobile-link/ws`. Das Geheimnis gilt 5 Minuten und genau eine
Kopplung. Prüfwert: `qrExample` / `qrExampleParsed` in der Fixture.

## Relay-Ebene (WebSocket, Textrahmen mit JSON)

Nach dem Verbindungsaufbau sendet das Relay
`{"t":"challenge","n":"<32 B>","relay":"dvhub-relay","v":1}`. Danach innerhalb
10 s genau eine Anmeldung:

| Rolle | Nachricht | Prüfung durch das Relay |
|---|---|---|
| Box | `{"t":"auth","role":"box","pub":…,"sig":…}` | `sig` über `framed("dvhub-relay-auth-v1","box",n)`; Kanal = `id(pub)` |
| Gerät | `{"t":"auth","role":"device","ticket":{…},"pub":…,"sig":…}` | Ticket gültig, `id(pub) == ticket.dev`, `sig` über `framed("dvhub-relay-auth-v1","device",n)`, Gerät in der Freigabeliste der Box, sobald die verbundene Box eine geschickt hat (die Box schickt sie direkt nach der Anmeldung; bis dahin fängt der Handshake unbekannte Geräte ab) |
| Kopplung | `{"t":"auth","role":"pair","box":"<boxId>","token":…}` | `token = HKDF(ikm=Geheimnis, salt=leer, info="dvhub-link-pair-token-v1", 32)`; Box hat `SHA-256(token)` angemeldet; einmal verwendbar |

`framed(…)` = die Feldfolge selbst (nicht gehasht). Antwort:
`{"t":"ok","role":…,"box":"<boxId>","boxOnline":true|false}`.

**Ticket** (von der Box bei Kopplung und bei jeder Sitzung neu ausgestellt, 365 Tage):
`{"v":1,"box":"<boxPub>","dev":"<devId>","exp":<Unix-s>,"sig":…}`, `sig` von der
Box über `framed("dvhub-ticket-v1", boxId, devId, exp)`.

Gerät/Kopplung ↔ Relay:

- `{"t":"data","d":"<base64url>"}` in beide Richtungen (Inhalt siehe unten)
- vom Relay: `{"t":"box_offline"}`, `{"t":"box_online"}`, `{"t":"error","e":…}`
- `{"t":"mbox_get"}` → `{"t":"mbox","items":[{"id","ts","d","slot"?}]}`;
  `{"t":"mbox_ack","ids":[…]}` löscht Ereignisse (`latest` wird nur überschrieben)
- `{"t":"ping"}` → `{"t":"pong"}`

Box ↔ Relay (nur zur Info für Relay-Betreiber): `open`/`data`/`close` mit
Verbindungsnummer `c`, `allow` (Freigabeliste, höchstens 32), `pair_open` (`{"h":…,"ttlMs":…}` — relative Laufzeit, die Uhr der Box zählt nicht)/`pair_close`,
`mbox_put`/`mbox_clear`.

Schließcodes: 4000 normal, 4001 ersetzt, 4002 Anmeldung falsch, 4003 nicht
erlaubt (z. B. entkoppelt), 4004 Box offline, 4008 Grenze überschritten,
4009 Protokollfehler, 4010 Anmeldung zu spät, 4011 Relay fährt herunter.

Grenzen (gezählt in Zeichen des JSON-Textes): Rahmen vom Gerät ≤ 256 KiB, von
der Box ≤ 1 MiB; höchstens 64 Verbindungen je Quelladresse; Briefkästen nur für
Geräte auf der Freigabeliste; je 10 s ≤ 200
Rahmen / 1 MiB vom Gerät.

## Handshake gekoppeltes Gerät

Die ersten Nachrichten in `data.d` sind base64url(JSON) im Klartext.

1. Gerät → Box: `{"t":"hs1","v":1,"dev":"<devId>","e":"<X25519 32 B>","n":"<16 B>"}`
2. Box → Gerät: `{"t":"hs2","e":…,"n":…,"sig":…}`
   - `th = SHA256(framed("dvhub-link-hs-v1", "1", boxPub, devPub, eD, nD, eB, nB))` — `"1"` ist die Protokollversion (Schutz vor Herabstufung)
   - `sig` = Box-Signatur über `th` — das Gerät prüft gegen den Schlüssel aus dem QR-Code
3. Gerät → Box: `{"t":"hs3","sig":…}` — Gerätesignatur über `SHA256(framed(th, "client"))`

Schlüssel: `okm = HKDF(ikm=X25519(eD,eB), salt=th, info="dvhub-link-keys-v1", 64)`;
`okm[0..32]` Gerät→Box, `okm[32..64]` Box→Gerät.

Danach ist jedes `data.d` = base64url(ChaChaPoly(JSON)), Nonce = 4 Null-Byte ‖
u64 BE Zähler (je Richtung ab 0), AAD = `th`. Ein fehlender, doppelter oder
vertauschter Rahmen lässt die Entschlüsselung scheitern → Verbindung neu aufbauen.

## Kopplung

1. Gerät verbindet mit Rolle `pair` (Heimnetz-Adresse zuerst, sonst Relay).
2. Gerät → Box (Klartext): `{"t":"p1","v":1,"e":…,"n":…}`
3. Box → Gerät (Klartext): `{"t":"p2","e":…,"n":…,"sig":…}`
   - `th = SHA256(framed("dvhub-link-pair-v1", "1", boxPub, eD, nD, eB, nB))`, Box-Signatur über `th`
   - Schlüssel: `HKDF(ikm=X25519, salt=HMAC-SHA256(Geheimnis, th), info="dvhub-link-pair-keys-v1", 64)`, Aufteilung und AAD wie oben
4. Gerät → Box (verschlüsselt): `{"t":"p3","pub":"<devPub>","sig":…,"name":"…","model":"…"}`,
   `sig` über `SHA256(framed(th, "pair-client"))`
5. Box → Gerät: `{"t":"p_wait","box":{"id","name"}}` — die Oberfläche zeigt Name, Modell
   und den **Vergleichscode**; das Gerät zeigt denselben Code an:
   `code = UInt32BE(SHA256(framed("dvhub-pair-code-v1", th))[0..4]) mod 1 000 000`,
   sechsstellig mit führenden Nullen. Nur bei gleichem Code freigeben. Freigeben
   kann nur das Fenster, das die Kopplung gestartet hat (Freigabe-Token aus
   `POST /api/mobile-link/pair/start`); den QR-Inhalt gibt es nur in dieser Antwort.
6. Box → Gerät: `{"t":"p_ok","dev","name","perms","box":{"id","name"},"ticket","mailboxKey","relay"}`
   oder `{"t":"p_denied"}`. Danach trennt die Box; das Gerät verbindet neu als `device`.

Die App speichert: `boxPub`, `boxId`, `devId`, `ticket`, `mailboxKey`, `lan`, `relay`, Namen.

## Nachrichten in der Sitzung

Box → Gerät zuerst: `{"t":"welcome","box":{"id","name","version"},"perms":["read"|"control"],"ticket","relay","via":"lan"|"remote"}`
(neues Ticket speichern).

| Gerät → Box | Box → Gerät |
|---|---|
| `{"t":"sub","live":true,"intervalMs":2000}` (≥ 1000) | `{"t":"live","ts","status":{…}}` im Takt; `live:false` beendet |
| `{"t":"req","id":"1","m":"GET","p":"/api/status"}` | `{"t":"res","id":"1","s":200,"b":<JSON oder Text>}` |
| `{"t":"req","id":"2","m":"POST","p":"/api/control/stop","b":{}}` | wie oben; ohne Recht `control` → 403 |
| `{"t":"ping","id":…}` | `{"t":"pong","id":…}` |

Erlaubte Pfade: `dvhub/services/mobile-link/permissions.js`. Passt eine Antwort
verschlüsselt nicht in einen Relay-Rahmen (1 MiB, also gut 750 KiB JSON), kommt
`s: 413` mit `{"error":"response_too_large"}`.

`status` (live, Briefkasten) = Kompakt-Status wie im Installateurs-Portal:
`soc`, `batteryPowerW`, `pvTotalW`, `gridImportW`, `gridExportW`, `loadW`,
`gridSetpointW`, `minSocPct`, `alarmsActive`, `alarmsSeverity`,
`emergencyStop`, `todayNetEur`, `todayRevenueEur`, `todayCostEur`, `version`, `controls`.

## Briefkasten

Die Box legt am Relay je Gerät alle 60 s den letzten Stand ab (`slot:"latest"`)
und, wenn sich Alarme oder Not-Halt ändern, ein Ereignis (geprüft alle 10 s). Inhalt:
`d = base64url(Nonce 12 B ‖ ChaChaPoly(JSON))`, Schlüssel `mailboxKey`, AAD =
`framed("dvhub-mbox-v1", devId)`. JSON: `{"t":"latest","ts","status"}` bzw.
`{"t":"event","ts","kind":"state_change","alarmsActive","alarmsSeverity","emergencyStop"}`.

## Entkoppeln

In der DVhub-Oberfläche. Die Box schließt laufende Sitzungen, schickt dem
Relay die neue Freigabeliste und leert den Briefkasten des Geräts. Ist die Box
gerade nicht mit dem Relay verbunden, kann ein entkoppeltes Gerät dort nur noch
seinen (leeren) Briefkasten sehen.

**Wiederholung durch das Relay:** Das Relay kann alte Briefkasten-Einträge erneut
ausliefern (es kann sie nicht lesen, aber zurückhalten und später schicken). Die
App vergleicht deshalb `ts` aus dem entschlüsselten Inhalt mit dem zuletzt
gezeigten Stand und verwirft Älteres.

## Mengen und Protokoll auf der Box

Anfragen eines Geräts laufen als Loopback über die eigene API und teilen sich dort
den Rate-Limit-Topf von 127.0.0.1. Die Box nimmt deshalb je Gerät höchstens 60
Anfragen pro Minute an, von allen Geräten zusammen 240, und höchstens 4
gleichzeitig; darüber `s: 429`. Im Audit-Log stehen Befehle mit
`actor_session = "mobile-link:<devId>"`.

