# Fern-Support-Relay: Freischaltung über das Portal

Seit 2026-10-14 trägt das Installateurs-Portal Anlagen selbst beim Relay ein.
Wer im Portal bei einer Anlage „Fern-Support öffnen" klickt, braucht keinen
Schlüsselaustausch per Chat und keine Handarbeit an `registry.json` mehr.

## Ablauf

1. **Anlage meldet ihren Schlüssel.** Sie schickt beim Melden ans Portal ihren
   öffentlichen Relay-Schlüssel mit und ob der Kunde Fern-Support erlaubt hat.
2. **Portal legt einen Auftrag ab.** Beim ersten Öffnen schreibt das Portal
   `spool/requests/<appliance-id>.json` (Anlage und Schlüssel).
3. **Root-Dienst trägt ein.** `support-relay-enroll.path` startet
   `enroll-from-portal.py`. Das Skript prüft den Auftrag, vergibt das
   kleinste freie Port-Paar, schreibt `keys/<id>.pub` und `registry.json` und
   rendert mit `build-authorized-keys.sh`.
4. **Portal schickt den Befehl.** Das Ergebnis liegt in
   `spool/results/<id>.json`; das Portal schickt der Anlage „Tunnel öffnen"
   mit Ports und Dauer.

Eine schon eingetragene Anlage behält Ports und Schlüssel. Meldet sie einen
anderen Schlüssel (z. B. nach einer Neuinstallation), lehnt das Skript ab
(`key_mismatch`); das bleibt Handarbeit (siehe unten).

## Rechte

| Pfad | Besitzer | Portal-Container |
|---|---|---|
| `/opt/support-relay/spool` | root, 0755 | nicht eingebunden |
| `/opt/support-relay/spool/requests` | 1000:1000, 0700 | `/relay/requests` (schreiben) |
| `/opt/support-relay/spool/results` | root:1000, 0750 | `/relay/results` (nur lesen) |

Das Portal kommt nicht an `registry.json`, `keys/` oder die sshd-Dateien.
Aufträge liest das Skript ohne Symlinks, nur als reguläre Datei bis 4 KB.

## Einrichten

```bash
install -m 0755 enroll-from-portal.py /opt/support-relay/
install -m 0644 support-relay-enroll.path support-relay-enroll.service /etc/systemd/system/
install -d -m 0755 /opt/support-relay/spool
install -d -m 0700 -o 1000 -g 1000 /opt/support-relay/spool/requests
install -d -m 0750 -o 0 -g 1000 /opt/support-relay/spool/results
systemctl daemon-reload && systemctl enable --now support-relay-enroll.path
```

Im Portal (`docker-compose.yml`):

```yaml
    environment:
      RELAY_REQUEST_DIR: /relay/requests
      RELAY_RESULT_DIR: /relay/results
    volumes:
      - /opt/support-relay/spool/requests:/relay/requests
      - /opt/support-relay/spool/results:/relay/results:ro
```

## Handarbeit bleibt für

- **Neuer Schlüssel für eine bekannte Anlage:** alten Eintrag prüfen, dann
  `keys/<id>.pub` ersetzen und `build-authorized-keys.sh` laufen lassen.
- **Anlage austragen:** Eintrag aus `registry.json` und `keys/<id>.pub`
  löschen, `build-authorized-keys.sh` laufen lassen.

Protokoll: `/var/log/support-relay-enroll.log`.

## Tests

`python3 test_enroll.py` (lokal mit einem Ersatz-Renderer). Auf dem Relay
rendert `RELAY_TEST_REAL_RENDER=/opt/support-relay/build-authorized-keys.sh
python3 test_enroll.py` mit dem echten Skript in ein Testverzeichnis.
