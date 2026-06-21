# Notfall-Fernzugang (wenn DVhub nicht mehr startet)

Wenn die **DVhub-Oberfläche/App nicht mehr startet** (z. B. nach einem Fehler oder
einem fehlgeschlagenen Update), kannst du den Support-Tunnel **nicht** über die
Einstellungen öffnen. Solange die **Box selbst** noch läuft und erreichbar ist
(SSH im Heimnetz oder lokale Konsole/Bildschirm), gibt es einen Notfall-Weg.

Es liegt ein eigenständiges Skript auf der Box, das den **gleichen**
Support-Tunnel aufbaut wie die App — ganz ohne DVhub, Datenbank oder Web-UI:

```
/opt/dvhub/dvhub-support-tunnel.sh
```

## So geht's

1. **Auf die Box einloggen** — per SSH aus dem Heimnetz (mit deinem Admin-Zugang)
   oder direkt an Tastatur/Bildschirm der Box.

2. **Tunnel öffnen:**
   ```bash
   sudo bash /opt/dvhub/dvhub-support-tunnel.sh
   ```
   Das Skript zeigt dir an, was du dem Support durchgeben musst, z. B.:
   ```
   Appliance-ID : 762fb93c-0e2e-41d3-a0bf-3caebbad6c6c
   RELAY        : dvhub-support@support.dvhub.de:47821  (Ports 49101/49102)
   ```

3. **Diese Zeile dem Support durchgeben.** Der Support verbindet sich dann über
   den Tunnel und kann die Box reparieren.

4. **Laufen lassen**, solange der Support arbeitet. Das Fenster offen lassen.

5. **Beenden:** `Strg-C` im selben Fenster — oder in einem anderen Terminal:
   ```bash
   sudo bash /opt/dvhub/dvhub-support-tunnel.sh --close
   ```
   Der Tunnel **schließt sich zusätzlich automatisch nach 60 Minuten**.

## Optionen

| Befehl | Wirkung |
|--------|---------|
| `sudo bash /opt/dvhub/dvhub-support-tunnel.sh` | Öffnen, Auto-Close nach 60 Min |
| `… --ttl 30` | Öffnen, Auto-Close nach 30 Min |
| `… --ttl 0` | Öffnen bis `Strg-C` (kein Auto-Close) |
| `… --print` | Nur anzeigen, was passieren würde (verbindet **nicht**) |
| `… --close` | Laufenden Tunnel sofort beenden |

## Sicherheit

Das Vertrauensmodell ist identisch zum Tunnel aus der App:

- **Kundeninitiiert** — der Tunnel öffnet sich nur, wenn **du** das Skript startest.
- **Zeitbegrenzt** — Auto-Close (Standard 60 Min) und jederzeit per `--close`/`Strg-C` beendbar.
- **Kein Dauerzugang** — ohne offenen Tunnel ist die Box hinter dem Router von außen
  nicht erreichbar; der hinterlegte Support-Schlüssel allein gibt **keinen** Zugriff.

> Voraussetzung: Der Support-Zugang wurde bei der Installation eingerichtet
> (Standard). Wenn mit `--no-support-user` installiert wurde, existiert kein
> Support-Schlüssel und das Skript meldet „Support nicht eingerichtet".
