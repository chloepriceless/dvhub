# DVhub-Relay (Handy-App)

Das Relay verbindet die DVhub-App auf dem Handy mit der Anlage, wenn das Handy
nicht im Heimnetz ist. Voreingestellt ist `relay.dvhub.de`. Wer seine Daten
nicht über einen fremden Server leiten will, betreibt ein eigenes Relay und trägt
es in DVhub unter **Einstellungen → Freigaben → Handy-App → Relay-Adresse** ein.

## Was das Relay sieht – und was nicht

- **Inhalte nicht.** Alles ist Ende zu Ende verschlüsselt. Die Schlüssel tauschen
  Anlage und Handy nur über den QR-Code aus; das Relay bekommt sie nie.
- **Verbindungsdaten schon:** dass eine Anlage (Kennung = Hash ihres öffentlichen
  Schlüssels) und ihre Handys verbunden sind, wann und wie viel übertragen wird,
  die IP-Adressen.
- **Kein Register, keine Datenbank, nichts auf der Platte.** Wer in einen Kanal
  darf, prüft das Relay an Signaturen und an einem von der Anlage unterschriebenen
  Ticket. Der Briefkasten (letzter Stand und Ereignisse, solange das Handy nicht
  verbunden ist) liegt nur im Arbeitsspeicher, höchstens 24 h; ein Neustart leert ihn.

Protokoll: [`docs/HANDY-APP-PROTOKOLL.md`](../docs/HANDY-APP-PROTOKOLL.md). Code:
`dvhub/services/mobile-link/relay-core.js` (derselbe Code läuft eingebettet in
jeder DVhub-Anlage fürs Heimnetz).

## Betrieb mit Docker (empfohlen)

Voraussetzung: ein Server mit öffentlicher Adresse, Ports 80/443 frei, ein
DNS-Eintrag (z. B. `relay.example.org`) auf diesen Server.

```bash
git clone https://github.com/chloepriceless/dvhub.git
cd dvhub/relay
RELAY_DOMAIN=relay.example.org docker compose up -d --build
curl https://relay.example.org/healthz
```

Caddy holt das TLS-Zertifikat selbst. In DVhub dann `relay.example.org`
eintragen – DVhub ergänzt `wss://` und den Pfad `/v1/ws`.

## Ohne Docker

```bash
cd dvhub/dvhub && npm ci --omit=dev
RELAY_PORT=8787 node services/mobile-link/relay-server.js
```

Davor einen Reverse-Proxy mit TLS setzen, der WebSockets durchreicht, z. B. nginx:

```nginx
location /v1/ws {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_read_timeout 120s;
}
```

Ohne TLS (`ws://`) nimmt DVhub ein Relay nur im eigenen Netz an.

## Einstellungen

| Variable | Bedeutung | Standard |
|---|---|---|
| `RELAY_PORT` | Port | `8787` |
| `RELAY_HOST` | Adresse | `0.0.0.0` |
| `RELAY_NAME` | Name in der Begrüßung | `dvhub-relay` |
| `RELAY_BOX_ALLOWLIST` | Datei mit erlaubten Anlagen-Kennungen (eine je Zeile, `#` = Kommentar). Ohne Datei darf jede Anlage das Relay nutzen. Änderungen wirken ohne Neustart. | – |
| `RELAY_MAX_BOXES` | höchstens so viele Anlagen gleichzeitig | `10000` |
| `RELAY_TRUST_PROXY` | `1` = Client-Adresse aus `X-Forwarded-For` (nur fürs Log) | – |

Die Kennung einer Anlage steht in DVhub in der Kachel „Handy-App“ (`boxId`) bzw.
in `GET /api/mobile-link/status`.

Grenzen je Verbindung (Rahmengröße, Rahmen und Bytes je 10 s, Geräte je Anlage,
Briefkasten-Größe) stehen in `DEFAULT_LIMITS` in `relay-core.js`.

## Überwachung

`GET /healthz` → `{"ok":true,"boxesOnline":…,"deviceConnections":…,"mailboxes":…,"mailboxBytes":…}`.
Das Log (stdout, JSON) enthält nur Kennungen und Ereignisse wie „Anlage online/offline“,
nie Inhalte.
