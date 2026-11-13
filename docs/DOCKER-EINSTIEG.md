# DVhub mit Docker – Einstieg Schritt für Schritt

Diese Anleitung ist für alle, die DVhub zum ersten Mal per Docker installieren. Technische Details für
Fortgeschrittene stehen in [`docker/README.md`](../docker/README.md).

## 1. Was du brauchst

- Ein Linux-Gerät, das dauerhaft läuft und im selben Netz wie Wechselrichter/GX hängt, zum Beispiel Raspberry Pi 4/5,
  Mini-PC, NAS mit Docker.
- Docker mit Compose **2.23 oder neuer**. Prüfen:

  ```bash
  docker compose version
  ```

  Fehlt Docker, auf Debian, Ubuntu oder Raspberry Pi OS:

  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER   # danach einmal ab- und wieder anmelden
  ```

> **Hinweis zu Docker Desktop (Windows/Mac) und manchen NAS-Oberflächen:** DVhub läuft im *Host-Netz*
> (`network_mode: host`), damit es Modbus-Geräte im Heimnetz erreicht und selbst als Modbus-Server erreichbar ist.
> Das klappt unter Linux direkt. Unter Docker Desktop ist das Host-Netz nur eingeschränkt verfügbar – dort am
> besten ein Linux-Gerät oder eine Linux-VM nehmen.

## 2. Installieren

Im Ordner, in dem DVhub liegen soll (es entsteht der Unterordner `dvhub`):

```bash
curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/docker/install.sh | bash
```

Am Ende zeigt der Installer die Adresse, zum Beispiel `Fertig. DVhub läuft: http://192.168.1.50:8080`.

Prüfen, ob alles läuft:

```bash
cd dvhub
docker compose ps        # dvhub, db und eos sollten "healthy" bzw. "running" sein
```

Varianten beim Installieren:

| Option | Wirkung |
|---|---|
| `bash -s -- --port 8090` | DVhub auf einem anderen Port (wenn 8080 schon belegt ist) |
| `bash -s -- --no-eos` | ohne EOS-Optimierer (kleine Geräte) |
| `bash -s -- --dir /opt/dvhub` | anderer Installationsordner |

Beispiel: `curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/docker/install.sh | bash -s -- --port 8090`

## 3. Weboberfläche aufrufen

Im Browser auf einem beliebigen Gerät im Heimnetz:

```
http://<IP-Adresse des Geräts>:8080
```

Die IP-Adresse des Geräts zeigt:

```bash
hostname -I
```

Beim ersten Aufruf startet der **Einrichtungsassistent**: Hersteller wählen (z. B. Victron), Adresse der Anlage
eintragen, fertig. Alles Weitere stellst du danach in der Oberfläche unter *Einstellungen* ein.

## 4. Welche Ports wofür?

DVhub läuft im Host-Netz – es gibt **keine** Port-Weiterleitung (`-p …`) einzustellen. Die Ports sind direkt die
des Geräts:

| Port | Wofür | Von wo erreichbar |
|---|---|---|
| **8080** (oder dein `--port`) | Weboberfläche und API von DVhub | Heimnetz |
| 8443 | Weboberfläche per HTTPS (wenn eingeschaltet) | Heimnetz |
| 502 | Modbus-Server für den Direktvermarkter – nur bei Direktvermarktung nötig | Heimnetz/VPN |
| 5433 | Datenbank | **nur** das Gerät selbst (127.0.0.1) |
| 8503 | EOS-Optimierer | **nur** das Gerät selbst (127.0.0.1) |

**Port später ändern:** in der Oberfläche unter *Einstellungen → System → Grundsystem → HTTP Port*, speichern, dann
`docker compose restart dvhub`. Die Einstellung `DVHUB_HTTP_PORT` in der Datei `.env` gilt nur beim allerersten Start.

## 5. Und EOS?

EOS ist der Rechenkern, der Akku- und Ladepläne optimiert. **Du musst EOS nicht selbst bedienen.** DVhub schickt
EOS die Prognosen und Preise, startet die Berechnungen und setzt die Pläne um – alles über die EOS-Schnittstelle.
Was EOS geplant hat, siehst du in DVhub im Leitstand.

Die EOS-eigene Oberfläche (EOSdash) ist im Docker-Paket bewusst ausgeschaltet; sie braucht viel Speicher und wird
nicht gebraucht. Siehst du trotzdem eine EOS-Seite, ist das die technische Schnittstelle von EOS, keine Bedienoberfläche.
Läuft EOS bei dir woanders (z. B. als Home-Assistant-Add-on), trägst du dessen Adresse in DVhub unter
*Einstellungen → Zeitplan → EOS-Optimierung → Adresse des Optimierers* ein.

## 6. Wenn etwas nicht geht

| Problem | Was tun |
|---|---|
| Seite lädt nicht | `docker compose ps` – läuft `dvhub`? Richtige IP und Port? Firewall des Geräts lässt Port 8080 zu? |
| `dvhub` startet immer neu | `docker compose logs --tail 50 dvhub` zeigt den Grund |
| Port 8080 schon belegt | neu installieren mit `--port 8090` oder Port in den Einstellungen ändern |
| Assistent findet die Anlage nicht | Gerät und Anlage im selben Netz? Bei Victron: Modbus TCP am GX eingeschaltet? |
| API-Token für Skripte | `docker compose exec dvhub node -p 'require("/etc/dvhub/config.json").apiToken'` |

## 7. Aktualisieren

Denselben Einzeiler wie bei der Installation im selben Ordner erneut ausführen. Einstellungen, Passwörter und Daten
bleiben erhalten.
